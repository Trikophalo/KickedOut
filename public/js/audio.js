/* ============================================================
   Sound-Engine — vollständig synthetisiert (Web Audio).
   Kein einziges Audio-Asset: Das Spiel klingt auch dann, wenn es
   offline im WLAN einer Wohnung läuft, und das Repo bleibt schlank.

   Zwei Busse: Musik (nur auf der Bühne) und SFX (überall).
   Die Musik ist geschichtet — mit jeder Runde kommt eine Ebene dazu,
   Runde 5 klingt gefährlicher als Runde 1 (KONZEPT.md §3.1).
   ============================================================ */

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);

class Engine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.volumes = { music: 0.34, sfx: 0.85 };
    this.mood = 'off';
    this.intensity = 1;
    this.step = 0;
    this.nextNoteTime = 0;
    this.schedulerId = null;
  }

  /** Muss aus einer echten Nutzergeste heraus laufen (Autoplay-Sperren). */
  init() {
    if (this.ready) return true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    this.ctx = new Ctx();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.master.connect(this.limiter).connect(this.ctx.destination);

    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = this.volumes.music;
    this.musicBus.connect(this.master);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = this.volumes.sfx;
    this.sfxBus.connect(this.master);

    // Rauschen einmalig erzeugen und wiederverwenden.
    const len = this.ctx.sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.ready = true;
    return true;
  }

  resume() {
    if (this.ctx?.state === 'suspended') this.ctx.resume();
  }

  setVolume(kind, value) {
    this.volumes[kind] = value;
    if (!this.ready) return;
    const bus = kind === 'music' ? this.musicBus : this.sfxBus;
    bus.gain.setTargetAtTime(value, this.ctx.currentTime, 0.05);
  }

  get t() { return this.ctx.currentTime; }

  // ------------------------------------------------------------ Bausteine

  tone({ freq, dur = 0.2, type = 'sine', gain = 0.3, at = 0, attack = 0.005, release, bend, bus }) {
    if (!this.ready || !this.enabled) return;
    const start = this.t + at;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (bend) osc.frequency.exponentialRampToValueAtTime(Math.max(20, bend), start + dur);
    const rel = release ?? dur;
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, start + rel);
    osc.connect(env).connect(bus || this.sfxBus);
    osc.start(start);
    osc.stop(start + rel + 0.05);
  }

  noise({ dur = 0.2, gain = 0.3, at = 0, filter = 'bandpass', freq = 1200, q = 1, sweepTo, bus }) {
    if (!this.ready || !this.enabled) return;
    const start = this.t + at;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const biquad = this.ctx.createBiquadFilter();
    biquad.type = filter;
    biquad.frequency.setValueAtTime(freq, start);
    biquad.Q.value = q;
    if (sweepTo) biquad.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), start + dur);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(biquad).connect(env).connect(bus || this.sfxBus);
    src.start(start);
    src.stop(start + dur + 0.05);
  }

  arp(notes, { step = 0.08, type = 'triangle', gain = 0.26, dur = 0.22 } = {}) {
    notes.forEach((n, i) => this.tone({ freq: NOTE(n), at: i * step, dur, type, gain }));
  }

  /** Musik kurz wegdrücken, damit der Moderator gehört wird. */
  duck(ms = 2600) {
    if (!this.ready) return;
    const g = this.musicBus.gain;
    const t = this.t;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(this.volumes.music * 0.22, t, 0.05);
    g.setTargetAtTime(this.volumes.music, t + ms / 1000, 0.35);
  }

  // ------------------------------------------------------------ Cues

  play(name, opts = {}) {
    if (!this.ready || !this.enabled) return;
    this.resume();
    const cue = CUES[name];
    if (cue) cue(this, opts);
  }

  // ------------------------------------------------------------ Musik

  setMood(mood, intensity = 1) {
    if (!this.ready) return;
    this.intensity = Math.max(0, Math.min(4, intensity));
    if (mood === this.mood) return;
    this.mood = mood;
    this.step = 0;
    if (mood === 'off') return this.stopMusic();
    if (!this.schedulerId) {
      this.nextNoteTime = this.t + 0.1;
      this.schedulerId = setInterval(() => this.schedule(), 60);
    }
  }

  stopMusic() {
    if (this.schedulerId) clearInterval(this.schedulerId);
    this.schedulerId = null;
  }

  get tempo() {
    return ({ lobby: 0.42, round: 0.34, voting: 0.5, final: 0.24, results: 0.3 })[this.mood] || 0.4;
  }

  schedule() {
    if (!this.ready) return;
    const lookahead = 0.35;
    while (this.nextNoteTime < this.t + lookahead) {
      this.playStep(this.step, this.nextNoteTime);
      this.nextNoteTime += this.tempo;
      this.step++;
    }
  }

  /** Akkordfolgen je Stimmung — moll, damit auch die Lobby leicht bedrohlich bleibt. */
  progression() {
    switch (this.mood) {
      case 'voting': return [[45, 52, 57], [45, 52, 57], [44, 51, 56], [44, 51, 56]];
      case 'final':  return [[43, 50, 55, 62], [41, 48, 53, 60], [45, 52, 57, 64], [46, 53, 58, 65]];
      case 'results':return [[48, 55, 60, 64], [50, 57, 62, 65], [45, 52, 57, 64], [43, 50, 55, 62]];
      case 'lobby':  return [[45, 52, 57, 64], [48, 55, 60, 67], [43, 50, 55, 62], [46, 53, 58, 65]];
      default:       return [[45, 52, 57, 64], [43, 50, 55, 62], [48, 55, 60, 67], [46, 53, 58, 65]];
    }
  }

  playStep(step, when) {
    const chords = this.progression();
    const bar = Math.floor(step / 4) % chords.length;
    const beat = step % 4;
    const chord = chords[bar];
    const at = when - this.t;
    if (at < -0.05) return;
    const bus = this.musicBus;

    // Ebene 1 — Pad. Immer da.
    if (beat === 0) {
      for (const n of chord) {
        this.tone({ freq: NOTE(n), at, dur: this.tempo * 3.6, type: 'sine', gain: 0.075, attack: 0.35, bus });
      }
    }
    // Ebene 2 — Bass ab Runde 2.
    if (this.intensity >= 2 && beat % 2 === 0) {
      this.tone({ freq: NOTE(chord[0] - 12), at, dur: this.tempo * 0.9, type: 'triangle', gain: 0.12, bus });
    }
    // Ebene 3 — Puls ab Runde 3.
    if (this.intensity >= 3) {
      this.noise({ at, dur: 0.05, gain: beat === 0 ? 0.05 : 0.025, filter: 'highpass', freq: 7000, bus });
    }
    // Ebene 4 — Melodiefigur ab Runde 4.
    if (this.intensity >= 4 && beat === 3) {
      this.tone({ freq: NOTE(chord[chord.length - 1] + 12), at, dur: this.tempo * 0.8, type: 'triangle', gain: 0.07, bus });
    }
    // Voting bekommt einen eigenen tiefen Herzschlag statt Melodie.
    if (this.mood === 'voting' && beat % 2 === 0) {
      this.tone({ freq: 58, at, dur: 0.3, type: 'sine', gain: 0.16, bend: 40, bus });
    }
  }
}

/* ------------------------------------------------------------------
   Die Cue-Bibliothek. Jede Zeile ist ein Moment aus der Trigger-Matrix
   des Konzepts (§3.2) — von „Spieler joint" bis „Sieger-Fanfare".
   ------------------------------------------------------------------ */
const CUES = {
  join: (a) => { a.tone({ freq: 520, dur: 0.16, type: 'sine', gain: 0.3, bend: 880 }); },
  leave: (a) => { a.tone({ freq: 500, dur: 0.2, type: 'sine', gain: 0.25, bend: 220 }); },
  ready: (a) => { a.arp([69, 76], { step: 0.09, gain: 0.3 }); },
  tap: (a) => { a.tone({ freq: 900, dur: 0.05, type: 'square', gain: 0.12 }); },

  // Ein satter „Thock" — das haptische Herz des Antwort-Buttons.
  lock: (a) => {
    a.tone({ freq: 190, dur: 0.13, type: 'sine', gain: 0.42, bend: 90 });
    a.noise({ dur: 0.05, gain: 0.14, filter: 'lowpass', freq: 2400 });
  },

  count: (a, { last } = {}) => {
    a.tone({ freq: last ? 780 : 520, dur: 0.12, type: 'square', gain: 0.22 });
  },

  gameStart: (a) => {
    a.arp([57, 60, 64, 69, 72], { step: 0.085, type: 'sawtooth', gain: 0.2, dur: 0.4 });
    a.noise({ at: 0.42, dur: 0.7, gain: 0.16, filter: 'lowpass', freq: 400, sweepTo: 3000 });
  },

  questionIn: (a) => {
    a.noise({ dur: 0.28, gain: 0.16, filter: 'bandpass', freq: 500, sweepTo: 4200, q: 0.6 });
    a.tone({ freq: 300, at: 0.16, dur: 0.09, type: 'square', gain: 0.16, bend: 620 });
  },

  tick: (a) => { a.tone({ freq: 1250, dur: 0.035, type: 'square', gain: 0.11 }); },
  heartbeat: (a) => {
    a.tone({ freq: 62, dur: 0.14, type: 'sine', gain: 0.4, bend: 38 });
    a.tone({ freq: 58, at: 0.19, dur: 0.12, type: 'sine', gain: 0.26, bend: 34 });
  },

  correct: (a) => { a.arp([72, 76, 79, 84], { step: 0.062, type: 'triangle', gain: 0.3, dur: 0.3 }); },
  wrong: (a) => {
    a.tone({ freq: 200, dur: 0.32, type: 'sawtooth', gain: 0.26, bend: 82 });
    a.noise({ dur: 0.18, gain: 0.1, filter: 'lowpass', freq: 900 });
  },
  allWrong: (a) => {
    a.tone({ freq: 160, dur: 0.5, type: 'sawtooth', gain: 0.24, bend: 62 });
    a.tone({ freq: 155, at: 0.05, dur: 0.5, type: 'sawtooth', gain: 0.18, bend: 60 });
  },

  coins: (a, { n = 6 } = {}) => {
    for (let i = 0; i < n; i++) {
      a.tone({ freq: 1500 + Math.random() * 900, at: i * 0.045, dur: 0.06, type: 'square', gain: 0.09 });
    }
  },

  // Amboss: metallischer Anschlag plus Funkenrauschen.
  forge: (a, { chain = 2 } = {}) => {
    const base = 520 + chain * 70;
    a.tone({ freq: base, dur: 0.5, type: 'triangle', gain: 0.3 });
    a.tone({ freq: base * 1.5, dur: 0.42, type: 'sine', gain: 0.2 });
    a.tone({ freq: base * 2.66, dur: 0.34, type: 'sine', gain: 0.12 });
    a.noise({ dur: 0.16, gain: 0.15, filter: 'highpass', freq: 4200 });
  },

  // Eiszeit: Knacken, dann Glassplitter.
  freeze: (a) => {
    a.noise({ dur: 0.16, gain: 0.24, filter: 'bandpass', freq: 2600, sweepTo: 480, q: 2.5 });
    for (let i = 0; i < 7; i++) {
      a.tone({ freq: 2000 + Math.random() * 2600, at: 0.1 + i * 0.035, dur: 0.1, type: 'triangle', gain: 0.11 });
    }
    a.tone({ freq: 300, at: 0.05, dur: 0.6, type: 'sine', gain: 0.26, bend: 70 });
  },

  votingOpen: (a) => {
    a.tone({ freq: 110, dur: 1.5, type: 'sine', gain: 0.24, attack: 0.5 });
    a.tone({ freq: 165, dur: 1.4, type: 'sine', gain: 0.14, attack: 0.6 });
    a.noise({ dur: 1.2, gain: 0.05, filter: 'lowpass', freq: 300, sweepTo: 1400 });
  },

  voteCast: (a) => {
    a.noise({ dur: 0.16, gain: 0.13, filter: 'highpass', freq: 3000, sweepTo: 900 });
    a.tone({ freq: 150, at: 0.14, dur: 0.09, type: 'square', gain: 0.3, bend: 70 });
  },

  drumroll: (a, { dur = 1.6 } = {}) => {
    for (let i = 0; i < dur * 24; i++) {
      a.noise({ at: i / 24, dur: 0.035, gain: 0.05 + (i / (dur * 24)) * 0.09, filter: 'bandpass', freq: 260, q: 1.2 });
    }
  },

  cardFlap: (a, { i = 0 } = {}) => {
    a.noise({ at: i * 0.02, dur: 0.09, gain: 0.12, filter: 'bandpass', freq: 1600, sweepTo: 700, q: 0.8 });
    a.tone({ freq: 240, at: 0.06 + i * 0.02, dur: 0.07, type: 'sine', gain: 0.2, bend: 120 });
  },

  tiebreak: (a) => {
    a.tone({ freq: 880, dur: 0.14, type: 'square', gain: 0.22 });
    a.tone({ freq: 660, at: 0.16, dur: 0.14, type: 'square', gain: 0.22 });
    a.tone({ freq: 880, at: 0.32, dur: 0.2, type: 'square', gain: 0.22 });
  },

  // Der Rausschmiss. Boing, Cartoon-Schrei, Türknall.
  eliminate: (a) => {
    a.tone({ freq: 420, dur: 0.42, type: 'sine', gain: 0.34, bend: 90 });
    a.tone({ freq: 700, at: 0.1, dur: 0.5, type: 'triangle', gain: 0.22, bend: 130 });
    a.noise({ at: 0.5, dur: 0.28, gain: 0.34, filter: 'lowpass', freq: 260 });
    a.tone({ freq: 70, at: 0.5, dur: 0.4, type: 'sine', gain: 0.42, bend: 38 });
  },

  ghost: (a) => {
    a.noise({ dur: 0.55, gain: 0.09, filter: 'bandpass', freq: 700, sweepTo: 2400, q: 3 });
    a.tone({ freq: 330, dur: 0.5, type: 'sine', gain: 0.13, bend: 620 });
  },

  versus: (a) => {
    a.noise({ dur: 0.5, gain: 0.2, filter: 'lowpass', freq: 220, sweepTo: 2600 });
    a.arp([45, 52, 57, 64], { step: 0.05, type: 'sawtooth', gain: 0.22, dur: 0.7 });
    a.tone({ freq: 55, at: 0.35, dur: 0.7, type: 'sine', gain: 0.4 });
  },

  finalPoint: (a) => { a.arp([76, 81, 88], { step: 0.07, type: 'triangle', gain: 0.28, dur: 0.34 }); },
  matchPoint: (a) => {
    a.tone({ freq: 44, dur: 1.6, type: 'sine', gain: 0.3, attack: 0.2 });
    a.tone({ freq: 66, dur: 1.5, type: 'sawtooth', gain: 0.09, attack: 0.4 });
  },

  fanfare: (a) => {
    const melody = [72, 76, 79, 84, 79, 84, 88];
    melody.forEach((n, i) => {
      a.tone({ freq: NOTE(n), at: i * 0.11, dur: i === melody.length - 1 ? 1.1 : 0.24, type: 'sawtooth', gain: 0.2 });
      a.tone({ freq: NOTE(n - 12), at: i * 0.11, dur: 0.24, type: 'triangle', gain: 0.13 });
    });
    for (let i = 0; i < 3; i++) {
      a.noise({ at: 0.65 + i * 0.16, dur: 0.22, gain: 0.2, filter: 'bandpass', freq: 900 + i * 500, sweepTo: 240 });
    }
  },

  award: (a) => { a.arp([79, 83, 86], { step: 0.06, type: 'triangle', gain: 0.22, dur: 0.24 }); },
  emoji: (a) => { a.tone({ freq: 1400 + Math.random() * 800, dur: 0.05, type: 'sine', gain: 0.07 }); },
  toast: (a) => { a.arp([76, 81], { step: 0.06, gain: 0.16, dur: 0.16 }); },
  error: (a) => { a.tone({ freq: 240, dur: 0.22, type: 'square', gain: 0.2, bend: 150 }); },
};

export const audio = new Engine();

/** Vibration — auf Android da, auf iOS Safari nicht. Immer nur Würze, nie Information. */
export function buzz(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* nicht unterstützt */ }
}

export const BUZZ = {
  tap: 12,
  lock: [18],
  correct: [22, 40, 22],
  wrong: [90],
  chainBreak: [200],
  eliminated: [70, 60, 70, 60, 260],
  win: [40, 50, 40, 50, 40, 50, 220],
  matchPoint: [30, 90, 30],
};
