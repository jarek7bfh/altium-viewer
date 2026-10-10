// Shared helpers for Altium parsing

// CP1252 mapping for 0x80-0x9F (rest of latin1 maps 1:1)
const CP1252 = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const utf8 = new TextDecoder('utf-8');

/** bytes -> "binary string" (one char per byte) */
export function bin(u8, start = 0, end = u8.length) {
  let s = '';
  const CH = 8192;
  for (let i = start; i < end; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(end, i + CH)));
  }
  return s;
}

function binToCp1252(s) {
  if (!/[\x80-\x9f]/.test(s)) return s;
  let o = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    o += CP1252[c] ? String.fromCharCode(CP1252[c]) : s[i];
  }
  return o;
}

function binToUtf8(s) {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return utf8.decode(u);
}

/** Parse Altium "|KEY=VALUE|KEY=VALUE" record (given as binary string). Keys upper-cased. */
export function parseProps(s) {
  const out = {};
  const parts = s.split('|');
  for (const kv of parts) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    let k = kv.slice(0, eq).toUpperCase();
    let v = kv.slice(eq + 1);
    if (k.startsWith('%UTF8%')) {
      k = k.slice(6);
      out[k] = binToUtf8(v);
      continue;
    }
    if (k in out) continue; // utf8 variant came first, keep it
    out[k] = binToCp1252(v);
  }
  return out;
}

/** Read text records with 4-byte length prefix (PCB streams like Components6/Data) */
export function textRecords32(u8) {
  const out = [];
  if (!u8) return out;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let i = 0;
  while (i + 4 <= u8.length) {
    const n = dv.getUint32(i, true); i += 4;
    let e = i + n;
    let end = e; while (end > i && u8[end - 1] === 0) end--;
    out.push(parseProps(bin(u8, i, end)));
    i = e;
  }
  return out;
}

/** "1234.5mil" -> 1234.5 (mil); also handles mm */
export function milVal(v, def = 0) {
  if (v == null || v === '') return def;
  const s = String(v).trim();
  const n = parseFloat(s);
  if (isNaN(n)) return def;
  if (/mm$/i.test(s)) return n / 0.0254;
  return n;
}

export const num = (v, def = 0) => {
  if (v == null || v === '') return def;
  const n = parseFloat(String(v).trim());
  return isNaN(n) ? def : n;
};
export const bool = (v) => v === 'T' || v === 'TRUE' || v === 'True' || v === 'true';

/** Altium color int (BGR) -> css */
export function color(v, def = '#000') {
  if (v == null || v === '') return def;
  const c = parseInt(v, 10);
  if (isNaN(c)) return def;
  const r = c & 255, g = (c >> 8) & 255, b = (c >> 16) & 255;
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Binary reader */
export class Reader {
  constructor(u8) {
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.p = 0;
    this.subEnd = -1;
  }
  get eof() { return this.p >= this.u8.length; }
  u8_() { return this.dv.getUint8(this.p++); }
  u16() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  skip(n) { this.p += n; }
  /** Altium internal unit (1e-4 mil) -> mil */
  unit() { return this.i32() / 10000; }
  sub() { const n = this.u32(); this.subStart = this.p; this.subEnd = this.p + n; return n; }
  endSub() { this.p = this.subEnd; }
  remaining() { return this.subEnd - this.p; }
  pstr() { const n = this.u8_(); const s = bin(this.u8, this.p, this.p + n); this.p += n; return binToCp1252(s); }
}
