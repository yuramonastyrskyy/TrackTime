package io.github.yuramonastyrskyy.tracktime;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Range;
import android.util.Rational;
import android.util.Size;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
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

import org.json.JSONArray;
import org.json.JSONObject;

import android.graphics.Bitmap;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.ArrayList;
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

    static final int VERSION = 5; // 2: rider identification (riders*); 3: info().highSpeed; 4: rider colour features v2 (fv); 5: start({slowmo}), info().mode
    static final int PERM_CODE = 7101;
    private static final int MAX_QUEUE = 360; // 3 s at 120 fps if the page stops pulling

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
    // Slow-motion test mode (HighSpeedCamera): asked for by the page, used when the phone has it.
    private boolean slowmoWanted = false;
    private HighSpeedCamera hs = null;
    private SurfaceView hsView = null;
    private String slowmoNote = "";
    private Range<Integer> fpsRange = null;
    private String fpsRanges = "";
    /** Slow-motion (constrained high-speed) modes, e.g. "120 240 at 1280x720"; empty if none. */
    private String highSpeed = "";
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
            slowmoNote = "";
            if (slowmoWanted && startSlowmo()) return;
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
        highSpeed = highSpeedText(c2);
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

    /**
     * The camera's slow-motion modes (120/240 fps). They need a special capture
     * session that this plugin does not use yet; listed so we know what the
     * phone could do.
     */
    private static String highSpeedText(Camera2CameraInfo c2) {
        try {
            StreamConfigurationMap m = c2.getCameraCharacteristic(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (m == null) return "";
            java.util.TreeSet<Integer> rates = new java.util.TreeSet<>();
            for (Range<Integer> r : m.getHighSpeedVideoFpsRanges()) rates.add(r.getUpper());
            if (rates.isEmpty()) return "";
            StringBuilder sb = new StringBuilder();
            for (Integer r : rates) sb.append(sb.length() > 0 ? " " : "").append(r);
            sb.append(" fps at");
            for (Size z : m.getHighSpeedVideoSizes()) sb.append(' ').append(z.getWidth()).append('x').append(z.getHeight());
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
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
        if (hs != null) hs.setDisplayRotation(displayDegrees());
        if (analysis != null && previewView.getDisplay() != null) {
            analysis.setTargetRotation(previewView.getDisplay().getRotation());
        }
    }

    private void stopCamera() {
        getActivity().runOnUiThread(() -> {
            if (provider != null) provider.unbindAll();
            camera = null;
            stopSlowmo();
            running = false;
            locked = false;
            if (previewView != null) previewView.setVisibility(View.GONE);
            getBridge().getWebView().setBackgroundColor(Color.parseColor("#0a1622"));
            getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    // ---------- slow-motion (test) ----------

    /** UI thread. Starts the 120 fps slow-motion camera; false (with a note) if this phone cannot. */
    private boolean startSlowmo() {
        HighSpeedCamera.Choice c;
        CameraManager cm = (CameraManager) getContext().getSystemService(android.content.Context.CAMERA_SERVICE);
        try {
            c = HighSpeedCamera.choose(cm, 120);
        } catch (Exception e) {
            slowmoNote = "slow-motion: " + e;
            return false;
        }
        if (c == null) { slowmoNote = "no 120 fps slow-motion mode on the back camera"; return false; }
        try {
            CameraCharacteristics cc = cm.getCameraCharacteristics(c.id);
            evRange = cc.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
            evStep = cc.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
        } catch (Exception ignored) { }
        fpsRange = c.range;
        timestampSource = c.timestampSource;
        manualSensor = false;
        slowmoNote = "slow-motion " + c;

        WebView wv = getBridge().getWebView();
        if (previewView != null) previewView.setVisibility(View.GONE);
        if (hsView == null) {
            hsView = new SurfaceView(getContext());
            ViewGroup parent = (ViewGroup) wv.getParent();
            parent.addView(hsView, 0, new ViewGroup.LayoutParams(wv.getWidth(), wv.getHeight()));
            wv.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> placeSlowmoView());
            hsView.getHolder().addCallback(new SurfaceHolder.Callback() {
                @Override public void surfaceCreated(@NonNull SurfaceHolder h) { }
                @Override public void surfaceChanged(@NonNull SurfaceHolder h, int f, int w, int ht) { if (hs != null) hs.setPreview(h.getSurface(), w, ht); }
                @Override public void surfaceDestroyed(@NonNull SurfaceHolder h) { if (hs != null) hs.setPreview(null, 0, 0); }
            });
        }
        placeSlowmoView();
        hsView.setVisibility(View.VISIBLE);
        wv.setBackgroundColor(Color.TRANSPARENT);

        synchronized (lock) {
            frameCount = 0; dropped = 0; queueOverflow = 0; lastTsNs = 0;
            queueTimes.clear(); queueData.clear();
            fpsWindowStart = 0; fpsWindowFrames = 0; fpsNow = 0;
        }
        hs = new HighSpeedCamera(getContext(), c, slowmoSink);
        hs.setDisplayRotation(displayDegrees());
        SurfaceHolder holder = hsView.getHolder();
        if (holder.getSurface() != null && holder.getSurface().isValid()) {
            hs.setPreview(holder.getSurface(), hsView.getWidth(), hsView.getHeight());
        }
        locked = false;
        hs.start();
        applyLock();
        running = true;
        getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        return true;
    }

    /** UI thread. */
    private void stopSlowmo() {
        if (hs != null) { hs.stop(); hs = null; }
        if (hsView != null) hsView.setVisibility(View.GONE);
    }

    private void placeSlowmoView() {
        if (hsView == null) return;
        WebView wv = getBridge().getWebView();
        ViewGroup.LayoutParams lp = hsView.getLayoutParams();
        if (lp.width != wv.getWidth() || lp.height != wv.getHeight()) {
            lp.width = wv.getWidth();
            lp.height = wv.getHeight();
            hsView.setLayoutParams(lp);
        }
        hsView.setX(wv.getX());
        hsView.setY(wv.getY());
        if (hs != null) hs.setDisplayRotation(displayDegrees());
    }

    @SuppressWarnings("deprecation")
    private int displayDegrees() {
        int r = getActivity().getWindowManager().getDefaultDisplay().getRotation();
        switch (r) {
            case Surface.ROTATION_90: return 90;
            case Surface.ROTATION_180: return 180;
            case Surface.ROTATION_270: return 270;
            default: return 0;
        }
    }

    private final HighSpeedCamera.Sink slowmoSink = new HighSpeedCamera.Sink() {
        @Override public float[] points() { synchronized (lock) { return points; } }
        @Override public int pointsVersion() { synchronized (lock) { return pointsVersion; } }
        @Override public void rider(long tsNs, int dispW, int dispH, int rot, HighSpeedCamera.Source src) {
            synchronized (lock) { width = dispW; height = dispH; rotation = rot; }
            if (ridersOn) riderFrame(src, tsNs);
        }
        @Override public void frame(long tsNs, byte[] luma) { deliver(tsNs, luma); }
        @Override public void result(Long e, Integer iso, Float fd, Integer ae) {
            if (e != null) lastExposureNs = e;
            if (iso != null) lastIso = iso;
            if (fd != null) lastFocus = fd;
            lastAeState = ae;
        }
        @Override public void failed(String e) { error = e; }
        @Override public void started() { error = null; }
    };

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (hs != null) hs.pause();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (hs != null) hs.resume();
    }

    // ---------- exposure + focus ----------

    private void applyLock() {
        if (hs != null) { hs.setControls(locked, compensationSteps(nudgeThirds)); return; }
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
            if (ridersOn) riderFrame(imageSource(image, rot), ts);
            deliver(ts, out);
        } catch (Exception e) {
            error = "frame: " + e;
        } finally {
            image.close();
        }
    }

    /** Rider identification's view of a CPU (YUV) frame. */
    private HighSpeedCamera.Source imageSource(ImageProxy image, int rot) {
        return new HighSpeedCamera.Source() {
            @Override public float[] luma(float[] uv) {
                ImageProxy.PlaneProxy yp = image.getPlanes()[0];
                ByteBuffer yb = yp.getBuffer();
                int iw = image.getWidth(), ih = image.getHeight();
                float[] out = new float[uv.length / 2];
                for (int i = 0; i < out.length; i++) {
                    int[] s = sensorPixel(uv[i * 2], uv[i * 2 + 1], iw, ih, rot);
                    int p = s[1] * yp.getRowStride() + s[0] * yp.getPixelStride();
                    out[i] = p < yb.limit() ? (yb.get(p) & 255) : 0;
                }
                return out;
            }
            @Override public byte[] rgbHalf(int[] size) { return toRgbHalf(image, rot, size); }
        };
    }

    /** A frame's samples into the page's queue, with the rate and gap counts. */
    private void deliver(long ts, byte[] out) {
        synchronized (lock) {
            if (lastTsNs != 0 && fpsRange != null) {
                double frameNs = 1e9 / fpsRange.getUpper();
                // A gap over 1 s is a pause (app in the background), not lost frames.
                if (ts - lastTsNs < 1_000_000_000L) {
                    long missing = Math.round((ts - lastTsNs) / frameNs) - 1;
                    if (missing > 0) dropped += missing;
                }
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
        riderExecutor.shutdown();
    }

    // ---------- rider identification ----------
    // While timing, frames with something on the finish line are turned into
    // small RGB pictures (half size, display orientation). The last second of
    // them is kept; when the page reports a lap (ridersLap), those from just
    // before it and everything for the next 8 s go to RiderEngine on a worker
    // thread, which describes the riders near the line. The page pulls the
    // descriptions (ridersPull) and decides who is who (js/riders.js).

    private static final int RIDER_GATE_POINTS = 48;
    private static final int RIDER_GATE_DIFF = 30;      // luma change that counts
    private static final float RIDER_GATE_SHARE = 0.04f;
    private static final double RIDER_BEFORE_MS = 500, RIDER_AFTER_MS = 8000, RIDER_RECENT_MS = 1000;
    private static final int RIDER_MAX_WORK = 150;      // ~100 MB at most; older frames are dropped

    private static final class RiderFrame {
        final byte[] rgb; final int w, h; final double t;
        RiderFrame(byte[] rgb, int w, int h, double t) { this.rgb = rgb; this.w = w; this.h = h; this.t = t; }
    }

    private final ExecutorService riderExecutor = Executors.newSingleThreadExecutor();
    private final Object riderLock = new Object();
    private volatile boolean ridersOn = false;
    private volatile RiderEngine riderEngine = null;
    private volatile String riderError = null;
    private float[] riderLine = { 0.5f, 0.15f, 0.5f, 0.8f };
    private int riderEvery = 2;
    private long riderFrameNo = 0;
    private float[] gateBg = null;
    private boolean riderBgWanted = false;
    private double busySince = -1;
    private long quietFrames = 0;
    private final ArrayDeque<RiderFrame> riderRecent = new ArrayDeque<>();
    private final ArrayDeque<RiderFrame> riderWork = new ArrayDeque<>();
    private double riderKeepUntil = -1;
    private final ArrayList<String> riderResults = new ArrayList<>();
    private long riderBusyFrames = 0, riderDone = 0, riderDropped = 0, riderMs = 0;
    private boolean riderWorking = false;
    private byte[] yCopy = new byte[0], uCopy = new byte[0], vCopy = new byte[0];

    /** Frame thread (analysis or slow-motion): every riderEvery-th frame while rider identification is on. */
    private void riderFrame(HighSpeedCamera.Source src, long tsNs) {
        if (++riderFrameNo % riderEvery != 0) return;
        try {
            double t = tsNs / 1e6;
            float[] l;
            synchronized (riderLock) { l = riderLine; }
            float[] uv = new float[RIDER_GATE_POINTS * 2];
            for (int i = 0; i < RIDER_GATE_POINTS; i++) {
                float f = (i + 0.5f) / RIDER_GATE_POINTS;
                uv[i * 2] = l[0] + (l[2] - l[0]) * f;
                uv[i * 2 + 1] = l[1] + (l[3] - l[1]) * f;
            }
            float[] luma = src.luma(uv);
            boolean wantBg;
            synchronized (riderLock) { wantBg = riderBgWanted || gateBg == null; }
            if (wantBg) {
                // The empty track (Start timing): background for the gate and the colour mask.
                int[] size = new int[2];
                byte[] rgb = src.rgbHalf(size);
                synchronized (riderLock) { gateBg = luma; riderBgWanted = false; busySince = -1; }
                RiderEngine e = riderEngine;
                if (e != null) riderExecutor.execute(() -> e.setBackground(rgb, size[0], size[1]));
                return;
            }
            int hit = 0;
            for (int i = 0; i < RIDER_GATE_POINTS; i++) if (Math.abs(luma[i] - gateBg[i]) > RIDER_GATE_DIFF) hit++;
            boolean busy = hit >= RIDER_GATE_SHARE * RIDER_GATE_POINTS;
            if (!busy) {
                for (int i = 0; i < RIDER_GATE_POINTS; i++) gateBg[i] += 0.05f * (luma[i] - gateBg[i]);
                busySince = -1;
                // Now and then the empty track refreshes the colour background (light drifts).
                if (++quietFrames % 120 == 0) {
                    int[] size = new int[2];
                    byte[] rgb = src.rgbHalf(size);
                    RiderEngine e = riderEngine;
                    if (e != null) riderExecutor.execute(() -> e.learnBackground(rgb, size[0], size[1], 0.2f));
                }
                return;
            }
            if (busySince < 0) busySince = t;
            else if (t - busySince > 4000) { // "covered" for 4 s: the picture changed; relearn
                synchronized (riderLock) { riderBgWanted = true; }
                return;
            }
            riderBusyFrames++;
            int[] size = new int[2];
            RiderFrame f = new RiderFrame(src.rgbHalf(size), size[0], size[1], t);
            synchronized (riderLock) {
                if (t <= riderKeepUntil) queueRiderWork(f);
                else {
                    riderRecent.add(f);
                    while (!riderRecent.isEmpty() && riderRecent.peekFirst().t < t - RIDER_RECENT_MS) riderRecent.pollFirst();
                }
            }
        } catch (Exception e) {
            riderError = "frame: " + e;
        }
    }

    /** Display-normalised point to a sensor pixel (as in buildIndex). */
    private static int[] sensorPixel(float u, float v, int iw, int ih, int rot) {
        float sx, sy;
        switch (rot) {
            case 90: sx = v; sy = 1 - u; break;
            case 180: sx = 1 - u; sy = 1 - v; break;
            case 270: sx = 1 - v; sy = u; break;
            default: sx = u; sy = v;
        }
        return new int[] { Math.max(0, Math.min(iw - 1, (int) (sx * iw))), Math.max(0, Math.min(ih - 1, (int) (sy * ih))) };
    }

    /** YUV frame to half-size RGB in display orientation (2x2 luma average, full-range BT.601). */
    private byte[] toRgbHalf(ImageProxy image, int rot, int[] size) {
        ImageProxy.PlaneProxy[] pl = image.getPlanes();
        int iw = image.getWidth(), ih = image.getHeight();
        yCopy = copyPlane(pl[0].getBuffer(), yCopy);
        uCopy = copyPlane(pl[1].getBuffer(), uCopy);
        vCopy = copyPlane(pl[2].getBuffer(), vCopy);
        int ys = pl[0].getRowStride(), yps = pl[0].getPixelStride();
        int us = pl[1].getRowStride(), ups = pl[1].getPixelStride(), vs = pl[2].getRowStride(), vps = pl[2].getPixelStride();
        boolean turned = rot == 90 || rot == 270;
        int W = turned ? ih : iw, H = turned ? iw : ih; // display size, full
        int dw = W / 2, dh = H / 2;
        byte[] out = new byte[dw * dh * 3];
        int ylen = yCopy.length, ulen = uCopy.length, vlen = vCopy.length;
        for (int dy = 0; dy < dh; dy++) {
            for (int dx = 0; dx < dw; dx++) {
                int X = dx * 2, Y = dy * 2; // display pixel (top-left of the 2x2)
                int sx, sy;
                switch (rot) {
                    case 90: sx = Y; sy = ih - 2 - X; break;
                    case 180: sx = iw - 2 - X; sy = ih - 2 - Y; break;
                    case 270: sx = iw - 2 - Y; sy = X; break;
                    default: sx = X; sy = Y;
                }
                sx = Math.max(0, Math.min(iw - 2, sx)); sy = Math.max(0, Math.min(ih - 2, sy));
                int p = sy * ys + sx * yps;
                int yv = 0;
                if (p + ys + yps < ylen) yv = ((yCopy[p] & 255) + (yCopy[p + yps] & 255) + (yCopy[p + ys] & 255) + (yCopy[p + ys + yps] & 255)) >> 2;
                int up = (sy >> 1) * us + (sx >> 1) * ups, vp = (sy >> 1) * vs + (sx >> 1) * vps;
                int U = (up < ulen ? uCopy[up] & 255 : 128) - 128, V = (vp < vlen ? vCopy[vp] & 255 : 128) - 128;
                int r = yv + Math.round(1.402f * V), g = yv - Math.round(0.344136f * U + 0.714136f * V), b = yv + Math.round(1.772f * U);
                int o = (dy * dw + dx) * 3;
                out[o] = (byte) (r < 0 ? 0 : (r > 255 ? 255 : r));
                out[o + 1] = (byte) (g < 0 ? 0 : (g > 255 ? 255 : g));
                out[o + 2] = (byte) (b < 0 ? 0 : (b > 255 ? 255 : b));
            }
        }
        size[0] = dw; size[1] = dh;
        return out;
    }

    private static byte[] copyPlane(ByteBuffer b, byte[] into) {
        ByteBuffer d = b.duplicate();
        d.position(0);
        int n = d.remaining();
        if (into.length < n) into = new byte[n];
        d.get(into, 0, n);
        return into;
    }

    /** Under riderLock. */
    private void queueRiderWork(RiderFrame f) {
        riderWork.add(f);
        while (riderWork.size() > RIDER_MAX_WORK) { riderWork.pollFirst(); riderDropped++; }
        if (!riderWorking) {
            riderWorking = true;
            riderExecutor.execute(this::drainRiderWork);
        }
    }

    /** Worker thread: describes the queued frames one by one. */
    private void drainRiderWork() {
        while (true) {
            RiderFrame f;
            synchronized (riderLock) {
                f = riderWork.pollFirst();
                if (f == null) { riderWorking = false; return; }
            }
            RiderEngine e = riderEngine;
            if (e == null) continue;
            long t0 = SystemClock.elapsedRealtime();
            try {
                String r = e.process(f.rgb, f.w, f.h, f.t);
                synchronized (riderLock) {
                    if (r != null) riderResults.add(r);
                    riderDone++;
                    riderMs += SystemClock.elapsedRealtime() - t0;
                    while (riderResults.size() > 400) riderResults.remove(0);
                }
            } catch (Throwable err) {
                riderError = "process: " + err;
            }
        }
    }

    private void loadRiderEngine() {
        if (riderEngine != null) return;
        try {
            byte[] det = readAsset("riders/yolox_tiny.onnx"), reid = readAsset("riders/osnet_x0_25.onnx");
            riderEngine = new RiderEngine(det, reid, 2, TrackCameraPlugin::jpeg);
            riderError = null;
            synchronized (riderLock) { riderBgWanted = true; } // the next frame becomes its background
        } catch (Throwable e) {
            riderError = "load: " + e;
        }
    }

    private byte[] readAsset(String name) throws Exception {
        try (InputStream in = getContext().getAssets().open(name)) {
            ByteArrayOutputStream o = new ByteArrayOutputStream(1 << 20);
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            return o.toByteArray();
        }
    }

    private static byte[] jpeg(byte[] rgb, int w, int h) {
        int[] px = new int[w * h];
        for (int i = 0; i < px.length; i++) px[i] = 0xff000000 | (rgb[i * 3] & 255) << 16 | (rgb[i * 3 + 1] & 255) << 8 | (rgb[i * 3 + 2] & 255);
        Bitmap bm = Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888);
        ByteArrayOutputStream o = new ByteArrayOutputStream(8192);
        bm.compress(Bitmap.CompressFormat.JPEG, 80, o);
        bm.recycle();
        return o.toByteArray();
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
                    o.put("highSpeed", highSpeed);
                    o.put("mode", hs != null ? "slowmo" : "normal");
                    o.put("slowmoNote", slowmoNote);
                    if (hs != null) {
                        o.put("camFps", hs.camFps);
                        o.put("doneFps", hs.doneFps);
                        o.put("workMs", Math.round(hs.workMs * 10) / 10.0);
                        o.put("maxMs", Math.round(hs.maxMs * 10) / 10.0);
                        o.put("frameQueue", hs.usesQueue());
                        o.put("inputNote", hs.inputNote);
                    }
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

        /** options: {"fps":60,"slowmo":false}; a rate the camera has no range for (e.g. 999) takes its fastest range; slowmo asks for 120 fps slow-motion. */
        @JavascriptInterface
        public void start(String options) {
            try {
                JSONObject o = new JSONObject(options == null || options.isEmpty() ? "{}" : options);
                fpsWanted = o.optInt("fps", 60);
                slowmoWanted = o.optBoolean("slowmo", false);
            } catch (Exception ignored) { fpsWanted = 60; slowmoWanted = false; }
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
            if (camera == null && hs == null) return false;
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

        /** options: {"line":[topU,topV,innerU,innerV],"every":2}. Starts rider identification (models load in the background). */
        @JavascriptInterface
        public boolean ridersStart(String options) {
            try {
                JSONObject o = new JSONObject(options == null || options.isEmpty() ? "{}" : options);
                JSONArray a = o.optJSONArray("line");
                float[] line = riderLine;
                if (a != null && a.length() >= 4) line = new float[] { (float) a.getDouble(0), (float) a.getDouble(1), (float) a.getDouble(2), (float) a.getDouble(3) };
                int every = Math.max(1, o.optInt("every", 2));
                synchronized (riderLock) {
                    riderLine = line; riderEvery = every; riderFrameNo = 0;
                    gateBg = null; riderBgWanted = true; busySince = -1; quietFrames = 0;
                    riderRecent.clear(); riderWork.clear(); riderResults.clear(); riderKeepUntil = -1;
                    riderBusyFrames = 0; riderDone = 0; riderDropped = 0; riderMs = 0;
                }
                final float[] l = line;
                riderExecutor.execute(() -> { loadRiderEngine(); RiderEngine e = riderEngine; if (e != null) e.setLine(l); });
                ridersOn = true;
                return true;
            } catch (Exception e) {
                riderError = "start: " + e;
                return false;
            }
        }

        /** A lap crossing at sensor time t (ms): describe the riders from just before it to 8 s after. */
        @JavascriptInterface
        public void ridersLap(double t) {
            synchronized (riderLock) {
                for (RiderFrame f : riderRecent) if (f.t >= t - RIDER_BEFORE_MS) queueRiderWork(f);
                riderRecent.clear();
                riderKeepUntil = Math.max(riderKeepUntil, t + RIDER_AFTER_MS);
            }
        }

        /** Stops taking new frames; queued ones are still described. */
        @JavascriptInterface
        public void ridersStop() { ridersOn = false; }

        /** Descriptions since the last call, as a JSON array (see RiderEngine.process). */
        @JavascriptInterface
        public String ridersPull() {
            synchronized (riderLock) {
                if (riderResults.isEmpty()) return "[]";
                StringBuilder sb = new StringBuilder("[");
                for (int i = 0; i < riderResults.size(); i++) { if (i > 0) sb.append(','); sb.append(riderResults.get(i)); }
                riderResults.clear();
                return sb.append(']').toString();
            }
        }

        @JavascriptInterface
        public String ridersInfo() {
            try {
                JSONObject o = new JSONObject();
                synchronized (riderLock) {
                    o.put("on", ridersOn);
                    o.put("ready", riderEngine != null);
                    o.put("error", riderError == null ? JSONObject.NULL : riderError);
                    o.put("busyFrames", riderBusyFrames);
                    o.put("queued", riderWork.size());
                    o.put("working", riderWorking);
                    o.put("done", riderDone);
                    o.put("dropped", riderDropped);
                    o.put("msPerFrame", riderDone > 0 ? riderMs / riderDone : 0);
                    o.put("keepUntil", riderKeepUntil);
                }
                return o.toString();
            } catch (Exception e) {
                return "{}";
            }
        }
    }
}
