/* ============================================================
   WebSocket-Anbindung mit automatischem Reconnect.
   Handy im Tunnel oder gesperrter Bildschirm sind kein Rauswurf:
   Die Sitzung hängt an einem Token im localStorage, nicht an der
   Verbindung.
   ============================================================ */

export class Net extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.queue = [];
    this.retry = 0;
    this.offset = 0;      // Serverzeit minus lokale Zeit
    this.connected = false;
    this.onOpenPayload = null;
    this.closed = false;
  }

  connect(openPayload) {
    if (openPayload) this.onOpenPayload = openPayload;
    this.closed = false;
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener('open', () => {
      this.connected = true;
      this.retry = 0;
      this.emit('status', { connected: true });
      if (this.onOpenPayload) this.ws.send(JSON.stringify(this.onOpenPayload));
      for (const msg of this.queue.splice(0)) this.ws.send(JSON.stringify(msg));
    });

    this.ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.t === 'state' && msg.serverNow) this.offset = msg.serverNow - Date.now();
      this.emit(msg.t, msg);
      this.emit('*', msg);
    });

    this.ws.addEventListener('close', () => {
      this.connected = false;
      this.emit('status', { connected: false });
      if (this.closed) return;
      // Exponentiell zurückweichen, aber nie länger als 8 Sekunden warten —
      // niemand will nach einem Funkloch eine halbe Minute zusehen.
      const wait = Math.min(8000, 400 * Math.pow(1.7, this.retry++));
      setTimeout(() => this.connect(), wait);
    });

    this.ws.addEventListener('error', () => this.ws?.close());
  }

  /** Serverzeit aus lokaler Sicht — Grundlage aller Countdowns. */
  now() {
    return Date.now() + this.offset;
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  disconnect() {
    this.closed = true;
    this.ws?.close();
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, handler) {
    this.addEventListener(type, (e) => handler(e.detail));
    return this;
  }
}

/** Sitzungsspeicher — überlebt Reload und Bildschirmsperre. */
export const session = {
  key: 'kickedout.session',
  load() {
    try { return JSON.parse(localStorage.getItem(this.key) || 'null'); } catch { return null; }
  },
  save(data) {
    try { localStorage.setItem(this.key, JSON.stringify(data)); } catch { /* Privatmodus */ }
  },
  clear() {
    try { localStorage.removeItem(this.key); } catch { /* egal */ }
  },
};
