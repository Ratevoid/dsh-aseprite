/* dsh-aseprite client bundle — built by scripts/build.mjs. DO NOT EDIT. */
window.__ModuleLoader__.load({
	id: "dsh-aseprite",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

/**
 * dsh-aseprite: Aseprite (.aseprite / .ase) binary codec.
 *
 * Pure JS, no dependencies. Reads and writes the official file format
 * (docs/ase-file-specs.md from the Aseprite repo). Normalizes everything to
 * RGBA internally (mode "rgba") so file-format details don't leak into the
 * editor's document model.
 *
 * Reader handles: RGBA(32) / grayscale(16) / indexed(8) via palette, raw +
 * ZLIB image cels (types 0 & 2), linked cels (1), old (0x0004/0x0011) and new
 * (0x2019) palette chunks, frame tags (0x2018), and skips unknown chunks by
 * length. Writer emits RGBA with raw cels, a new-style palette chunk, and
 * frame tags so files open straight in Aseprite with no external dependency.
 */
class ASEError extends Error {
  constructor(message) { super(message); this.name = 'ASEError' }
}

class Reader {
  constructor(bytes) { this.b = bytes; this.o = 0 }
  get remaining() { return this.b.length - this.o }
  u8() { if (this.o + 1 > this.b.length) throw new ASEError('truncated file'); return this.b[this.o++] }
  u16() {
    if (this.o + 2 > this.b.length) throw new ASEError('truncated file')
    const v = this.b[this.o] | (this.b[this.o + 1] << 8); this.o += 2; return v
  }
  s16() { const v = this.u16(); return v >= 0x8000 ? v - 0x10000 : v }
  u32() {
    if (this.o + 4 > this.b.length) throw new ASEError('truncated file')
    let v = 0; for (let i = 0; i < 4; i++) v |= this.b[this.o + i] << (8 * i); this.o += 4; return v >>> 0
  }
  s32() { const v = this.u32(); return v >= 0x80000000 ? v - 0x100000000 : v }
  skip(n) { if (this.o + n > this.b.length) throw new ASEError('truncated file'); this.o += n }
  string() { const len = this.u16(); const o = this.o; this.o += len; return new TextDecoder().decode(this.b.subarray(o, o + len)) }
  bytes(n) { if (this.o + n > this.b.length) throw new ASEError('truncated file'); const out = this.b.subarray(this.o, this.o + n); this.o += n; return out }
}

function emptyDoc(width, height, frames = 1, duration = 100) {
  const fr = []
  for (let i = 0; i < frames; i++) fr.push({ duration })
  return {
    width, height, mode: 'rgba',
    frames: fr,
    layers: [{ name: 'Layer 1', visible: true, opacity: 255, blendMode: 0 }],
    cels: new Map(),
    palette: [{ r: 0, g: 0, b: 0, a: 255, name: 'Black' }, { r: 255, g: 255, b: 255, a: 255, name: 'White' }],
    tags: [],
    meta: { colorDepth: 32 }
  }
}

function makeCel(doc, frameIdx, layerIdx) {
  const data = new Uint8ClampedArray(doc.width * doc.height * 4)
  const cel = { x: 0, y: 0, w: doc.width, h: doc.height, data }
  doc.cels.set(frameIdx + ':' + layerIdx, cel)
  return cel
}
function getCel(doc, frameIdx, layerIdx) {
  const key = frameIdx + ':' + layerIdx
  return doc.cels.get(key) ?? makeCel(doc, frameIdx, layerIdx)
}

async function inflateAsync(zlibBuffer) {
  if (typeof DecompressionStream === 'undefined') throw new ASEError('no DecompressionStream')
  const stream = new Blob([zlibBuffer.slice(0)]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function decodePixels(bytes, width, height, depth, palette) {
  const out = new Uint8ClampedArray(width * height * 4)
  let p = 0
  const n = width * height
  if (depth === 32) {
    for (let i = 0; i < n; i++) { out[p++] = bytes[i*4]; out[p++] = bytes[i*4+1]; out[p++] = bytes[i*4+2]; out[p++] = bytes[i*4+3] }
  } else if (depth === 16) {
    for (let i = 0; i < n; i++) { const v = bytes[i*2], a = bytes[i*2+1]; out[p++]=v; out[p++]=v; out[p++]=v; out[p++]=a }
  } else if (depth === 8) {
    for (let i = 0; i < n; i++) { const c = palette[bytes[i]] ?? { r:0,g:0,b:0,a:255 }; out[p++]=c.r; out[p++]=c.g; out[p++]=c.b; out[p++]=c.a }
  } else throw new ASEError('unsupported color depth ' + depth)
  return out
}

function parseOldPalette(r, into, scale) {
  const packets = r.u16(); let pos = 0
  for (let i = 0; i < packets; i++) {
    const skip = r.u8(); let n = r.u8(); if (n === 0) n = 256
    pos += skip
    for (let j = 0; j < n; j++) {
      into[pos++] = { r: Math.round(r.u8() * scale), g: Math.round(r.u8() * scale), b: Math.round(r.u8() * scale), a: 255, name: '' }
    }
  }
}
function parseNewPalette(r, into) {
  r.u32(); const first = r.u32(); const last = r.u32(); r.skip(8)
  for (let i = first; i <= last; i++) {
    const flags = r.u16(); const a = r.bytes(4); let name = ''
    if (flags & 1) name = r.string()
    into[i] = { r: a[0], g: a[1], b: a[2], a: a[3], name }
  }
}

async function parseAseprite(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const r = new Reader(bytes)
  const fileSize = r.u32()
  const magic = r.u16()
  if (magic !== 0xa5e0) throw new ASEError('not an .aseprite file (magic 0x' + magic.toString(16) + ')')
  const frameCount = r.u16()
  const width = r.u16()
  const height = r.u16()
  if (width === 0 || height === 0) throw new ASEError('sprite has zero dimension')
  const depth = r.u16()
  const flags = r.u32()
  const legacySpeed = r.u16()
  r.skip(8); r.skip(1); r.skip(3); r.skip(2); r.skip(2); r.skip(8); r.skip(84)
  if (r.o !== 128) throw new ASEError('header is ' + r.o + ' bytes, expected 128')

  const doc = emptyDoc(width, height, frameCount, legacySpeed || 100)
  doc.meta.colorDepth = depth
  doc.meta.legacySpeed = legacySpeed

  const layers = []
  const buffer = Array.from({ length: 256 }, (_, i) => ({ r: i, g: i, b: i, a: 255, name: '' }))
  let sawNewPalette = false
  doc.palette = []

  for (let f = 0; f < frameCount; f++) {
    const frameSize = r.u32()
    const frameEnd = r.o + frameSize - 4
    const frameMagic = r.u16()
    if (frameMagic !== 0xf1fa) throw new ASEError('bad frame magic 0x' + frameMagic.toString(16))
    const oldChunks = r.u16()
    const duration = r.u16()
    r.skip(2)
    const newChunks = r.u32()
    const chunkCount = newChunks !== 0 ? newChunks : oldChunks
    if (duration > 0) doc.frames[f].duration = duration

    for (let c = 0; c < chunkCount; c++) {
      const chunkBase = r.o
      const chunkSize = r.u32()
      const chunkType = r.u16()

      switch (chunkType) {
        case 0x2004: {
          const lflags = r.u16(); const ltype = r.u16(); const childLevel = r.u16()
          r.skip(4); const blendMode = r.u16(); const opacity = r.u8(); r.skip(3)
          const name = r.string()
          if (ltype === 2) r.skip(4)
          if (flags & 4) r.skip(16)
          if (f === 0) layers.push({ name, visible: (lflags & 1) !== 0, opacity, blendMode, childLevel, lflags, type: ltype })
          break
        }
        case 0x2005: {
          const layerIdx = r.u16(); const x = r.s16(); const y = r.s16()
          r.u8(); const celType = r.u16(); r.s16(); r.skip(5)
          const layer = layers[layerIdx]
          if (!layer) throw new ASEError('cel references missing layer ' + layerIdx)
          if (celType === 0) {
            const w = r.u16(); const h = r.u16()
            const raw = r.bytes(w * h * (depth / 8))
            doc.cels.set(f + ':' + layerIdx, { x, y, w, h, data: decodePixels(raw, w, h, depth, buffer) })
          } else if (celType === 1) {
            const linkFrame = r.u16()
            const src = doc.cels.get(linkFrame + ':' + layerIdx)
            if (src) doc.cels.set(f + ':' + layerIdx, { x: src.x, y: src.y, w: src.w, h: src.h, data: new Uint8ClampedArray(src.data) })
          } else if (celType === 2) {
            const w = r.u16(); const h = r.u16()
            // No explicit length field: the ZLIB stream runs to the chunk's end.
            const byteLen = chunkBase + chunkSize - r.o
            if (byteLen < 0) throw new ASEError('compressed cel out of bounds')
            const compressed = r.bytes(byteLen)
            const raw = await inflateAsync(compressed)
            doc.cels.set(f + ':' + layerIdx, { x, y, w, h, data: decodePixels(raw, w, h, depth, buffer) })
          }
          break
        }
        case 0x2019: {
          sawNewPalette = true
          parseNewPalette(r, buffer)
          doc.palette = buffer.map((c) => ({ r: c.r, g: c.g, b: c.b, a: c.a, name: c.name }))
          break
        }
        case 0x0004: if (!sawNewPalette) { parseOldPalette(r, buffer, 1); doc.palette = buffer.map((c) => ({ ...c })) } break
        case 0x0011: if (!sawNewPalette) { parseOldPalette(r, buffer, 255 / 63); doc.palette = buffer.map((c) => ({ ...c })) } break
        case 0x2018: {
          const tagCount = r.u16(); r.skip(8)
          for (let t = 0; t < tagCount; t++) {
            const from = r.u16(); const to = r.u16(); const loopDir = r.u8(); const repeat = r.u16()
            r.skip(6); const color = { r: r.u8(), g: r.u8(), b: r.u8() }; r.u8(); const name = r.string()
            doc.tags.push({ from, to, name, loopDir, repeat, color })
          }
          break
        }
        default: break
      }

      const consumed = r.o - chunkBase
      if (consumed < chunkSize) r.skip(chunkSize - consumed)
      else if (consumed > chunkSize) throw new ASEError('chunk ' + chunkType.toString(16) + ' overran its bounds')
    }

    if (r.o < frameEnd) r.skip(frameEnd - r.o)
    else if (r.o > frameEnd) r.o = frameEnd
  }

  if (doc.palette.length === 0) doc.palette = [{ r: 0, g: 0, b: 0, a: 255, name: 'Black' }, { r: 255, g: 255, b: 255, a: 255, name: 'White' }]
  doc.layers = layers
  if (doc.layers.length === 0) doc.layers = [{ name: 'Layer 1', visible: true, opacity: 255, blendMode: 0, childLevel: 0, lflags: 0, type: 0 }]
  return doc
}

const isLE = true
class Writer {
  constructor() { this.chunks = [] }
  get length() { return this.chunks.reduce((n, c) => n + c.length, 0) }
  u8(v) { this.chunks.push(Uint8Array.from([v & 0xff])) }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xffff, isLE); this.chunks.push(b) }
  s16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v, isLE); this.chunks.push(b) }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, isLE); this.chunks.push(b) }
  zero(n) { this.chunks.push(new Uint8Array(n)) }
  raw(b) { this.chunks.push(b instanceof Uint8Array ? b : new Uint8Array(b)) }
  string(s) { const bytes = new TextEncoder().encode(s); this.u16(bytes.length); this.raw(bytes) }
  concat() { const out = new Uint8Array(this.length); let o = 0; for (const c of this.chunks) { out.set(c, o); o += c.length } return out }
}

function buildPaletteChunk(palette) {
  const w = new Writer()
  const list = []
  for (let i = 0; i < 256; i++) {
    const c = palette[i] ?? { r: 0, g: 0, b: 0, a: 0, name: '' }
    list.push(c)
  }
  w.u32(256); w.u32(0); w.u32(255); w.zero(8)
  for (const c of list) {
    const hasName = c.name !== undefined && String(c.name).length > 0
    w.u16(hasName ? 1 : 0)
    w.u8(c.r & 0xff); w.u8(c.g & 0xff); w.u8(c.b & 0xff); w.u8(c.a & 0xff)
    if (hasName) w.string(String(c.name))
  }
  return { type: 0x2019, data: w.concat() }
}

function buildLayerChunk(layer, index) {
  const w = new Writer()
  let lflags = (layer.visible ? 1 : 0)
  if (index === 0 && (layer.lflags & 8)) lflags |= 8
  w.u16(lflags); w.u16(layer.type ?? 0); w.u16(layer.childLevel ?? 0)
  w.u16(0); w.u16(0); w.u16(layer.blendMode ?? 0); w.u8(layer.opacity ?? 255); w.zero(3)
  w.string(layer.name ?? 'Layer ' + (index + 1))
  return { type: 0x2004, data: w.concat() }
}

function buildCelChunk(cel, layerIdx) {
  const w = new Writer()
  w.u16(layerIdx); w.s16(cel.x); w.s16(cel.y); w.u8(255); w.u16(0)
  w.s16(0); w.zero(5); w.u16(cel.w); w.u16(cel.h); w.raw(cel.data.slice(0))
  return { type: 0x2005, data: w.concat() }
}

function buildTagsChunk(tags) {
  if (tags.length === 0) return null
  const w = new Writer(); w.u16(tags.length); w.zero(8)
  for (const tag of tags) {
    w.u16(tag.from); w.u16(tag.to); w.u8(tag.loopDir ?? 0); w.u16(tag.repeat ?? 0)
    w.zero(6); w.u8(tag.color?.r ?? 128); w.u8(tag.color?.g ?? 128); w.u8(tag.color?.b ?? 128); w.u8(0)
    w.string(tag.name ?? '')
  }
  return { type: 0x2018, data: w.concat() }
}

function serializeAseprite(doc) {
  const width = doc.width
  const height = doc.height
  const frames = doc.frames.length
  const frameBodies = []
  const layerChunks = doc.layers.map((layer, i) => buildLayerChunk(layer, i))
  const paletteChunk = buildPaletteChunk(doc.palette)
  const tagsChunk = buildTagsChunk(doc.tags)

  for (let f = 0; f < frames; f++) {
    const chunks = []
    if (f === 0) {
      for (const c of layerChunks) chunks.push(c)
      chunks.push(paletteChunk)
      if (tagsChunk) chunks.push(tagsChunk)
    }
    for (let l = 0; l < doc.layers.length; l++) {
      const cel = doc.cels.get(f + ':' + l)
      if (cel) chunks.push(buildCelChunk(cel, l))
    }
    const w = new Writer()
    for (const c of chunks) { w.u32(6 + c.data.length); w.u16(c.type); w.raw(c.data) }
    frameBodies.push(w.concat())
  }

  const totalLen = 128 + frameBodies.reduce((n, b) => n + 16 + b.length, 0)
  const all = new Uint8Array(totalLen)
  const view = new DataView(all.buffer)
  view.setUint32(0, totalLen, isLE)
  view.setUint16(4, 0xa5e0, isLE)
  view.setUint16(6, frames, isLE)
  view.setUint16(8, width, isLE)
  view.setUint16(10, height, isLE)
  view.setUint16(12, 32, isLE)
  view.setUint32(14, 1, isLE)
  view.setUint16(18, doc.frames[0]?.duration ?? 100, isLE)
  let o = 128
  for (let f = 0; f < frames; f++) {
    const body = frameBodies[f]
    const nChunks = chunkCountFor(body)
    view.setUint32(o, 16 + body.length, isLE)
    view.setUint16(o + 4, 0xf1fa, isLE)
    view.setUint16(o + 6, 0xffff, isLE)
    view.setUint16(o + 8, doc.frames[f].duration ?? 100, isLE)
    view.setUint16(o + 10, 0, isLE)
    view.setUint32(o + 12, nChunks, isLE)
    all.set(body, o + 16)
    o += 16 + body.length
  }
  return all
}

function chunkCountFor(body) {
  let n = 0, o = 0
  while (o < body.length) {
    const size = (body[o] | (body[o+1] << 8) | (body[o+2] << 16) | (body[o+3] << 24)) >>> 0
    if (size < 6) return n
    o += size; n++
  }
  return n
}


/**
 * dsh-aseprite editor model: pure document operations over the normalized
 * sprite document (see ase-codec.js). Everything mutates a deep-ish copy so
 * React state can swap in a new version; undo is a snapshot stack keyed on the
 * touched cel(s).
 */
/** Clone a cel's pixel data. */
function cloneCel(cel) {
  if (!cel) return null
  return { x: cel.x, y: cel.y, w: cel.w, h: cel.h, data: new Uint8ClampedArray(cel.data) }
}

/** Deep-clone a document (cels included). */
function cloneDoc(doc) {
  const cels = new Map()
  for (const [k, v] of doc.cels) cels.set(k, cloneCel(v))
  return {
    width: doc.width,
    height: doc.height,
    mode: doc.mode,
    frames: doc.frames.map((f) => ({ duration: f.duration })),
    layers: doc.layers.map((l) => ({ ...l })),
    cels,
    palette: doc.palette.map((c) => ({ ...c })),
    tags: doc.tags.map((t) => ({ ...t })),
    meta: { ...doc.meta }
  }
}

/** The default brush color (opaque black). */
const DEFAULT_COLOR = { r: 0, g: 0, b: 0, a: 255 }

function newSprite(width, height, frames = 1, duration = 100, layers = 1) {
  const doc = emptyDoc(width, height, frames, duration)
  doc.layers = []
  for (let i = 0; i < layers; i++) {
    doc.layers.push({
      name: i === 0 ? 'Layer 1' : 'Layer ' + (i + 1),
      visible: true,
      opacity: 255,
      blendMode: 0,
      childLevel: 0,
      lflags: i === 0 ? 1 : 1,
      type: 0
    })
  }
  return doc
}

/**
 * A tiny undo/redo manager over whole documents. Call push(doc) before
 * mutating; snapshot() captures the current doc; undo/redo restore snapshots.
 */
class History {
  constructor(initial) {
    this.stack = [cloneDoc(initial)]
    this.index = 0
    this.cap = 50
  }
  snapshot() {
    this.stack = this.stack.slice(0, this.index + 1)
    this.stack.push(cloneDoc(this.stack[this.index]))
    if (this.stack.length > this.cap) this.stack.shift()
    this.index = this.stack.length - 1
  }
  canUndo() { return this.index > 0 }
  canRedo() { return this.index < this.stack.length - 1 }
  undo() {
    if (!this.canUndo()) return null
    this.index--
    return cloneDoc(this.stack[this.index])
  }
  redo() {
    if (!this.canRedo()) return null
    this.index++
    return cloneDoc(this.stack[this.index])
  }
  reset(doc) {
    this.stack = [cloneDoc(doc)]
    this.index = 0
  }
}

// ── pixel helpers ───────────────────────────────────────────────────────────

/** Index into a full-canvas cel buffer. */
function idx(doc, cel, x, y) {
  return (y * doc.width + x) * 4
}

/** Get or create the full-canvas cel for (frame, layer). */
function ensureCel(doc, frameIdx, layerIdx) {
  const key = frameIdx + ':' + layerIdx
  let cel = doc.cels.get(key)
  if (!cel || cel.w !== doc.width || cel.h !== doc.height) {
    const data = new Uint8ClampedArray(doc.width * doc.height * 4)
    if (cel) {
      // blit existing smaller cel at its offset
      for (let y = 0; y < cel.h; y++) {
        for (let x = 0; x < cel.w; x++) {
          const sx = x + cel.x, sy = y + cel.y
          if (sx < 0 || sx >= doc.width || sy < 0 || sy >= doc.height) continue
          const si = (y * cel.w + x) * 4
          const di = idx(doc, { w: doc.width, h: doc.height }, sx, sy)
          data[di] = cel.data[si]; data[di+1] = cel.data[si+1]; data[di+2] = cel.data[si+2]; data[di+3] = cel.data[si+3]
        }
      }
    }
    cel = { x: 0, y: 0, w: doc.width, h: doc.height, data }
    doc.cels.set(key, cel)
  }
  return cel
}

/** Composite the visible layers of a frame into an RGBA buffer (bottom to top). */
function compositeFrame(doc, frameIdx, into) {
  const w = doc.width, h = doc.height
  into.fill(0)
  for (let l = 0; l < doc.layers.length; l++) {
    const layer = doc.layers[l]
    if (!layer.visible) continue
    const cel = doc.cels.get(frameIdx + ':' + l)
    if (!cel) continue
    const opacity = layer.opacity / 255
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = (y * w + x) * 4
        const a = cel.data[si + 3]
        if (a === 0) continue
        const di = si
        if (opacity >= 1 && a >= 255) {
          into[di] = cel.data[di]; into[di+1] = cel.data[di+1]; into[di+2] = cel.data[di+2]; into[di+3] = 255
          continue
        }
        // source-over with layer opacity
        const sa = (a * opacity) / 255
        const da = into[di + 3] / 255
        const oa = sa + da * (1 - sa)
        if (oa === 0) continue
        into[di] = Math.round((cel.data[di] * sa + into[di] * da * (1 - sa)) / oa)
        into[di+1] = Math.round((cel.data[di+1] * sa + into[di+1] * da * (1 - sa)) / oa)
        into[di+2] = Math.round((cel.data[di+2] * sa + into[di+2] * da * (1 - sa)) / oa)
        into[di+3] = Math.round(oa * 255)
      }
    }
  }
  return into
}

// ── drawing ops (each mutates doc in place; caller snapshots history) ───────

/** Set one pixel with a color {r,g,b,a} (a=0 erases). Returns true when changed. */
function setPixel(doc, frameIdx, layerIdx, x, y, color) {
  if (x < 0 || x >= doc.width || y < 0 || y >= doc.height) return false
  const cel = ensureCel(doc, frameIdx, layerIdx)
  const i = idx(doc, cel, x, y)
  if (cel.data[i] === color.r && cel.data[i+1] === color.g && cel.data[i+2] === color.b && cel.data[i+3] === color.a) return false
  cel.data[i] = color.r; cel.data[i+1] = color.g; cel.data[i+2] = color.b; cel.data[i+3] = color.a
  return true
}

/** Draw a straight line. */
function drawLine(doc, frameIdx, layerIdx, x0, y0, x1, y1, color) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  let changed = false
  for (;;) {
    changed = setPixel(doc, frameIdx, layerIdx, x0, y0, color) || changed
    if (x0 === x1 && y0 === y1) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x0 += sx }
    if (e2 <= dx) { err += dx; y0 += sy }
  }
  return changed
}

/** Draw a rectangle outline (or filled when fill=true). */
function drawRect(doc, frameIdx, layerIdx, x0, y0, x1, y1, color, fill) {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1)
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1)
  let changed = false
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (fill || x === minX || x === maxX || y === minY || y === maxY) {
        changed = setPixel(doc, frameIdx, layerIdx, x, y, color) || changed
      }
    }
  }
  return changed
}

/** Flood fill from (x,y) with tolerance 0 (exact match on the layer). */
function floodFill(doc, frameIdx, layerIdx, x, y, color) {
  if (x < 0 || x >= doc.width || y < 0 || y >= doc.height) return false
  const cel = ensureCel(doc, frameIdx, layerIdx)
  const w = doc.width, h = doc.height
  const target = [cel.data[(y * w + x) * 4], cel.data[(y * w + x) * 4 + 1], cel.data[(y * w + x) * 4 + 2], cel.data[(y * w + x) * 4 + 3]]
  if (target[0] === color.r && target[1] === color.g && target[2] === color.b && target[3] === color.a) return false
  const stack = [[x, y]]
  let changed = false
  while (stack.length > 0) {
    const [px, py] = stack.pop()
    if (px < 0 || px >= w || py < 0 || py >= h) continue
    const i = (py * w + px) * 4
    if (cel.data[i] !== target[0] || cel.data[i+1] !== target[1] || cel.data[i+2] !== target[2] || cel.data[i+3] !== target[3]) continue
    cel.data[i] = color.r; cel.data[i+1] = color.g; cel.data[i+2] = color.b; cel.data[i+3] = color.a
    changed = true
    stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1])
  }
  return changed
}

/** Sample the color under (x,y) on the active layer (or composite). */
function pickPixel(doc, frameIdx, layerIdx, x, y) {
  if (x < 0 || x >= doc.width || y < 0 || y >= doc.height) return null
  const cel = doc.cels.get(frameIdx + ':' + layerIdx)
  if (!cel) return { r: 0, g: 0, b: 0, a: 0 }
  const i = idx(doc, cel, x, y)
  return { r: cel.data[i], g: cel.data[i+1], b: cel.data[i+2], a: cel.data[i+3] }
}

// ── layer ops ───────────────────────────────────────────────────────────────

function addLayer(doc, name, index) {
  const layer = { name: name || 'Layer ' + (doc.layers.length + 1), visible: true, opacity: 255, blendMode: 0, childLevel: 0, lflags: 1, type: 0 }
  if (index === undefined || index < 0) doc.layers.push(layer)
  else doc.layers.splice(index, 0, layer)
  return doc.layers.length - 1
}

function removeLayer(doc, layerIdx) {
  if (doc.layers.length <= 1) return false
  doc.layers.splice(layerIdx, 1)
  // drop cels of the removed layer
  for (const [k] of [...doc.cels]) {
    if (k.endsWith(':' + layerIdx)) doc.cels.delete(k)
    else {
      const [f, l] = k.split(':').map(Number)
      if (l > layerIdx) {
        const cel = doc.cels.get(k)
        doc.cels.delete(k)
        doc.cels.set(f + ':' + (l - 1), cel)
      }
    }
  }
  return true
}

function moveLayer(doc, from, to) {
  if (from < 0 || to < 0 || from >= doc.layers.length || to >= doc.layers.length || from === to) return
  const [layer] = doc.layers.splice(from, 1)
  doc.layers.splice(to, 0, layer)
  const remap = new Map()
  for (let i = 0; i < doc.layers.length; i++) remap.set(i, i)
  // rebuild cels: easiest is to rebuild key mapping by scanning old keys
  const oldKeys = [...doc.cels.entries()]
  doc.cels.clear()
  for (const [k, cel] of oldKeys) {
    const [f, l] = k.split(':').map(Number)
    let nl = l
    if (l === from) nl = to
    else if (l === to) nl = from
    else nl = l
    doc.cels.set(f + ':' + nl, cel)
  }
}

// ── frame ops ───────────────────────────────────────────────────────────────

function addFrame(doc, after, duration) {
  const dur = duration ?? doc.frames[doc.frames.length - 1]?.duration ?? 100
  const idx = after === undefined ? doc.frames.length : after + 1
  doc.frames.splice(idx, 0, { duration: dur })
  // shift cels for frames >= idx
  const pending = []
  for (const [k, cel] of doc.cels) {
    const [f, l] = k.split(':').map(Number)
    if (f >= idx) pending.push([f + 1 + ':' + l, cel])
  }
  for (const [k, cel] of pending) doc.cels.set(k, cel)
  return idx
}

function duplicateFrame(doc, frameIdx) {
  const src = doc.frames[frameIdx]
  const idx = frameIdx + 1
  doc.frames.splice(idx, 0, { duration: src.duration })
  const pending = []
  for (const [k, cel] of doc.cels) {
    const [f, l] = k.split(':').map(Number)
    if (f === frameIdx) pending.push([idx + ':' + l, cloneCel(cel)])
    else if (f >= idx) pending.push([f + 1 + ':' + l, cel])
  }
  for (const [k, cel] of pending) doc.cels.set(k, cel)
  return idx
}

function removeFrame(doc, frameIdx) {
  if (doc.frames.length <= 1) return false
  doc.frames.splice(frameIdx, 1)
  const pending = []
  for (const [k, cel] of doc.cels) {
    const [f, l] = k.split(':').map(Number)
    if (f === frameIdx) continue
    pending.push([(f > frameIdx ? f - 1 : f) + ':' + l, cel])
  }
  doc.cels.clear()
  for (const [k, cel] of pending) doc.cels.set(k, cel)
  return true
}

function moveFrame(doc, from, to) {
  if (from === to) return
  const [fr] = doc.frames.splice(from, 1)
  doc.frames.splice(to, 0, fr)
  const cels = []
  for (const [k, cel] of doc.cels) {
    const [f, l] = k.split(':').map(Number)
    let nf = f
    if (f === from) nf = to
    else if (f === to) nf = from
    cels.push([nf + ':' + l, cel])
  }
  doc.cels.clear()
  for (const [k, cel] of cels) doc.cels.set(k, cel)
}

/** Return a data-URL PNG for one frame (or the composite). */
function frameToPng(doc, frameIdx, scale = 1) {
  const w = doc.width * scale, h = doc.height * scale
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (scale !== 1) {
    ctx.imageSmoothingEnabled = false
    ctx.scale(scale, scale)
  }
  const buf = compositeFrame(doc, frameIdx, new Uint8ClampedArray(doc.width * doc.height * 4))
  const img = new ImageData(new Uint8ClampedArray(buf), doc.width, doc.height)
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

/** Return a PNG sprite-sheet data URL: frames laid out horizontally. */
function sheetToPng(doc, scale = 1) {
  const fw = doc.width, fh = doc.height
  const w = fw * doc.frames.length * scale, h = fh * scale
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  const tmp = document.createElement('canvas')
  tmp.width = fw; tmp.height = fh
  const tctx = tmp.getContext('2d')
  for (let f = 0; f < doc.frames.length; f++) {
    const buf = compositeFrame(doc, f, new Uint8ClampedArray(fw * fh * 4))
    tctx.putImageData(new ImageData(new Uint8ClampedArray(buf), fw, fh), 0, 0)
    if (scale === 1) ctx.drawImage(tmp, f * fw, 0)
    else ctx.drawImage(tmp, f * fw * scale, 0, fw * scale, fh * scale)
  }
  return canvas.toDataURL('image/png')
}


/**
 * dsh-aseprite client: pixel-art / sprite animation editor panel for the DSH
 * Web UI. Pure client-side: no host services needed. Reads and writes real
 * .aseprite files through the bundled codec; exports PNG frames/sheets.
 *
 * Wire contract: window.__ModuleLoader__.load({ id, factory }) with
 * exports { name, inject, apply } — same shape as dshmarket/dsh-terminal.
 */
const NS = 'aseprite'

const name = 'dsh-aseprite'
const inject = ['slots', 'locale']

// ── tiny hyperscript helper ─────────────────────────────────────────────────
const h = React.createElement

// ── built-in palettes ───────────────────────────────────────────────────────
const DB16 = [
  '#140c1c', '#442434', '#30346d', '#4e4a4e', '#854c30', '#346524', '#d04648', '#757161',
  '#597dce', '#d27d2c', '#8595a1', '#6daa2c', '#d2aa99', '#6dc2ca', '#dad45e', '#deeed6'
].map((hex, i) => {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255, name: 'DB16 #' + i }
})

const PICO8 = [
  '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
  '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'
].map((hex, i) => {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255, name: 'PICO-8 #' + i }
})

function defaultPalette() {
  return DB16.map((c) => ({ ...c }))
}

// ── store ───────────────────────────────────────────────────────────────────
function makeInitial() {
  const doc = newSprite(32, 32, 1, 100, 1)
  doc.palette = defaultPalette()
  return {
    open: false,
    doc,
    frame: 0,
    layer: 0,
    tool: 'pencil',
    color: { r: 0, g: 0, b: 0, a: 255 },
    zoom: 8,
    playing: false,
    onion: false,
    showNew: false,
    error: null,
    fileName: 'sprite.aseprite',
    history: new History(doc)
  }
}

let snapshot = makeInitial()
const listeners = new Set()

function set(patch) {
  snapshot = { ...snapshot, ...patch }
  for (const fn of listeners) fn()
}

function useAse() {
  return React.useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    () => snapshot
  )
}

function clampState() {
  const patch = {}
  if (snapshot.frame >= snapshot.doc.frames.length) patch.frame = snapshot.doc.frames.length - 1
  if (snapshot.layer >= snapshot.doc.layers.length) patch.layer = snapshot.doc.layers.length - 1
  if (Object.keys(patch).length > 0) set(patch)
}

/** Run a doc mutation with undo support: history captured once per gesture. */
function commit(mutator, withHistory = true) {
  if (withHistory) snapshot.history.snapshot()
  const doc = cloneDoc(snapshot.doc)
  const result = mutator(doc)
  set({ doc })
  clampState()
  return result
}

// file io ────────────────────────────────────────────────────────────────────
async function openFile(file) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer())
    const doc = await parseAseprite(buf)
    // normalize: blit any offset cels into full-canvas buffers
    for (const [key, cel] of [...doc.cels]) {
      if (cel.w === doc.width && cel.h === doc.height && cel.x === 0 && cel.y === 0) continue
      const full = new Uint8ClampedArray(doc.width * doc.height * 4)
      for (let y = 0; y < cel.h; y++) {
        for (let x = 0; x < cel.w; x++) {
          const sx = x + cel.x, sy = y + cel.y
          if (sx < 0 || sx >= doc.width || sy < 0 || sy >= doc.height) continue
          const si = (y * cel.w + x) * 4
          const di = (sy * doc.width + sx) * 4
          full[di] = cel.data[si]; full[di+1] = cel.data[si+1]; full[di+2] = cel.data[si+2]; full[di+3] = cel.data[si+3]
        }
      }
      doc.cels.set(key, { x: 0, y: 0, w: doc.width, h: doc.height, data: full })
    }
    const history = new History(doc)
    set({ doc, history, frame: 0, layer: 0, error: null, fileName: file.name || 'sprite.aseprite', playing: false })
  } catch (err) {
    set({ error: (err instanceof ASEError ? err.message : String(err?.message ?? err)) })
  }
}

function saveFile() {
  try {
    const bytes = serializeAseprite(snapshot.doc)
    const blob = new Blob([bytes], { type: 'application/octet-stream' })
    downloadBlob(blob, snapshot.fileName.replace(/\.asepr?ite$/i, '') + '.aseprite')
  } catch (err) {
    set({ error: String(err?.message ?? err) })
  }
}

function exportPng(kind) {
  const url = kind === 'sheet' ? sheetToPng(snapshot.doc) : frameToPng(snapshot.doc, snapshot.frame)
  const a = document.createElement('a')
  a.href = url
  a.download = (snapshot.fileName.replace(/\.asepr?ite$/i, '') + (kind === 'sheet' ? '-sheet.png' : '-frame' + snapshot.frame + '.png'))
  a.click()
}

function downloadBlob(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

// ── header action (toggles the panel) ───────────────────────────────────────
function HeaderAction() {
  const s = useAse()
  return h('button', {
    type: 'button',
    className: 'ase-header-btn' + (s.open ? ' ase-active' : ''),
    title: 'Pixel Editor',
    onClick: () => set({ open: !s.open })
  }, h('span', { className: 'ase-glyph' }, '🎨'))
}

// ── toolbar ─────────────────────────────────────────────────────────────────
const TOOLS = [
  ['pencil', '✏️'], ['eraser', '◻️'], ['fill', '🪣'], ['picker', '💉'], ['line', '📏'], ['rect', '▭']
]

function Toolbar({ t, onUndo, onRedo, canUndo, canRedo, onOpen, onSave, onExport, onNew }) {
  const s = useAse()
  return h('div', { className: 'ase-toolbar' },
    h('div', { className: 'ase-tool-group' },
      TOOLS.map(([id, icon]) =>
        h('button', {
          key: id,
          type: 'button',
          className: 'ase-btn ase-tool' + (s.tool === id ? ' ase-active' : ''),
          title: t('tool.' + id),
          onClick: () => set({ tool: id })
        }, icon)
      )
    ),
    h('div', { className: 'ase-tool-group' },
      h('button', { type: 'button', className: 'ase-btn', title: t('action.undo'), disabled: !canUndo, onClick: onUndo }, '↶'),
      h('button', { type: 'button', className: 'ase-btn', title: t('action.redo'), disabled: !canRedo, onClick: onRedo }, '↷')
    ),
    h('div', { className: 'ase-tool-group' },
      h('button', { type: 'button', className: 'ase-btn', title: t('action.zoomOut'), onClick: () => set({ zoom: Math.max(1, s.zoom / 2) }) }, '−'),
      h('span', { className: 'ase-zoom-label' }, '×' + s.zoom),
      h('button', { type: 'button', className: 'ase-btn', title: t('action.zoomIn'), onClick: () => set({ zoom: Math.min(64, s.zoom * 2) }) }, '+')
    ),
    h('div', { className: 'ase-tool-group' },
      h('label', { className: 'ase-btn ase-file-btn', title: t('action.open') },
        '📂',
        h('input', {
          type: 'file',
          accept: '.aseprite,.ase',
          style: { display: 'none' },
          onChange: (e) => { const f = e.target.files?.[0]; if (f) void openFile(f); e.target.value = '' }
        })
      ),
      h('button', { type: 'button', className: 'ase-btn', title: t('action.save'), onClick: onSave }, '💾'),
      h('button', { type: 'button', className: 'ase-btn', title: t('action.new'), onClick: onNew }, '🆕'),
      h('button', { type: 'button', className: 'ase-btn', title: t('action.exportFrame'), onClick: () => exportPng('frame') }, '⤓'),
      h('button', { type: 'button', className: 'ase-btn', title: t('action.exportSheet'), onClick: () => exportPng('sheet') }, '⤓⤓')
    ),
    h('div', { className: 'ase-spacer' }),
    h('span', { className: 'ase-file-name' }, s.fileName)
  )
}

// ── canvas ──────────────────────────────────────────────────────────────────
function CanvasView({ t }) {
  const s = useAse()
  const canvasRef = React.useRef(null)
  const overlayRef = React.useRef(null)
  const drag = React.useRef(null) // { startX, startY, curX, curY, working }

  // draw composite whenever doc/frame/layer/onion changes
  React.useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    const w = s.doc.width, h = s.doc.height
    if (cv.width !== w) cv.width = w
    if (cv.height !== h) cv.height = h
    ctx.clearRect(0, 0, w, h)
    if (s.onion && s.frame > 0) {
      const prev = compositeFrame(s.doc, s.frame - 1, new Uint8ClampedArray(w * h * 4))
      ctx.globalAlpha = 0.35
      ctx.putImageData(new ImageData(new Uint8ClampedArray(prev), w, h), 0, 0)
      ctx.globalAlpha = 1
    }
    const cur = compositeFrame(s.doc, s.frame, new Uint8ClampedArray(w * h * 4))
    ctx.putImageData(new ImageData(new Uint8ClampedArray(cur), w, h), 0, 0)
  }, [s.doc, s.frame, s.onion, s.layer, s.tool])

  const pixelAt = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const x = Math.floor((e.clientX - rect.left) / rect.width * s.doc.width)
    const y = Math.floor((e.clientY - rect.top) / rect.height * s.doc.height)
    return [x, y]
  }

  const begin = (e) => {
    e.preventDefault()
    const [x, y] = pixelAt(e)
    const color = s.color
    if (s.tool === 'picker') {
      const p = pickPixel(s.doc, s.frame, s.layer, x, y)
      if (p) set({ color: p })
      return
    }
    if (s.tool === 'fill') {
      commit((d) => floodFill(d, s.frame, s.layer, x, y, color))
      return
    }
    // pencil / eraser / line / rect: snapshot once, then drag
    snapshot.history.snapshot()
    const working = cloneDoc(s.doc)
    if (s.tool === 'pencil' || s.tool === 'eraser') {
      const c = s.tool === 'eraser' ? { r: 0, g: 0, b: 0, a: 0 } : color
      setPixel(working, s.frame, s.layer, x, y, c)
      set({ doc: working })
    }
    drag.current = { startX: x, startY: y, curX: x, curY: y, working }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }

  const move = (e) => {
    const d = drag.current
    if (!d) return
    const [x, y] = pixelAt(e)
    if (x === d.curX && y === d.curY) return
    const prevX = d.curX, prevY = d.curY
    d.curX = x; d.curY = y
    const color = s.tool === 'eraser' ? { r: 0, g: 0, b: 0, a: 0 } : s.color
    if (s.tool === 'pencil' || s.tool === 'eraser') {
      // Pointer events can be coalesced while dragging; interpolate every
      // skipped pixel so fast strokes never leave checkerboard gaps.
      drawLine(d.working, s.frame, s.layer, prevX, prevY, x, y, color)
      set({ doc: d.working })
    } else if (s.tool === 'line' || s.tool === 'rect') {
      drawPreview(d)
    }
  }

  const end = () => {
    const d = drag.current
    drag.current = null
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    if (!d) return
    if (s.tool === 'line' || s.tool === 'rect') {
      const color = s.color
      const doc = cloneDoc(d.working)
      if (s.tool === 'line') drawLine(doc, s.frame, s.layer, d.startX, d.startY, d.curX, d.curY, color)
      else drawRect(doc, s.frame, s.layer, d.startX, d.startY, d.curX, d.curY, color, false)
      set({ doc })
      clearPreview()
    }
  }

  const drawPreview = (d) => {
    const ov = overlayRef.current
    if (!ov) return
    const ctx = ov.getContext('2d')
    const w = s.doc.width, h = s.doc.height
    if (ov.width !== w) ov.width = w
    if (ov.height !== h) ov.height = h
    ctx.clearRect(0, 0, w, h)
    const c = s.color
    ctx.fillStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + c.a / 255 + ')'
    if (s.tool === 'line') {
      ctx.beginPath()
      ctx.moveTo(d.startX + 0.5, d.startY + 0.5)
      ctx.lineTo(d.curX + 0.5, d.curY + 0.5)
      ctx.stroke()
    } else if (s.tool === 'rect') {
      const x = Math.min(d.startX, d.curX), y = Math.min(d.startY, d.curY)
      const w2 = Math.abs(d.curX - d.startX), h2 = Math.abs(d.curY - d.startY)
      ctx.strokeRect(x + 0.5, y + 0.5, w2, h2)
    }
  }

  const clearPreview = () => {
    const ov = overlayRef.current
    if (ov) ov.getContext('2d').clearRect(0, 0, ov.width, ov.height)
  }

  React.useEffect(() => () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
  }, [])

  const size = { width: s.doc.width * s.zoom, height: s.doc.height * s.zoom }
  return h('div', { className: 'ase-canvas-wrap', style: { width: size.width, height: size.height } },
    h('div', {
      className: 'ase-canvas-checker',
      style: {
        width: size.width,
        height: size.height,
        // Checker tiles are two pixels wide; the two 45° layers are offset by one.
        backgroundSize: (s.zoom * 2) + 'px ' + (s.zoom * 2) + 'px',
        backgroundPosition: '0 0'
      }
    }),
    h('canvas', {
      ref: canvasRef,
      className: 'ase-canvas',
      style: { width: size.width, height: size.height },
      onPointerDown: begin,
      onContextMenu: (e) => e.preventDefault()
    }),
    h('canvas', {
      ref: overlayRef,
      className: 'ase-canvas ase-overlay',
      style: { width: size.width, height: size.height, pointerEvents: 'none' }
    }),
    s.doc.width > 24 || s.doc.height > 24
      ? h('div', { className: 'ase-canvas-grid', style: { width: size.width, height: size.height, backgroundSize: s.zoom + 'px ' + s.zoom + 'px' } })
      : null
  )
}

// ── layers panel ────────────────────────────────────────────────────────────
function LayersPanel({ t }) {
  const s = useAse()
  const layers = [...s.doc.layers].reverse() // topmost first
  return h('div', { className: 'ase-panel ase-layers' },
    h('div', { className: 'ase-panel-head' },
      h('span', {}, t('panel.layers')),
      h('button', { type: 'button', className: 'ase-btn ase-mini', title: t('action.addLayer'), onClick: () => commit((d) => addLayer(d, undefined, d.layers.length)) }, '+')
    ),
    h('div', { className: 'ase-layer-list' },
      layers.map((layer, i) => {
        const idx = s.doc.layers.length - 1 - i
        return h('div', {
          key: idx,
          className: 'ase-layer-row' + (idx === s.layer ? ' ase-active' : ''),
          onClick: () => set({ layer: idx })
        },
          h('button', {
            type: 'button', className: 'ase-mini ase-eye',
            title: t('action.toggleVisible'),
            onClick: (e) => { e.stopPropagation(); commit((d) => { d.layers[idx].visible = !d.layers[idx].visible }) }
          }, layer.visible ? '👁' : '—'),
          h('span', { className: 'ase-layer-name' }, layer.name),
          h('button', {
            type: 'button', className: 'ase-mini',
            title: t('action.layerUp'),
            disabled: idx >= s.doc.layers.length - 1,
            onClick: (e) => { e.stopPropagation(); commit((d) => moveLayer(d, idx, idx + 1)); set({ layer: idx + 1 }) }
          }, '↑'),
          h('button', {
            type: 'button', className: 'ase-mini',
            title: t('action.layerDown'),
            disabled: idx <= 0,
            onClick: (e) => { e.stopPropagation(); commit((d) => moveLayer(d, idx, idx - 1)); set({ layer: idx - 1 }) }
          }, '↓'),
          h('button', {
            type: 'button', className: 'ase-mini ase-danger',
            title: t('action.deleteLayer'),
            disabled: s.doc.layers.length <= 1,
            onClick: (e) => { e.stopPropagation(); commit((d) => removeLayer(d, idx)); set({ layer: Math.max(0, idx - 1) }) }
          }, '✕')
        )
      })
    )
  )
}

// ── frames panel ────────────────────────────────────────────────────────────
function FramesPanel({ t }) {
  const s = useAse()
  React.useEffect(() => {
    if (!s.playing) return
    const timer = setInterval(() => {
      const next = (s.frame + 1) % s.doc.frames.length
      set({ frame: next })
    }, Math.max(16, s.doc.frames[s.frame]?.duration ?? 100))
    return () => clearInterval(timer)
  }, [s.playing, s.frame, s.doc])
  return h('div', { className: 'ase-panel ase-frames' },
    h('div', { className: 'ase-panel-head' },
      h('span', {}, t('panel.frames')),
      h('button', { type: 'button', className: 'ase-btn ase-mini', title: t('action.play'), onClick: () => set({ playing: !s.playing }) }, s.playing ? '⏸' : '▶'),
      h('button', { type: 'button', className: 'ase-btn ase-mini', title: t('action.onion'), onClick: () => set({ onion: !s.onion }) }, s.onion ? '🧅' : '👻'),
      h('button', { type: 'button', className: 'ase-btn ase-mini', title: t('action.dupFrame'), onClick: () => commit((d) => { const i = duplicateFrame(d, s.frame); set({ frame: i }) }) }, '⧉'),
      h('button', { type: 'button', className: 'ase-btn ase-mini', title: t('action.addFrame'), onClick: () => commit((d) => { const i = addFrame(d, s.frame); set({ frame: i }) }) }, '+'),
      h('button', { type: 'button', className: 'ase-btn ase-mini ase-danger', title: t('action.delFrame'), disabled: s.doc.frames.length <= 1, onClick: () => commit((d) => removeFrame(d, s.frame)) }, '✕')
    ),
    h('div', { className: 'ase-frame-list' },
      s.doc.frames.map((frame, i) =>
        h('div', {
          key: i,
          className: 'ase-frame-chip' + (i === s.frame ? ' ase-active' : ''),
          onClick: () => set({ frame: i, playing: false })
        },
          h('span', { className: 'ase-frame-num' }, String(i)),
          h('input', {
            type: 'number',
            min: 1,
            max: 10000,
            value: frame.duration,
            title: t('action.duration'),
            onClick: (e) => e.stopPropagation(),
            onChange: (e) => commit((d) => { d.frames[i].duration = Math.max(1, Number(e.target.value) || 100) })
          })
        )
      )
    )
  )
}

// ── palette panel ───────────────────────────────────────────────────────────
function PalettePanel({ t }) {
  const s = useAse()
  const [custom, setCustom] = React.useState('#000000')
  const css = (c) => 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + c.a / 255 + ')'
  return h('div', { className: 'ase-panel ase-palette' },
    h('div', { className: 'ase-panel-head' },
      h('span', {}, t('panel.palette')),
      h('input', {
        type: 'color',
        value: custom,
        title: t('action.customColor'),
        onChange: (e) => {
          const v = e.target.value
          setCustom(v)
          const n = parseInt(v.slice(1), 16)
          set({ color: { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 } })
        }
      }),
      h('button', {
        type: 'button', className: 'ase-btn ase-mini',
        title: t('action.addColor'),
        onClick: () => commit((d) => { d.palette.push({ ...s.color, name: '' }) })
      }, '+')
    ),
    h('div', { className: 'ase-swatches' },
      s.doc.palette.map((c, i) =>
        h('button', {
          key: i,
          type: 'button',
          className: 'ase-swatch' + (s.color.r === c.r && s.color.g === c.g && s.color.b === c.b && s.color.a === c.a ? ' ase-active' : ''),
          style: { background: css(c) },
          title: c.name || '#' + i,
          onClick: () => set({ color: { r: c.r, g: c.g, b: c.b, a: c.a } })
        })
      )
    ),
    h('div', { className: 'ase-current' },
      h('span', { className: 'ase-current-swatch', style: { background: css(s.color) } }),
      h('span', { className: 'ase-current-hex' }, 'rgba(' + s.color.r + ',' + s.color.g + ',' + s.color.b + ',' + Math.round(s.color.a / 255 * 100) + '%)')
    )
  )
}

// ── new-document dialog ─────────────────────────────────────────────────────
function NewDialog({ t, onClose }) {
  const [w, setW] = React.useState(32)
  const [hh, setH] = React.useState(32)
  const [frames, setFrames] = React.useState(1)
  const [dur, setDur] = React.useState(100)
  const create = () => {
    const doc = newSprite(Math.max(1, w | 0), Math.max(1, hh | 0), Math.max(1, frames | 0), Math.max(1, dur | 0), 1)
    doc.palette = defaultPalette()
    const history = new History(doc)
    set({ doc, history, frame: 0, layer: 0, showNew: false, playing: false, fileName: 'sprite.aseprite' })
  }
  return h('div', { className: 'ase-modal' },
    h('div', { className: 'ase-modal-box' },
      h('div', { className: 'ase-modal-title' }, t('dialog.new')),
      h('label', {}, t('dialog.width'), h('input', { type: 'number', min: 1, max: 512, value: w, onChange: (e) => setW(e.target.value) })),
      h('label', {}, t('dialog.height'), h('input', { type: 'number', min: 1, max: 512, value: hh, onChange: (e) => setH(e.target.value) })),
      h('label', {}, t('dialog.frames'), h('input', { type: 'number', min: 1, max: 256, value: frames, onChange: (e) => setFrames(e.target.value) })),
      h('label', {}, t('dialog.duration'), h('input', { type: 'number', min: 1, max: 10000, value: dur, onChange: (e) => setDur(e.target.value) })),
      h('div', { className: 'ase-modal-actions' },
        h('button', { type: 'button', className: 'ase-btn', onClick: onClose }, t('action.cancel')),
        h('button', { type: 'button', className: 'ase-btn ase-btn-primary', onClick: create }, t('action.create'))
      )
    )
  )
}

// ── main panel ──────────────────────────────────────────────────────────────
function EditorPanel({ t }) {
  const s = useAse()
  if (!s.open) return null
  return h('div', { className: 'ase-root', 'data-ase-root': '' },
    h(Toolbar, {
      t,
      canUndo: s.history.canUndo(),
      canRedo: s.history.canRedo(),
      onUndo: () => { const d = s.history.undo(); if (d) set({ doc: d }) },
      onRedo: () => { const d = s.history.redo(); if (d) set({ doc: d }) },
      onOpen: () => {},
      onSave: saveFile,
      onNew: () => set({ showNew: true })
    }),
    s.error !== null
      ? h('div', { className: 'ase-error' },
          h('span', {}, s.error),
          h('button', { type: 'button', className: 'ase-btn ase-mini', onClick: () => set({ error: null }) }, '✕'))
      : null,
    h('div', { className: 'ase-body' },
      h('div', { className: 'ase-left' },
        h(PalettePanel, { t }),
        h(LayersPanel, { t })
      ),
      h('div', { className: 'ase-center' },
        h(CanvasView, { t }),
        h('div', { className: 'ase-hint' }, s.doc.width + '×' + s.doc.height + ' · ' + s.doc.frames.length + 'f · ' + s.doc.layers.length + 'L')
      ),
      h('div', { className: 'ase-right' },
        h(FramesPanel, { t })
      )
    ),
    s.showNew ? h(NewDialog, { t, onClose: () => set({ showNew: false }) }) : null
  )
}

// ── apply ───────────────────────────────────────────────────────────────────
function apply(ctx) {
  ensureStyles()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-aseprite: dictionaries')

  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'aseprite-action',
      order: 30,
      locale: NS,
      inject: () => ({})
    }, HeaderAction)
  )

  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'aseprite-panel',
      order: 30,
      locale: NS,
      inject: () => ({})
    }, EditorPanel)
  )
}

// ── locale ──────────────────────────────────────────────────────────────────
const zh = {
  'panel.layers': '图层',
  'panel.frames': '帧',
  'panel.palette': '调色板',
  'tool.pencil': '铅笔',
  'tool.eraser': '橡皮',
  'tool.fill': '油漆桶',
  'tool.picker': '取色器',
  'tool.line': '直线',
  'tool.rect': '矩形',
  'action.undo': '撤销',
  'action.redo': '重做',
  'action.zoomIn': '放大',
  'action.zoomOut': '缩小',
  'action.open': '打开 .aseprite',
  'action.save': '保存为 .aseprite',
  'action.new': '新建精灵',
  'action.exportFrame': '导出当前帧 PNG',
  'action.exportSheet': '导出全部帧 PNG',
  'action.addLayer': '新建图层',
  'action.deleteLayer': '删除图层',
  'action.layerUp': '上移图层',
  'action.layerDown': '下移图层',
  'action.toggleVisible': '显示/隐藏',
  'action.play': '播放',
  'action.onion': '洋葱皮',
  'action.addFrame': '新增帧',
  'action.dupFrame': '复制帧',
  'action.delFrame': '删除帧',
  'action.duration': '帧时长(ms)',
  'action.customColor': '自定义颜色',
  'action.addColor': '加入调色板',
  'action.cancel': '取消',
  'action.create': '创建',
  'dialog.new': '新建精灵',
  'dialog.width': '宽度',
  'dialog.height': '高度',
  'dialog.frames': '帧数',
  'dialog.duration': '每帧时长(ms)'
}
const en = {
  'panel.layers': 'Layers',
  'panel.frames': 'Frames',
  'panel.palette': 'Palette',
  'tool.pencil': 'Pencil',
  'tool.eraser': 'Eraser',
  'tool.fill': 'Fill',
  'tool.picker': 'Picker',
  'tool.line': 'Line',
  'tool.rect': 'Rect',
  'action.undo': 'Undo',
  'action.redo': 'Redo',
  'action.zoomIn': 'Zoom in',
  'action.zoomOut': 'Zoom out',
  'action.open': 'Open .aseprite',
  'action.save': 'Save .aseprite',
  'action.new': 'New sprite',
  'action.exportFrame': 'Export frame PNG',
  'action.exportSheet': 'Export sheet PNG',
  'action.addLayer': 'New layer',
  'action.deleteLayer': 'Delete layer',
  'action.layerUp': 'Move layer up',
  'action.layerDown': 'Move layer down',
  'action.toggleVisible': 'Toggle visibility',
  'action.play': 'Play',
  'action.onion': 'Onion skin',
  'action.addFrame': 'New frame',
  'action.dupFrame': 'Duplicate frame',
  'action.delFrame': 'Delete frame',
  'action.duration': 'Frame duration (ms)',
  'action.customColor': 'Custom color',
  'action.addColor': 'Add to palette',
  'action.cancel': 'Cancel',
  'action.create': 'Create',
  'dialog.new': 'New sprite',
  'dialog.width': 'Width',
  'dialog.height': 'Height',
  'dialog.frames': 'Frames',
  'dialog.duration': 'Frame duration (ms)'
}

// ── styles ──────────────────────────────────────────────────────────────────
const TAG_ID = 'dsh-aseprite/styles'
function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(TAG_ID) !== null) return
  const style = document.createElement('style')
  style.id = TAG_ID
  style.dataset.plugin = 'dsh-aseprite'
  style.textContent = `
[data-ase-root] {
  --ase-border: var(--dsw-alias-border-l2, rgba(128,128,128,.25));
  --ase-text: var(--dsw-alias-label-primary, inherit);
  --ase-text-dim: var(--dsw-alias-label-secondary, rgba(128,128,128,.8));
  --ase-bg: var(--dsw-alias-bg-layer-1, #0e1116);
  --ase-accent: var(--dsw-alias-brand-primary, #4d9fff);
  --ase-danger: var(--dsw-alias-state-error-primary, #f85149);
  box-sizing: border-box;
  color: var(--ase-text);
  font-size: 13px;
  line-height: 1.5;
}
[data-ase-root] * , [data-ase-root] *::before, [data-ase-root] *::after { box-sizing: border-box; }

.ase-root {
  border: 1px solid var(--ase-border);
  border-radius: 8px;
  background: var(--ase-bg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}
.ase-toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--ase-border);
  flex-wrap: wrap;
}
.ase-tool-group { display: inline-flex; align-items: center; gap: 4px; }
.ase-spacer { flex: 1; }
.ase-file-name { color: var(--ase-text-dim); font-size: 12px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ase-btn {
  background: transparent; color: var(--ase-text);
  border: 1px solid var(--ase-border); border-radius: 6px;
  padding: 3px 9px; font-size: 13px; cursor: pointer; white-space: nowrap;
  line-height: 1.4;
}
.ase-btn:hover:not(:disabled) { border-color: var(--ase-accent); color: var(--ase-accent); }
.ase-btn:disabled { opacity: .4; cursor: default; }
.ase-btn-primary { background: var(--ase-accent); border-color: var(--ase-accent); color: #fff; font-weight: 600; }
.ase-tool.ase-active, .ase-btn.ase-active { border-color: var(--ase-accent); color: var(--ase-accent); background: color-mix(in srgb, var(--ase-accent) 12%, transparent); }
.ase-mini { padding: 0 5px; font-size: 12px; }
.ase-danger:hover:not(:disabled) { border-color: var(--ase-danger); color: var(--ase-danger); }
.ase-zoom-label { font-size: 12px; color: var(--ase-text-dim); min-width: 34px; text-align: center; }
.ase-file-btn { display: inline-flex; align-items: center; }

.ase-header-btn {
  background: transparent; color: var(--ase-text);
  border: 1px solid var(--ase-border); border-radius: 6px;
  padding: 2px 8px; font-size: 13px; cursor: pointer; user-select: none;
}
.ase-header-btn:hover { border-color: var(--ase-accent); }
.ase-header-btn.ase-active { border-color: var(--ase-accent); box-shadow: 0 0 0 1px var(--ase-accent) inset; }

.ase-error {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; font-size: 12px;
  color: var(--ase-danger);
  border-bottom: 1px solid var(--ase-border);
  background: color-mix(in srgb, var(--ase-danger) 10%, transparent);
}

.ase-body {
  display: flex;
  gap: 10px;
  padding: 10px;
  min-height: 0;
  flex: 1;
}
.ase-left { display: flex; flex-direction: column; gap: 10px; width: 210px; flex: none; }
.ase-right { width: 240px; flex: none; min-height: 0; }
.ase-center {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  overflow: auto;
}
.ase-hint { color: var(--ase-text-dim); font-size: 12px; }

.ase-panel {
  border: 1px solid var(--ase-border);
  border-radius: 6px;
  overflow: hidden;
  display: flex; flex-direction: column;
}
.ase-panel-head {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px;
  font-size: 12px; font-weight: 600;
  color: var(--ase-text-dim);
  border-bottom: 1px solid var(--ase-border);
}
.ase-panel-head .ase-btn { margin-left: auto; }
.ase-panel-head .ase-btn + .ase-btn { margin-left: 0; }
.ase-layer-list { overflow-y: auto; max-height: 180px; padding: 4px; }
.ase-layer-row {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 6px; border-radius: 5px; cursor: pointer;
  font-size: 12px;
}
.ase-layer-row:hover { background: color-mix(in srgb, var(--ase-text) 6%, transparent); }
.ase-layer-row.ase-active { background: color-mix(in srgb, var(--ase-accent) 15%, transparent); }
.ase-layer-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ase-eye { background: none; border: none; cursor: pointer; font-size: 12px; padding: 0 2px; }

.ase-frame-list { overflow-x: auto; padding: 6px; display: flex; gap: 6px; }
.ase-frame-chip {
  flex: none;
  border: 1px solid var(--ase-border);
  border-radius: 6px;
  padding: 4px 6px;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  cursor: pointer; background: transparent;
}
.ase-frame-chip.ase-active { border-color: var(--ase-accent); }
.ase-frame-chip input {
  width: 58px; font-size: 11px;
  background: transparent; color: var(--ase-text);
  border: 1px solid var(--ase-border); border-radius: 4px; padding: 1px 3px;
}
.ase-frame-num { font-size: 11px; color: var(--ase-text-dim); }

.ase-swatches { display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; padding: 6px; }
.ase-swatch {
  aspect-ratio: 1; border-radius: 4px; cursor: pointer;
  border: 1px solid rgba(0,0,0,.35);
  padding: 0;
}
.ase-swatch.ase-active { outline: 2px solid var(--ase-accent); outline-offset: 1px; }
.ase-current { display: flex; align-items: center; gap: 6px; padding: 4px 8px; font-size: 11px; color: var(--ase-text-dim); }
.ase-current-swatch { width: 18px; height: 18px; border-radius: 4px; border: 1px solid rgba(0,0,0,.35); }

.ase-canvas-wrap {
  position: relative;
  flex: none;
  display: inline-block;
}
.ase-canvas-checker {
  position: absolute; inset: 0;
  background-color: rgba(255,255,255,.92);
  /* A tiny square SVG keeps transparency cells square at every zoom. */
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2'%3E%3Crect width='1' height='1' fill='%23808080' fill-opacity='.28'/%3E%3Crect x='1' y='1' width='1' height='1' fill='%23808080' fill-opacity='.28'/%3E%3C/svg%3E");
  background-position: 0 0;
  background-repeat: repeat;
  background-size: 16px 16px;
}
.ase-canvas {
  position: relative;
  display: block;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  touch-action: none;
}
.ase-overlay { position: absolute; inset: 0; }
.ase-canvas-grid {
  position: absolute; inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(to right, rgba(128,128,128,.18) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(128,128,128,.18) 1px, transparent 1px);
  background-size: 16px 16px;
}

.ase-modal {
  position: absolute; inset: 0; z-index: 50;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.45);
}
.ase-modal-box {
  background: var(--ase-bg);
  border: 1px solid var(--ase-border);
  border-radius: 10px;
  padding: 16px;
  display: flex; flex-direction: column; gap: 10px;
  min-width: 260px;
}
.ase-modal-title { font-weight: 600; }
.ase-modal-box label { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; }
.ase-modal-box input {
  width: 110px;
  background: transparent; color: var(--ase-text);
  border: 1px solid var(--ase-border); border-radius: 5px; padding: 3px 6px;
}
.ase-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
`
  document.head.appendChild(style)
}


		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
