/* ============================================================
   Minimaler QR-Encoder (Byte-Modus, Fehlerkorrektur L, Version 1–5).
   Eigenimplementierung, weil das Spiel im WLAN einer Wohnung laufen
   soll: Ein QR-Dienst aus dem Netz wäre genau dann weg, wenn man ihn
   braucht. Version 1–5 sind einblockig — deshalb entfällt das
   Verschachteln der Codewörter komplett.

   Reicht für rund 100 Zeichen; das deckt jede Join-URL ab.
   ============================================================ */

// --- Galois-Feld GF(256), Primitivpolynom 0x11D -------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generatorpolynom für n Fehlerkorrektur-Codewörter. */
function generatorPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

/** Rest der Polynomdivision — die Fehlerkorrektur-Codewörter. */
export function reedSolomon(data, ecCount) {
  const gen = generatorPoly(ecCount);
  const buffer = [...data, ...new Array(ecCount).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const factor = buffer[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) buffer[i + j] ^= gfMul(gen[j], factor);
  }
  return buffer.slice(data.length);
}

// --- Versions-Tabellen (nur Fehlerkorrektur L, einblockig) --------------
const VERSIONS = [
  { v: 1, size: 21, data: 19, ec: 7, align: [] },
  { v: 2, size: 25, data: 34, ec: 10, align: [6, 18] },
  { v: 3, size: 29, data: 55, ec: 15, align: [6, 22] },
  { v: 4, size: 33, data: 80, ec: 20, align: [6, 26] },
  { v: 5, size: 37, data: 108, ec: 26, align: [6, 30] },
];

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** BCH(15,5) für die Formatinformation, danach die vorgeschriebene Maske. */
export function formatBits(eccLevelBits, mask) {
  const data = (eccLevelBits << 3) | mask;
  let rest = data << 10;
  for (let i = 14; i >= 10; i--) {
    if (rest & (1 << i)) rest ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rest) ^ 0x5412;
}

function pickVersion(byteLength) {
  for (const spec of VERSIONS) {
    // 4 Bit Modusindikator + 8 Bit Längenangabe (gilt für Version 1–9)
    const capacity = Math.floor((spec.data * 8 - 12) / 8);
    if (byteLength <= capacity) return spec;
  }
  return null;
}

function buildCodewords(bytes, spec) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);          // Byte-Modus
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);

  const capacityBits = spec.data * 8;
  push(0, Math.min(4, capacityBits - bits.length));       // Terminator
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  const PADS = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < spec.data) codewords.push(PADS[padIndex++ % 2]);

  return [...codewords, ...reedSolomon(codewords, spec.ec)];
}

function emptyMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function placeFunctionPatterns(m, spec) {
  const size = spec.size;
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const onBorder = (r === 0 || r === 6) && c >= 0 && c <= 6;
        const onSide = (c === 0 || c === 6) && r >= 0 && r <= 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[rr][cc] = onBorder || onSide || core ? 1 : 0;
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    m[6][i] = bit;
    m[i][6] = bit;
  }

  for (const r of spec.align) {
    for (const c of spec.align) {
      // Ecken mit Suchmustern bleiben frei.
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          m[r + dr][c + dc] = ring === 1 ? 0 : 1;
        }
      }
    }
  }

  m[size - 8][8] = 1; // immer dunkel

  // Plätze der Formatinformation reservieren.
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 2;
    if (m[i][8] === null) m[i][8] = 2;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 2;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 2;
  }
}

function placeData(m, codewords, size) {
  const bits = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  }
  let index = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // Zeitgeber-Spalte überspringen
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (m[row][col] !== null) continue;
        m[row][col] = index < bits.length ? bits[index] : 0;
        index++;
      }
    }
    upward = !upward;
  }
}

function applyFormat(m, size, mask) {
  const bits = formatBits(0b01, mask); // Fehlerkorrektur L
  const bit = (i) => (bits >> i) & 1;
  for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
  m[8][7] = bit(6);
  m[8][8] = bit(7);
  m[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);
  for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = bit(i);
  for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = bit(i);
}

/** Bewertung nach den vier Strafregeln der Norm — je kleiner, desto lesbarer. */
function penalty(grid, size) {
  let score = 0;
  const at = (r, c) => grid[r][c];

  for (let r = 0; r < size; r++) {
    for (let axis = 0; axis < 2; axis++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        const prev = axis ? at(c - 1, r) : at(r, c - 1);
        const cur = axis ? at(c, r) : at(r, c);
        if (cur === prev) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  const pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const rev = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      let okA = true;
      let okB = true;
      let okC = true;
      let okD = true;
      for (let i = 0; i < 11; i++) {
        if (at(r, c + i) !== pattern[i]) okA = false;
        if (at(r, c + i) !== rev[i]) okB = false;
        if (at(c + i, r) !== pattern[i]) okC = false;
        if (at(c + i, r) !== rev[i]) okD = false;
      }
      if (okA) score += 40;
      if (okB) score += 40;
      if (okC) score += 40;
      if (okD) score += 40;
    }
  }

  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (at(r, c)) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/**
 * @returns {{size:number, modules:number[][]}|null} null, wenn der Text zu lang ist.
 */
export function encodeQR(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const spec = pickVersion(bytes.length);
  if (!spec) return null;

  const codewords = buildCodewords(bytes, spec);
  const base = emptyMatrix(spec.size);
  placeFunctionPatterns(base, spec);
  // Merken, welche Felder Funktionsmuster sind — sie werden nicht maskiert.
  const reserved = base.map((row) => row.map((cell) => cell !== null));
  placeData(base, codewords, spec.size);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = base.map((row, r) => row.map((cell, c) => {
      if (reserved[r][c]) return cell === 2 ? 0 : cell;
      return MASKS[mask](r, c) ? cell ^ 1 : cell;
    }));
    applyFormat(grid, spec.size, mask);
    const score = penalty(grid, spec.size);
    if (!best || score < best.score) best = { score, grid };
  }
  return { size: spec.size, modules: best.grid, version: spec.v };
}

/** Zeichnet den Code auf ein Canvas — inklusive der vorgeschriebenen Ruhezone. */
export function drawQR(canvas, text, { scale = 5, quiet = 3, dark = '#1E1B4B', light = '#FFFFFF' } = {}) {
  const result = encodeQR(text);
  if (!result) return false;
  const { size, modules } = result;
  const px = (size + quiet * 2) * scale;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = dark;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  return true;
}
