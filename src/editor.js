/**
 * dsh-aseprite editor model: pure document operations over the normalized
 * sprite document (see ase-codec.js). Everything mutates a deep-ish copy so
 * React state can swap in a new version; undo is a snapshot stack keyed on the
 * touched cel(s).
 */
import { emptyDoc } from './ase-codec.js'

/** Clone a cel's pixel data. */
function cloneCel(cel) {
  if (!cel) return null
  return { x: cel.x, y: cel.y, w: cel.w, h: cel.h, data: new Uint8ClampedArray(cel.data) }
}

/** Deep-clone a document (cels included). */
export function cloneDoc(doc) {
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
export const DEFAULT_COLOR = { r: 0, g: 0, b: 0, a: 255 }

export function newSprite(width, height, frames = 1, duration = 100, layers = 1) {
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
export class History {
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
export function compositeFrame(doc, frameIdx, into) {
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
export function setPixel(doc, frameIdx, layerIdx, x, y, color) {
  if (x < 0 || x >= doc.width || y < 0 || y >= doc.height) return false
  const cel = ensureCel(doc, frameIdx, layerIdx)
  const i = idx(doc, cel, x, y)
  if (cel.data[i] === color.r && cel.data[i+1] === color.g && cel.data[i+2] === color.b && cel.data[i+3] === color.a) return false
  cel.data[i] = color.r; cel.data[i+1] = color.g; cel.data[i+2] = color.b; cel.data[i+3] = color.a
  return true
}

/** Stamp a square pixel brush centered on (x,y). */
export function drawBrush(doc, frameIdx, layerIdx, x, y, color, size = 1) {
  const brush = Math.max(1, Math.round(Number(size) || 1))
  const startX = x - Math.floor((brush - 1) / 2)
  const startY = y - Math.floor((brush - 1) / 2)
  let changed = false
  for (let yy = startY; yy < startY + brush; yy++) {
    for (let xx = startX; xx < startX + brush; xx++) {
      changed = setPixel(doc, frameIdx, layerIdx, xx, yy, color) || changed
    }
  }
  return changed
}

/** Draw a straight line with an optional square brush size. */
export function drawLine(doc, frameIdx, layerIdx, x0, y0, x1, y1, color, size = 1) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  let changed = false
  for (;;) {
    changed = drawBrush(doc, frameIdx, layerIdx, x0, y0, color, size) || changed
    if (x0 === x1 && y0 === y1) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x0 += sx }
    if (e2 <= dx) { err += dx; y0 += sy }
  }
  return changed
}

/** Draw a rectangle outline (or filled when fill=true) with an optional brush size. */
export function drawRect(doc, frameIdx, layerIdx, x0, y0, x1, y1, color, fill, size = 1) {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1)
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1)
  let changed = false
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (fill || x === minX || x === maxX || y === minY || y === maxY) {
        changed = drawBrush(doc, frameIdx, layerIdx, x, y, color, size) || changed
      }
    }
  }
  return changed
}

/** Flood fill from (x,y) with tolerance 0 (exact match on the layer). */
export function floodFill(doc, frameIdx, layerIdx, x, y, color) {
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
export function pickPixel(doc, frameIdx, layerIdx, x, y) {
  if (x < 0 || x >= doc.width || y < 0 || y >= doc.height) return null
  const cel = doc.cels.get(frameIdx + ':' + layerIdx)
  if (!cel) return { r: 0, g: 0, b: 0, a: 0 }
  const i = idx(doc, cel, x, y)
  return { r: cel.data[i], g: cel.data[i+1], b: cel.data[i+2], a: cel.data[i+3] }
}

// ── layer ops ───────────────────────────────────────────────────────────────

export function addLayer(doc, name, index) {
  const layer = { name: name || 'Layer ' + (doc.layers.length + 1), visible: true, opacity: 255, blendMode: 0, childLevel: 0, lflags: 1, type: 0 }
  if (index === undefined || index < 0) doc.layers.push(layer)
  else doc.layers.splice(index, 0, layer)
  return doc.layers.length - 1
}

export function removeLayer(doc, layerIdx) {
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

export function moveLayer(doc, from, to) {
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

export function addFrame(doc, after, duration) {
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

export function duplicateFrame(doc, frameIdx) {
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

export function removeFrame(doc, frameIdx) {
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

export function moveFrame(doc, from, to) {
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
export function frameToPng(doc, frameIdx, scale = 1) {
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
export function sheetToPng(doc, scale = 1) {
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
