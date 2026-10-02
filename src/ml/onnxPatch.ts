/**
 * Minimal ONNX protobuf rewriter: converts float64 (DOUBLE) tensors inside node attributes and
 * value_info types to float32. onnxruntime-web's CPU kernels are compiled without double support
 * (e.g. ConstantOfShape(double) in HTDemucs' iSTFT), while the math is fine in float32
 * (verified: max abs diff 6e-8 on the 6-stem model). Weight blobs are copied untouched.
 */

const DOUBLE = 11, FLOAT = 1;

type Parts = { parts: Uint8Array[]; len: number };
const out = (): Parts => ({ parts: [], len: 0 });
const push = (p: Parts, b: Uint8Array) => {
  p.parts.push(b);
  p.len += b.length;
};

function readVarint(b: Uint8Array, pos: number): [number, number] {
  let x = 0, mul = 1, byte: number;
  do {
    byte = b[pos++];
    x += (byte & 0x7f) * mul;
    mul *= 128;
  } while (byte & 0x80);
  return [x, pos];
}

function varint(x: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) byte |= 0x80;
    bytes.push(byte);
  } while (x > 0);
  return Uint8Array.from(bytes);
}

interface Field {
  no: number;
  wt: number;
  start: number; // start of key
  vStart: number; // start of value (for wt 2: start of payload)
  end: number;
  num?: number; // varint value
}

function fields(b: Uint8Array, start: number, end: number): Field[] {
  const fs: Field[] = [];
  let pos = start;
  while (pos < end) {
    const s = pos;
    let key: number;
    [key, pos] = readVarint(b, pos);
    const no = Math.floor(key / 8), wt = key & 7;
    const f: Field = { no, wt, start: s, vStart: pos, end: pos };
    if (wt === 0) [f.num, pos] = readVarint(b, pos);
    else if (wt === 1) pos += 8;
    else if (wt === 5) pos += 4;
    else if (wt === 2) {
      let len: number;
      [len, pos] = readVarint(b, pos);
      f.vStart = pos;
      pos += len;
    } else throw new Error(`unsupported protobuf wire type ${wt}`);
    f.end = pos;
    fs.push(f);
  }
  return fs;
}

/** Emit a length-delimited field whose payload was rebuilt. */
function emitMsg(p: Parts, no: number, inner: Parts) {
  push(p, varint(no * 8 + 2));
  push(p, varint(inner.len));
  inner.parts.forEach((x) => push(p, x));
}

type Rewriter = (b: Uint8Array, s: number, e: number) => Parts;

/** Rewrite a message: listed fields go through their rewriter, everything else is copied verbatim. */
function message(b: Uint8Array, s: number, e: number, map: Record<number, Rewriter>): Parts {
  const p = out();
  for (const f of fields(b, s, e)) {
    const rw = f.wt === 2 ? map[f.no] : undefined;
    if (rw) emitMsg(p, f.no, rw(b, f.vStart, f.end));
    else push(p, b.subarray(f.start, f.end));
  }
  return p;
}

let patched = 0;

const tensor: Rewriter = (b, s, e) => {
  const fs = fields(b, s, e);
  const dt = fs.find((f) => f.no === 2 && f.wt === 0)?.num;
  if (dt !== DOUBLE) {
    const p = out();
    push(p, b.subarray(s, e));
    return p;
  }
  patched++;
  const p = out();
  const doubles: number[] = [];
  for (const f of fs) {
    if (f.no === 2 && f.wt === 0) {
      push(p, varint(2 * 8 + 0));
      push(p, varint(FLOAT));
    } else if (f.no === 9 && f.wt === 2) {
      // raw_data: little-endian float64 → float32
      const n = (f.end - f.vStart) / 8;
      const dv = new DataView(b.buffer, b.byteOffset + f.vStart, f.end - f.vStart);
      const f32 = new Float32Array(n);
      for (let i = 0; i < n; i++) f32[i] = dv.getFloat64(i * 8, true);
      push(p, varint(9 * 8 + 2));
      push(p, varint(f32.byteLength));
      push(p, new Uint8Array(f32.buffer));
    } else if (f.no === 10) {
      // double_data (packed or not) → collected into float_data
      const dv = new DataView(b.buffer, b.byteOffset + f.vStart, f.end - f.vStart);
      for (let i = 0; i + 8 <= f.end - f.vStart; i += 8) doubles.push(dv.getFloat64(i, true));
    } else push(p, b.subarray(f.start, f.end));
  }
  if (doubles.length) {
    const f32 = Float32Array.from(doubles);
    push(p, varint(4 * 8 + 2));
    push(p, varint(f32.byteLength));
    push(p, new Uint8Array(f32.buffer));
  }
  return p;
};

const tensorType: Rewriter = (b, s, e) => {
  const p = out();
  for (const f of fields(b, s, e)) {
    if (f.no === 1 && f.wt === 0 && f.num === DOUBLE) {
      push(p, varint(1 * 8 + 0));
      push(p, varint(FLOAT));
    } else push(p, b.subarray(f.start, f.end));
  }
  return p;
};
const typeProto: Rewriter = (b, s, e) => message(b, s, e, { 1: tensorType });
const valueInfo: Rewriter = (b, s, e) => message(b, s, e, { 2: typeProto });
const attribute: Rewriter = (b, s, e) => message(b, s, e, { 5: tensor, 6: graph, 10: graph });
const node: Rewriter = (b, s, e) => message(b, s, e, { 5: attribute });
function graph(b: Uint8Array, s: number, e: number): Parts {
  return message(b, s, e, { 1: node, 11: valueInfo, 12: valueInfo, 13: valueInfo });
}

/** Returns the patched model bytes and how many tensors were converted. */
export function patchDoublesToFloat(model: Uint8Array): { bytes: Uint8Array; patched: number } {
  patched = 0;
  const p = message(model, 0, model.length, { 7: graph });
  const bytes = new Uint8Array(p.len);
  let o = 0;
  for (const part of p.parts) {
    bytes.set(part, o);
    o += part.length;
  }
  return { bytes, patched };
}
