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
export class ASEError extends Error {
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

export function emptyDoc(width, height, frames = 1, duration = 100) {
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

export async function parseAseprite(input) {
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

export function serializeAseprite(doc) {
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
