package io.github.yuramonastyrskyy.tracktime;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/**
 * Picture maths for rider identification, without Android or model code, so
 * it can be checked on a desktop against recorded clips.
 *
 * Frames are small RGB pictures (about 360 x 640, display orientation),
 * bytes r,g,b per pixel, row by row. A background frame of the same size
 * (the empty track) separates riders from the track for the colour feature.
 *
 * Per frame: {@link #letterbox} feeds the person/bicycle detector (YOLOX,
 * 416 x 416), {@link #decode} turns its output into boxes, and for each rider
 * near the finish line {@link #colour} (jersey, legs, bike colour
 * histograms) and {@link #reidInput} (the crop for the re-ID model) give the
 * two kinds of features the page matches riders with.
 */
public final class RiderVision {
    private RiderVision() {}

    /** Detector input size (YOLOX nano/tiny). */
    public static final int DET = 416;
    /** Re-ID input size (OSNet), height x width. */
    public static final int REID_H = 256, REID_W = 128;
    /** Colour histogram bins: hue x saturation x value, per region (3 regions). */
    public static final int HB = 18, SB = 3, VB = 3, BINS = HB * SB * VB, COLOUR_LEN = BINS * 3;
    /** Channel difference from the background that counts as "rider". */
    public static final int MASK_DIFF = 35;
    /** Below this saturation or value a pixel counts as black / grey / white (no hue). */
    public static final int GREY_S = 60, DARK_V = 45;
    /** Version of the colour features above (the page drops riders learnt with another). */
    public static final int FEATURES = 2;

    // ---------- detector ----------

    /**
     * Fills out (3 x DET x DET, planar BGR 0..255, as YOLOX was trained) with
     * the frame scaled to fit, top-left aligned, grey (114) around it.
     * Returns the scale (detector pixels per frame pixel).
     */
    public static float letterbox(byte[] rgb, int w, int h, float[] out) {
        float r = Math.min((float) DET / w, (float) DET / h);
        int nw = Math.round(w * r), nh = Math.round(h * r);
        int plane = DET * DET;
        Arrays.fill(out, 0, plane * 3, 114f);
        for (int y = 0; y < nh; y++) {
            // Bilinear sample at pixel centres (like cv2.resize).
            float sy = (y + 0.5f) / r - 0.5f;
            int y0 = clamp((int) Math.floor(sy), 0, h - 1), y1 = Math.min(y0 + 1, h - 1);
            float fy = Math.max(0f, Math.min(1f, sy - y0));
            for (int x = 0; x < nw; x++) {
                float sx = (x + 0.5f) / r - 0.5f;
                int x0 = clamp((int) Math.floor(sx), 0, w - 1), x1 = Math.min(x0 + 1, w - 1);
                float fx = Math.max(0f, Math.min(1f, sx - x0));
                int o = y * DET + x;
                for (int c = 0; c < 3; c++) {
                    float v = lerp2(rgb, w, x0, x1, y0, y1, fx, fy, c);
                    out[(2 - c) * plane + o] = v; // BGR planes
                }
            }
        }
        return r;
    }

    private static float lerp2(byte[] rgb, int w, int x0, int x1, int y0, int y1, float fx, float fy, int c) {
        float a = rgb[(y0 * w + x0) * 3 + c] & 255, b = rgb[(y0 * w + x1) * 3 + c] & 255;
        float d = rgb[(y1 * w + x0) * 3 + c] & 255, e = rgb[(y1 * w + x1) * 3 + c] & 255;
        return (a + (b - a) * fx) * (1 - fy) + (d + (e - d) * fx) * fy;
    }

    /** A detected person (cls 0) or bicycle (cls 1), in frame pixels. */
    public static final class Box {
        public final float x1, y1, x2, y2, score;
        public final int cls;
        public Box(float x1, float y1, float x2, float y2, float score, int cls) {
            this.x1 = x1; this.y1 = y1; this.x2 = x2; this.y2 = y2; this.score = score; this.cls = cls;
        }
        public float w() { return x2 - x1; }
        public float h() { return y2 - y1; }
        public float cx() { return (x1 + x2) / 2; }
        float area() { return Math.max(0, x2 - x1) * Math.max(0, y2 - y1); }
    }

    /**
     * YOLOX output (rows of 85: box, objectness, 80 class scores, already
     * sigmoid; boxes relative to the grid) to person and bicycle boxes in
     * frame pixels, after non-maximum suppression.
     */
    public static List<Box> decode(float[] o, float r, int w, int h, float minScore) {
        List<Box> all = new ArrayList<>();
        int row = 0;
        for (int stride : new int[] { 8, 16, 32 }) {
            int g = DET / stride;
            for (int gy = 0; gy < g; gy++) {
                for (int gx = 0; gx < g; gx++, row++) {
                    int b = row * 85;
                    float obj = o[b + 4];
                    if (obj < minScore) continue;
                    for (int cls = 0; cls < 2; cls++) {
                        float s = obj * o[b + 5 + cls];
                        if (s < minScore) continue;
                        float cx = (o[b] + gx) * stride, cy = (o[b + 1] + gy) * stride;
                        float bw = (float) Math.exp(o[b + 2]) * stride, bh = (float) Math.exp(o[b + 3]) * stride;
                        all.add(new Box(
                            clampf((cx - bw / 2) / r, 0, w), clampf((cy - bh / 2) / r, 0, h),
                            clampf((cx + bw / 2) / r, 0, w), clampf((cy + bh / 2) / r, 0, h), s, cls));
                    }
                }
            }
        }
        all.sort(Comparator.comparingDouble((Box x) -> -x.score));
        List<Box> keep = new ArrayList<>();
        for (Box a : all) {
            boolean ok = true;
            for (Box k : keep) if (k.cls == a.cls && iou(k, a) > 0.45f) { ok = false; break; }
            if (ok) keep.add(a);
        }
        return keep;
    }

    static float iou(Box a, Box b) {
        float ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
        float iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
        float i = ix * iy;
        return i / (a.area() + b.area() - i + 1e-6f);
    }

    /** The bicycle under a person: overlapping across, reaching below their lower body. */
    public static Box bikeFor(Box p, List<Box> boxes) {
        Box best = null;
        float bestSc = 0;
        for (Box b : boxes) {
            if (b.cls != 1) continue;
            float ov = Math.min(b.x2, p.x2) - Math.max(b.x1, p.x1);
            if (ov <= 0 || b.y2 <= p.y2 - 0.15f * p.h()) continue;
            // The bike under this rider, not the wheel of the one next to them: most overlap wins.
            float sc = ov / Math.max(1f, b.x2 - b.x1) + 0.2f * b.score;
            if (best == null || sc > bestSc) { best = b; bestSc = sc; }
        }
        return best;
    }

    // ---------- finish line ----------

    /** X of the finish line at height y (frame pixels); line = top u,v then inner u,v (0..1). */
    public static float lineX(float[] line, int w, int h, float y) {
        float x1 = line[0] * w, y1 = line[1] * h, x2 = line[2] * w, y2 = line[3] * h;
        if (Math.abs(y2 - y1) < 1e-3f) return (x1 + x2) / 2;
        return x1 + (x2 - x1) * (y - y1) / (y2 - y1);
    }

    /**
     * Share of 48 points along the finish line (top to inner edge) that differ
     * from the background: something is crossing when this is above a few %.
     */
    public static float coverage(byte[] rgb, byte[] bg, int w, int h, float[] line) {
        int n = 48, hit = 0;
        for (int i = 0; i < n; i++) {
            float t = (i + 0.5f) / n;
            int x = clamp(Math.round((line[0] + (line[2] - line[0]) * t) * w), 0, w - 1);
            int y = clamp(Math.round((line[1] + (line[3] - line[1]) * t) * h), 0, h - 1);
            if (differs(rgb, bg, (y * w + x) * 3)) hit++;
        }
        return (float) hit / n;
    }

    private static boolean differs(byte[] a, byte[] b, int i) {
        return Math.abs((a[i] & 255) - (b[i] & 255)) > MASK_DIFF
            || Math.abs((a[i + 1] & 255) - (b[i + 1] & 255)) > MASK_DIFF
            || Math.abs((a[i + 2] & 255) - (b[i + 2] & 255)) > MASK_DIFF;
    }

    /** Moves the background towards an empty frame (alpha 0..1). */
    public static void blend(byte[] bg, byte[] rgb, float alpha) {
        for (int i = 0; i < bg.length; i++) {
            int b = bg[i] & 255;
            bg[i] = (byte) Math.round(b + alpha * ((rgb[i] & 255) - b));
        }
    }

    // ---------- colour ----------

    /**
     * Colour of one rider: hue/saturation/value histograms of the pixels that
     * differ from the background, for three regions: upper body (helmet and
     * jersey), legs, and the bike. Each histogram sums to 1 before the square
     * root (so a dot product compares them fairly).
     */
    public static float[] colour(byte[] rgb, byte[] bg, int w, int h, Box p, Box bike) {
        float[] out = new float[COLOUR_LEN];
        float ph = p.h();
        float bx1 = p.x1, bx2 = p.x2, by2 = p.y2;
        if (bike != null) { bx1 = Math.min(bx1, bike.x1); bx2 = Math.max(bx2, bike.x2); by2 = Math.max(by2, bike.y2); }
        hist(rgb, bg, w, h, p.x1, p.y1, p.x2, p.y1 + 0.45f * ph, out, 0);
        hist(rgb, bg, w, h, p.x1, p.y1 + 0.45f * ph, p.x2, p.y1 + 0.75f * ph, out, BINS);
        // Bike: the detected bike, or (when the detector missed it, often at speed)
        // the frame and wheels below the hips, a little under the rider's box.
        if (bike == null) by2 = p.y2 + 0.1f * ph;
        hist(rgb, bg, w, h, bx1, p.y1 + (bike != null ? 0.55f : 0.5f) * ph, bx2, by2, out, 2 * BINS);
        return out;
    }

    private static void hist(byte[] rgb, byte[] bg, int w, int h, float fx1, float fy1, float fx2, float fy2, float[] out, int off) {
        int x1 = clamp((int) fx1, 0, w), x2 = clamp((int) fx2, 0, w), y1 = clamp((int) fy1, 0, h), y2 = clamp((int) fy2, 0, h);
        int[] hsv = new int[3];
        float sum = 0;
        for (int y = y1; y < y2; y++) {
            for (int x = x1; x < x2; x++) {
                int i = (y * w + x) * 3;
                if (bg != null && !differs(rgb, bg, i)) continue;
                toHsv(rgb[i] & 255, rgb[i + 1] & 255, rgb[i + 2] & 255, hsv);
                // Black, white and grey have no steady hue: count them by brightness only
                // (bins 0..2), so a white bike and a black one land far apart.
                int hb = (hsv[1] < GREY_S || hsv[2] < DARK_V) ? 0 : hsv[0] * HB / 180;
                int k = hb * SB * VB + (hsv[1] * SB / 256) * VB + hsv[2] * VB / 256;
                out[off + Math.min(k, BINS - 1)]++;
                sum++;
            }
        }
        for (int k = 0; k < BINS; k++) out[off + k] = sum > 0 ? (float) Math.sqrt(out[off + k] / sum) : 0;
    }

    /** OpenCV's 8-bit HSV: hue 0..179, saturation and value 0..255. */
    static void toHsv(int r, int g, int b, int[] out) {
        int v = Math.max(r, Math.max(g, b)), mn = Math.min(r, Math.min(g, b));
        int d = v - mn;
        int s = v == 0 ? 0 : Math.round(255f * d / v);
        float hh = 0;
        if (d > 0) {
            if (v == r) hh = 60f * (g - b) / d;
            else if (v == g) hh = 120f + 60f * (b - r) / d;
            else hh = 240f + 60f * (r - g) / d;
            if (hh < 0) hh += 360;
        }
        int hue = Math.round(hh / 2);
        out[0] = hue >= 180 ? hue - 180 : hue; out[1] = s; out[2] = v;
    }

    // ---------- re-ID ----------

    private static final float[] MEAN = { 0.485f, 0.456f, 0.406f }, STD = { 0.229f, 0.224f, 0.225f };

    /** The person box resized to 128 x 256, planar RGB normalised for OSNet, written at out[off..]. */
    public static void reidInput(byte[] rgb, int w, int h, Box p, float[] out, int off) {
        int plane = REID_H * REID_W;
        float x1 = Math.max(0, p.x1), y1 = Math.max(0, p.y1);
        float sxs = Math.max(1, Math.min(w, p.x2) - x1) / REID_W, sys = Math.max(1, Math.min(h, p.y2) - y1) / REID_H;
        for (int y = 0; y < REID_H; y++) {
            float sy = y1 + (y + 0.5f) * sys - 0.5f;
            int y0 = clamp((int) Math.floor(sy), 0, h - 1), yy1 = Math.min(y0 + 1, h - 1);
            float fy = Math.max(0f, Math.min(1f, sy - y0));
            for (int x = 0; x < REID_W; x++) {
                float sx = x1 + (x + 0.5f) * sxs - 0.5f;
                int x0 = clamp((int) Math.floor(sx), 0, w - 1), xx1 = Math.min(x0 + 1, w - 1);
                float fx = Math.max(0f, Math.min(1f, sx - x0));
                for (int c = 0; c < 3; c++) {
                    float v = lerp2(rgb, w, x0, xx1, y0, yy1, fx, fy, c) / 255f;
                    out[off + c * plane + y * REID_W + x] = (v - MEAN[c]) / STD[c];
                }
            }
        }
    }

    /** Scales a vector to length 1 (in place). */
    public static float[] unit(float[] v) {
        double s = 0;
        for (float x : v) s += x * x;
        float k = s > 0 ? (float) (1 / Math.sqrt(s)) : 0;
        for (int i = 0; i < v.length; i++) v[i] *= k;
        return v;
    }

    /** A crop of the frame as RGB bytes, scaled to height th (for thumbnails). */
    public static byte[] thumb(byte[] rgb, int w, int h, float fx1, float fy1, float fx2, float fy2, int th, int[] size) {
        int x1 = clamp((int) fx1, 0, w - 1), y1 = clamp((int) fy1, 0, h - 1);
        int x2 = clamp((int) Math.ceil(fx2), x1 + 1, w), y2 = clamp((int) Math.ceil(fy2), y1 + 1, h);
        float s = (float) th / (y2 - y1);
        int tw = Math.max(1, Math.round((x2 - x1) * s));
        byte[] out = new byte[tw * th * 3];
        for (int y = 0; y < th; y++) {
            int sy = clamp(y1 + (int) ((y + 0.5f) / s), 0, h - 1);
            for (int x = 0; x < tw; x++) {
                int sx = clamp(x1 + (int) ((x + 0.5f) / s), 0, w - 1);
                System.arraycopy(rgb, (sy * w + sx) * 3, out, (y * tw + x) * 3, 3);
            }
        }
        size[0] = tw; size[1] = th;
        return out;
    }

    private static final char[] B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    /** Standard base64 (java.util.Base64 needs Android 8). */
    public static String base64(byte[] d) {
        StringBuilder sb = new StringBuilder((d.length + 2) / 3 * 4);
        for (int i = 0; i < d.length; i += 3) {
            int n = (d[i] & 255) << 16 | (i + 1 < d.length ? (d[i + 1] & 255) << 8 : 0) | (i + 2 < d.length ? d[i + 2] & 255 : 0);
            sb.append(B64[n >> 18 & 63]).append(B64[n >> 12 & 63])
              .append(i + 1 < d.length ? B64[n >> 6 & 63] : '=').append(i + 2 < d.length ? B64[n & 63] : '=');
        }
        return sb.toString();
    }

    static int clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
    static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
}
