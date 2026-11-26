package io.github.yuramonastyrskyy.tracktime;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;

import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Runs the two models on frames around a crossing and describes the riders
 * near the finish line: box, bike, colour histograms, re-ID vector and a
 * small picture. Plain Java plus ONNX Runtime (no Android), so the same code
 * runs in the app and on a desktop against recorded clips.
 *
 * Which rider is which is decided on the page (js/riders.js); this only
 * describes what the camera saw.
 */
public final class RiderEngine implements AutoCloseable {

    /** Turns a small RGB picture into JPEG bytes (Android: Bitmap; desktop: ImageIO). */
    public interface JpegEncoder { byte[] encode(byte[] rgb, int w, int h); }

    /** Line share above which something is on the line (and the detector runs). */
    public static final float BUSY = 0.04f;
    /** Half-width of the band around the line, as a share of the frame width. */
    public static final float BAND = 0.125f;
    public static final float MIN_PERSON = 0.35f;
    public static final int THUMB_H = 96;

    private final OrtEnvironment env;
    private final OrtSession det, reid;
    private final String detIn, reidIn;
    private final JpegEncoder jpeg;
    private final float[] detBuf = new float[3 * RiderVision.DET * RiderVision.DET];

    private float[] line = { 0.5f, 0.15f, 0.5f, 0.8f };
    private byte[] bg = null;
    private int bgW = 0, bgH = 0;

    public long framesSeen = 0, framesDetected = 0, detMsTotal = 0;

    public RiderEngine(byte[] detModel, byte[] reidModel, int threads, JpegEncoder jpeg) throws OrtException {
        env = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions o = new OrtSession.SessionOptions();
        o.setIntraOpNumThreads(Math.max(1, threads));
        o.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        det = env.createSession(detModel, o);
        reid = env.createSession(reidModel, o);
        detIn = det.getInputNames().iterator().next();
        reidIn = reid.getInputNames().iterator().next();
        this.jpeg = jpeg;
    }

    /** Finish line: top u,v then inner u,v (0..1, display orientation). */
    public synchronized void setLine(float[] l) { if (l != null && l.length >= 4) line = l.clone(); }

    /** The empty track (called at Start timing, when the line is clear). */
    public synchronized void setBackground(byte[] rgb, int w, int h) {
        bg = rgb.clone(); bgW = w; bgH = h;
    }

    public synchronized boolean hasBackground() { return bg != null; }

    /** Blends an (almost) empty frame into the background, so slow light changes do not count as riders. */
    public synchronized void learnBackground(byte[] rgb, int w, int h, float alpha) {
        if (bg == null || bgW != w || bgH != h) { setBackground(rgb, w, h); return; }
        if (RiderVision.coverage(rgb, bg, w, h, line) < BUSY) RiderVision.blend(bg, rgb, alpha);
    }

    /**
     * Describes one frame (sensor time t ms). Returns a JSON object text, or
     * null when nothing is on the line (the background then learns from it).
     */
    public synchronized String process(byte[] rgb, int w, int h, double t) throws OrtException {
        framesSeen++;
        if (bg == null || bgW != w || bgH != h) { setBackground(rgb, w, h); return null; }
        float cov = RiderVision.coverage(rgb, bg, w, h, line);
        if (cov < BUSY) {
            RiderVision.blend(bg, rgb, 0.05f);
            return null;
        }
        long t0 = System.nanoTime();
        float r = RiderVision.letterbox(rgb, w, h, detBuf);
        float[] out;
        try (OnnxTensor in = OnnxTensor.createTensor(env, FloatBuffer.wrap(detBuf), new long[] { 1, 3, RiderVision.DET, RiderVision.DET });
             OrtSession.Result res = det.run(java.util.Collections.singletonMap(detIn, in))) {
            float[][][] o = (float[][][]) res.get(0).getValue();
            int rows = o[0].length;
            out = new float[rows * 85];
            for (int i = 0; i < rows; i++) System.arraycopy(o[0][i], 0, out, i * 85, 85);
        }
        List<RiderVision.Box> boxes = RiderVision.decode(out, r, w, h, 0.25f);
        framesDetected++;

        List<RiderVision.Box> people = new ArrayList<>();
        for (RiderVision.Box b : boxes) {
            if (b.cls != 0 || b.score < MIN_PERSON || b.h() < 0.12f * h) continue;
            float lx = RiderVision.lineX(line, w, h, (b.y1 + b.y2) / 2);
            if (Math.abs(b.cx() - lx) > BAND * w) continue;
            people.add(b);
        }
        boolean anyone = false;
        for (RiderVision.Box b : boxes) if (b.score >= 0.3f) anyone = true;
        if (!anyone) RiderVision.blend(bg, rgb, 0.2f);

        float[][] emb = new float[people.size()][];
        if (!people.isEmpty()) {
            int n = people.size(), plane = 3 * RiderVision.REID_H * RiderVision.REID_W;
            float[] buf = new float[n * plane];
            for (int i = 0; i < n; i++) RiderVision.reidInput(rgb, w, h, people.get(i), buf, i * plane);
            try (OnnxTensor in = OnnxTensor.createTensor(env, FloatBuffer.wrap(buf), new long[] { n, 3, RiderVision.REID_H, RiderVision.REID_W });
                 OrtSession.Result res = reid.run(java.util.Collections.singletonMap(reidIn, in))) {
                float[][] e = (float[][]) res.get(0).getValue();
                for (int i = 0; i < n; i++) emb[i] = RiderVision.unit(e[i]);
            }
        }
        detMsTotal += (System.nanoTime() - t0) / 1_000_000;

        StringBuilder sb = new StringBuilder(people.size() * 9000 + 100);
        sb.append("{\"t\":").append(String.format(Locale.ROOT, "%.3f", t))
          .append(",\"w\":").append(w).append(",\"h\":").append(h)
          .append(",\"cov\":").append(fmt(cov, 3)).append(",\"fv\":").append(RiderVision.FEATURES).append(",\"people\":[");
        for (int i = 0; i < people.size(); i++) {
            RiderVision.Box p = people.get(i);
            RiderVision.Box bike = RiderVision.bikeFor(p, boxes);
            float[] col = RiderVision.colour(rgb, bg, w, h, p, bike);
            if (i > 0) sb.append(',');
            sb.append("{\"box\":"); box(sb, p);
            sb.append(",\"bike\":"); if (bike == null) sb.append("null"); else box(sb, bike);
            sb.append(",\"score\":").append(fmt(p.score, 3));
            sb.append(",\"col\":"); arr(sb, col, 3);
            sb.append(",\"emb\":"); arr(sb, emb[i], 4);
            if (jpeg != null) {
                float x1 = p.x1, x2 = p.x2, y2 = p.y2;
                if (bike != null) { x1 = Math.min(x1, bike.x1); x2 = Math.max(x2, bike.x2); y2 = Math.max(y2, bike.y2); }
                int[] size = new int[2];
                byte[] th = RiderVision.thumb(rgb, w, h, x1, p.y1, x2, y2, THUMB_H, size);
                byte[] jp = jpeg.encode(th, size[0], size[1]);
                if (jp != null) sb.append(",\"thumb\":\"data:image/jpeg;base64,").append(RiderVision.base64(jp)).append('"');
            }
            sb.append('}');
        }
        sb.append("]}");
        return sb.toString();
    }

    private static void box(StringBuilder sb, RiderVision.Box b) {
        sb.append('[').append(fmt(b.x1, 1)).append(',').append(fmt(b.y1, 1)).append(',')
          .append(fmt(b.x2, 1)).append(',').append(fmt(b.y2, 1)).append(']');
    }

    private static void arr(StringBuilder sb, float[] v, int dec) {
        sb.append('[');
        for (int i = 0; i < v.length; i++) {
            if (i > 0) sb.append(',');
            if (v[i] == 0) sb.append('0'); else sb.append(fmt(v[i], dec));
        }
        sb.append(']');
    }

    private static String fmt(float v, int dec) {
        return String.format(Locale.ROOT, "%." + dec + "f", v);
    }

    @Override
    public void close() {
        try { det.close(); } catch (Exception ignored) { }
        try { reid.close(); } catch (Exception ignored) { }
    }
}
