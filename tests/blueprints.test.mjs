import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../src/blueprints.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '') + '\n' +
  'globalThis.__api = { normalizeBlueprint, useBlueprints, getBlueprints, upsertBlueprint, removeBlueprint, importBlueprintText, exportBlueprintText, blueprintPrompt, extractBlueprintsFromText, executeBlueprint }'

const storage = new Map()
const context = {
  localStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value)
  },
  React: { useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() },
  compositeFrame: () => new Uint8ClampedArray(),
  setPixel: () => {}
}
vm.runInNewContext(source, context)
const api = context.__api

const node = (id, type, params = {}) => ({ id, type, params })
const image = { width: 5, height: 5, data: new Uint8ClampedArray(5 * 5 * 4) }
image.data[(2 * 5 + 2) * 4 + 3] = 255

const safe = api.normalizeBlueprint({
  id: 'safe',
  nodes: [node('input', 'input'), node('crop', 'crop', { padding: 99 }), node('output', 'output'), { id: 'evil', type: 'javascript', script: 'alert(1)' }],
  edges: [{ from: 'input', to: 'crop' }, { from: 'crop', to: 'output' }, { from: 'evil', to: 'output' }],
  script: 'never execute this'
})
assert.equal(safe.nodes.length, 3)
assert.equal(safe.nodes.find((item) => item.id === 'crop').params.padding, 64)
assert.equal(Object.hasOwn(safe, 'script'), false)

const crop = api.executeBlueprint({
  nodes: [node('input', 'input'), node('crop', 'crop'), node('output', 'output')],
  edges: [{ from: 'input', to: 'crop' }, { from: 'crop', to: 'output' }]
}, image)
assert.equal(crop.ok, true)
assert.deepEqual([crop.image.width, crop.image.height], [1, 1])

const outline = api.executeBlueprint({
  nodes: [node('input', 'input'), node('outline', 'outline', { thickness: 1, color: '#ff0000' }), node('output', 'output')],
  edges: [{ from: 'input', to: 'outline' }, { from: 'outline', to: 'output' }]
}, image)
assert.equal(outline.ok, true)
assert.equal(outline.image.data[(1 * 5 + 1) * 4 + 3], 255)
assert.equal(outline.image.data[(1 * 5 + 1) * 4], 255)

const active = api.executeBlueprint({
  name: 'active',
  nodes: [node('input', 'input'), node('llm', 'llm', { prompt: '处理 {{width}}x{{height}}：{{blueprint}}' }), node('output', 'output')],
  edges: [{ from: 'input', to: 'llm' }, { from: 'llm', to: 'output' }]
}, image)
assert.equal(active.kind, 'active')
assert.match(active.prompt, /5x5/)
assert.match(active.prompt, /active/)

const cycle = api.executeBlueprint({ nodes: [node('a', 'input'), node('b', 'crop')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }, image)
assert.equal(cycle.ok, false)

const fence = String.fromCharCode(96).repeat(3)
const parsed = api.extractBlueprintsFromText(fence + 'json\n{"id":"parsed","name":"自动保存","nodes":[{"id":"i","type":"input"},{"id":"o","type":"output"}],"edges":[{"from":"i","to":"o"}]}' + fence)
assert.equal(parsed.length, 1)
assert.equal(parsed[0].name, '自动保存')
assert.match(api.blueprintPrompt('裁剪并描边', 'request-1'), /request-1/)

const persisted = api.upsertBlueprint({ id: 'persisted', name: '持久化', nodes: [node('i', 'input'), node('o', 'output')], edges: [{ from: 'i', to: 'o' }] })
assert.equal(api.getBlueprints().some((item) => item.id === persisted.id), true)
assert.match(api.exportBlueprintText(), /持久化/)
const imported = api.importBlueprintText(JSON.stringify({ blueprints: [persisted] }))
assert.equal(imported.length, 1)
assert.equal(api.removeBlueprint('persisted'), true)

console.log('blueprints: ok')
