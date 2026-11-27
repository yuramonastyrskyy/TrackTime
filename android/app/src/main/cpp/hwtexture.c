// Native half of HwTexture.java: a camera frame's HardwareBuffer becomes the
// image behind a GL_TEXTURE_EXTERNAL_OES texture (EGLImage, no copy).
// Every function is looked up at run time, so this builds for the app's
// minSdk (24) and is only used on Android 10+ (where ImageReader gives
// HardwareBuffers).
#include <jni.h>
#include <dlfcn.h>
#include <stdint.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>

typedef void *(*FromHb)(JNIEnv *, jobject);
typedef EGLClientBuffer (*GetClientBuffer)(const void *);
typedef EGLImageKHR (*CreateImage)(EGLDisplay, EGLContext, EGLenum, EGLClientBuffer, const EGLint *);
typedef EGLBoolean (*DestroyImage)(EGLDisplay, EGLImageKHR);
typedef void (*TargetTexture)(GLenum, GLeglImageOES);

static FromHb fromHb;
static GetClientBuffer getClientBuffer;
static CreateImage createImage;
static DestroyImage destroyImage;
static TargetTexture targetTexture;

JNIEXPORT jboolean JNICALL
Java_io_github_yuramonastyrskyy_tracktime_HwTexture_init(JNIEnv *env, jclass cls) {
    void *android = dlopen("libandroid.so", RTLD_NOW);
    if (android) fromHb = (FromHb) dlsym(android, "AHardwareBuffer_fromHardwareBuffer");
    getClientBuffer = (GetClientBuffer) eglGetProcAddress("eglGetNativeClientBufferANDROID");
    createImage = (CreateImage) eglGetProcAddress("eglCreateImageKHR");
    destroyImage = (DestroyImage) eglGetProcAddress("eglDestroyImageKHR");
    targetTexture = (TargetTexture) eglGetProcAddress("glEGLImageTargetTexture2DOES");
    return fromHb && getClientBuffer && createImage && destroyImage && targetTexture;
}

// Binds the buffer to the external texture; returns the EGLImage (0 on failure).
// The GL context must be current on this thread.
JNIEXPORT jlong JNICALL
Java_io_github_yuramonastyrskyy_tracktime_HwTexture_bind(JNIEnv *env, jclass cls, jobject hardwareBuffer, jint texture) {
    if (!fromHb || !hardwareBuffer) return 0;
    void *ahb = fromHb(env, hardwareBuffer);
    if (!ahb) return 0;
    EGLClientBuffer cb = getClientBuffer(ahb);
    if (!cb) return 0;
    EGLint attrs[] = { EGL_IMAGE_PRESERVED_KHR, EGL_TRUE, EGL_NONE };
    EGLImageKHR img = createImage(eglGetCurrentDisplay(), EGL_NO_CONTEXT, EGL_NATIVE_BUFFER_ANDROID, cb, attrs);
    if (img == EGL_NO_IMAGE_KHR) return 0;
    glBindTexture(GL_TEXTURE_EXTERNAL_OES, (GLuint) texture);
    targetTexture(GL_TEXTURE_EXTERNAL_OES, (GLeglImageOES) img);
    return (jlong) (intptr_t) img;
}

JNIEXPORT void JNICALL
Java_io_github_yuramonastyrskyy_tracktime_HwTexture_release(JNIEnv *env, jclass cls, jlong image) {
    if (image && destroyImage) destroyImage(eglGetCurrentDisplay(), (EGLImageKHR) (intptr_t) image);
}
