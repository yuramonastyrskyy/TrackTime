package io.github.yuramonastyrskyy.tracktime;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Range;
import android.util.Rational;
import android.util.Size;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.camera.camera2.interop.Camera2CameraControl;
import androidx.camera.camera2.interop.Camera2CameraInfo;
import androidx.camera.camera2.interop.Camera2Interop;
import androidx.camera.camera2.interop.CaptureRequestOptions;
import androidx.camera.camera2.interop.ExperimentalCamera2Interop;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraInfo;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.core.resolutionselector.AspectRatioStrategy;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.core.resolutionselector.ResolutionStrategy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The native camera for TrackTime.
 *
 * The web page (loaded from GitHub Pages) finds this as window.TrackTimeNative.
 * The camera runs here with CameraX at a fixed frame rate; its preview is drawn
 * natively behind the (transparent) web view. For every frame only the
 * finish-line sample pixels the page asks for (setPoints) are read from the Y
 * plane, together with the sensor timestamp, and queued for the page to pull
 * (frames). The page runs the same detector.js on them as in the browser.
 *
 * Exposure and focus run automatically in Set up; lock() freezes what they
 * metered (manual sensor values, so the frame rate cannot drop in a dim hall),
 * and nudge() makes the locked picture brighter or darker in 1/3 stops.
 *
 * Plain @JavascriptInterface methods (not Capacitor plugin calls), so it works
 * on every page the web view loads, including copies served by the service
 * worker. Bump VERSION when this interface changes; the page checks it.
 */
@CapacitorPlugin(name = "TrackCamera", requestCodes = { TrackCameraPlugin.PERM_CODE })
@OptIn(markerClass = ExperimentalCamera2Interop.class)
public class TrackCameraPlugin extends Plugin {

    static final int VERSION = 1;
    static final int PERM_CODE = 7101;
    private static final int MAX_QUEUE = 180; // 3 s at 60 fps if the page stops pulling

    private final Object lock = new Object();
    private final ExecutorService analysisExecutor = Executors.newSingleThreadExecutor();

    private PreviewView previewView;
    private ProcessCameraProvider provider;
    private Camera camera;
    private ImageAnalysis analysis;
    private boolean running = false;
    private String error = null;
    private String permission = "prompt";
    private int fpsWanted = 60;
    private Range<Integer> fpsRange = null;
    private String fpsRanges = "";
    private boolean manualSensor = false;
    private int timestampSource = CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_UNKNOWN;

    // Latest values the camera metered (from capture results).
    private volatile Long lastExposureNs = null;
    private volatile Integer lastIso = null;
    private volatile Float lastFocus = null;
    private volatile Integer lastAeState = null;
    private Range<Integer> isoRange = null;
    private Range<Long> exposureRange = null;
    private Range<Integer> evRange = null;
    private Rational evStep = null;

    // Lock state.
    private boolean locked = false;
    private long lockedExposureNs = 0;
    private int lockedIso = 0;
    private Float lockedFocus = null;
    private int nudgeThirds = 0;   // brighter (+) / darker (-) in 1/3 stops, kept across Start/Stop
    private int nudgeAtLock = 0;   // already in the metered values when lock() was called

    // Sample points from the page: normalised (0..1) picture coordinates in
    // display orientation, as pairs u,v.
    private float[] points = new float[0];
    private int pointsVersion = 0;
    // Index cache for the current image layout.
    private int[] index = new int[0];
    private int indexFor = -1, indexW = 0, indexH = 0, indexRot = -1, indexStride = 0;

    // Frame queue for the page.
    private final ArrayDeque<double[]> queueTimes = new ArrayDeque<>();
    private final ArrayDeque<byte[]> queueData = new ArrayDeque<>();
    private int queueN = 0;
    private long frameCount = 0, dropped = 0, queueOverflow = 0;
    private long lastTsNs = 0;
    private int width = 0, height = 0, rotation = 0; // display-oriented size
    private int fpsNow = 0;
    private long fpsWindowStart = 0, fpsWindowFrames = 0;

    private String pendingHash = null;

    @Override
    public void load() {
        WebView wv = getBridge().getWebView();
        wv.addJavascriptInterface(new Api(), "TrackTimeNative");
        wv.getSettings().setMediaPlaybackRequiresUserGesture(false);
        permission = hasCamera() ? "granted" : "prompt";
        takeIntent(getActivity().getIntent());
    }

    // ---------- Pacemaker "Open in app" links: tracktime://open?pm=... ----------

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (takeIntent(intent)) {
            getBridge().getWebView().post(() -> getBridge().getWebView().evaluateJavascript(
                "window.__ttNativeIntent && window.__ttNativeIntent()", null));
        }
    }

    private boolean takeIntent(Intent intent) {
        if (intent == null) return false;
        Uri data = intent.getData();
        if (data == null || !"tracktime".equals(data.getScheme())) return false;
        String pm = data.getQueryParameter("pm");
        if (pm == null || pm.isEmpty()) return false;
        synchronized (lock) { pendingHash = "#pm=" + pm; }
        return true;
    }

    // ---------- permission ----------

    private boolean hasCamera() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    protected void handleRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != PERM_CODE) return;
        if (hasCamera()) {
            permission = "granted";
        } else {
            boolean canAsk = ActivityCompat.shouldShowRequestPermissionRationale(getActivity(), Manifest.permission.CAMERA);
            permission = canAsk ? "prompt-again" : "denied";
        }
    }

    // ---------- camera ----------

    private void startCamera() {
        getActivity().runOnUiThread(() -> {
            if (running) return;
            error = null;
            if (!hasCamera()) { error = "no-permission"; return; }
            ListenableFuture<ProcessCameraProvider> f = ProcessCameraProvider.getInstance(getContext());
            f.addListener(() -> {
                try {
                    provider = f.get();
                    bind();
                } catch (Exception e) {
                    error = "start: " + e;
                }
            }, ContextCompat.getMainExecutor(getContext()));
        });
    }

    private void bind() {
        CameraInfo back = null;
        for (CameraInfo ci : provider.getAvailableCameraInfos()) {
            Integer facing = Camera2CameraInfo.from(ci).getCameraCharacteristic(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) { back = ci; break; }
        }
        if (back == null) { error = "no back camera"; return; }
        Camera2CameraInfo c2 = Camera2CameraInfo.from(back);
        readCharacteristics(c2);

        ResolutionSelector sel = new ResolutionSelector.Builder()
            .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
            .setResolutionStrategy(new ResolutionStrategy(new Size(1280, 720),
                ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
            .build();

        Preview.Builder pb = new Preview.Builder().setResolutionSelector(sel);
        Camera2Interop.Extender<Preview> pe = new Camera2Interop.Extender<>(pb);
        if (fpsRange != null) pe.setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange);
        pe.setSessionCaptureCallback(new CameraCaptureSession.CaptureCallback() {
            @Override
            public void onCaptureCompleted(@NonNull CameraCaptureSession s, @NonNull CaptureRequest r, @NonNull TotalCaptureResult res) {
                Long e = res.get(CaptureResult.SENSOR_EXPOSURE_TIME);
                Integer iso = res.get(CaptureResult.SENSOR_SENSITIVITY);
                Float fd = res.get(CaptureResult.LENS_FOCUS_DISTANCE);
                if (e != null) lastExposureNs = e;
                if (iso != null) lastIso = iso;
                if (fd != null) lastFocus = fd;
                lastAeState = res.get(CaptureResult.CONTROL_AE_STATE);
            }
        });
        Preview preview = pb.build();

        ImageAnalysis.Builder ab = new ImageAnalysis.Builder()
            .setResolutionSelector(sel)
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888);
        Camera2Interop.Extender<ImageAnalysis> ae = new Camera2Interop.Extender<>(ab);
        if (fpsRange != null) ae.setCaptureRequestOption(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fpsRange);
        analysis = ab.build();
        analysis.setAnalyzer(analysisExecutor, this::analyze);

        showPreview();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());
        provider.unbindAll();
        camera = provider.bindToLifecycle(getActivity(), back.getCameraSelector(), preview, analysis);
        running = true;
        locked = false;
        applyLock(); // the nudge, if any, as compensation
        synchronized (lock) {
            frameCount = 0; dropped = 0; queueOverflow = 0; lastTsNs = 0;
            queueTimes.clear(); queueData.clear();
            fpsWindowStart = 0; fpsWindowFrames = 0; fpsNow = 0;
        }
        getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void readCharacteristics(Camera2CameraInfo c2) {
        Range<Integer>[] ranges = c2.getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        StringBuilder sb = new StringBuilder();
        // Prefer exactly [wanted, wanted]; else the range reaching it with the
        // highest floor; else the fastest range there is.
        Range<Integer> wanted = null, best = null;
        if (ranges != null) {
            for (Range<Integer> r : ranges) {
                if (sb.length() > 0) sb.append(' ');
                sb.append(r.getLower()).append('-').append(r.getUpper());
                if (r.getUpper() == fpsWanted && (wanted == null || r.getLower() > wanted.getLower())) wanted = r;
                if (best == null || r.getUpper() > best.getUpper()
                    || (r.getUpper().equals(best.getUpper()) && r.getLower() > best.getLower())) best = r;
            }
        }
        fpsRanges = sb.toString();
        fpsRange = wanted != null ? wanted : best;
        int[] caps = c2.getCameraCharacteristic(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        manualSensor = false;
        if (caps != null) for (int c : caps) if (c == CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR) manualSensor = true;
        isoRange = c2.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
        exposureRange = c2.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
        evRange = c2.getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
        evStep = c2.getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
        Integer ts = c2.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE);
        timestampSource = ts == null ? CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_UNKNOWN : ts;
    }

    private void showPreview() {
        WebView wv = getBridge().getWebView();
        if (previewView == null) {
            previewView = new PreviewView(getContext());
            previewView.setScaleType(PreviewView.ScaleType.FIT_CENTER);
            previewView.setImplementationMode(PreviewView.ImplementationMode.PERFORMANCE);
            previewView.setBackgroundColor(Color.BLACK);
            ViewGroup parent = (ViewGroup) wv.getParent();
            parent.addView(previewView, 0, new ViewGroup.LayoutParams(wv.getWidth(), wv.getHeight()));
            // Same place and size as the web view, so the page's markers line up.
            wv.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> placePreview());
        }
        placePreview();
        previewView.setVisibility(View.VISIBLE);
        wv.setBackgroundColor(Color.TRANSPARENT);
    }

    private void placePreview() {
        if (previewView == null) return;
        WebView wv = getBridge().getWebView();
        ViewGroup.LayoutParams lp = previewView.getLayoutParams();
        if (lp.width != wv.getWidth() || lp.height != wv.getHeight()) {
            lp.width = wv.getWidth();
            lp.height = wv.getHeight();
            previewView.setLayoutParams(lp);
        }
        previewView.setX(wv.getX());
        previewView.setY(wv.getY());
        // Turning the phone: frames keep coming upright, in the new orientation.
        if (analysis != null && previewView.getDisplay() != null) {
            analysis.setTargetRotation(previewView.getDisplay().getRotation());
        }
    }

    private void stopCamera() {
        getActivity().runOnUiThread(() -> {
            if (provider != null) provider.unbindAll();
            camera = null;
            running = false;
            locked = false;
            if (previewView != null) previewView.setVisibility(View.GONE);
            getBridge().getWebView().setBackgroundColor(Color.parseColor("#0a1622"));
            getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    // ---------- exposure + focus ----------

    private void applyLock() {
        if (camera == null) return;
        Camera2CameraControl cc = Camera2CameraControl.from(camera.getCameraControl());
        CaptureRequestOptions.Builder b = new CaptureRequestOptions.Builder();
        if (!locked) {
            // Automatic, with the nudge as exposure compensation.
            int steps = compensationSteps(nudgeThirds);
            if (steps != 0) b.setCaptureRequestOption(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, steps);
            cc.setCaptureRequestOptions(b.build());
            return;
        }
        b.setCaptureRequestOption(CaptureRequest.CONTROL_AWB_LOCK, true);
        if (manualSensor) {
            double factor = Math.pow(2, (nudgeThirds - nudgeAtLock) / 3.0);
            long frameNs = 1_000_000_000L / Math.max(1, fpsRange != null ? fpsRange.getUpper() : fpsWanted);
            long exp = lockedExposureNs;
            double iso = lockedIso * factor;
            if (isoRange != null) {
                double clamped = Math.max(isoRange.getLower(), Math.min(isoRange.getUpper(), iso));
                // What ISO cannot do, exposure time does (never longer than a frame).
                exp = Math.round(exp * iso / clamped);
                iso = clamped;
            }
            long maxExp = frameNs;
            if (exposureRange != null) maxExp = Math.min(maxExp, exposureRange.getUpper());
            long minExp = exposureRange != null ? exposureRange.getLower() : 1000;
            exp = Math.max(minExp, Math.min(maxExp, exp));
            b.setCaptureRequestOption(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF);
            b.setCaptureRequestOption(CaptureRequest.SENSOR_EXPOSURE_TIME, exp);
            b.setCaptureRequestOption(CaptureRequest.SENSOR_SENSITIVITY, (int) Math.round(iso));
            b.setCaptureRequestOption(CaptureRequest.SENSOR_FRAME_DURATION, frameNs);
            if (lockedFocus != null) {
                b.setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF);
                b.setCaptureRequestOption(CaptureRequest.LENS_FOCUS_DISTANCE, lockedFocus);
            }
        } else {
            b.setCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK, true);
            int steps = compensationSteps(nudgeThirds);
            if (steps != 0) b.setCaptureRequestOption(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, steps);
        }
        cc.setCaptureRequestOptions(b.build());
    }

    private int compensationSteps(int thirds) {
        if (evRange == null || evStep == null || evStep.floatValue() <= 0) return 0;
        int steps = Math.round((thirds / 3f) / evStep.floatValue());
        return Math.max(evRange.getLower(), Math.min(evRange.getUpper(), steps));
    }

    // ---------- frames ----------

    private void analyze(ImageProxy image) {
        try {
            long ts = image.getImageInfo().getTimestamp();
            int rot = image.getImageInfo().getRotationDegrees();
            int iw = image.getWidth(), ih = image.getHeight();
            ImageProxy.PlaneProxy y = image.getPlanes()[0];
            ByteBuffer buf = y.getBuffer();
            int stride = y.getRowStride(), px = y.getPixelStride();
            byte[] out;
            synchronized (lock) {
                rotation = rot;
                if (rot == 90 || rot == 270) { width = ih; height = iw; } else { width = iw; height = ih; }
                if (indexFor != pointsVersion || indexW != iw || indexH != ih || indexRot != rot || indexStride != stride) {
                    buildIndex(iw, ih, rot, stride, px);
                }
                out = new byte[index.length];
            }
            int lim = buf.limit();
            for (int i = 0; i < out.length; i++) {
                int p = index[i];
                out[i] = p < lim ? buf.get(p) : 0;
            }
            synchronized (lock) {
                if (lastTsNs != 0 && fpsRange != null) {
                    double frameNs = 1e9 / fpsRange.getUpper();
                    long missing = Math.round((ts - lastTsNs) / frameNs) - 1;
                    if (missing > 0) dropped += missing;
                }
                lastTsNs = ts;
                frameCount++;
                long now = SystemClock.elapsedRealtime();
                if (fpsWindowStart == 0) fpsWindowStart = now;
                fpsWindowFrames++;
                if (now - fpsWindowStart >= 1000) {
                    fpsNow = (int) Math.round(fpsWindowFrames * 1000.0 / (now - fpsWindowStart));
                    fpsWindowStart = now; fpsWindowFrames = 0;
                }
                if (out.length != queueN) { queueTimes.clear(); queueData.clear(); queueN = out.length; }
                queueTimes.add(new double[] { ts / 1e6 });
                queueData.add(out);
                while (queueData.size() > MAX_QUEUE) { queueTimes.poll(); queueData.poll(); queueOverflow++; }
            }
        } catch (Exception e) {
            error = "frame: " + e;
        } finally {
            image.close();
        }
    }

    /** Buffer offsets of the sample points for this image size and rotation. */
    private void buildIndex(int iw, int ih, int rot, int stride, int px) {
        int n = points.length / 2;
        int[] idx = new int[n];
        for (int i = 0; i < n; i++) {
            float u = points[i * 2], v = points[i * 2 + 1];
            float sx, sy; // normalised sensor-image coordinates
            switch (rot) {
                case 90: sx = v; sy = 1 - u; break;
                case 180: sx = 1 - u; sy = 1 - v; break;
                case 270: sx = 1 - v; sy = u; break;
                default: sx = u; sy = v;
            }
            int x = Math.max(0, Math.min(iw - 1, (int) (sx * iw)));
            int yy = Math.max(0, Math.min(ih - 1, (int) (sy * ih)));
            idx[i] = yy * stride + x * px;
        }
        index = idx;
        indexFor = pointsVersion; indexW = iw; indexH = ih; indexRot = rot; indexStride = stride;
    }

    private double epochOffsetMs() {
        if (timestampSource == CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME) {
            return System.currentTimeMillis() - SystemClock.elapsedRealtimeNanos() / 1e6;
        }
        return System.currentTimeMillis() - System.nanoTime() / 1e6;
    }

    @Override
    protected void handleOnDestroy() {
        analysisExecutor.shutdown();
    }

    /** What the page calls, as window.TrackTimeNative. Runs on a binder thread. */
    public class Api {
        @JavascriptInterface
        public int version() { return VERSION; }

        @JavascriptInterface
        public String info() {
            try {
                JSONObject o = new JSONObject();
                synchronized (lock) {
                    o.put("version", VERSION);
                    o.put("permission", hasCamera() ? "granted" : permission);
                    o.put("running", running);
                    o.put("error", error == null ? JSONObject.NULL : error);
                    o.put("width", width);
                    o.put("height", height);
                    o.put("rotation", rotation);
                    o.put("fps", fpsNow);
                    o.put("fpsTarget", fpsRange == null ? JSONObject.NULL : fpsRange.getUpper());
                    o.put("fpsMin", fpsRange == null ? JSONObject.NULL : fpsRange.getLower());
                    o.put("fpsRanges", fpsRanges);
                    o.put("frames", frameCount);
                    o.put("dropped", dropped);
                    o.put("overflow", queueOverflow);
                    o.put("manualSensor", manualSensor);
                    o.put("locked", locked);
                    o.put("nudge", nudgeThirds);
                    o.put("exposureNs", locked ? lockedExposureNs : (lastExposureNs == null ? 0 : lastExposureNs));
                    o.put("iso", locked ? lockedIso : (lastIso == null ? 0 : lastIso));
                    o.put("aeState", lastAeState == null ? JSONObject.NULL : lastAeState);
                    o.put("epochOffsetMs", epochOffsetMs());
                    o.put("points", points.length / 2);
                }
                return o.toString();
            } catch (Exception e) {
                return "{\"version\":" + VERSION + ",\"error\":\"" + e.getClass().getSimpleName() + "\"}";
            }
        }

        @JavascriptInterface
        public void requestPermission() {
            if (hasCamera()) { permission = "granted"; return; }
            permission = "asking";
            getActivity().runOnUiThread(() -> ActivityCompat.requestPermissions(getActivity(),
                new String[] { Manifest.permission.CAMERA }, PERM_CODE));
        }

        @JavascriptInterface
        public void openSettings() {
            Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", getContext().getPackageName(), null));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }

        /** options: {"fps":60} */
        @JavascriptInterface
        public void start(String options) {
            try {
                JSONObject o = new JSONObject(options == null || options.isEmpty() ? "{}" : options);
                fpsWanted = o.optInt("fps", 60);
            } catch (Exception ignored) { fpsWanted = 60; }
            startCamera();
        }

        @JavascriptInterface
        public void stop() { stopCamera(); }

        /** Comma-separated u,v pairs (0..1, display orientation). Returns the point count. */
        @JavascriptInterface
        public int setPoints(String csv) {
            String[] parts = csv == null || csv.isEmpty() ? new String[0] : csv.split(",");
            float[] p = new float[parts.length - (parts.length % 2)];
            for (int i = 0; i < p.length; i++) p[i] = Float.parseFloat(parts[i]);
            synchronized (lock) {
                points = p;
                pointsVersion++;
                queueTimes.clear(); queueData.clear();
            }
            return p.length / 2;
        }

        /**
         * Frames since the last call: "n;t1,t2,...|base64" where n is samples
         * per frame, t are sensor times in ms, and the base64 holds the samples
         * of every frame back to back. "" when there is nothing new.
         */
        @JavascriptInterface
        public String frames() {
            double[][] ts;
            byte[][] data;
            int n;
            synchronized (lock) {
                if (queueData.isEmpty()) return "";
                ts = queueTimes.toArray(new double[0][]);
                data = queueData.toArray(new byte[0][]);
                n = queueN;
                queueTimes.clear(); queueData.clear();
            }
            StringBuilder sb = new StringBuilder(ts.length * 16 + 8);
            sb.append(n).append(';');
            for (int i = 0; i < ts.length; i++) {
                if (i > 0) sb.append(',');
                sb.append(String.format(Locale.ROOT, "%.4f", ts[i][0]));
            }
            byte[] all = new byte[n * data.length];
            for (int i = 0; i < data.length; i++) System.arraycopy(data[i], 0, all, i * n, n);
            sb.append('|').append(Base64.encodeToString(all, Base64.NO_WRAP));
            return sb.toString();
        }

        /** Freezes exposure, focus and white balance at what was metered last. */
        @JavascriptInterface
        public boolean lock() {
            if (camera == null) return false;
            Long e = lastExposureNs;
            Integer iso = lastIso;
            if (manualSensor && (e == null || iso == null)) return false;
            lockedExposureNs = e == null ? 0 : e;
            lockedIso = iso == null ? 0 : iso;
            lockedFocus = lastFocus;
            nudgeAtLock = nudgeThirds;
            locked = true;
            getActivity().runOnUiThread(TrackCameraPlugin.this::applyLock);
            return true;
        }

        @JavascriptInterface
        public void unlock() {
            locked = false;
            getActivity().runOnUiThread(TrackCameraPlugin.this::applyLock);
        }

        /** Brighter (+) or darker (-) in 1/3 stops, on top of the locked exposure. Returns the total. */
        @JavascriptInterface
        public int nudge(int thirds) {
            nudgeThirds = Math.max(-9, Math.min(9, nudgeThirds + thirds));
            getActivity().runOnUiThread(TrackCameraPlugin.this::applyLock);
            return nudgeThirds;
        }

        /** "#pm=..." from a Pacemaker "Open in app" link, once; "" if none. */
        @JavascriptInterface
        public String takeLaunchHash() {
            synchronized (lock) {
                String h = pendingHash;
                pendingHash = null;
                return h == null ? "" : h;
            }
        }

        @JavascriptInterface
        public String fpsRangesText() { return fpsRanges; }
    }
}
