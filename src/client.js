/**
 * dsh-aseprite client: pixel-art / sprite animation editor panel for the DSH
 * Web UI. Pure client-side: no host services needed. Reads and writes real
 * .aseprite files through the bundled codec; exports PNG frames/sheets.
 *
 * Wire contract: window.__ModuleLoader__.load({ id, factory }) with
 * exports { name, inject, apply } — same shape as dshmarket/dsh-terminal.
 */
import { parseAseprite, serializeAseprite, ASEError } from './ase-codec.js'
import {
  newSprite, cloneDoc, History, compositeFrame, regionToPng,
  setPixel, drawBrush, drawLine, drawRect, floodFill, pickPixel,
  addLayer, removeLayer, moveLayer,
  addFrame, duplicateFrame, removeFrame, moveFrame,
  frameToPng, sheetToPng
} from './editor.js'
import {
  useBlueprints, upsertBlueprint, removeBlueprint, importBlueprintText,
  exportBlueprintText, blueprintPrompt, extractBlueprintsFromText,
  executeBlueprint, imageFromDocument, imageToPng, writeImageToDocument,
  blueprintNodeTitle
} from './blueprints.js'

const NS = 'aseprite'

export const name = 'dsh-aseprite'
export const inject = ['slots', 'locale', 'sessions', 'conversation']

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
    brushSize: 1,
    leftRatio: 0.18,
    rightRatio: 0.20,
    panelHeight: null,
    selection: null,
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

export function useAse() {
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
    set({ doc, history, frame: 0, layer: 0, selection: null, error: null, fileName: file.name || 'sprite.aseprite', playing: false })
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
  ['pencil', '✏️'], ['eraser', '◻️'], ['fill', '🪣'], ['picker', '💉'], ['line', '📏'], ['rect', '▭'], ['select', '▧']
]
const ZOOM_STEPS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]
function zoomStep(value, direction) {
  const current = Number(value) || 1
  let index = ZOOM_STEPS.findIndex((n) => n >= current)
  if (index < 0) index = ZOOM_STEPS.length - 1
  if (ZOOM_STEPS[index] !== current && direction < 0) index--
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, index + (direction > 0 ? 1 : direction < 0 ? -1 : 0)))]
}
function clampBrushSize(value) {
  return Math.max(1, Math.min(32, Math.round(Number(value) || 1)))
}
function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
function selectionFromPoints(x0, y0, x1, y1, width, height) {
  const left = Math.max(0, Math.min(width - 1, Math.min(x0, x1)))
  const top = Math.max(0, Math.min(height - 1, Math.min(y0, y1)))
  const right = Math.max(left, Math.min(width - 1, Math.max(x0, x1)))
  const bottom = Math.max(top, Math.min(height - 1, Math.max(y0, y1)))
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }
}
function dataUrlToFile(dataUrl, name) {
  const split = dataUrl.indexOf(',')
  const header = split >= 0 ? dataUrl.slice(0, split) : ''
  const payload = split >= 0 ? dataUrl.slice(split + 1) : dataUrl
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const type = (header.match(/data:([^;]+)/) || [])[1] || 'image/png'
  return new File([bytes], name, { type })
}

function Toolbar({ t, onUndo, onRedo, canUndo, canRedo, onOpen, onSave, onExport, onNew, onAsk, canAsk, onBlueprints }) {
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
    h('div', { className: 'ase-tool-group ase-zoom-group' },
      h('button', { type: 'button', className: 'ase-btn', title: t('action.zoomOut'), onClick: () => set({ zoom: zoomStep(s.zoom, -1) }) }, '−'),
      h('span', { className: 'ase-zoom-label' }, '×' + s.zoom),
      h('button', { type: 'button', className: 'ase-btn', title: t('action.zoomIn'), onClick: () => set({ zoom: zoomStep(s.zoom, 1) }) }, '+')
    ),
    h('div', { className: 'ase-tool-group ase-brush-control' },
      h('span', { className: 'ase-brush-label' }, '✹'),
      h('input', {
        type: 'range', min: 1, max: 32, step: 1, value: s.brushSize,
        title: t('action.brushSize'), 'aria-label': t('action.brushSize'),
        onChange: (e) => set({ brushSize: clampBrushSize(e.target.value) })
      }),
      h('input', {
        type: 'number', min: 1, max: 32, step: 1, value: s.brushSize,
        title: t('action.brushSize'), 'aria-label': t('action.brushSize'),
        onChange: (e) => set({ brushSize: clampBrushSize(e.target.value) })
      }),
      h('span', { className: 'ase-brush-unit' }, 'px')
    ),
    h('div', { className: 'ase-tool-group ase-ask-group' },
      h('button', {
        type: 'button',
        className: 'ase-btn ase-ask',
        title: t('action.askSelection'),
        disabled: !canAsk,
        onClick: onAsk
      }, 'ASK'),
      s.selection ? h('span', { className: 'ase-selection-label' }, s.selection.w + '×' + s.selection.h) : null
    ),
    h('button', {
      type: 'button',
      className: 'ase-btn ase-blueprint-trigger',
      title: t('action.blueprints'),
      onClick: onBlueprints
    }, '🧩'),
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
function renderCanvasDocument(canvas, doc, frame, onion) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const w = doc.width, h = doc.height
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  ctx.clearRect(0, 0, w, h)
  if (onion && frame > 0) {
    const prev = compositeFrame(doc, frame - 1, new Uint8ClampedArray(w * h * 4))
    ctx.globalAlpha = 0.35
    ctx.putImageData(new ImageData(new Uint8ClampedArray(prev), w, h), 0, 0)
    ctx.globalAlpha = 1
  }
  const cur = compositeFrame(doc, frame, new Uint8ClampedArray(w * h * 4))
  ctx.putImageData(new ImageData(new Uint8ClampedArray(cur), w, h), 0, 0)
}

function CanvasView({ t }) {
  const s = useAse()
  const canvasRef = React.useRef(null)
  const overlayRef = React.useRef(null)
  const drag = React.useRef(null) // { startX, startY, curX, curY, working }

  // Commit state once per gesture; paint directly during movement.
  React.useEffect(() => {
    renderCanvasDocument(canvasRef.current, s.doc, s.frame, s.onion)
  }, [s.doc, s.frame, s.onion, s.layer, s.tool])

  const pixelAt = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(s.doc.width - 1, Math.floor((e.clientX - rect.left) / rect.width * s.doc.width)))
    const y = Math.max(0, Math.min(s.doc.height - 1, Math.floor((e.clientY - rect.top) / rect.height * s.doc.height)))
    return [x, y]
  }

  const drawSelectionOverlay = (selection) => {
    const ov = overlayRef.current
    if (!ov) return
    const ctx = ov.getContext('2d')
    const w = s.doc.width, h = s.doc.height
    if (ov.width !== w) ov.width = w
    if (ov.height !== h) ov.height = h
    ctx.clearRect(0, 0, w, h)
    if (!selection) return
    ctx.fillStyle = 'rgba(77,159,255,.16)'
    ctx.fillRect(selection.x, selection.y, selection.w, selection.h)
    ctx.strokeStyle = 'rgba(77,159,255,.95)'
    ctx.lineWidth = 1
    ctx.setLineDash([1, 1])
    ctx.strokeRect(selection.x + 0.5, selection.y + 0.5, selection.w, selection.h)
    ctx.setLineDash([])
  }

  React.useEffect(() => {
    if (!drag.current) drawSelectionOverlay(s.selection)
  }, [s.selection, s.doc.width, s.doc.height])

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
    if (s.tool === 'select') {
      set({ selection: null })
      drag.current = {
        startX: x, startY: y, curX: x, curY: y,
        selecting: true, pointerId: e.pointerId, raf: 0
      }
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
      drawPreview(drag.current)
      window.addEventListener('pointermove', move, { passive: false })
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
      return
    }
    // Clone and snapshot once; movement stays off the React render path.
    snapshot.history.snapshot()
    const working = cloneDoc(s.doc)
    if (s.tool === 'pencil' || s.tool === 'eraser') {
      const c = s.tool === 'eraser' ? { r: 0, g: 0, b: 0, a: 0 } : color
      drawBrush(working, s.frame, s.layer, x, y, c, s.brushSize)
    }
    drag.current = {
      startX: x, startY: y, curX: x, curY: y,
      working, pointerId: e.pointerId, raf: 0
    }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
    if (s.tool === 'pencil' || s.tool === 'eraser') {
      renderCanvasDocument(canvasRef.current, working, s.frame, s.onion)
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const move = (e) => {
    const d = drag.current
    if (!d) return
    e.preventDefault()
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    const samples = coalesced.length > 0 ? coalesced : [e]
    if (s.tool === 'select') {
      const sample = samples[samples.length - 1]
      const [x, y] = pixelAt(sample)
      if (x !== d.curX || y !== d.curY) {
        d.curX = x
        d.curY = y
        drawPreview(d)
      }
      return
    }
    let moved = false
    const color = s.tool === 'eraser' ? { r: 0, g: 0, b: 0, a: 0 } : s.color
    for (const sample of samples) {
      const [x, y] = pixelAt(sample)
      if (x === d.curX && y === d.curY) continue
      const prevX = d.curX, prevY = d.curY
      d.curX = x; d.curY = y
      moved = true
      if (s.tool === 'pencil' || s.tool === 'eraser') {
        // Interpolate each coalesced segment so fast strokes stay continuous.
        drawLine(d.working, s.frame, s.layer, prevX, prevY, x, y, color, s.brushSize)
      }
    }
    if (!moved) return
    if (s.tool === 'pencil' || s.tool === 'eraser') {
      // At most one composite/render per animation frame, never one React
      // render per pointer event.
      if (!d.raf) {
        d.raf = window.requestAnimationFrame(() => {
          d.raf = 0
          if (drag.current === d) renderCanvasDocument(canvasRef.current, d.working, s.frame, s.onion)
        })
      }
    } else if (s.tool === 'line' || s.tool === 'rect') {
      drawPreview(d)
    }
  }

  const end = (e) => {
    const d = drag.current
    drag.current = null
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    if (!d) return
    if (d.raf) {
      window.cancelAnimationFrame(d.raf)
      d.raf = 0
    }
    try {
      if (canvasRef.current?.hasPointerCapture?.(d.pointerId)) canvasRef.current.releasePointerCapture(d.pointerId)
    } catch (_) {}
    if (s.tool === 'select') {
      const selection = selectionFromPoints(d.startX, d.startY, d.curX, d.curY, s.doc.width, s.doc.height)
      set({ selection })
      drawSelectionOverlay(selection)
      return
    }
    if (s.tool === 'pencil' || s.tool === 'eraser') {
      renderCanvasDocument(canvasRef.current, d.working, s.frame, s.onion)
      set({ doc: d.working })
    } else if (s.tool === 'line' || s.tool === 'rect') {
      const color = s.color
      const doc = cloneDoc(d.working)
      if (s.tool === 'line') drawLine(doc, s.frame, s.layer, d.startX, d.startY, d.curX, d.curY, color, s.brushSize)
      else drawRect(doc, s.frame, s.layer, d.startX, d.startY, d.curX, d.curY, color, false, s.brushSize)
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
    if (d.selecting || s.tool === 'select') {
      const selection = selectionFromPoints(d.startX, d.startY, d.curX, d.curY, w, h)
      ctx.fillStyle = 'rgba(77,159,255,.16)'
      ctx.fillRect(selection.x, selection.y, selection.w, selection.h)
      ctx.strokeStyle = 'rgba(77,159,255,.95)'
      ctx.lineWidth = 1
      ctx.setLineDash([1, 1])
      ctx.strokeRect(selection.x + 0.5, selection.y + 0.5, selection.w, selection.h)
      ctx.setLineDash([])
      return
    }
    const c = s.color
    ctx.fillStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + c.a / 255 + ')'
    ctx.strokeStyle = ctx.fillStyle
    ctx.lineWidth = Math.max(1, s.brushSize)
    ctx.lineCap = 'square'
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

  const clearPreview = () => drawSelectionOverlay(s.selection)

  React.useEffect(() => () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    if (drag.current?.raf) window.cancelAnimationFrame(drag.current.raf)
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

// ── selection ASK dialog ─────────────────────────────────────────────────────
function AskDialog({ t, selection, onClose, onSubmit }) {
  const [prompt, setPrompt] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const submit = async () => {
    const value = prompt.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value)
      onClose()
    } catch (err) {
      setError(String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }
  return h('div', { className: 'ase-modal' },
    h('div', { className: 'ase-modal-box ase-ask-box' },
      h('div', { className: 'ase-modal-title' }, t('dialog.ask')),
      h('div', { className: 'ase-ask-hint' }, t('dialog.askHint')),
      h('div', { className: 'ase-ask-selection' }, t('dialog.selection') + ': ' + selection.w + '×' + selection.h + ' @ (' + selection.x + ',' + selection.y + ')'),
      h('textarea', {
        className: 'ase-ask-textarea',
        value: prompt,
        autoFocus: true,
        placeholder: t('dialog.askPlaceholder'),
        onChange: (e) => setPrompt(e.target.value),
        onKeyDown: (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void submit()
        }
      }),
      error ? h('div', { className: 'ase-ask-error' }, error) : null,
      h('div', { className: 'ase-modal-actions' },
        h('button', { type: 'button', className: 'ase-btn', disabled: busy, onClick: onClose }, t('action.cancel')),
        h('button', { type: 'button', className: 'ase-btn ase-btn-primary', disabled: busy || !prompt.trim(), onClick: () => void submit() }, busy ? '…' : t('action.askSend'))
      )
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
    set({ doc, history, frame: 0, layer: 0, selection: null, showNew: false, playing: false, fileName: 'sprite.aseprite' })
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


// ── blueprint workflow UI ───────────────────────────────────────────────────
function blueprintNodePosition(node, index) {
  return node.position || { x: 24 + index * 190, y: 36 + (index % 2) * 88 }
}

function blueprintColorHex(value) {
  const rgba = Array.isArray(value) ? value : [0, 0, 0, 255]
  return '#' + [0, 1, 2].map((index) => Math.max(0, Math.min(255, Math.round(Number(rgba[index]) || 0))).toString(16).padStart(2, '0')).join('')
}

function BlueprintNodeControls({ node, onPatch }) {
  const stop = (e) => e.stopPropagation()
  if (node.type === 'crop') return h('label', { className: 'ase-bp-control', onPointerDown: stop },
    '留白',
    h('input', { type: 'number', min: 0, max: 64, value: node.params.padding, onChange: (e) => onPatch({ padding: Math.max(0, Math.min(64, Number(e.target.value) || 0)) }) })
  )
  if (node.type === 'outline') return h('div', { className: 'ase-bp-control-row', onPointerDown: stop },
    h('label', { className: 'ase-bp-control' }, '厚度', h('input', { type: 'number', min: 1, max: 16, value: node.params.thickness, onChange: (e) => onPatch({ thickness: Math.max(1, Math.min(16, Number(e.target.value) || 1)) }) })),
    h('input', { type: 'color', value: blueprintColorHex(node.params.color), title: '描边颜色', onChange: (e) => { const n = parseInt(e.target.value.slice(1), 16); onPatch({ color: [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255] }) } })
  )
  if (node.type === 'llm') return h('textarea', { className: 'ase-bp-prompt', value: node.params.prompt, rows: 2, onPointerDown: stop, onChange: (e) => onPatch({ prompt: e.target.value }) })
  return null
}

function BlueprintGraph({ blueprint, onChange }) {
  const [positions, setPositions] = React.useState(() => Object.fromEntries(blueprint.nodes.map((node, index) => [node.id, blueprintNodePosition(node, index)])))
  const drag = React.useRef(null)
  const port = React.useRef(null)
  const [portHint, setPortHint] = React.useState('')

  React.useEffect(() => {
    setPositions(Object.fromEntries(blueprint.nodes.map((node, index) => [node.id, blueprintNodePosition(node, index)])))
    port.current = null
    setPortHint('')
  }, [blueprint.id])

  const endDrag = () => {
    const active = drag.current
    if (!active) return
    drag.current = null
    window.removeEventListener('pointermove', moveDrag)
    window.removeEventListener('pointerup', endDrag)
    const position = active.position
    if (!position) return
    onChange({
      ...blueprint,
      nodes: blueprint.nodes.map((node) => node.id === active.id ? { ...node, position } : node)
    })
  }

  const moveDrag = (e) => {
    const active = drag.current
    if (!active) return
    e.preventDefault()
    active.position = {
      x: Math.max(12, active.start.x + e.clientX - active.x),
      y: Math.max(12, active.start.y + e.clientY - active.y)
    }
    setPositions((previous) => ({ ...previous, [active.id]: active.position }))
  }

  const beginDrag = (e, node) => {
    if (e.target?.closest?.('button')) return
    e.preventDefault()
    const position = positions[node.id] || blueprintNodePosition(node, 0)
    drag.current = { id: node.id, x: e.clientX, y: e.clientY, start: position, position }
    window.addEventListener('pointermove', moveDrag, { passive: false })
    window.addEventListener('pointerup', endDrag)
  }

  const choosePort = (nodeId, side) => {
    const chosen = port.current
    if (!chosen) {
      port.current = { nodeId, side }
      setPortHint(side === 'out' ? '已选择输出端口，请点击另一个节点的输入端口。' : '已选择输入端口，请点击另一个节点的输出端口。')
      return
    }
    if (chosen.nodeId === nodeId || chosen.side === side) {
      port.current = null
      setPortHint('')
      return
    }
    const from = chosen.side === 'out' ? chosen.nodeId : nodeId
    const to = chosen.side === 'in' ? chosen.nodeId : nodeId
    const exists = blueprint.edges.some((edge) => edge.from === from && edge.to === to)
    port.current = null
    setPortHint(exists ? '这条连线已经存在。' : '连线已添加。')
    if (!exists) onChange({ ...blueprint, edges: [...blueprint.edges, { from, to }] })
  }

  React.useEffect(() => () => {
    window.removeEventListener('pointermove', moveDrag)
    window.removeEventListener('pointerup', endDrag)
  }, [])

  const maxX = Math.max(760, ...blueprint.nodes.map((node, index) => (positions[node.id] || blueprintNodePosition(node, index)).x + 190))
  const maxY = Math.max(280, ...blueprint.nodes.map((node, index) => (positions[node.id] || blueprintNodePosition(node, index)).y + 112))
  const byId = new Map(blueprint.nodes.map((node) => [node.id, node]))
  return h('div', { className: 'ase-bp-graph-wrap' },
    h('div', { className: 'ase-bp-graph-hint' }, portHint || '拖动节点标题移动；点击输出端口，再点击输入端口创建连线。'),
    h('div', { className: 'ase-bp-graph', style: { width: maxX, height: maxY } },
      h('svg', { className: 'ase-bp-edges', width: maxX, height: maxY, viewBox: '0 0 ' + maxX + ' ' + maxY },
        blueprint.edges.map((edge, index) => {
          const fromNode = byId.get(edge.from), toNode = byId.get(edge.to)
          if (!fromNode || !toNode) return null
          const from = positions[fromNode.id] || blueprintNodePosition(fromNode, 0)
          const to = positions[toNode.id] || blueprintNodePosition(toNode, 0)
          const x1 = from.x + 172, y1 = from.y + 48, x2 = to.x + 8, y2 = to.y + 48
          return h('path', { key: index, d: 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + 48) + ' ' + y1 + ' ' + (x2 - 48) + ' ' + y2 + ' ' + x2 + ' ' + y2, className: 'ase-bp-edge' })
        })
      ),
      blueprint.nodes.map((node, index) => {
        const position = positions[node.id] || blueprintNodePosition(node, index)
        return h('div', {
          key: node.id,
          className: 'ase-bp-node ase-bp-node-' + node.mode,
          style: { left: position.x, top: position.y },
          onPointerDown: (e) => beginDrag(e, node)
        },
          h('button', { type: 'button', className: 'ase-bp-port ase-bp-port-in', title: '输入端口', onClick: (e) => { e.stopPropagation(); choosePort(node.id, 'in') } }, '◀'),
          h('div', { className: 'ase-bp-node-head' },
            h('span', { className: 'ase-bp-node-type' }, node.mode === 'active' ? '主动' : '被动'),
            h('strong', {}, node.label || blueprintNodeTitle(node.type))
          ),
          h('div', { className: 'ase-bp-node-body' },
            h('div', { className: 'ase-bp-node-summary' }, node.type === 'llm' ? node.params.prompt : blueprintNodeTitle(node.type)),
            h(BlueprintNodeControls, { node, onPatch: (patch) => onChange({ ...blueprint, nodes: blueprint.nodes.map((item) => item.id === node.id ? { ...item, params: { ...item.params, ...patch } } : item) }) })
          ),
          h('button', { type: 'button', className: 'ase-bp-port ase-bp-port-out', title: '输出端口', onClick: (e) => { e.stopPropagation(); choosePort(node.id, 'out') } }, '▶')
        )
      })
    )
  )
}

function BlueprintCreateDialog({ t, onClose, onSubmit }) {
  const [task, setTask] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const submit = async () => {
    if (!task.trim()) return
    setBusy(true)
    setError('')
    try {
      await onSubmit(task.trim())
      onClose()
    } catch (err) {
      setError(String(err?.message || err))
    } finally {
      setBusy(false)
    }
  }
  return h('div', { className: 'ase-bp-create-overlay' },
    h('div', { className: 'ase-modal-box ase-bp-create-box' },
      h('div', { className: 'ase-modal-title' }, 'AI 创建蓝图'),
      h('div', { className: 'ase-ask-hint' }, '描述一项完整的像素处理任务，AI 会生成节点、参数和连线，并自动保存到蓝图库。'),
      h('textarea', {
        className: 'ase-ask-textarea',
        value: task,
        autoFocus: true,
        placeholder: '例如：先裁剪透明边界，再用深色像素描边；不要调用 AI。',
        onChange: (e) => setTask(e.target.value),
        onKeyDown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void submit() }
      }),
      error ? h('div', { className: 'ase-ask-error' }, error) : null,
      h('div', { className: 'ase-modal-actions' },
        h('button', { type: 'button', className: 'ase-btn', disabled: busy, onClick: onClose }, t('action.cancel')),
        h('button', { type: 'button', className: 'ase-btn ase-btn-primary', disabled: busy || !task.trim(), onClick: () => void submit() }, busy ? '…' : '发送给 AI')
      )
    )
  )
}

function BlueprintPanel({ t, onClose, onAskCreate, onRun, notice }) {
  const library = useBlueprints()
  const [selectedId, setSelectedId] = React.useState(library.list[0]?.id || '')
  const [createOpen, setCreateOpen] = React.useState(false)
  const [status, setStatus] = React.useState('')
  const fileRef = React.useRef(null)
  React.useEffect(() => {
    if (!library.list.some((item) => item.id === selectedId)) setSelectedId(library.list[0]?.id || '')
  }, [library.revision, selectedId])
  const selected = library.list.find((item) => item.id === selectedId) || library.list[0]
  const update = (next) => {
    try {
      const saved = upsertBlueprint(next)
      setSelectedId(saved.id)
      return saved
    } catch (err) {
      setStatus(String(err?.message || err))
      return null
    }
  }
  const run = async () => {
    if (!selected) return
    setStatus('')
    try {
      await onRun(selected)
      setStatus(selected.mode === 'active' ? '已发送到当前会话 AI。' : '被动蓝图已应用。')
    } catch (err) {
      setStatus(String(err?.message || err))
    }
  }
  const exportLibrary = () => downloadBlob(new Blob([exportBlueprintText()], { type: 'application/json' }), 'dsh-blueprints.json')
  const importLibrary = async (file) => {
    try {
      const imported = importBlueprintText(await file.text())
      setSelectedId(imported[0].id)
      setStatus('已自动导入 ' + imported.length + ' 个蓝图。')
    } catch (err) {
      setStatus('导入失败：' + String(err?.message || err))
    }
  }
  const deleteSelected = () => {
    if (!selected) return
    removeBlueprint(selected.id)
    setStatus('已删除蓝图。')
  }
  return h('div', { className: 'ase-modal ase-blueprint-modal' },
    h('div', { className: 'ase-modal-box ase-blueprint-box' },
      h('div', { className: 'ase-blueprint-head' },
        h('div', {}, h('strong', {}, '蓝图工作流'), h('span', { className: 'ase-bp-subtitle' }, ' · ComfyUI 风格节点复用')),
        h('div', { className: 'ase-tool-group' },
          h('button', { type: 'button', className: 'ase-btn ase-mini', title: t('action.blueprintCreate'), onClick: () => setCreateOpen(true) }, '✨ AI 创建'),
          h('button', { type: 'button', className: 'ase-btn ase-mini', title: '导出蓝图库', onClick: exportLibrary }, '⇩'),
          h('label', { className: 'ase-btn ase-mini', title: '导入蓝图库' }, '⇧', h('input', { ref: fileRef, type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: (e) => { const file = e.target.files?.[0]; if (file) void importLibrary(file); e.target.value = '' } })),
          h('button', { type: 'button', className: 'ase-btn ase-mini', onClick: onClose }, '✕')
        )
      ),
      h('div', { className: 'ase-blueprint-layout' },
        h('div', { className: 'ase-bp-library' },
          h('div', { className: 'ase-panel-head' }, '我的蓝图', h('span', { className: 'ase-bp-count' }, String(library.list.length))),
          h('div', { className: 'ase-bp-library-list' }, library.list.map((item) =>
            h('button', { key: item.id, type: 'button', className: 'ase-bp-library-item' + (item.id === selected?.id ? ' ase-active' : ''), onClick: () => setSelectedId(item.id) },
              h('span', { className: 'ase-bp-library-mode ase-bp-library-mode-' + item.mode }, item.mode === 'active' ? '主动' : '被动'),
              h('strong', {}, item.name),
              h('small', {}, item.description)
            )
          ))
        ),
        h('div', { className: 'ase-bp-workbench' }, selected
          ? h(React.Fragment, {},
              h('div', { className: 'ase-bp-workbench-head' },
                h('div', {}, h('strong', {}, selected.name), h('div', { className: 'ase-bp-description' }, selected.description)),
                h('div', { className: 'ase-tool-group' },
                  h('button', { type: 'button', className: 'ase-btn ase-btn-primary', onClick: () => void run() }, selected.mode === 'active' ? '运行并询问 AI' : '运行蓝图'),
                  h('button', { type: 'button', className: 'ase-btn ase-danger', onClick: deleteSelected }, '删除')
                )
              ),
              h(BlueprintGraph, { blueprint: selected, onChange: update }),
              h('div', { className: 'ase-bp-footer' }, notice || status || (selected.mode === 'active' ? '主动蓝图会把图像交给当前会话 LLM。' : '被动蓝图完全在浏览器本地运行，不调用 LLM。'))
            )
          : h('div', { className: 'ase-bp-empty' }, '还没有蓝图，点击“AI 创建”。')
        )
      ),
      createOpen ? h(BlueprintCreateDialog, { t, onClose: () => setCreateOpen(false), onSubmit: onAskCreate }) : null
    )
  )
}

function blueprintAssistantNodes(session) {
  const collections = [session?.chat?.nodes, session?.nodes]
  for (const collection of collections) {
    const values = collection?.values
    if (typeof values !== 'function') continue
    try { return Array.from(values.call(collection) || []) } catch (_) {}
  }
  return []
}

function blueprintAssistantKey(node) {
  return String(node?.messageId || node?.id || '')
}

function blueprintAssistantSeq(node) {
  const value = Number(node?.seq)
  return Number.isFinite(value) ? value : null
}

function blueprintSessionKey(session) {
  return String(session?.sessionId || session?.id || session?.key || '')
}

function blueprintNonce() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const values = new Uint32Array(3)
    crypto.getRandomValues(values)
    return Array.from(values).map((value) => value.toString(36)).join('-')
  }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

// ── main panel ──────────────────────────────────────────────────────────────
function EditorPanel({ t, askSelection, submitBlueprint, session }) {
  const s = useAse()
  const [askOpen, setAskOpen] = React.useState(false)
  const [blueprintOpen, setBlueprintOpen] = React.useState(false)
  const [blueprintNotice, setBlueprintNotice] = React.useState('')
  const pendingBlueprint = React.useRef(null)
  const seenAssistant = React.useRef(new Set())
  const openAsk = () => {
    if (s.selection && typeof askSelection === 'function') setAskOpen(true)
  }
  const submitAsk = async (request) => {
    const selection = snapshot.selection
    if (!selection) throw new Error(t('error.noSelection'))
    if (typeof askSelection !== 'function') throw new Error(t('error.noConversation'))
    const imageUrl = regionToPng(snapshot.doc, snapshot.frame, selection.x, selection.y, selection.w, selection.h, 8)
    const file = dataUrlToFile(imageUrl, 'aseprite-selection-frame-' + snapshot.frame + '.png')
    const prompt = [
      '这是像素画精灵当前帧的局部选区截图。',
      '原图尺寸：' + snapshot.doc.width + '×' + snapshot.doc.height + '；选区左上角：(' + selection.x + ',' + selection.y + ')；选区大小：' + selection.w + '×' + selection.h + '。',
      '请只针对附图中的选区进行局部调整，保持像素画风格，并不要改动选区外内容。',
      '具体要求：' + request
    ].join('\n')
    await askSelection(file, prompt)
  }
  const createBlueprint = async (task) => {
    if (typeof submitBlueprint !== 'function') throw new Error(t('error.noConversation'))
    const requestId = blueprintNonce()
    let baselineSeq = -1
    const baselineIds = new Set()
    for (const node of blueprintAssistantNodes(session)) {
      if (node?.kind !== 'assistant') continue
      const seq = blueprintAssistantSeq(node)
      if (seq !== null) baselineSeq = Math.max(baselineSeq, seq)
      const key = blueprintAssistantKey(node)
      if (key) baselineIds.add(key)
    }
    pendingBlueprint.current = {
      requestId,
      baselineSeq,
      baselineIds,
      sessionKey: blueprintSessionKey(session)
    }
    setBlueprintNotice('已发送蓝图设计请求，等待 AI 返回结构化蓝图。')
    try {
      await submitBlueprint({ prompt: blueprintPrompt(task, requestId) })
    } catch (err) {
      if (pendingBlueprint.current?.requestId === requestId) pendingBlueprint.current = null
      throw err
    }
  }
  const readAssistantText = (node) => (node?.blocks || []).filter((block) => block.kind === 'text').map((block) => String(block.text || '')).join('\n')
  React.useEffect(() => {
    const pending = pendingBlueprint.current
    if (!pending) return
    const currentSessionKey = blueprintSessionKey(session)
    if (pending.sessionKey && currentSessionKey && pending.sessionKey !== currentSessionKey) return
    for (const node of blueprintAssistantNodes(session)) {
      if (node?.kind !== 'assistant' || node.interrupted === true || node.partial === true || node.finalized === false || node.status === 'streaming') continue
      const key = blueprintAssistantKey(node)
      if (!key || seenAssistant.current.has(key)) continue
      const seq = blueprintAssistantSeq(node)
      if (pending.baselineIds.has(key) || (seq !== null && seq <= pending.baselineSeq)) {
        seenAssistant.current.add(key)
        continue
      }
      const matches = extractBlueprintsFromText(readAssistantText(node)).filter((blueprint) => blueprint.requestId === pending.requestId)
      if (matches.length === 0) {
        seenAssistant.current.add(key)
        continue
      }
      seenAssistant.current.add(key)
      try {
        for (const blueprint of matches) {
          const saved = upsertBlueprint(blueprint)
          setBlueprintNotice('AI 已自动创建蓝图：' + saved.name)
        }
        pendingBlueprint.current = null
      } catch (err) {
        setBlueprintNotice('蓝图解析失败：' + String(err?.message || err))
      }
    }
  }, [session])
  const runBlueprint = async (blueprint) => {
    const selection = snapshot.selection
    if (!selection) throw new Error('请先在画布上框选一个区域，再运行蓝图。')
    const initialImage = imageFromDocument(snapshot.doc, snapshot.frame, selection)
    const result = executeBlueprint(blueprint, initialImage)
    if (!result.ok) throw new Error(result.error)
    if (result.kind === 'active') {
      if (typeof submitBlueprint !== 'function') throw new Error(t('error.noConversation'))
      const file = dataUrlToFile(imageToPng(result.image, 8), 'blueprint-' + blueprint.id + '-frame-' + snapshot.frame + '.png')
      const prompt = [
        '这是一个主动蓝图工作流的输入图像。',
        '蓝图名称：' + blueprint.name,
        '节点提示：' + result.prompt,
        '请只处理附图对应的局部内容，保持像素画风格；不要修改选区外内容。'
      ].join('\n')
      await submitBlueprint({ file, prompt })
      return result
    }
    const output = result.image
    const nextDoc = cloneDoc(snapshot.doc)
    const history = new History(snapshot.doc)
    history.snapshot()
    if (output.width === selection.w && output.height === selection.h) {
      for (let row = 0; row < selection.h; row++) {
        for (let col = 0; col < selection.w; col++) setPixel(nextDoc, snapshot.frame, snapshot.layer, selection.x + col, selection.y + row, { r: 0, g: 0, b: 0, a: 0 })
      }
      writeImageToDocument(nextDoc, snapshot.frame, snapshot.layer, output, selection.x, selection.y)
      history.stack[history.index] = cloneDoc(nextDoc)
      set({ doc: nextDoc, history, selection: { x: selection.x, y: selection.y, w: output.width, h: output.height } })
      return result
    }
    const replacement = newSprite(output.width, output.height, 1, snapshot.doc.frames[snapshot.frame]?.duration || 100, 1)
    replacement.palette = defaultPalette()
    writeImageToDocument(replacement, 0, 0, output, 0, 0)
    const replacementHistory = new History(snapshot.doc)
    replacementHistory.snapshot()
    replacementHistory.stack[replacementHistory.index] = cloneDoc(replacement)
    set({ doc: replacement, history: replacementHistory, frame: 0, layer: 0, selection: null, fileName: blueprint.name + '.aseprite' })
    return result
  }
  const rootRef = React.useRef(null)
  const bodyRef = React.useRef(null)
  const resize = React.useRef(null)
  const handleCanvasWheel = (e) => {
    e.preventDefault()
    const direction = e.deltaY < 0 ? 1 : e.deltaY > 0 ? -1 : 0
    if (!direction) return
    const previous = snapshot.zoom
    const next = zoomStep(previous, direction)
    if (next === previous) return
    const host = e.currentTarget
    const rect = host.getBoundingClientRect()
    const cursorX = e.clientX - rect.left
    const cursorY = e.clientY - rect.top
    const anchorX = cursorX + host.scrollLeft
    const anchorY = cursorY + host.scrollTop
    set({ zoom: next })
    window.requestAnimationFrame(() => {
      if (!host.isConnected) return
      const ratio = next / previous
      host.scrollLeft = anchorX * ratio - cursorX
      host.scrollTop = anchorY * ratio - cursorY
    })
  }
  const endResize = () => {
    resize.current = null
    window.removeEventListener('pointermove', moveResize)
    window.removeEventListener('pointerup', endResize)
  }
  const moveResize = (e) => {
    const active = resize.current
    if (!active) return
    e.preventDefault()
    if (active.axis === 'height' || active.axis === 'height-top') {
      const delta = active.axis === 'height-top' ? active.startY - e.clientY : e.clientY - active.startY
      const next = clampNumber(active.startHeight + delta, 360, Math.min(720, Math.max(360, window.innerHeight * 0.9)))
      set({ panelHeight: next })
      return
    }
    const width = bodyRef.current?.getBoundingClientRect().width || 1
    const delta = (e.clientX - active.startX) / width
    if (active.axis === 'left') {
      const max = Math.min(0.36, 1 - active.startRight - 0.24)
      set({ leftRatio: clampNumber(active.startLeft + delta, 0.12, max) })
    } else {
      const max = Math.min(0.36, 1 - active.startLeft - 0.24)
      set({ rightRatio: clampNumber(active.startRight - delta, 0.14, max) })
    }
  }
  const beginResize = (axis, e) => {
    e.preventDefault()
    const rootBox = rootRef.current?.getBoundingClientRect()
    resize.current = {
      axis,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: s.leftRatio,
      startRight: s.rightRatio,
      startHeight: rootBox?.height || 560
    }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
    window.addEventListener('pointermove', moveResize, { passive: false })
    window.addEventListener('pointerup', endResize)
  }
  if (!s.open) return null
  return h('div', {
    ref: rootRef,
    className: 'ase-root',
    'data-ase-root': '',
    style: s.panelHeight ? { height: s.panelHeight + 'px' } : undefined
  },
    h('div', {
      className: 'ase-resize-grip ase-resize-y ase-resize-top',
      title: t('action.resizePanel'),
      onPointerDown: (e) => beginResize('height-top', e)
    }),
    h(Toolbar, {
      t,
      canUndo: s.history.canUndo(),
      canRedo: s.history.canRedo(),
      onUndo: () => { const d = s.history.undo(); if (d) set({ doc: d }) },
      onRedo: () => { const d = s.history.redo(); if (d) set({ doc: d }) },
      onOpen: () => {},
      onSave: saveFile,
      onNew: () => set({ showNew: true }),
      onAsk: openAsk,
      canAsk: Boolean(s.selection && typeof askSelection === 'function'),
      onBlueprints: () => setBlueprintOpen(true)
    }),
    s.error !== null
      ? h('div', { className: 'ase-error' },
          h('span', {}, s.error),
          h('button', { type: 'button', className: 'ase-btn ase-mini', onClick: () => set({ error: null }) }, '✕'))
      : null,
    h('div', {
      ref: bodyRef,
      className: 'ase-body',
      style: { gridTemplateColumns: (s.leftRatio * 100) + '% minmax(0, 1fr) ' + (s.rightRatio * 100) + '%' }
    },
      h('div', { className: 'ase-left' },
        h(PalettePanel, { t }),
        h(LayersPanel, { t })
      ),
      h('div', { className: 'ase-center', onWheel: handleCanvasWheel },
        h('div', { className: 'ase-center-stage' },
          h(CanvasView, { t }),
          h('div', { className: 'ase-hint' }, s.doc.width + '×' + s.doc.height + ' · ' + s.doc.frames.length + 'f · ' + s.doc.layers.length + 'L')
        )
      ),
      h('div', { className: 'ase-right' },
        h(FramesPanel, { t })
      ),
      h('div', {
        className: 'ase-resize-grip ase-resize-x ase-resize-left',
        style: { left: 'calc(' + (s.leftRatio * 100) + '% - 4px)' },
        title: t('action.resizePanel'),
        onPointerDown: (e) => beginResize('left', e)
      }),
      h('div', {
        className: 'ase-resize-grip ase-resize-x ase-resize-right',
        style: { left: 'calc(' + ((1 - s.rightRatio) * 100) + '% - 4px)' },
        title: t('action.resizePanel'),
        onPointerDown: (e) => beginResize('right', e)
      })
    ),
    h('div', {
      className: 'ase-resize-grip ase-resize-y ase-resize-bottom',
      title: t('action.resizePanel'),
      onPointerDown: (e) => beginResize('height', e)
    }),
    s.showNew ? h(NewDialog, { t, onClose: () => set({ showNew: false }) }) : null,
    askOpen && s.selection
      ? h(AskDialog, { t, selection: s.selection, onClose: () => setAskOpen(false), onSubmit: submitAsk })
      : null,
    blueprintOpen
      ? h(BlueprintPanel, { t, onClose: () => setBlueprintOpen(false), onAskCreate: createBlueprint, onRun: runBlueprint, notice: blueprintNotice })
      : null
  )
}

// ── apply ───────────────────────────────────────────────────────────────────
export function apply(ctx) {
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
      inject: (sessionId) => {
        const actx = ctx.sessions.scope(sessionId)
        if (actx === undefined) throw new Error('dsh-aseprite: session scope unavailable')
        const conversation = actx.get('conversation')
        if (conversation === undefined) throw new Error('dsh-aseprite: conversation service unavailable')
        const submitBlueprint = ({ file, prompt }) => {
          const input = conversation.input.for(actx)
          const attachments = file ? conversation.createDraftImages([file]) : []
          if (attachments.length > 0 && !input.addImages(attachments.map((attachment) => attachment.id))) {
            conversation.releaseDraftImages(attachments)
            throw new Error('当前会话暂时不能添加图片附件')
          }
          input.setDraft(prompt)
          input.submit()
        }
        return {
          submitBlueprint,
          askSelection: (file, prompt) => submitBlueprint({ file, prompt })
        }
      }
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
  'tool.select': '框选局部区域',
  'action.undo': '撤销',
  'action.redo': '重做',
  'action.zoomIn': '放大',
  'action.zoomOut': '缩小',
  'action.brushSize': '笔刷/橡皮大小',
  'action.askSelection': '把选区交给 AI 局部调整',
  'action.blueprints': '打开蓝图工作流',
  'action.blueprintCreate': '让 AI 创建蓝图',
  'action.askSend': '发送给 AI',
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
  'action.resizePanel': '拖拽调整面板大小',
  'action.create': '创建',
  'dialog.new': '新建精灵',
  'dialog.ask': 'ASK：局部调整',
  'dialog.askHint': '会把当前选区截图作为图片附件发送到当前会话的 AI。编辑器像素不会自动修改。',
  'dialog.selection': '选区',
  'dialog.askPlaceholder': '例如：把这个角色的眼睛改成闭眼，保持 8-bit 像素风格。',
  'error.noSelection': '请先框选一个区域。',
  'error.noConversation': '当前会话不可用，无法发送给 AI。',
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
  'tool.select': 'Select region',
  'action.undo': 'Undo',
  'action.redo': 'Redo',
  'action.zoomIn': 'Zoom in',
  'action.zoomOut': 'Zoom out',
  'action.brushSize': 'Brush / eraser size',
  'action.askSelection': 'Ask AI to adjust selection',
  'action.blueprints': 'Open blueprint workflows',
  'action.blueprintCreate': 'Ask AI to create a blueprint',
  'action.askSend': 'Send to AI',
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
  'action.resizePanel': 'Drag to resize panel',
  'action.create': 'Create',
  'dialog.new': 'New sprite',
  'dialog.ask': 'ASK: Local adjustment',
  'dialog.askHint': 'The selected crop will be sent as an image attachment to the current AI conversation. The editor pixels are not changed automatically.',
  'dialog.selection': 'Selection',
  'dialog.askPlaceholder': "For example: close this character's eyes while keeping the 8-bit pixel-art style.",
  'error.noSelection': 'Select a region first.',
  'error.noConversation': 'The current conversation is unavailable.',
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
[data-ase-root] { min-width: 0; }
[data-ase-root] * , [data-ase-root] *::before, [data-ase-root] *::after { box-sizing: border-box; }

.ase-root {
  position: relative;
  border: 1px solid var(--ase-border);
  border-radius: 8px;
  background: var(--ase-bg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  height: 560px;
  max-height: min(78vh, 720px);
  min-height: 360px;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}
.ase-toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  row-gap: 6px;
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
.ase-zoom-label { font-size: 12px; color: var(--ase-text-dim); min-width: 38px; text-align: center; }
.ase-brush-control { gap: 5px; }
.ase-brush-label { color: var(--ase-text-dim); font-size: 15px; }
.ase-brush-control input[type=range] { width: 72px; accent-color: var(--ase-accent); cursor: pointer; }
.ase-brush-control input[type=number] {
  width: 42px; padding: 2px 4px; font-size: 12px;
  color: var(--ase-text); background: transparent; border: 1px solid var(--ase-border); border-radius: 4px;
}
.ase-brush-unit { color: var(--ase-text-dim); font-size: 11px; }
.ase-ask { font-weight: 700; letter-spacing: .04em; }
.ase-selection-label { color: var(--ase-accent); font-size: 11px; white-space: nowrap; }
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
  display: grid;
  grid-template-columns: minmax(126px, 18%) minmax(0, 1fr) minmax(150px, 20%);
  grid-template-rows: minmax(0, 1fr);
  gap: 8px;
  padding: 8px;
  min-height: 0;
  flex: 1;
  overflow: hidden;
  position: relative;
}
.ase-left { display: flex; flex-direction: column; gap: 8px; width: auto; min-width: 0; }
.ase-right { width: auto; min-width: 0; min-height: 0; }
.ase-center {
  min-width: 0; min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.ase-center-stage {
  box-sizing: border-box;
  width: max-content;
  min-width: 100%;
  min-height: 100%;
  padding: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.ase-resize-grip {
  position: absolute;
  z-index: 20;
  touch-action: none;
  background: transparent;
}
.ase-resize-grip:hover,
.ase-resize-grip:active { background: color-mix(in srgb, var(--ase-accent) 45%, transparent); }
.ase-resize-x {
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
}
.ase-resize-y {
  left: 0;
  right: 0;
  height: 8px;
  cursor: row-resize;
}
.ase-resize-top { position: relative; flex: none; margin-bottom: -1px; }
.ase-resize-bottom { position: relative; flex: none; margin-top: -1px; }
@media (max-width: 720px) {
  .ase-body { grid-template-columns: minmax(112px, 22%) minmax(0, 1fr) minmax(132px, 24%); gap: 6px; padding: 6px; }
  .ase-toolbar { padding-left: 6px; padding-right: 6px; }
  .ase-file-name { max-width: 120px; }
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
  display: block;
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
.ase-ask-box { width: min(440px, calc(100% - 32px)); }
.ase-ask-hint { color: var(--ase-text-dim); font-size: 12px; }
.ase-ask-selection { color: var(--ase-accent); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.ase-ask-textarea {
  width: 100%; min-height: 92px; resize: vertical;
  background: transparent; color: var(--ase-text);
  border: 1px solid var(--ase-border); border-radius: 6px; padding: 8px;
  font: inherit;
}
.ase-ask-textarea:focus { outline: 1px solid var(--ase-accent); }
.ase-ask-error { color: var(--ase-danger); font-size: 12px; }
.ase-modal-box label { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; }
.ase-modal-box input {
  width: 110px;
  background: transparent; color: var(--ase-text);
  border: 1px solid var(--ase-border); border-radius: 5px; padding: 3px 6px;
}
.ase-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.ase-blueprint-trigger { border-color: color-mix(in srgb, var(--ase-accent) 55%, var(--ase-border)); }
.ase-mini { padding: 2px 6px; font-size: 12px; }
.ase-danger { color: var(--ase-danger); }
.ase-blueprint-box {
  width: min(1040px, calc(100% - 24px)); height: min(92%, 680px); min-height: 420px;
  max-width: none; overflow: hidden;
}
.ase-blueprint-head, .ase-bp-workbench-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.ase-bp-subtitle, .ase-bp-description { color: var(--ase-text-dim); font-size: 12px; font-weight: 400; }
.ase-blueprint-layout { display: grid; grid-template-columns: 218px minmax(0, 1fr); gap: 10px; min-height: 0; flex: 1; }
.ase-bp-library { min-width: 0; min-height: 0; border: 1px solid var(--ase-border); border-radius: 7px; overflow: hidden; display: flex; flex-direction: column; }
.ase-bp-library-list { min-height: 0; overflow: auto; padding: 5px; display: flex; flex-direction: column; gap: 4px; }
.ase-bp-library-item { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; width: 100%; padding: 8px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--ase-text); text-align: left; cursor: pointer; }
.ase-bp-library-item:hover, .ase-bp-library-item.ase-active { border-color: var(--ase-accent); background: color-mix(in srgb, var(--ase-accent) 10%, transparent); }
.ase-bp-library-item strong { font-size: 12px; }
.ase-bp-library-item small { color: var(--ase-text-dim); font-size: 11px; line-height: 1.35; }
.ase-bp-library-mode { font-size: 10px; padding: 1px 4px; border-radius: 3px; background: color-mix(in srgb, var(--ase-text-dim) 18%, transparent); }
.ase-bp-library-mode-active { color: #ffb86b; }
.ase-bp-library-mode-passive { color: #7dd3fc; }
.ase-bp-count { float: right; color: var(--ase-text-dim); font-size: 11px; }
.ase-bp-workbench { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.ase-bp-workbench-head { flex: none; }
.ase-bp-workbench-head strong { font-size: 14px; }
.ase-bp-graph-wrap { min-height: 0; flex: 1; overflow: auto; border: 1px solid var(--ase-border); border-radius: 7px; background: color-mix(in srgb, var(--ase-bg) 88%, #000 12%); }
.ase-bp-graph-hint { position: sticky; top: 0; z-index: 3; padding: 5px 8px; color: var(--ase-text-dim); font-size: 11px; background: color-mix(in srgb, var(--ase-bg) 88%, transparent); border-bottom: 1px solid var(--ase-border); }
.ase-bp-graph { position: relative; min-width: 760px; min-height: 280px; }
.ase-bp-edges { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
.ase-bp-edge { fill: none; stroke: color-mix(in srgb, var(--ase-accent) 70%, transparent); stroke-width: 2; }
.ase-bp-node { position: absolute; width: 180px; min-height: 88px; border: 1px solid var(--ase-border); border-radius: 7px; background: var(--ase-bg); box-shadow: 0 4px 12px rgba(0,0,0,.24); cursor: grab; user-select: none; z-index: 2; }
.ase-bp-node:active { cursor: grabbing; }
.ase-bp-node-active { border-color: color-mix(in srgb, #ffb86b 65%, var(--ase-border)); }
.ase-bp-node-passive { border-color: color-mix(in srgb, #7dd3fc 55%, var(--ase-border)); }
.ase-bp-node-head { display: flex; align-items: center; gap: 5px; padding: 7px 10px; border-bottom: 1px solid var(--ase-border); }
.ase-bp-node-type { font-size: 10px; color: var(--ase-text-dim); }
.ase-bp-node-body { padding: 7px 10px; color: var(--ase-text-dim); font-size: 11px; line-height: 1.35; max-height: 92px; overflow: hidden; }
.ase-bp-node-summary { max-height: 32px; overflow: hidden; margin-bottom: 5px; }
.ase-bp-control-row { display: flex; align-items: center; gap: 5px; }
.ase-bp-control { display: inline-flex; align-items: center; gap: 4px; color: var(--ase-text-dim); font-size: 10px; }
.ase-bp-control input[type=number] { width: 38px; padding: 1px 3px; color: var(--ase-text); background: transparent; border: 1px solid var(--ase-border); border-radius: 3px; font-size: 10px; }
.ase-bp-control-row input[type=color] { width: 26px; height: 20px; padding: 0; border: 1px solid var(--ase-border); background: transparent; }
.ase-bp-prompt { width: 100%; resize: vertical; min-height: 30px; padding: 3px; color: var(--ase-text); background: transparent; border: 1px solid var(--ase-border); border-radius: 3px; font: 10px/1.3 inherit; }
.ase-bp-port { position: absolute; z-index: 4; width: 17px; height: 17px; padding: 0; border: 1px solid var(--ase-border); border-radius: 50%; background: var(--ase-bg); color: var(--ase-text-dim); font-size: 9px; line-height: 14px; cursor: crosshair; }
.ase-bp-port:hover { color: var(--ase-accent); border-color: var(--ase-accent); }
.ase-bp-port-in { left: -9px; top: 40px; }
.ase-bp-port-out { right: -9px; top: 40px; }
.ase-bp-footer { flex: none; color: var(--ase-text-dim); font-size: 11px; min-height: 18px; }
.ase-bp-empty { display: grid; place-items: center; min-height: 240px; color: var(--ase-text-dim); }
.ase-bp-create-overlay { position: absolute; inset: 0; z-index: 5; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.32); }
.ase-bp-create-box { width: min(520px, calc(100% - 24px)); }
@media (max-width: 760px) {
  .ase-blueprint-box { min-height: 360px; }
  .ase-blueprint-layout { grid-template-columns: 156px minmax(0, 1fr); }
  .ase-bp-library-item { padding: 6px; }
}
`
  document.head.appendChild(style)
}
