// Sends lap signals to the laptop stopwatch (Velodrome Timing System).
//
// The phone and the laptop share a short pairing code. Each lead crossing is
// published as a small JSON message to two public MQTT brokers (over secure
// WebSocket) and to ntfy.sh; the stopwatch listens on all three and keeps the
// first copy. A browser page served over https cannot talk to a laptop on the
// local Wi-Fi directly, so the message goes through the internet instead.
//
// The message carries the phone's own time of the crossing, so the stopwatch
// can place the lap exactly even when the network is slow.
//
// Direct link: while the relays are reachable, the phone also sets up a WebRTC
// data channel to the stopwatch (the offer and answer travel through the MQTT
// brokers). It runs over the local network only (no STUN or TURN servers), so
// once it is up it keeps carrying laps when the hotspot loses its internet.
//
// Unsent laps stay queued for 30 minutes. A lap counts as delivered to a broker
// only once the broker answers a ping sent after it, so laps written to a
// socket that silently died are sent again after the reconnect. The stopwatch
// drops the duplicates.

export const DEFAULT_BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
export const DEFAULT_NTFY = 'https://ntfy.sh';
export const mqttTopic = (code) => `tracktime/v1/${code}`;
export const rtcTopic = (code) => `tracktime/v1/${code}/rtc`;
const QUEUE_MAX_AGE_MS = 30 * 60 * 1000;
export const ntfyTopic = (code) => `tracktime-v1-${code}`;
export const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

const enc = new TextEncoder();
const dec = new TextDecoder();
const str = (s) => { const b = enc.encode(s); return [b.length >> 8, b.length & 0xff, ...b]; };
function packet(type, body) {
  const len = [];
  let n = body.length;
  do { let byte = n % 128; n = Math.floor(n / 128); if (n > 0) byte |= 0x80; len.push(byte); } while (n > 0);
  return new Uint8Array([type, ...len, ...body]);
}

/**
 * Small MQTT 3.1.1 client over WebSocket (QoS 0), with reconnects.
 * Every publish is followed by a PINGREQ; the broker answers pings in order,
 * so `acked` tells which publishes it surely received.
 */
export class MqttPublisher {
  constructor(url, { keepAliveSec = 20, onStatus, onMessage } = {}) {
    this.url = url;
    this.keepAlive = keepAliveSec;
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.status = 'closed';
    this.ws = null;
    this.stopped = true;
    this.retryMs = 1000;
    this.lastRx = 0;
    this.topics = new Set();
    this.tx = 0;          // publish counter (never reset)
    this.acked = 0;       // highest publish counter the broker has confirmed on this socket
    this.pings = [];      // publish counter at each outstanding PINGREQ
    this.packetId = 1;
    this.buf = new Uint8Array(0);
    this.clientId = 'tt-' + Math.random().toString(36).slice(2, 12);
  }

  start() { this.stopped = false; this.open(); }
  stop() { this.stopped = true; clearTimeout(this.retryTimer); this.teardown(); this.set('closed'); }

  subscribe(topic) {
    this.topics.add(topic);
    if (this.status === 'open') this.sendSubscribe(topic);
  }

  /** Returns the publish counter (truthy) when written to an open socket, else 0. */
  publish(topic, payload) {
    if (this.status !== 'open' || !this.ws) return 0;
    try {
      this.ws.send(packet(0x30, [...str(topic), ...enc.encode(payload)]));
      this.tx++;
      this.sendPing();
    } catch { return 0; }
    return this.tx;
  }

  sendPing() {
    try { this.ws.send(new Uint8Array([0xc0, 0])); this.pings.push(this.tx); } catch { /* closing */ }
  }

  sendSubscribe(topic) {
    const id = (this.packetId++ & 0xffff) || 1;
    try { this.ws?.send(packet(0x82, [id >> 8, id & 0xff, ...str(topic), 0])); } catch { /* closing */ }
  }

  set(s) { if (this.status !== s) { this.status = s; this.onStatus?.(s); } }

  open() {
    this.teardown();
    this.set('connecting');
    let ws;
    try { ws = new WebSocket(this.url, 'mqtt'); } catch { this.retry(); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => ws.send(packet(0x10, [...str('MQTT'), 4, 0x02, this.keepAlive >> 8, this.keepAlive & 0xff, ...str(this.clientId)]));
    ws.onmessage = (e) => this.onData(new Uint8Array(e.data));
    ws.onclose = () => { if (this.ws === ws) this.retry(); };
    ws.onerror = () => ws.close();
  }

  onData(chunk) {
    this.lastRx = Date.now();
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    for (;;) {
      let mult = 1, len = 0, i = 1, byte;
      do {
        if (i >= this.buf.length) return;
        byte = this.buf[i++];
        len += (byte & 0x7f) * mult;
        mult *= 128;
      } while (byte & 0x80);
      if (this.buf.length < i + len) return;
      const type = this.buf[0] >> 4;
      const body = this.buf.subarray(i, i + len);
      this.buf = this.buf.slice(i + len);
      this.onPacket(type, body);
    }
  }

  onPacket(type, body) {
    const ws = this.ws;
    if (type === 2) { // CONNACK
      if (this.status === 'open') return;
      if (body[1] !== 0) { ws?.close(); return; }
      this.retryMs = 1000;
      this.pings = [];
      for (const t of this.topics) this.sendSubscribe(t);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastRx > this.keepAlive * 2500) { ws?.close(); return; }
        this.sendPing();
      }, this.keepAlive * 500);
      this.set('open');
    } else if (type === 13) { // PINGRESP
      const t = this.pings.shift();
      if (t !== undefined && t > this.acked) this.acked = t;
    } else if (type === 3) { // PUBLISH at QoS 0
      const tlen = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + tlen));
      this.onMessage?.(topic, dec.decode(body.subarray(2 + tlen)));
    }
  }

  teardown() {
    clearInterval(this.pingTimer);
    this.buf = new Uint8Array(0);
    this.pings = [];
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  retry() {
    this.teardown();
    if (this.stopped) return;
    this.set('connecting');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.open(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 15000);
  }
}

/**
 * The phone's side of the direct link: makes a WebRTC offer, sends it through
 * the relays, and keeps a data channel to the stopwatch that needs no internet.
 */
export class DirectLink {
  constructor({ dev, signal, onStatus, gatherMs = 3000 }) {
    this.dev = dev;
    this.signal = signal;   // (object) => sends it on the signalling topic
    this.onStatus = onStatus;
    this.gatherMs = gatherMs;
    this.status = 'closed';
    this.pc = null;
    this.dc = null;
    this.sid = '';
    this.offeredAt = 0;
    this.detail = '';       // why it is not up yet, for the status line
  }

  static get supported() { return typeof RTCPeerConnection === 'function'; }

  set(s) { if (this.status !== s) { this.status = s; this.onStatus?.(s); } }
  note(d) { if (this.detail !== d) { this.detail = d; this.onStatus?.(this.status); } }

  /** Starts a fresh offer unless the link is up or an offer is only just out. */
  async offer() {
    if (!DirectLink.supported || this.status === 'open') return;
    if (this.status === 'connecting' && Date.now() - this.offeredAt < 8000) return;
    this.close();
    this.offeredAt = Date.now();
    const sid = Math.random().toString(36).slice(2, 10);
    this.sid = sid;
    this.set('connecting');
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      this.pc = pc;
      const dc = pc.createDataChannel('laps', { ordered: true });
      this.dc = dc;
      dc.onopen = () => { if (this.dc === dc) { this.detail = ''; this.set('open'); } };
      dc.onclose = () => { if (this.dc === dc) { this.note('link closed'); this.close(); } };
      pc.oniceconnectionstatechange = () => {
        if (this.pc === pc && this.status !== 'open') this.note(`network check: ${pc.iceConnectionState}`);
      };
      pc.onconnectionstatechange = () => {
        if (this.pc !== pc) return;
        if (pc.connectionState === 'failed') { this.note('this device and the stopwatch cannot reach each other on this network'); this.close(); }
        else if (pc.connectionState === 'closed') this.close();
      };
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc, this.gatherMs);
      if (this.pc !== pc) return;
      this.signal({ v: 1, type: 'offer', dev: this.dev, sid, sdp: pc.localDescription.sdp });
      this.note(`waiting for the stopwatch (this device: ${describeCandidates(pc.localDescription.sdp)})`);
    } catch {
      if (this.pc === pc) this.close();
    }
  }

  /** A message from the signalling topic. */
  async onSignal(m) {
    if (!m || m.v !== 1) return;
    if (m.type !== 'answer' || m.to !== this.dev || m.sid !== this.sid || typeof m.sdp !== 'string') return;
    const pc = this.pc;
    // Each broker delivers its own copy of the answer, often in the same
    // moment: take the first one only, before any await.
    if (!pc || this.answeredSid === m.sid || pc.signalingState !== 'have-local-offer') return;
    this.answeredSid = m.sid;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      this.note(`stopwatch answered (stopwatch: ${describeCandidates(m.sdp)})`);
    } catch {
      if (this.pc === pc && pc.signalingState !== 'stable') { this.note('bad answer from the stopwatch'); this.close(); }
    }
  }

  send(text) {
    if (this.status !== 'open' || this.dc?.readyState !== 'open') return false;
    try { this.dc.send(text); return true; } catch { return false; }
  }

  close() {
    const { pc, dc } = this;
    this.pc = null;
    this.dc = null;
    try { dc?.close(); } catch { /* ignore */ }
    try { pc?.close(); } catch { /* ignore */ }
    this.set('closed');
  }
}

/** Short summary of an SDP's ICE candidates: local IPs, hidden (.local) names, or none. */
export function describeCandidates(sdp) {
  const ips = new Set();
  let hidden = 0;
  for (const line of String(sdp).split(/\r?\n/)) {
    const m = /^a=candidate:\S+ \d+ udp \d+ (\S+) \d+ typ host/i.exec(line);
    if (!m) continue;
    if (m[1].endsWith('.local')) hidden++;
    else ips.add(m[1]);
  }
  const parts = [...ips];
  if (hidden) parts.push(`${hidden} hidden address${hidden > 1 ? 'es' : ''}`);
  return parts.length ? parts.join(', ') : 'no local address';
}

/** Waits until ICE gathering is complete (or `ms` passes), so one message carries all candidates. */
function gathered(pc, ms) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', check); resolve(); }
    function check() { if (pc.iceGatheringState === 'complete') done(); }
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/**
 * Sends crossings for one pairing code. Laps go to every broker, to ntfy and
 * over the direct link; pings (every 20 s, so the stopwatch can show
 * "connected") skip ntfy, which keeps its daily message limit for the laps.
 */
export class LapSender {
  constructor({ brokers = DEFAULT_BROKERS, ntfy = DEFAULT_NTFY, onState, pingSec = 20, direct = true } = {}) {
    this.brokers = brokers;
    this.ntfy = ntfy;
    this.onState = onState;
    this.pingSec = pingSec;
    this.useDirect = direct && DirectLink.supported;
    this.code = '';
    this.links = [];
    this.direct = null;
    this.dev = Math.random().toString(36).slice(2, 10); // new id per page load
    this.seq = 0;
    this.queue = [];      // laps not yet confirmed by every relay
    this.history = [];    // { seq, at, msg } of recent laps, for a stopwatch that missed some
    this.lastSent = null; // { lap, at, via: number of links that took it }
    this.ntfyOk = true;
  }

  setCode(code) {
    code = normalizeCode(code);
    if (code === this.code) return;
    this.stop();
    this.code = code;
    if (!code) { this.emit(); return; }
    const rtc = rtcTopic(code);
    if (this.useDirect) {
      this.direct = new DirectLink({
        dev: this.dev,
        signal: (m) => { const t = JSON.stringify(m); for (const l of this.links) l.publish(rtc, t); },
        onStatus: () => this.emit(),
      });
    }
    this.links = this.brokers.map((url) => {
      const link = new MqttPublisher(url, {
        onStatus: (s) => {
          if (s === 'open') {
            // Anything sent on the old socket and not confirmed goes again.
            for (const q of this.queue) if (q.pend.has(link)) q.pend.set(link, 0);
            this.flush();
            this.direct?.offer();
          }
          this.emit();
        },
        onMessage: (topic, payload) => {
          if (topic !== rtc) return;
          let m;
          try { m = JSON.parse(payload); } catch { return; }
          if (m?.v !== 1) return;
          if (m.type === 'hello') this.onHello(m);
          else this.direct?.onSignal(m);
        },
      });
      link.name = new URL(url).hostname;
      link.subscribe(rtc);
      link.start();
      return link;
    });
    this.pingTimer = setInterval(() => this.ping(), this.pingSec * 1000);
    this.flushTimer = setInterval(() => this.flush(), 3000);
    this.offerTimer = setInterval(() => { if (this.links.some((l) => l.status === 'open')) this.direct?.offer(); }, 15000);
    this.emit();
  }

  stop() {
    clearInterval(this.pingTimer);
    clearInterval(this.flushTimer);
    clearInterval(this.offerTimer);
    for (const l of this.links) l.stop();
    this.direct?.close();
    this.direct = null;
    this.links = [];
    this.queue = [];
    this.history = [];
  }

  /**
   * The stopwatch (re)connected to a broker. It says the last lap number it got
   * from us, so laps it missed while it was reconnecting are sent again. After
   * a page reload it knows nothing of us and nothing is replayed.
   */
  onHello(m) {
    this.direct?.offer();
    const had = m.seen?.[this.dev];
    if (!Number.isFinite(had)) return;
    const topic = mqttTopic(this.code);
    for (const h of this.history) if (h.seq > had) for (const l of this.links) l.publish(topic, h.msg);
  }

  get connected() { return this.links.some((l) => l.status === 'open') || this.direct?.status === 'open'; }

  message(type, at, lap) {
    const m = { v: 1, type, dev: this.dev, seq: ++this.seq, at: Math.round(at) };
    if (lap !== undefined) m.lap = lap;
    return JSON.stringify(m);
  }

  /** A lead crossing at phone time `at` (epoch ms). `lap` is 0 for the first crossing. */
  sendCrossing(at, lap) {
    if (!this.code) return;
    const msg = this.message('lap', at, lap);
    const now = Date.now();
    this.history = this.history.filter((h) => now - h.at < QUEUE_MAX_AGE_MS);
    this.history.push({ seq: this.seq, at, msg });
    let via = this.direct?.send(msg) ? 1 : 0;
    const q = { msg, at, pend: new Map(this.links.map((l) => [l, 0])), ntfy: !!(this.ntfy && this.ntfyOk), posting: false };
    this.queue.push(q);
    this.deliver(q);
    for (const t of q.pend.values()) if (t) via++;
    if (q.ntfy) via++;
    this.lastSent = { lap, at, via };
    this.emit();
  }

  /** Writes a queued lap to every relay that has not taken it yet. */
  deliver(q) {
    const topic = mqttTopic(this.code);
    for (const [l, t] of q.pend) if (!t) q.pend.set(l, l.publish(topic, q.msg));
    if (q.ntfy && this.ntfyOk && !q.posting) {
      q.posting = true;
      // A simple POST (text/plain) needs no CORS preflight.
      fetch(`${this.ntfy}/${ntfyTopic(this.code)}`, { method: 'POST', body: q.msg, keepalive: true })
        .then((r) => {
          if (r.ok) q.ntfy = false;
          else if (r.status === 429) { this.ntfyOk = false; q.ntfy = false; }
        })
        .catch(() => {})
        .finally(() => { q.posting = false; });
    }
    if (!this.ntfyOk) q.ntfy = false;
  }

  /** Drops what the relays confirmed and re-sends the rest (the stopwatch drops duplicates). */
  flush() {
    const now = Date.now();
    this.queue = this.queue.filter((q) => {
      if (now - q.at > QUEUE_MAX_AGE_MS) return false;
      for (const [l, t] of q.pend) if (t && l.acked >= t) q.pend.delete(l);
      if (!q.pend.size && !q.ntfy) return false;
      this.deliver(q);
      return true;
    });
    const pending = this.pendingCount();
    if (pending !== this.lastPending) { this.lastPending = pending; this.emit(); }
  }

  /** Laps still unconfirmed after 5 s (a fresh lap is normally confirmed within a second). */
  pendingCount() {
    const now = Date.now();
    return this.queue.filter((q) => now - q.at > 5000).length;
  }

  ping() {
    if (!this.code) return;
    const msg = this.message('ping', Date.now());
    this.direct?.send(msg);
    for (const l of this.links) l.publish(mqttTopic(this.code), msg);
  }

  emit() {
    const links = this.links.map((l) => ({ name: l.name, status: l.status }));
    this.onState?.({
      code: this.code,
      links,
      direct: this.direct ? this.direct.status : null,
      directDetail: this.direct?.detail || '',
      connected: this.connected,
      pending: this.pendingCount(),
      lastSent: this.lastSent,
    });
  }
}

/** Test hook: `?relay=ws://host:port[,more]` replaces the brokers, `?ntfy=off|URL`, `?direct=off`. */
export function linkOverrides(search) {
  const p = new URLSearchParams(search);
  const out = {};
  const relay = p.get('relay');
  if (relay) out.brokers = relay.split(',').filter(Boolean);
  const ntfy = p.get('ntfy');
  if (ntfy) out.ntfy = ntfy === 'off' ? null : ntfy;
  if (p.get('direct') === 'off') out.direct = false;
  return out;
}
