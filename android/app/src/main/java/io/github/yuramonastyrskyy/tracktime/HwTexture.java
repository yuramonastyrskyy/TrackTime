package io.github.yuramonastyrskyy.tracktime;

import android.hardware.HardwareBuffer;

/**
 * Puts a camera frame (HardwareBuffer from an ImageReader) on a GL external
 * texture without copying it (native: src/main/cpp/hwtexture.c). Lets the
 * slow-motion camera queue frames in an ImageReader instead of a SurfaceTexture,
 * which keeps only the newest frame and so loses some of a burst.
 */
final class HwTexture {
    static final boolean available = load();

    private static boolean load() {
        try {
            System.loadLibrary("ttnative");
            return init();
        } catch (Throwable e) {
            return false;
        }
    }

    private static native boolean init();
    /** GL context current. Returns the EGLImage handle, 0 on failure. */
    static native long bind(HardwareBuffer buffer, int texture);
    static native void release(long image);

    private HwTexture() { }
}
