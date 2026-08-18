/**
 * dsh-aseprite build script (zero-dependency): assembles src/ase-codec.js +
 * src/editor.js + src/client.js into the DSH browser module contract:
 *
 *   window.__ModuleLoader__.load({ id: "dsh-aseprite", factory: (require) => {...} })
 *
 * The three sources are ESM for authoring convenience; this script strips the
 * import/export keywords (they share one scope) and emits a single CJS-style
 * factory that requires only "react" (resolved by the host page's module
 * table, same as dshmarket/dsh-terminal).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function stripEsm(src) {
  // remove whole import statements (single-line and multi-line braces)
  let out = src
    .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?\s*/g, '')
    .replace(/import\s*['"][^'"]+['"];?\s*/g, '')
    .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
  out = out
    .split('\n')
    .map((line) => {
      const t = line.trim()
      if (t.startsWith('export default ')) return line.replace('export default ', '')
      if (t.startsWith('export ')) return line.replace(/^export /, '')
      return line
    })
    .join('\n')
  return out
}

const codec = stripEsm(readFileSync(resolve(root, 'src/ase-codec.js'), 'utf8'))
const editor = stripEsm(readFileSync(resolve(root, 'src/editor.js'), 'utf8'))
const client = stripEsm(readFileSync(resolve(root, 'src/client.js'), 'utf8'))

const out = [
  '/* dsh-aseprite client bundle — built by scripts/build.mjs. DO NOT EDIT. */',
  'window.__ModuleLoader__.load({',
  '\tid: "dsh-aseprite",',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  '\t\tconst React = require("react");',
  '',
  codec,
  '',
  editor,
  '',
  client,
  '',
  '\t\texports.name = name;',
  '\t\texports.inject = inject;',
  '\t\texports.apply = apply;',
  '\t\treturn module.exports;',
  '\t}',
  '});',
  ''
].join('\n')

writeFileSync(resolve(root, 'client/client.js'), out)
console.log('wrote client/client.js (' + out.length + ' bytes)')
