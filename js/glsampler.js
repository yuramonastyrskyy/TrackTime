// Reads the finish-line sample pixels on the GPU.
//
// Copying a camera frame into a 2D canvas and reading it back is the slow part
// of each frame on phones (it pulls the whole frame from the GPU). Here the
// frame is uploaded as a WebGL texture (GPU to GPU), one point is drawn per
// sample into a tiny framebuffer, and only those few thousand pixels are read
// back. Falls back to the canvas path (in app.js) when WebGL is not available.

const VS = `
attribute vec2 aOut;  // where this sample goes in the output grid (pixel centre, clip space)
attribute vec2 aUv;   // where to read it in the video frame (0..1)
attribute float aMode; // 0 = grey detector sample, 1 = colour photo-finish pixel
varying vec2 vUv;
varying float vMode;
void main() {
  vUv = aUv;
  vMode = aMode;
  gl_Position = vec4(aOut, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

const FS = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
varying float vMode;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  float g = dot(c, vec3(0.30078125, 0.5859375, 0.11328125)); // same weights as readSamplesRGBA
  gl_FragColor = vMode > 0.5 ? vec4(c, 1.0) : vec4(g, g, g, 1.0);
}`;

export class GLSampler {
  /**
   * sampler: from buildSampler(); its xs/ys are in a frame of sampler.width x sampler.height.
   * strip (optional): from buildStripLine() in the same frame; its pixels are read in colour
   * for the photo-finish, after the detector samples.
   */
  constructor(sampler, strip = null) {
    const n = sampler.sampleCount;
    const m = strip ? strip.count : 0;
    this.n = n;
    this.m = m;
    const total = n + m;
    this.w = Math.min(256, total);
    this.h = Math.ceil(total / this.w);
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(this.w, this.h)
      : Object.assign(document.createElement('canvas'), { width: this.w, height: this.h });
    const gl = canvas.getContext('webgl', { antialias: false, depth: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;

    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader error');
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link error');
    gl.useProgram(prog);

    // One vertex per sample: output position + video uv + mode.
    const data = new Float32Array(total * 5);
    for (let i = 0; i < total; i++) {
      const ox = i % this.w, oy = Math.floor(i / this.w);
      const j = i - n, colour = j >= 0;
      data[i * 5] = ((ox + 0.5) / this.w) * 2 - 1;
      data[i * 5 + 1] = ((oy + 0.5) / this.h) * 2 - 1;
      data[i * 5 + 2] = colour ? (Math.round(strip.xs[j]) + 0.5) / strip.width : (sampler.xs[i] + 0.5) / sampler.width;
      data[i * 5 + 3] = colour ? (Math.round(strip.ys[j]) + 0.5) / strip.height : (sampler.ys[i] + 0.5) / sampler.height;
      data[i * 5 + 4] = colour ? 1 : 0;
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const aOut = gl.getAttribLocation(prog, 'aOut'), aUv = gl.getAttribLocation(prog, 'aUv');
    const aMode = gl.getAttribLocation(prog, 'aMode');
    gl.enableVertexAttribArray(aOut);
    gl.vertexAttribPointer(aOut, 2, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 20, 8);
    gl.enableVertexAttribArray(aMode);
    gl.vertexAttribPointer(aMode, 1, gl.FLOAT, false, 20, 16);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.viewport(0, 0, this.w, this.h);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    this.pixels = new Uint8Array(this.w * this.h * 4);
  }

  /**
   * Fills `out` (Uint8Array of sampleCount) with grey values from the current
   * video frame, and `stripOut` (strip.count * 3 bytes, RGB) when given.
   */
  read(video, out, stripOut = null) {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('WebGL context lost');
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    gl.drawArrays(gl.POINTS, 0, this.n + this.m);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    const px = this.pixels, n = this.n;
    for (let i = 0; i < n; i++) out[i] = px[i * 4];
    if (stripOut) {
      for (let j = 0; j < this.m; j++) {
        const p = (n + j) * 4;
        stripOut[j * 3] = px[p]; stripOut[j * 3 + 1] = px[p + 1]; stripOut[j * 3 + 2] = px[p + 2];
      }
    }
    return out;
  }
}
