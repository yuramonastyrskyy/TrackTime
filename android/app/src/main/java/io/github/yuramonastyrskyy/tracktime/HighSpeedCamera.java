package io.github.yuramonastyrskyy.tracktime;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraConstrainedHighSpeedCaptureSession;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.SessionConfiguration;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLSurface;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Range;
import android.util.Size;
import android.view.Surface;

import androidx.annotation.NonNull;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.Collections;
import java.util.List;

/**
 * Slow-motion (constrained high-speed) camera at a fixed 120 fps, for
 * TrackCameraPlugin.
 *
 * Android only allows preview-type or encoder surfaces in this mode, so the
 * frames go to one SurfaceTexture (an OpenGL texture) instead of a CPU image
 * reader. Per frame, on this class's own thread: the finish-line sample points
 * are drawn into a tiny off-screen buffer and read back (one pixel each), and
 * the preview is drawn onto the given Surface (at most ~60 times a second).
 * Rider identification reads its gate points and half-size RGB pictures the
 * same way (Source), only while the frame is current.
 *
 * Geometry: SurfaceTexture.getTransformMatrix already turns the picture upright
 * for the phone's natural (portrait) orientation; what is left is the screen
 * rotation. Display coordinates (u,v in 0..1, v down) map to the natural
 * picture with the same formulas as TrackCameraPlugin.buildIndex.
 *
 * Exposure: manual sensor values are not allowed here, so lock() means AE, AWB
 * and AF locks, and the nudge is exposure compensation.
 */
final class HighSpeedCamera {

    /** What the plugin gets per frame. Called on this class's thread. */
    interface Sink {
        float[] points();
        int pointsVersion();
        void frame(long tsNs, byte[] luma, int dispW, int dispH, int rotation, Source src);
        void result(Long exposureNs, Integer iso, Float focus, Integer aeState);
        void failed(String error);
        void started();
    }

    /** Pixels of the current frame; valid only inside Sink.frame. */
    interface Source {
        /** Luma (0..255) at display points u,v pairs. */
        float[] luma(float[] uv);
        /** Half-size RGB in display orientation; size gets [w, h]. */
        byte[] rgbHalf(int[] size);
    }

    static final class Choice {
        String id;
        Size size;
        Range<Integer> range;
        int sensorOrientation;
        int timestampSource;
        @Override public String toString() { return range.getUpper() + " fps at " + size.getWidth() + "x" + size.getHeight(); }
    }

    /** The first back camera with a fixed [fps, fps] slow-motion mode, preferring 1280x720. */
    static Choice choose(CameraManager cm, int fps) throws CameraAccessException {
        for (String id : cm.getCameraIdList()) {
            CameraCharacteristics cc = cm.getCameraCharacteristics(id);
            Integer facing = cc.get(CameraCharacteristics.LENS_FACING);
            if (facing == null || facing != CameraCharacteristics.LENS_FACING_BACK) continue;
            int[] caps = cc.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
            boolean hs = false;
            if (caps != null) for (int c : caps) if (c == CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_CONSTRAINED_HIGH_SPEED_VIDEO) hs = true;
            StreamConfigurationMap m = cc.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (!hs || m == null) continue;
            Size best = null;
            Range<Integer> bestRange = null;
            for (Size s : m.getHighSpeedVideoSizes()) {
                for (Range<Integer> r : m.getHighSpeedVideoFpsRangesFor(s)) {
                    if (r.getLower() != fps || r.getUpper() != fps) continue;
                    if (best == null || score(s) < score(best)) { best = s; bestRange = r; }
                }
            }
            if (best == null) continue;
            Choice c = new Choice();
            c.id = id;
            c.size = best;
            c.range = bestRange;
            Integer so = cc.get(CameraCharacteristics.SENSOR_ORIENTATION);
            c.sensorOrientation = so == null ? 90 : so;
            Integer ts = cc.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE);
            c.timestampSource = ts == null ? CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_UNKNOWN : ts;
            return c;
        }
        return null;
    }

    /** Lower is better: 1280x720 first, then the nearest size. */
    private static long score(Size s) {
        return Math.abs((long) s.getWidth() * s.getHeight() - 1280L * 720L);
    }

    private final Context context;
    private final Choice choice;
    private final Sink sink;
    private HandlerThread thread;
    private Handler handler;

    // Camera (thread).
    private CameraDevice device;
    private CameraConstrainedHighSpeedCaptureSession session;
    private boolean paused = false;
    private boolean closed = false;

    // Controls (any thread; applied on the thread).
    private volatile boolean locked = false;
    private volatile int compensation = 0;

    // Screen.
    private volatile Surface previewSurface;
    private volatile int viewW = 0, viewH = 0;
    private volatile int displayDeg = 0;
    private EGLSurface windowSurface = EGL14.EGL_NO_SURFACE;
    private Surface windowFor = null;
    private long lastDrawMs = 0;

    // GL (thread).
    private EGLDisplay eglDisplay = EGL14.EGL_NO_DISPLAY;
    private EGLContext eglContext = EGL14.EGL_NO_CONTEXT;
    private EGLConfig eglConfig;
    private EGLSurface pbuffer = EGL14.EGL_NO_SURFACE;
    private int program, aPos, aSt, uM, uTex;
    private int oesTex;
    private SurfaceTexture texture;
    private Surface cameraSurface;
    private final float[] matrix = new float[16];
    private final int[] fbo = new int[1], fboTex = new int[1];
    private int fboW = 0, fboH = 0;
    private ByteBuffer readBuf = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder());

    // Sample point geometry, rebuilt when the points or the rotation change.
    private int geomVersion = -1, geomRot = -1, geomN = 0, geomW = 1, geomH = 1;
    private FloatBuffer geomPos, geomSt;

    HighSpeedCamera(Context context, Choice choice, Sink sink) {
        this.context = context;
        this.choice = choice;
        this.sink = sink;
    }

    // ---------- public (any thread) ----------

    void start() {
        thread = new HandlerThread("tt-slowmo");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(() -> {
            try {
                initGl();
                open();
            } catch (Throwable e) {
                sink.failed("slow-motion: " + e);
            }
        });
    }

    void stop() {
        Handler h = handler;
        if (h == null) return;
        h.post(() -> {
            closed = true;
            closeCamera();
            releaseGl();
            thread.quitSafely();
        });
        handler = null;
    }

    /** App to the background: the camera has to be given back. */
    void pause() {
        Handler h = handler;
        if (h != null) h.post(() -> { paused = true; closeCamera(); });
    }

    void resume() {
        Handler h = handler;
        if (h != null) h.post(() -> {
            if (!paused || closed) return;
            paused = false;
            try { open(); } catch (Throwable e) { sink.failed("slow-motion: " + e); }
        });
    }

    void setPreview(Surface s, int w, int h) { previewSurface = s; viewW = w; viewH = h; }

    void setDisplayRotation(int degrees) { displayDeg = degrees; }

    void setControls(boolean lock, int compensationSteps) {
        boolean changedLock = lock != locked;
        locked = lock;
        compensation = compensationSteps;
        Handler h = handler;
        if (h != null) h.post(() -> applyControls(changedLock));
    }

    // ---------- camera ----------

    @SuppressLint("MissingPermission") // the plugin checks the permission first
    private void open() throws CameraAccessException {
        CameraManager cm = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
        cm.openCamera(choice.id, new CameraDevice.StateCallback() {
            @Override public void onOpened(@NonNull CameraDevice d) {
                if (closed || paused) { d.close(); return; }
                device = d;
                try { createSession(); } catch (Throwable e) { sink.failed("slow-motion session: " + e); }
            }
            @Override public void onDisconnected(@NonNull CameraDevice d) {
                d.close();
                if (device == d) { device = null; session = null; }
            }
            @Override public void onError(@NonNull CameraDevice d, int err) {
                d.close();
                if (device == d) { device = null; session = null; }
                sink.failed("slow-motion camera error " + err);
            }
        }, handler);
    }

    @SuppressWarnings("deprecation")
    private void createSession() throws CameraAccessException {
        CameraCaptureSession.StateCallback cb = new CameraCaptureSession.StateCallback() {
            @Override public void onConfigured(@NonNull CameraCaptureSession s) {
                if (device == null) { s.close(); return; }
                session = (CameraConstrainedHighSpeedCaptureSession) s;
                applyControls(false);
                sink.started();
            }
            @Override public void onConfigureFailed(@NonNull CameraCaptureSession s) {
                sink.failed("slow-motion: the camera refused " + choice);
            }
        };
        List<Surface> outs = Collections.singletonList(cameraSurface);
        if (Build.VERSION.SDK_INT >= 28) {
            SessionConfiguration sc = new SessionConfiguration(SessionConfiguration.SESSION_HIGH_SPEED,
                Collections.singletonList(new OutputConfiguration(cameraSurface)),
                handler::post, cb);
            device.createCaptureSession(sc);
        } else {
            device.createConstrainedHighSpeedCaptureSession(outs, cb, handler);
        }
    }

    private void applyControls(boolean lockChanged) {
        if (session == null || device == null) return;
        try {
            if (lockChanged) {
                // Focus: lock where it is now, or let it run again.
                CaptureRequest.Builder t = request();
                t.set(CaptureRequest.CONTROL_AF_TRIGGER, locked ? CameraMetadata.CONTROL_AF_TRIGGER_START : CameraMetadata.CONTROL_AF_TRIGGER_CANCEL);
                session.captureBurst(session.createHighSpeedRequestList(t.build()), null, handler);
            }
            session.setRepeatingBurst(session.createHighSpeedRequestList(request().build()), results, handler);
        } catch (Throwable e) {
            sink.failed("slow-motion controls: " + e);
        }
    }

    private CaptureRequest.Builder request() throws CameraAccessException {
        CaptureRequest.Builder b = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
        b.addTarget(cameraSurface);
        b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, choice.range);
        b.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
        b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON);
        b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
        b.set(CaptureRequest.CONTROL_AE_LOCK, locked);
        b.set(CaptureRequest.CONTROL_AWB_LOCK, locked);
        if (compensation != 0) b.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, compensation);
        return b;
    }

    private final CameraCaptureSession.CaptureCallback results = new CameraCaptureSession.CaptureCallback() {
        @Override
        public void onCaptureCompleted(@NonNull CameraCaptureSession s, @NonNull CaptureRequest r, @NonNull TotalCaptureResult res) {
            sink.result(res.get(CaptureResult.SENSOR_EXPOSURE_TIME), res.get(CaptureResult.SENSOR_SENSITIVITY),
                res.get(CaptureResult.LENS_FOCUS_DISTANCE), res.get(CaptureResult.CONTROL_AE_STATE));
        }
    };

    private void closeCamera() {
        try { if (session != null) session.close(); } catch (Throwable ignored) { }
        try { if (device != null) device.close(); } catch (Throwable ignored) { }
        session = null;
        device = null;
    }

    // ---------- GL ----------

    private static final String VS =
        "attribute vec2 aPos; attribute vec2 aSt; uniform mat4 uM; varying vec2 vT;\n"
        + "void main() { gl_Position = vec4(aPos, 0.0, 1.0); gl_PointSize = 1.0; vT = (uM * vec4(aSt, 0.0, 1.0)).xy; }\n";
    private static final String FS =
        "#extension GL_OES_EGL_image_external : require\n"
        + "precision mediump float; uniform samplerExternalOES uTex; varying vec2 vT;\n"
        + "void main() { gl_FragColor = texture2D(uTex, vT); }\n";

    private void initGl() {
        eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        int[] v = new int[2];
        if (!EGL14.eglInitialize(eglDisplay, v, 0, v, 1)) throw new RuntimeException("eglInitialize");
        int[] attrs = {
            EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT | EGL14.EGL_PBUFFER_BIT,
            EGL14.EGL_NONE };
        EGLConfig[] configs = new EGLConfig[1];
        int[] n = new int[1];
        if (!EGL14.eglChooseConfig(eglDisplay, attrs, 0, configs, 0, 1, n, 0) || n[0] == 0) throw new RuntimeException("eglChooseConfig");
        eglConfig = configs[0];
        eglContext = EGL14.eglCreateContext(eglDisplay, eglConfig, EGL14.EGL_NO_CONTEXT,
            new int[] { EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE }, 0);
        if (eglContext == EGL14.EGL_NO_CONTEXT) throw new RuntimeException("eglCreateContext");
        pbuffer = EGL14.eglCreatePbufferSurface(eglDisplay, eglConfig, new int[] { EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE }, 0);
        EGL14.eglMakeCurrent(eglDisplay, pbuffer, pbuffer, eglContext);

        program = link(VS, FS);
        aPos = GLES20.glGetAttribLocation(program, "aPos");
        aSt = GLES20.glGetAttribLocation(program, "aSt");
        uM = GLES20.glGetUniformLocation(program, "uM");
        uTex = GLES20.glGetUniformLocation(program, "uTex");

        int[] t = new int[1];
        GLES20.glGenTextures(1, t, 0);
        oesTex = t[0];
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);

        texture = new SurfaceTexture(oesTex);
        texture.setDefaultBufferSize(choice.size.getWidth(), choice.size.getHeight());
        texture.setOnFrameAvailableListener(st -> onFrame(), handler);
        cameraSurface = new Surface(texture);
    }

    private void releaseGl() {
        try {
            if (windowSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(eglDisplay, windowSurface);
            windowSurface = EGL14.EGL_NO_SURFACE;
            if (cameraSurface != null) cameraSurface.release();
            if (texture != null) texture.release();
            if (eglDisplay != EGL14.EGL_NO_DISPLAY) {
                EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
                if (pbuffer != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(eglDisplay, pbuffer);
                if (eglContext != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(eglDisplay, eglContext);
                EGL14.eglTerminate(eglDisplay);
            }
        } catch (Throwable ignored) { }
        eglDisplay = EGL14.EGL_NO_DISPLAY;
    }

    private static int compile(int type, String src) {
        int s = GLES20.glCreateShader(type);
        GLES20.glShaderSource(s, src);
        GLES20.glCompileShader(s);
        int[] ok = new int[1];
        GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0);
        if (ok[0] == 0) throw new RuntimeException("shader: " + GLES20.glGetShaderInfoLog(s));
        return s;
    }

    private static int link(String vs, String fs) {
        int p = GLES20.glCreateProgram();
        GLES20.glAttachShader(p, compile(GLES20.GL_VERTEX_SHADER, vs));
        GLES20.glAttachShader(p, compile(GLES20.GL_FRAGMENT_SHADER, fs));
        GLES20.glLinkProgram(p);
        int[] ok = new int[1];
        GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0);
        if (ok[0] == 0) throw new RuntimeException("link: " + GLES20.glGetProgramInfoLog(p));
        return p;
    }

    /** The window surface for the preview, made current when there is one; else the pbuffer. */
    private boolean makeCurrent() {
        Surface s = previewSurface;
        if (s != windowFor) {
            if (windowSurface != EGL14.EGL_NO_SURFACE) {
                EGL14.eglMakeCurrent(eglDisplay, pbuffer, pbuffer, eglContext);
                EGL14.eglDestroySurface(eglDisplay, windowSurface);
                windowSurface = EGL14.EGL_NO_SURFACE;
            }
            windowFor = s;
            if (s != null && s.isValid()) {
                try {
                    windowSurface = EGL14.eglCreateWindowSurface(eglDisplay, eglConfig, s, new int[] { EGL14.EGL_NONE }, 0);
                } catch (Throwable e) {
                    windowSurface = EGL14.EGL_NO_SURFACE;
                }
                if (windowSurface != EGL14.EGL_NO_SURFACE) {
                    EGL14.eglMakeCurrent(eglDisplay, windowSurface, windowSurface, eglContext);
                    EGL14.eglSwapInterval(eglDisplay, 0); // never wait for the screen
                    return true;
                }
            }
            EGL14.eglMakeCurrent(eglDisplay, pbuffer, pbuffer, eglContext);
            return false;
        }
        return windowSurface != EGL14.EGL_NO_SURFACE;
    }

    // ---------- frames ----------

    private int rotation() { return (360 - displayDeg) % 360; } // what is left after the texture matrix

    private int naturalW() { boolean t = choice.sensorOrientation % 180 != 0; return t ? choice.size.getHeight() : choice.size.getWidth(); }
    private int naturalH() { boolean t = choice.sensorOrientation % 180 != 0; return t ? choice.size.getWidth() : choice.size.getHeight(); }

    /** Display point (v down) to texture coordinates before the matrix (t up). */
    private static void st(float u, float v, int rot, float[] out, int o) {
        float nx, ny;
        switch (rot) {
            case 90: nx = v; ny = 1 - u; break;
            case 180: nx = 1 - u; ny = 1 - v; break;
            case 270: nx = 1 - v; ny = u; break;
            default: nx = u; ny = v;
        }
        out[o] = nx;
        out[o + 1] = 1 - ny;
    }

    private void onFrame() {
        if (closed || eglDisplay == EGL14.EGL_NO_DISPLAY) return;
        try {
            boolean onScreen = makeCurrent();
            texture.updateTexImage();
            texture.getTransformMatrix(matrix);
            long ts = texture.getTimestamp();
            int rot = rotation();
            int dw = rot % 180 != 0 ? naturalH() : naturalW();
            int dh = rot % 180 != 0 ? naturalW() : naturalH();

            byte[] luma = samplePoints(rot);
            sink.frame(ts, luma, dw, dh, rot, new Source() {
                @Override public float[] luma(float[] uv) { return readPoints(uv, rot); }
                @Override public byte[] rgbHalf(int[] size) { return readRgbHalf(rot, dw, dh, size); }
            });

            long now = SystemClock.elapsedRealtime();
            if (onScreen && now - lastDrawMs >= 15) {
                lastDrawMs = now;
                drawPreview(rot, dw, dh);
                EGL14.eglSwapBuffers(eglDisplay, windowSurface);
            }
        } catch (Throwable e) {
            sink.failed("slow-motion frame: " + e);
        }
    }

    private void useProgram() {
        GLES20.glUseProgram(program);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex);
        GLES20.glUniform1i(uTex, 0);
        GLES20.glUniformMatrix4fv(uM, 1, false, matrix, 0);
    }

    private void bindFbo(int w, int h) {
        if (fbo[0] == 0 || fboW != w || fboH != h) {
            if (fbo[0] != 0) {
                GLES20.glDeleteFramebuffers(1, fbo, 0);
                GLES20.glDeleteTextures(1, fboTex, 0);
            }
            GLES20.glGenTextures(1, fboTex, 0);
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fboTex[0]);
            GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, w, h, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null);
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_NEAREST);
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_NEAREST);
            GLES20.glGenFramebuffers(1, fbo, 0);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo[0]);
            GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, fboTex[0], 0);
            fboW = w; fboH = h;
        }
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo[0]);
        GLES20.glViewport(0, 0, w, h);
    }

    private ByteBuffer read(int w, int h) {
        int need = w * h * 4;
        if (readBuf.capacity() < need) readBuf = ByteBuffer.allocateDirect(need).order(ByteOrder.nativeOrder());
        readBuf.clear();
        GLES20.glReadPixels(0, 0, w, h, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, readBuf);
        return readBuf;
    }

    private static FloatBuffer floats(float[] a) {
        FloatBuffer b = ByteBuffer.allocateDirect(a.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        b.put(a).position(0);
        return b;
    }

    private void draw(FloatBuffer pos, FloatBuffer st, int mode, int count) {
        useProgram();
        GLES20.glEnableVertexAttribArray(aPos);
        GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 0, pos);
        GLES20.glEnableVertexAttribArray(aSt);
        GLES20.glVertexAttribPointer(aSt, 2, GLES20.GL_FLOAT, false, 0, st);
        GLES20.glDrawArrays(mode, 0, count);
    }

    /** Points laid out in a w x h grid, one pixel each. */
    private static int gridW(int n) { return Math.max(1, Math.min(n, 1024)); }

    private static float[] gridPos(int n, int w, int h) {
        float[] p = new float[n * 2];
        for (int i = 0; i < n; i++) {
            p[i * 2] = (2f * (i % w) + 1f) / w - 1f;
            p[i * 2 + 1] = (2f * (i / w) + 1f) / h - 1f;
        }
        return p;
    }

    private static byte[] lumaOf(ByteBuffer b, int n) {
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) {
            int r = b.get(i * 4) & 255, g = b.get(i * 4 + 1) & 255, bl = b.get(i * 4 + 2) & 255;
            out[i] = (byte) ((77 * r + 150 * g + 29 * bl) >> 8);
        }
        return out;
    }

    private byte[] samplePoints(int rot) {
        int ver = sink.pointsVersion();
        if (ver != geomVersion || rot != geomRot) {
            float[] pts = sink.points();
            int n = pts.length / 2;
            geomN = n; geomW = gridW(n); geomH = Math.max(1, (n + geomW - 1) / geomW);
            float[] s = new float[n * 2];
            for (int i = 0; i < n; i++) st(pts[i * 2], pts[i * 2 + 1], rot, s, i * 2);
            geomPos = floats(gridPos(n, geomW, geomH));
            geomSt = floats(s);
            geomVersion = ver; geomRot = rot;
        }
        if (geomN == 0) return new byte[0];
        bindFbo(geomW, geomH);
        draw(geomPos, geomSt, GLES20.GL_POINTS, geomN);
        return lumaOf(read(geomW, geomH), geomN);
    }

    private float[] readPoints(float[] uv, int rot) {
        int n = uv.length / 2;
        int w = gridW(n), h = Math.max(1, (n + w - 1) / w);
        float[] s = new float[n * 2];
        for (int i = 0; i < n; i++) st(uv[i * 2], uv[i * 2 + 1], rot, s, i * 2);
        bindFbo(w, h);
        draw(floats(gridPos(n, w, h)), floats(s), GLES20.GL_POINTS, n);
        byte[] l = lumaOf(read(w, h), n);
        float[] out = new float[n];
        for (int i = 0; i < n; i++) out[i] = l[i] & 255;
        return out;
    }

    /** A strip of 4 vertices covering the display picture: top-left, bottom-left, top-right, bottom-right. */
    private static float[] quadSt(int rot) {
        float[] s = new float[8];
        st(0, 0, rot, s, 0);
        st(0, 1, rot, s, 2);
        st(1, 0, rot, s, 4);
        st(1, 1, rot, s, 6);
        return s;
    }

    private byte[] readRgbHalf(int rot, int dw, int dh, int[] size) {
        int w = dw / 2, h = dh / 2;
        bindFbo(w, h);
        draw(floats(new float[] { -1, 1, -1, -1, 1, 1, 1, -1 }), floats(quadSt(rot)), GLES20.GL_TRIANGLE_STRIP, 4);
        ByteBuffer b = read(w, h);
        byte[] out = new byte[w * h * 3];
        for (int y = 0; y < h; y++) {
            int src = (h - 1 - y) * w * 4; // GL rows go bottom-up
            int dst = y * w * 3;
            for (int x = 0; x < w; x++) {
                out[dst++] = b.get(src);
                out[dst++] = b.get(src + 1);
                out[dst++] = b.get(src + 2);
                src += 4;
            }
        }
        size[0] = w; size[1] = h;
        return out;
    }

    /** The picture, fitted and centred in the view (as PreviewView FIT_CENTER). */
    private void drawPreview(int rot, int dw, int dh) {
        int vw = viewW, vh = viewH;
        if (vw <= 0 || vh <= 0) return;
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
        GLES20.glViewport(0, 0, vw, vh);
        GLES20.glClearColor(0, 0, 0, 1);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
        float s = Math.min(vw / (float) dw, vh / (float) dh);
        float rw = dw * s, rh = dh * s, x0 = (vw - rw) / 2, y0 = (vh - rh) / 2;
        float l = 2 * x0 / vw - 1, r = 2 * (x0 + rw) / vw - 1, t = 1 - 2 * y0 / vh, b = 1 - 2 * (y0 + rh) / vh;
        draw(floats(new float[] { l, t, l, b, r, t, r, b }), floats(quadSt(rot)), GLES20.GL_TRIANGLE_STRIP, 4);
    }
}
