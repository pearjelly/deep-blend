#!/usr/bin/env node
/**
 * The parameters a tool DECLARES, held against the parameters its handler READS.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A tool's `parameters` block is a promise made to the MODEL, and the model cannot check it: it fills in
 * `license` because the description says "Licence string recorded with the asset", and if the handler never
 * passes it on, the model has been lied to by the only party it can ask. MEASURED before this existed:
 * `blender_asset_ingest` declared `license`, the tool built its request without it, and the host had no
 * licence field at all — while the SceneSpec's asset schema HAS one, so the string had somewhere to go the
 * whole time. That is the same failure as a config key nothing reads (D169), one surface over, and it is
 * worse here because the reader who believes it is a model with no way to find out.
 *
 * WHAT IT PARSES, AND WHY THE SOURCE RATHER THAN THE REGISTRY
 * ----------------------------------------------------------
 * The registered tool object is a WRAPPER (`validate(args)` then `userExecute(args, exec)`), so the reads
 * are not visible from it at all. The definitions are parsed instead, by brace matching, which is enough
 * for this codebase and is guarded against going vacuous: the number of tools found must equal the number
 * of tools the product ships, so a reshaping of `defineTool` fails here rather than silently checking
 * nothing.
 *
 * THE ONE ALLOWANCE, NAMED
 * ------------------------
 * A handler may pass the whole `args` object to a helper (`studio.someCall(args)`), and then no `args.x`
 * appears anywhere. That case is detected and SKIPPED for the declared-but-unread direction only — and it
 * is reported as an allowance, not as a pass, so a tool cannot hide a dead parameter behind it without the
 * line being visible in this file.
 *
 * Run standalone: `node deepblend/tests/contract/tool-parameters.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { UI_TOOL_CARD_KEYS } from '@deepblend/dsh-blender-contracts'

import { ROOT } from '../../tools/workspace-layout.mjs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const TOOL_DIR = join(ROOT, 'packages', 'deepblend', 'tool', 'lib')
const SOURCES = ['index.js', 'tools.js', 'render-tools.js', 'visual-tools.js']
  .map(name => ({ name, text: readFileSync(join(TOOL_DIR, name), 'utf8') }))

/** Every `defineTool({ … })` block, found by brace matching so a nested object does not end it early. */
function defineToolBlocks(text) {
  const blocks = []
  let at = text.indexOf('defineTool({')
  while (at !== -1) {
    const open = text.indexOf('{', at)
    let depth = 0
    let index = open
    for (; index < text.length; index += 1) {
      if (text[index] === '{') depth += 1
      else if (text[index] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    blocks.push(text.slice(open, index + 1))
    at = text.indexOf('defineTool({', index)
  }
  return blocks
}

/**
 * The `parameters` object of a block: its TOP-LEVEL keys, at brace depth 1.
 *
 * Depth matters rather than indentation: the first version matched any `word: {` at four to eight spaces,
 * which swept up `items:` from the JSON-Schema spelling of an array parameter and reported four tools as
 * declaring a parameter their handler never read. A schema keyword is not a parameter.
 */
function declaredParameters(block) {
  const start = block.indexOf('parameters:')
  if (start === -1) return []
  if (block.slice(start, start + 40).includes('undefined')) return []
  const open = block.indexOf('{', start)
  const keys = []
  let depth = 0
  for (let index = open; index < block.length; index += 1) {
    const char = block[index]
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) break
      continue
    }
    if (depth !== 1) continue
    const rest = block.slice(index)
    const match = /^([a-zA-Z][a-zA-Z0-9_]*):\s*(?:\{|[A-Z][A-Z0-9_]*[,}])/.exec(rest)
    if (match === null) continue
    // Only a key that starts a line: `{ id: x }` on one line is a value, not a declaration.
    const before = block.slice(0, index)
    const lineStart = before.lastIndexOf('\n') + 1
    if (!/^\s*$/.test(before.slice(lineStart))) continue
    keys.push(match[1])
  }
  return keys
}

const tools = []
for (const source of SOURCES) {
  for (const block of defineToolBlocks(source.text)) {
    const name = /name: '([a-z_]+)'/.exec(block)?.[1]
    if (name === undefined) continue
    // `args?.x` and `args.x` are both reads; the optional-chaining spelling is used where the caller may
    // omit the whole object.
    const read = [...new Set([...block.matchAll(/\bargs\?\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map(m => m[1])
      .concat([...block.matchAll(/\bargs\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map(m => m[1])))]
    // A parameter may also arrive by DESTRUCTURING (`const { limit } = args`), which is a read even though no
    // `args.limit` appears anywhere.
    for (const match of block.matchAll(/const\s*\{([^}]*)\}\s*=\s*args\b/g)) {
      for (const piece of match[1].split(',')) {
        const key = piece.split(':').pop().split('=')[0].trim()
        if (/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) read.push(key)
      }
    }
    // NO WHOLE-ARGS ALLOWANCE. The first version had one, and it flagged all sixteen tools — because every
    // handler passes `args` to a helper somewhere, so an allowance that admits everybody is not an allowance
    // but a hole. The unread direction below is applied to every tool instead, and it is safe to do so: the
    // measurement that found the real defect (`license`, declared and never passed on) also showed no tool
    // reading a declared parameter ONLY through a helper.
    tools.push({ source: source.name, name, declared: declaredParameters(block), read: [...new Set(read)] })
  }
}

check('every tool the product ships was parsed (a check over fewer tools than exist proves less)',
  tools.length === UI_TOOL_CARD_KEYS.length,
  { parsed: tools.length, shipped: UI_TOOL_CARD_KEYS.length, names: tools.map(tool => tool.name) })
check('and every parsed tool declares parameters at all, so the two directions below have content',
  tools.every(tool => tool.declared.length > 0),
  tools.filter(tool => tool.declared.length === 0).map(tool => tool.name))

const unread = tools.filter(tool => tool.declared.some(key => !tool.read.includes(key)))
check('every declared parameter is READ by its handler (a parameter nobody reads is a lie told to the model)',
  unread.length === 0,
  unread.map(tool => `${tool.name}: ${tool.declared.filter(key => !tool.read.includes(key)).join(', ')}`))

const undeclared = tools.filter(tool => tool.read.some(key => !tool.declared.includes(key)))
check('every parameter a handler reads is DECLARED (an undeclared read can never arrive)',
  undeclared.length === 0,
  undeclared.map(tool => `${tool.name}: ${tool.read.filter(key => !tool.declared.includes(key)).join(', ')}`))

// Every tool must declare at least one parameter and read at least one: a tool whose reads are invisible to
// this parser would otherwise pass the two directions above by having nothing to check.
check('every parsed tool both declares and reads at least one parameter (no tool passes by being unreadable)',
  tools.every(tool => tool.declared.length > 0 && tool.read.length > 0),
  tools.filter(tool => tool.declared.length === 0 || tool.read.length === 0).map(tool => tool.name))

const passed = results.filter(entry => entry.ok).length
console.log(`\nTool parameters: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
