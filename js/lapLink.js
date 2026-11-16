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

export const DEFAULT_BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
export const DEFAULT_NTFY = 'https://ntfy.sh';
export const mqttTopic = (code) => `tracktime/v1/${code}`;
export const ntfyTopic = (code) => `tracktime-v1-${code}`;
export const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

const enc = new TextEncoder();
const str = (s) => { const b = enc.encode(s); return [b.length >> 8, b.length & 0xff, ...b]; };
function packet(type, body) {
  const len = [];
  let n = body.length;
  do { let byte = n % 128; n = Math.floor(n / 128); if (n > 0) byte |= 0x80; len.push(byte); } while (n > 0);
  return new Uint8Array([type, ...len, ...body]);
}

/** Publish-only MQTT 3.1.1 client over WebSocket (QoS 0), with reconnects. */
export class MqttPublisher {
  constructor(url, { keepAliveSec = 20, onStatus } = {}) {
    this.url = url;
    this.keepAlive = keepAliveSec;
    this.onStatus = onStatus;
    this.status = 'closed';
    this.ws = null;
    this.stopped = true;
    this.retryMs = 1000;
    this.lastRx = 0;
    this.clientId = 'tt-' + Math.random().toString(36).slice(2, 12);
  }

  start() { this.stopped = false; this.open(); }
  stop() { this.stopped = true; clearTimeout(this.retryTimer); this.teardown(); this.set('closed'); }

  publish(topic, payload) {
    if (this.status !== 'open' || !this.ws) return false;
    try { this.ws.send(packet(0x30, [...str(topic), ...enc.encode(payload)])); } catch { return false; }
    return true;
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
    ws.onmessage = (e) => {
      this.lastRx = Date.now();
      const b = new Uint8Array(e.data);
      // We only need CONNACK (0x20); PINGRESP and anything else just count as "alive".
      if (b[0] === 0x20 && this.status !== 'open') {
        if (b[3] !== 0) { ws.close(); return; }
        this.retryMs = 1000;
        this.set('open');
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (Date.now() - this.lastRx > this.keepAlive * 2500) { ws.close(); return; }
          try { ws.send(new Uint8Array([0xc0, 0])); } catch { /* closing */ }
        }, this.keepAlive * 500);
      }
    };
    ws.onclose = () => { if (this.ws === ws) this.retry(); };
    ws.onerror = () => ws.close();
  }

  teardown() {
    clearInterval(this.pingTimer);
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
 * Sends crossings for one pairing code. Laps go to every broker and to ntfy;
 * pings (every 20 s, so the stopwatch can show "connected") go to the brokers
 * only, which keeps ntfy's daily message limit for the laps.
 */
export class LapSender {
  constructor({ brokers = DEFAULT_BROKERS, ntfy = DEFAULT_NTFY, onState, pingSec = 20 } = {}) {
    this.brokers = brokers;
    this.ntfy = ntfy;
    this.onState = onState;
    this.pingSec = pingSec;
    this.code = '';
    this.links = [];
    this.dev = Math.random().toString(36).slice(2, 10); // new id per page load
    this.seq = 0;
    this.queue = [];      // laps waiting for a broker to come back
    this.lastSent = null; // { lap, at, via: number of links that took it }
    this.ntfyOk = true;
  }

  setCode(code) {
    code = normalizeCode(code);
    if (code === this.code) return;
    this.stop();
    this.code = code;
    if (!code) { this.emit(); return; }
    this.links = this.brokers.map((url) => {
      const link = new MqttPublisher(url, { onStatus: (s) => { if (s === 'open') this.flush(); this.emit(); } });
      link.name = new URL(url).hostname;
      link.start();
      return link;
    });
    this.pingTimer = setInterval(() => this.ping(), this.pingSec * 1000);
    this.emit();
  }

  stop() {
    clearInterval(this.pingTimer);
    for (const l of this.links) l.stop();
    this.links = [];
    this.queue = [];
  }

  get connected() { return this.links.some((l) => l.status === 'open'); }

  message(type, at, lap) {
    const m = { v: 1, type, dev: this.dev, seq: ++this.seq, at: Math.round(at) };
    if (lap !== undefined) m.lap = lap;
    return JSON.stringify(m);
  }

  /** A lead crossing at phone time `at` (epoch ms). `lap` is 0 for the first crossing. */
  sendCrossing(at, lap) {
    if (!this.code) return;
    const msg = this.message('lap', at, lap);
    const topic = mqttTopic(this.code);
    let via = 0;
    for (const l of this.links) if (l.publish(topic, msg)) via++;
    if (via < this.links.length) this.queue.push({ msg, at, links: new Set(this.links.filter((l) => l.status !== 'open')) });
    if (this.ntfy && this.ntfyOk) {
      // A simple POST (text/plain) needs no CORS preflight.
      fetch(`${this.ntfy}/${ntfyTopic(this.code)}`, { method: 'POST', body: msg, keepalive: true })
        .then((r) => { if (r.status === 429) this.ntfyOk = false; })
        .catch(() => {});
      via++;
    }
    this.lastSent = { lap, at, via };
    this.emit();
  }

  /** Re-send laps that missed a broker while it was down (the stopwatch drops duplicates). */
  flush() {
    const topic = mqttTopic(this.code);
    const now = Date.now();
    this.queue = this.queue.filter((q) => {
      if (now - q.at > 60000) return false; // too old to matter
      for (const l of [...q.links]) if (l.publish(topic, q.msg)) q.links.delete(l);
      return q.links.size > 0;
    });
  }

  ping() {
    if (!this.code) return;
    const msg = this.message('ping', Date.now());
    for (const l of this.links) l.publish(mqttTopic(this.code), msg);
  }

  emit() {
    this.onState?.({
      code: this.code,
      links: this.links.map((l) => ({ name: l.name, status: l.status })),
      connected: this.connected,
      lastSent: this.lastSent,
    });
  }
}

/** Test hook: `?relay=ws://host:port[,more]` replaces the brokers, `?ntfy=off|URL`. */
export function linkOverrides(search) {
  const p = new URLSearchParams(search);
  const out = {};
  const relay = p.get('relay');
  if (relay) out.brokers = relay.split(',').filter(Boolean);
  const ntfy = p.get('ntfy');
  if (ntfy) out.ntfy = ntfy === 'off' ? null : ntfy;
  return out;
}
