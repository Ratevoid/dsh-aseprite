/**
 * Declarative, safe blueprint workflows for dsh-aseprite.
 *
 * Blueprints are data, not code. AI may create the graph, but execution is
 * limited to the operations interpreted below; arbitrary JavaScript is never
 * evaluated. The client stores the normalized library in localStorage.
 */

const BLUEPRINT_STORAGE_KEY = 'dsh-aseprite:blueprints:v1'
const BLUEPRINT_SCHEMA_VERSION = 1
const MAX_BLUEPRINTS = 64
const MAX_NODES = 32
const MAX_EDGES = 64
const ALLOWED_TYPES = new Set(['input', 'crop', 'outline', 'llm', 'output'])

const blueprintListeners = new Set()
let blueprintList = []
let blueprintRevision = 0
let blueprintSnapshot = { list: blueprintList, revision: blueprintRevision }

function blueprintId(prefix = 'blueprint') {
  const random = Math.random().toString(36).slice(2, 8)
  return prefix + '-' + Date.now().toString(36) + '-' + random
}

function text(value, fallback = '', limit = 2400) {
  return String(value ?? fallback).trim().slice(0, limit)
}

function number(value, fallback = 0) {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

function color(value, fallback = [0, 0, 0, 255]) {
  if (Array.isArray(value)) {
    return [0, 1, 2, 3].map((i) => Math.max(0, Math.min(255, Math.round(number(value[i], fallback[i])))))
  }
  if (typeof value === 'string' && /^#[0-9a-f]{6,8}$/i.test(value)) {
    const hex = value.slice(1)
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) : 255]
  }
  return fallback.slice()
}

function nodeType(node) {
  const raw = text(node?.type || node?.op || node?.kind || 'input', 'input', 30).toLowerCase()
  if (raw === 'source' || raw === 'input' || raw === 'image-input') return 'input'
  if (raw === 'trim' || raw === 'autocrop' || raw === 'crop') return 'crop'
  if (raw === 'border' || raw === 'stroke' || raw === 'outline') return 'outline'
  if (raw === 'ai' || raw === 'ask' || raw === 'llm' || raw === 'active') return 'llm'
  if (raw === 'sink' || raw === 'result' || raw === 'output') return 'output'
  return null
}

function normalizeNode(raw, index) {
  const type = nodeType(raw)
  if (!type || !ALLOWED_TYPES.has(type)) return null
  const id = text(raw?.id || type + '-' + (index + 1), type + '-' + (index + 1), 80).replace(/[^a-zA-Z0-9_-]/g, '-')
  const params = {}
  const input = raw?.params && typeof raw.params === 'object' ? raw.params : {}
  if (type === 'crop') params.padding = Math.max(0, Math.min(64, Math.round(number(input.padding, 0))))
  if (type === 'outline') {
    params.thickness = Math.max(1, Math.min(16, Math.round(number(input.thickness, 1))))
    params.color = color(input.color)
  }
  if (type === 'llm') params.prompt = text(input.prompt || raw?.prompt || '请保持像素画风格，对这张图做局部优化。', '请保持像素画风格，对这张图做局部优化。')
  const position = raw?.position && typeof raw.position === 'object' ? raw.position : raw
  return {
    id,
    type,
    label: text(raw?.label || raw?.name || ({ input: '输入选区', crop: '裁剪透明边界', outline: '像素描边', llm: 'AI 局部处理', output: '输出' }[type]), type, 80),
    mode: type === 'llm' ? 'active' : 'passive',
    params,
    position: { x: Math.max(12, Math.min(1400, number(position?.x, 24 + index * 190))), y: Math.max(12, Math.min(800, number(position?.y, 36 + (index % 2) * 88))) }
  }
}

function normalizeEdge(raw) {
  const from = typeof raw?.from === 'object' ? raw.from?.node || raw.from?.id : raw?.from
  const to = typeof raw?.to === 'object' ? raw.to?.node || raw.to?.id : raw?.to
  if (!from || !to) return null
  return { from: text(from, '', 80), to: text(to, '', 80) }
}

export function normalizeBlueprint(raw) {
  if (!raw || typeof raw !== 'object') return null
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes.slice(0, MAX_NODES) : []
  const nodes = []
  const nodeIds = new Set()
  for (let index = 0; index < rawNodes.length; index++) {
    const node = normalizeNode(rawNodes[index], index)
    if (!node || nodeIds.has(node.id)) continue
    nodeIds.add(node.id)
    nodes.push(node)
  }
  if (nodes.length === 0 || !nodes.some((node) => node.type === 'input') || !nodes.some((node) => node.type === 'output')) return null
  const ids = nodeIds
  const edges = []
  const seen = new Set()
  for (const edge of (Array.isArray(raw.edges) ? raw.edges : []).slice(0, MAX_EDGES)) {
    const normalized = normalizeEdge(edge)
    if (!normalized || !ids.has(normalized.from) || !ids.has(normalized.to) || normalized.from === normalized.to) continue
    const key = normalized.from + '>' + normalized.to
    if (seen.has(key)) continue
    seen.add(key)
    edges.push(normalized)
  }
  const hasActive = nodes.some((node) => node.type === 'llm')
  return {
    schemaVersion: BLUEPRINT_SCHEMA_VERSION,
    id: text(raw.id, blueprintId(), 100).replace(/[^a-zA-Z0-9_-]/g, '-'),
    requestId: text(raw.requestId, '', 100),
    name: text(raw.name || raw.title, '未命名蓝图', 80),
    description: text(raw.description, hasActive ? '需要当前会话 AI 的可复用工作流。' : '不需要 AI 的本地像素工作流。', 360),
    mode: hasActive || raw.mode === 'active' ? 'active' : 'passive',
    nodes,
    edges,
    createdAt: number(raw.createdAt, Date.now()),
    updatedAt: Date.now()
  }
}

function defaultBlueprints() {
  const make = (id, name, description, nodes, edges) => normalizeBlueprint({ id, name, description, nodes, edges })
  return [
    make('crop-selection', '裁剪透明边界', '自动移除选区四周透明空白。', [
      { id: 'input', type: 'input', position: { x: 24, y: 60 } },
      { id: 'crop', type: 'crop', params: { padding: 0 }, position: { x: 230, y: 60 } },
      { id: 'output', type: 'output', position: { x: 436, y: 60 } }
    ], [{ from: 'input', to: 'crop' }, { from: 'crop', to: 'output' }]),
    make('outline-selection', '像素描边', '沿透明边缘生成一圈不覆盖原图的像素描边。', [
      { id: 'input', type: 'input', position: { x: 24, y: 60 } },
      { id: 'outline', type: 'outline', params: { thickness: 1, color: '#000000' }, position: { x: 230, y: 60 } },
      { id: 'output', type: 'output', position: { x: 436, y: 60 } }
    ], [{ from: 'input', to: 'outline' }, { from: 'outline', to: 'output' }]),
    make('crop-outline', '裁剪并描边', '先裁剪透明边界，再对结果做像素描边。', [
      { id: 'input', type: 'input', position: { x: 24, y: 60 } },
      { id: 'crop', type: 'crop', params: { padding: 0 }, position: { x: 210, y: 24 } },
      { id: 'outline', type: 'outline', params: { thickness: 1, color: '#000000' }, position: { x: 416, y: 96 } },
      { id: 'output', type: 'output', position: { x: 622, y: 60 } }
    ], [{ from: 'input', to: 'crop' }, { from: 'crop', to: 'outline' }, { from: 'outline', to: 'output' }]),
    make('ai-pixel-polish', 'AI 像素润色', '把当前选区交给当前会话 AI，按蓝图提示进行局部处理。', [
      { id: 'input', type: 'input', position: { x: 24, y: 60 } },
      { id: 'llm', type: 'llm', params: { prompt: '请在不改变构图和像素风格的前提下，优化这张局部像素图。' }, position: { x: 230, y: 60 } },
      { id: 'output', type: 'output', position: { x: 436, y: 60 } }
    ], [{ from: 'input', to: 'llm' }, { from: 'llm', to: 'output' }])
  ].filter(Boolean)
}

function readLibrary() {
  try {
    if (typeof localStorage === 'undefined') return []
    const parsed = JSON.parse(localStorage.getItem(BLUEPRINT_STORAGE_KEY) || '[]')
    const list = Array.isArray(parsed) ? parsed : parsed?.blueprints
    return Array.isArray(list) ? list.map(normalizeBlueprint).filter(Boolean).slice(0, MAX_BLUEPRINTS) : []
  } catch (_) {
    return []
  }
}

function writeLibrary() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(BLUEPRINT_STORAGE_KEY, JSON.stringify(blueprintList))
  } catch (_) {}
}

function publishLibrary() {
  blueprintRevision++
  blueprintSnapshot = { list: blueprintList, revision: blueprintRevision }
  writeLibrary()
  for (const listener of blueprintListeners) listener()
}

blueprintList = readLibrary()
if (blueprintList.length === 0) {
  blueprintList = defaultBlueprints()
  writeLibrary()
}
blueprintSnapshot = { list: blueprintList, revision: blueprintRevision }

export function useBlueprints() {
  return React.useSyncExternalStore(
    (listener) => { blueprintListeners.add(listener); return () => blueprintListeners.delete(listener) },
    () => blueprintSnapshot
  )
}

export function getBlueprints() {
  return blueprintList.slice()
}

export function upsertBlueprint(raw) {
  const blueprint = normalizeBlueprint(raw)
  if (!blueprint) throw new Error('蓝图格式无效或没有可执行节点')
  const index = blueprintList.findIndex((item) => item.id === blueprint.id)
  if (index >= 0) blueprintList = blueprintList.map((item, i) => i === index ? blueprint : item)
  else blueprintList = [...blueprintList, blueprint].slice(-MAX_BLUEPRINTS)
  publishLibrary()
  return blueprint
}

export function removeBlueprint(id) {
  const next = blueprintList.filter((item) => item.id !== id)
  if (next.length === blueprintList.length) return false
  blueprintList = next
  publishLibrary()
  return true
}

export function importBlueprintText(source) {
  const parsed = JSON.parse(source)
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.blueprints) ? parsed.blueprints : [parsed]
  const imported = list.map(normalizeBlueprint).filter(Boolean)
  if (imported.length === 0) throw new Error('文件中没有有效蓝图')
  for (const blueprint of imported) upsertBlueprint(blueprint)
  return imported
}

export function exportBlueprintText() {
  return JSON.stringify({ schemaVersion: BLUEPRINT_SCHEMA_VERSION, blueprints: blueprintList }, null, 2)
}

export function blueprintPrompt(task, requestId) {
  return [
    '你是 dsh-aseprite 的蓝图设计器。请把下面的像素画任务设计成一个可复用的 ComfyUI 风格节点工作流。',
    '请求 ID：' + requestId,
    '相关标记：DSH_ASE_BLUEPRINT:' + requestId + '；JSON 的 requestId 必须原样等于该请求 ID。',
    '用户任务：' + text(task, '请设计一个像素画处理工作流。', 1200),
    '',
    '安全约束：只允许使用 input、crop、outline、llm、output 五种节点；禁止输出 JavaScript、函数、脚本或任意代码。',
    'crop 参数只能有 padding（0 到 64 的整数）；outline 参数只能有 thickness（1 到 16 的整数）和 color（#RRGGBB 或 #RRGGBBAA）；llm 参数只能有 prompt。',
    '如果不需要模型，把 mode 设为 passive；只要包含 llm 节点就设为 active。',
    '请在回答最后输出唯一一个 dsh-blueprint 代码块，代码块内必须是完整 JSON，不要在 JSON 外再包一层 markdown。',
    'JSON 结构：{schemaVersion:1,requestId:"' + requestId + '",id,name,description,mode,nodes:[{id,type,label,params,position:{x,y}}],edges:[{from,to}]}。',
    '蓝图必须包含 input 和 output，并保证 edges 形成从 input 到 output 的有向图。'
  ].join('\n')
}

export function extractBlueprintsFromText(source) {
  const textSource = String(source || '').slice(0, 1024 * 1024)
  const results = []
  const fence = String.fromCharCode(96).repeat(3)
  const pattern = new RegExp(fence + '(?:dsh-blueprint|blueprint(?:-json)?|json(?:\\s+dsh-blueprint)?)\\s*([\\s\\S]*?)' + fence, 'gi')
  let match
  while ((match = pattern.exec(textSource)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim())
      const blueprint = normalizeBlueprint(parsed)
      if (blueprint) results.push(blueprint)
    } catch (_) {}
  }
  return results
}

function cloneImage(image) {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }
}

function cropImage(image, x, y, width, height) {
  const sx = Math.max(0, Math.min(image.width - 1, Math.floor(x)))
  const sy = Math.max(0, Math.min(image.height - 1, Math.floor(y)))
  const sw = Math.max(1, Math.min(image.width - sx, Math.floor(width)))
  const sh = Math.max(1, Math.min(image.height - sy, Math.floor(height)))
  const data = new Uint8ClampedArray(sw * sh * 4)
  for (let row = 0; row < sh; row++) data.set(image.data.subarray(((sy + row) * image.width + sx) * 4, ((sy + row) * image.width + sx + sw) * 4), row * sw * 4)
  return { width: sw, height: sh, data }
}

function cropTransparent(image, padding = 0) {
  let minX = image.width, minY = image.height, maxX = -1, maxY = -1
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] === 0) continue
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
    }
  }
  if (maxX < 0) return cloneImage(image)
  const pad = Math.max(0, Math.round(padding))
  return cropImage(image, minX - pad, minY - pad, maxX - minX + 1 + pad * 2, maxY - minY + 1 + pad * 2)
}

function outlineImage(image, thickness = 1, rgba = [0, 0, 0, 255]) {
  const result = cloneImage(image)
  const radius = Math.max(1, Math.round(thickness))
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const target = (y * image.width + x) * 4
      if (image.data[target + 3] !== 0) continue
      let hit = false
      for (let oy = -radius; oy <= radius && !hit; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) > radius) continue
          const nx = x + ox, ny = y + oy
          if (nx < 0 || nx >= image.width || ny < 0 || ny >= image.height) continue
          if (image.data[(ny * image.width + nx) * 4 + 3] !== 0) { hit = true; break }
        }
      }
      if (hit) { result.data[target] = rgba[0]; result.data[target + 1] = rgba[1]; result.data[target + 2] = rgba[2]; result.data[target + 3] = rgba[3] }
    }
  }
  return result
}

function promptTemplate(template, image, blueprint) {
  return text(template, '请保持像素画风格，对这张局部图像做局部优化。', 2400)
    .replace(/\{\{width\}\}/g, String(image.width))
    .replace(/\{\{height\}\}/g, String(image.height))
    .replace(/\{\{blueprint\}\}/g, blueprint.name)
}

export function executeBlueprint(blueprint, initialImage) {
  const normalized = normalizeBlueprint(blueprint)
  if (!normalized) return { ok: false, error: '蓝图格式无效' }
  const nodes = normalized.nodes
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const incoming = new Map(nodes.map((node) => [node.id, []]))
  for (const edge of normalized.edges) if (incoming.has(edge.to) && byId.has(edge.from)) incoming.get(edge.to).push(edge.from)
  const values = new Map()
  const remaining = new Set(nodes.map((node) => node.id))
  let output = null
  for (let pass = 0; pass < nodes.length + 2 && remaining.size > 0; pass++) {
    let progressed = false
    for (const node of nodes) {
      if (!remaining.has(node.id)) continue
      const parents = incoming.get(node.id) || []
      if (parents.some((parent) => !values.has(parent))) continue
      const input = parents.length > 0 ? values.get(parents[0]) : initialImage
      if (!input) return { ok: false, error: '节点 ' + node.label + ' 没有输入图像' }
      let value = input
      if (node.type === 'crop') value = cropTransparent(input, node.params.padding)
      else if (node.type === 'outline') value = outlineImage(input, node.params.thickness, node.params.color)
      else if (node.type === 'llm') return { ok: true, kind: 'active', image: input, node, prompt: promptTemplate(node.params.prompt, input, normalized), values }
      else if (node.type === 'output') output = input
      values.set(node.id, value)
      remaining.delete(node.id)
      progressed = true
    }
    if (!progressed) break
  }
  if (remaining.size > 0) return { ok: false, error: '蓝图连线存在循环或断开的节点' }
  return { ok: true, kind: 'passive', image: output || values.get(nodes[nodes.length - 1].id) || initialImage, values }
}

export function imageFromDocument(doc, frameIdx, selection) {
  const x = selection ? selection.x : 0
  const y = selection ? selection.y : 0
  const width = selection ? selection.w : doc.width
  const height = selection ? selection.h : doc.height
  const buf = compositeFrame(doc, frameIdx, new Uint8ClampedArray(doc.width * doc.height * 4))
  return cropImage({ width: doc.width, height: doc.height, data: buf }, x, y, width, height)
}

export function imageToPng(image, scale = 8) {
  const factor = Math.max(1, Math.floor(number(scale, 8)))
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
  if (factor === 1) return canvas.toDataURL('image/png')
  const scaled = document.createElement('canvas')
  scaled.width = image.width * factor; scaled.height = image.height * factor
  const scaledCtx = scaled.getContext('2d')
  scaledCtx.imageSmoothingEnabled = false
  scaledCtx.drawImage(canvas, 0, 0, scaled.width, scaled.height)
  return scaled.toDataURL('image/png')
}

export function writeImageToDocument(doc, frameIdx, layerIdx, image, x = 0, y = 0) {
  for (let row = 0; row < image.height; row++) {
    for (let col = 0; col < image.width; col++) {
      const dx = x + col, dy = y + row
      if (dx < 0 || dx >= doc.width || dy < 0 || dy >= doc.height) continue
      const i = (row * image.width + col) * 4
      setPixel(doc, frameIdx, layerIdx, dx, dy, { r: image.data[i], g: image.data[i + 1], b: image.data[i + 2], a: image.data[i + 3] })
    }
  }
  return doc
}

export function blueprintNodeTitle(type) {
  return ({ input: '输入选区', crop: '裁剪', outline: '描边', llm: 'LLM', output: '输出' }[type]) || type
}
