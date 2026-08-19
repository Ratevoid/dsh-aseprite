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
  newSprite, cloneDoc, History, compositeFrame,
  setPixel, drawBrush, drawLine, drawRect, floodFill, pickPixel,
  addLayer, removeLayer, moveLayer,
  addFrame, duplicateFrame, removeFrame, moveFrame,
  frameToPng, sheetToPng
} from './editor.js'

const NS = 'aseprite'

export const name = 'dsh-aseprite'
export const inject = ['slots', 'locale']

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

  const clearPreview = () => {
    const ov = overlayRef.current
    if (ov) ov.getContext('2d').clearRect(0, 0, ov.width, ov.height)
  }

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
    if (active.axis === 'height') {
      const next = clampNumber(active.startHeight + e.clientY - active.startY, 360, Math.min(720, Math.max(360, window.innerHeight * 0.9)))
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
    s.showNew ? h(NewDialog, { t, onClose: () => set({ showNew: false }) }) : null
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
  'action.brushSize': '笔刷/橡皮大小',
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
  'action.brushSize': 'Brush / eraser size',
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
