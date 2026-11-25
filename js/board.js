// LED time board: shows the lead team's lap time on a 64x32 LED panel driven
// by an ESP32 (firmware: time-board/time_board.ino in the project files).
//
// The phone talks to the board over Bluetooth LE (Web Bluetooth, Chrome or
// Brave on Android, Chrome on a Mac). The board has one writable
// characteristic: we write the text to show ("23.8", "--"), or "!B<0-255>"
// to set the brightness.

export const BOARD_SERVICE = '7a1e0001-5c2b-4d8e-9f00-7472616b7469';
export const BOARD_TEXT = '7a1e0002-5c2b-4d8e-9f00-7472616b7469';

const enc = new TextEncoder();

export const boardSupported = () => !!(typeof navigator !== 'undefined' && navigator.bluetooth);

export class LapBoard {
  constructor({ onState } = {}) {
    this.onState = onState;
    this.device = null;
    this.char = null;
    this.state = 'off';        // off | connecting | on | lost
    this.last = '--';          // last text asked for, re-sent after a reconnect
    this.busy = false;
    this.next = null;
    this.retry = 0;
    this.timer = 0;
    this.wanted = false;       // user asked to be connected
  }

  emit(detail = '') {
    this.onState?.({ state: this.state, name: this.device?.name || '', detail, text: this.last });
  }

  /** Must be called from a click: the browser shows its device picker. */
  async connect() {
    if (!boardSupported()) throw new Error('This browser has no Bluetooth. Use Chrome on Android, or Brave with Web Bluetooth turned on.');
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [BOARD_SERVICE] }] });
    this.useDevice(device);
    await this.open();
  }

  /** Reconnect to a board picked in an earlier visit, if the browser allows it. */
  async restore() {
    if (!navigator.bluetooth?.getDevices) return false;
    try {
      const devs = await navigator.bluetooth.getDevices();
      const d = devs.find((x) => /TrackTime/i.test(x.name || '')) || null;
      if (!d) return false;
      this.useDevice(d);
      this.open().catch(() => {});
      return true;
    } catch { return false; }
  }

  useDevice(device) {
    if (this.device === device) return;
    this.device?.removeEventListener('gattserverdisconnected', this.onLost);
    this.device = device;
    this.onLost = () => this.lost();
    device.addEventListener('gattserverdisconnected', this.onLost);
  }

  async open() {
    if (!this.device) return;
    this.wanted = true;
    clearTimeout(this.timer);
    this.state = 'connecting'; this.emit();
    try {
      const server = await this.device.gatt.connect();
      const svc = await server.getPrimaryService(BOARD_SERVICE);
      this.char = await svc.getCharacteristic(BOARD_TEXT);
      this.state = 'on'; this.retry = 0; this.emit();
      this.write(this.last);
    } catch (e) {
      this.char = null;
      this.lost(e?.message);
    }
  }

  lost(detail) {
    this.char = null;
    if (!this.wanted) { this.state = 'off'; this.emit(); return; }
    this.state = 'lost'; this.emit(detail || 'Reconnecting…');
    clearTimeout(this.timer);
    const wait = Math.min(15000, 1000 * 2 ** this.retry++);
    this.timer = setTimeout(() => this.open(), wait);
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.timer);
    try { this.device?.gatt?.disconnect(); } catch { /* already gone */ }
    this.char = null;
    this.state = 'off'; this.emit();
  }

  /** Show text on the board (only the newest text is kept while a write is in flight). */
  show(text) {
    this.last = String(text);
    this.write(this.last);
  }

  brightness(level) {
    this.write(`!B${Math.max(0, Math.min(255, Math.round(level)))}`);
  }

  async write(text) {
    if (!this.char) return;
    if (this.busy) { this.next = text; return; }
    this.busy = true;
    try {
      const data = enc.encode(text);
      if (this.char.writeValueWithoutResponse) await this.char.writeValueWithoutResponse(data);
      else await this.char.writeValue(data);
    } catch (e) {
      this.emit(`Send failed: ${e?.message || e}`);
    } finally {
      this.busy = false;
      if (this.next !== null) { const n = this.next; this.next = null; this.write(n); }
    }
  }
}
