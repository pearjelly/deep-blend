/**
 * What each tool DECLARES — parsed once, for every checker that needs it.
 *
 * WHY THIS IS A MODULE
 * --------------------
 * Two checks need the same facts: `contract/tool-parameters.test.mjs` holds each tool's declared parameters
 * against the ones its handler reads, and `contract/docs-consistency.test.mjs` holds them against the manual's
 * tables. The first version of the parser lived inside the first test, so the second would have needed a copy —
 * and a copy of a PARSER is the worst kind: the two would drift silently, and a test that parses nothing looks
 * exactly like a test that passes.
 *
 * WHAT IT PARSES, AND WHY THE SOURCE RATHER THAN THE REGISTRY
 * ----------------------------------------------------------
 * A registered tool object is a WRAPPER (`validate(args)` then `userExecute(args, exec)`), so neither the
 * declared parameters nor the reads are visible from it. The definitions are parsed instead, by brace matching,
 * which is enough for this codebase and is guarded against going vacuous by its callers: a check that finds
 * fewer tools than the product ships fails rather than passing over an empty list.
 *
 * Owner: DeepBlend Studio — M5
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The files a tool may be defined in, relative to the tool package's `lib/`. */
const SOURCES = ['index.js', 'tools.js', 'render-tools.js', 'visual-tools.js']

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
 * The `parameters` object's TOP-LEVEL keys, at brace depth 1.
 *
 * Depth matters rather than indentation: a version that matched any `word: {` at four to eight spaces swept up
 * `items:` from the JSON-Schema spelling of an array parameter and reported four tools as declaring a parameter
 * their handler never read. A schema keyword is not a parameter.
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
    const before = block.slice(0, index)
    if (!/^\s*$/.test(before.slice(before.lastIndexOf('\n') + 1))) continue
    const match = /^([a-zA-Z][a-zA-Z0-9_]*):\s*(?:\{|[A-Z][A-Z0-9_]*[,}])/.exec(block.slice(index))
    if (match !== null) keys.push(match[1])
  }
  return keys
}

/**
 * Every tool the product defines, with what it declares and what its handler reads.
 *
 * @param {string} root - repository root
 * @returns {{ source: string, name: string, declared: string[], read: string[] }[]}
 */
export function declaredTools(root) {
  const directory = join(root, 'packages', 'deepblend', 'tool', 'lib')
  const tools = []
  for (const source of SOURCES) {
    const text = readFileSync(join(directory, source), 'utf8')
    for (const block of defineToolBlocks(text)) {
      const name = /name: '([a-z_]+)'/.exec(block)?.[1]
      if (name === undefined) continue
      // `args?.x` and `args.x` are both reads; the optional-chaining spelling is used where the caller may omit
      // the whole object.
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
      tools.push({ source, name, declared: declaredParameters(block), read: [...new Set(read)] })
    }
  }
  return tools
}
