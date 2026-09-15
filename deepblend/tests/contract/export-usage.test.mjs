#!/usr/bin/env node
/**
 * Export surface contract — what a package exports is a promise, and every promise is kept or withdrawn.
 *
 * WHY THIS EXISTS (round 36)
 * --------------------------
 * Round 35 found it by accident: `provider-local` exported `inspectExecutablePath` and
 * `discoverBlenderOnPath`, `contract/imports.test.mjs` required them to exist, a comment described the
 * settings-card affordance they served — and NOTHING in the product called either, because the
 * affordance did not exist. Auditing the whole surface the same way found more:
 *
 *   - `JOB_RECORD_VERSION` — unused, while the host wrote its literal string in SIX places;
 *   - `LOG_SCOPE` — unused, while the host wrote its literal prefix in SIX places;
 *   - `asBlenderError` — unused, a second implementation of what `renderFailure` already does;
 *   - `VISUAL_TOOL_NAMES` — unused, and its comment claimed a re-export that did not exist. It is also
 *     the shape this repository keeps paying for: a second list of the tools, beside the registry the
 *     suites already assert;
 *   - and the SERVICE NAMES, written twice each in different packages (`'blenderRuntime'` in the
 *     provider and again as a private literal in the host; `'blenderStudio'` in the host and again in
 *     the tool). Nothing tied the copies together, so renaming one would have surfaced as "the host
 *     bundle is missing" at runtime.
 *
 * WHAT THIS CHECKS
 * ----------------
 *   1. no exported symbol of the five packages is DEAD — used nowhere in this repository, in any file
 *      type. (Loader-convention exports are exempt: `apply`, `name`, `inject`, `Config`, `default` are
 *      consumed by Cordis by name, and no import of them can exist.)
 *   2. a rejection list, because "used nowhere" is sometimes deliberate: every entry there needs a
 *      reason, and the reason is what a reviewer checks.
 *   3. the names that cross a plane agree: what the provider registers equals what the host resolves,
 *      what the host registers equals what the tool binds to, and no two services share a name.
 *   4. each service is registered THROUGH its constant (`super(ctx, NAME)`), not through a literal, or
 *      the constant and the registration can drift apart while this file still passes.
 *
 * Run: node deepblend/tests/contract/export-usage.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BLENDER_RUNTIME_SERVICE } from '@deepblend/dsh-blender-provider-local'
import { BLENDER_STUDIO_SERVICE, RUNTIME_SERVICE } from '@deepblend/dsh-blender-host'
import { STUDIO_SERVICE } from '@deepblend/dsh-blender-tool'
import { ROOT } from '../../tools/workspace-layout.mjs'

/** The five packages whose surface a reader may import. */
const PACKAGES = ['contracts', 'provider-local', 'host', 'tool', 'ui']

/** Exports the Loader consumes by name; no import of these can exist. */
const LOADER_CONVENTION = new Set(['apply', 'name', 'inject', 'Config', 'default'])

/**
 * Symbols that are deliberately unused, each with the reason a reviewer should check.
 * @type {Record<string, string>}
 */
const ACCEPTED_UNUSED = {
  // EMPTIED IN ROUND 37. Every name that was listed here was withdrawn: `compileSchemaText`,
  // `ANIMATION_TARGET_KINDS`, `ANIMATION_PROPERTIES`, `SCENE_ENGINES`, `toCanonicalPreviewResult`,
  // `VISUAL_ISSUE_VERSION`, `describeMeasurements` and `UI_ROUTE_IDS` are gone, together with the
  // barrel lines that re-exported them. Three of them documented a use that did not exist — the same
  // defect round 35 found in the provider — and two were second copies of vocabularies the JSON Schema
  // really enforces. The table stays, EMPTY, because "used nowhere" is sometimes deliberate and the
  // next such name needs somewhere to be declared with its reason.
}
const TEXT_FILE = /\.(js|mjs|json|ya?ml|md|py)$/
/** Files whose contents can be a call site. Markdown and prose are not. */
const CODE_FILE = /\.(js|mjs|py|ya?ml|json)$/

function walk(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path, found)
    else if (entry.isFile() && TEXT_FILE.test(entry.name)) found.push(path)
  }
  return found
}

const repositoryFiles = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'deepblend'))]

/** This file, which names symbols in prose and must not be counted as one of their callers. */
const SELF = fileURLToPath(import.meta.url)

/** Every name a file exports, with `export { a, b as c }` handled. */
function exportsOf(path) {
  const text = readFileSync(path, 'utf8')
  const names = new Set()
  for (const match of text.matchAll(/^export (?:async )?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1])
  }
  for (const match of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const piece = part.trim()
      if (piece.length === 0) continue
      const renamed = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(piece)
      names.add(renamed !== null ? renamed[2] : piece.split(/\s+/)[0])
    }
  }
  return names
}

/**
 * The source with `import` and re-`export ... from` statements removed.
 *
 * WHY A SCANNER AND NOT A REGEX, measured three times in a row:
 *
 *   1. a line-by-line filter missed the multi-line form, so `import {\n  A,\n} from 'x'` left the name
 *      on a line of its own and a reverted constant still counted as used;
 *   2. a whole-statement regex (`^\s*(?:import|export)\b[\s\S]*?from\s*['"]…`) swallowed 186k of a
 *      189k-character file, because `export default class …` matches "starts with export" and the
 *      first `from '…'` after it was the re-export block at the END of the file;
 *   3. which is why declarations are recognised as declarations here: `export default|class|function|
 *      const|let|var` is code, and only `import`, `export {…} from`, `export * from` and bare imports
 *      are statements to skip.
 *
 * @param {string} text
 * @returns {string}
 */
/** Does this line END an import or re-export statement? */
const ENDS_IMPORT = /\bfrom\s*['"][^'"]+['"]\s*(?:(?:with|assert)\s*\{[^}]*\}\s*)?;?\s*$/

export function codeWithoutImports(text) {
  const kept = []
  let insideStatement = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!insideStatement) {
      const declaration = /^export\s+(?:default|async\s+function|function|class|const|let|var)\b/.test(trimmed)
      // `import.meta.dirname` is an EXPRESSION, not a statement — and it is indented mid-file, so
      // matching a bare `^import` swallowed the rest of every file that uses it (measured: 35 of 599
      // lines survived in `scene-spec.test.mjs`, which is why `SCENE_ENGINES` was reported dead while
      // two checks in that very file pin it).
      const importLike = /^import\s+(?![.=(])\S/.test(trimmed) || /^import\s*['"]/.test(trimmed) ||
        /^export\s*(?:\{|\*)/.test(trimmed)
      if (!declaration && importLike) {
        const completesHere = ENDS_IMPORT.test(trimmed) || /^import\s*['"]/.test(trimmed)
        insideStatement = !completesHere
        continue
      }
    } else {
      if (ENDS_IMPORT.test(trimmed)) insideStatement = false
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * How many times a name appears in CODE anywhere in this repository.
 *
 * The question is deliberately global rather than "outside the defining file", because a BARREL package
 * re-exports names it does not define: `contracts/lib/index.js` is the file the audit sees, the
 * definition lives in a sibling module, and asking "is it used outside index.js" flagged eighteen
 * symbols that siblings call every day (measured). What matters is simpler: is this name mentioned
 * anywhere except the statement that defines it?
 */
function codeUses(name) {
  const pattern = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`)
  let count = 0
  for (const path of repositoryFiles) {
    if (!CODE_FILE.test(path)) continue
    // THE AUDITOR IS NOT A CALLER. This file names the symbols it is about — in its header, in the
    // reasons below, and in the failure message — and counting those mentions made the rule blind to
    // exactly the case it was written for: reverting the `JOB_RECORD_VERSION` wiring still "used" the
    // constant, because the assertion message that reports dead exports names it. Measured.
    if (path === SELF) continue
    for (const line of codeWithoutImports(readFileSync(path, 'utf8')).split('\n')) {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue
      if (pattern.test(line)) count += 1
    }
  }
  return count
}

test('no exported symbol of the five packages is dead', () => {
  const dead = []
  for (const pkg of PACKAGES) {
    const libDirectory = join(ROOT, 'packages', 'deepblend', pkg, 'lib')
    if (!existsSync(libDirectory)) continue
    for (const path of walk(libDirectory).filter(file => file.endsWith('.js'))) {
      for (const name of exportsOf(path)) {
        if (LOADER_CONVENTION.has(name)) continue
        // One mention is the definition itself; anything that is never mentioned again is dead.
        if (codeUses(name) > 1) continue
        const key = `${pkg}/${relative(libDirectory, path)}::${name}`
        if (ACCEPTED_UNUSED[key] !== undefined) continue
        dead.push(key)
      }
    }
  }
  assert.deepEqual(
    dead,
    [],
    'these exports are used nowhere in this repository: wire them (as `JOB_RECORD_VERSION` was) or ' +
      'withdraw them (as `asBlenderError` was); if one is deliberately external, add it to ' +
      `ACCEPTED_UNUSED with its reason — ${dead.join(', ')}`,
  )
})

test('the import scanner removes statements and keeps code — the three shapes that fooled it', () => {
  // Each of these broke a version of this checker, and each failure looked like a dead export rather
  // than like a broken scanner:
  const source = [
    "import { A, B } from './one.js'",
    'import {',
    '  MULTI,',
    '  LINE,',
    "} from './two.js'",
    "import attributes from './x.schema.json' with { type: 'json' }",
    "import './side-effect.js'",
    "export { ReExported } from './three.js'",
    "export * from './four.js'",
    'export default class Service {}',
    'const here = import.meta.dirname',
    'export function kept() { return MULTI + LINE + attributes + ReExported }',
    'const alsoKept = A + B',
  ].join('\n')
  const stripped = codeWithoutImports(source)

  for (const gone of ['A, B', 'MULTI,', "from './two.js'", "with { type: 'json' }", "export * from './four.js'"]) {
    assert.equal(stripped.includes(gone), false, `the scanner kept "${gone}"`)
  }
  for (const kept of ['export default class Service {}', 'export function kept()', 'const alsoKept = A + B',
    'const here = import.meta.dirname']) {
    assert.equal(stripped.includes(kept), true, `the scanner removed "${kept}"`)
  }
  // The USES inside kept code stay, which is the whole point: `MULTI` and `attributes` are references.
  assert.match(stripped, /return MULTI \+ LINE \+ attributes \+ ReExported/)
})

test('the names that cross a plane agree with each other', () => {
  // The provider REGISTERS this name; the host resolves it.
  assert.equal(
    RUNTIME_SERVICE,
    BLENDER_RUNTIME_SERVICE,
    'the host resolves a runtime service the provider does not register — a rename on one side only',
  )
  // The host REGISTERS this name; the tool binds to it from another package.
  assert.equal(
    BLENDER_STUDIO_SERVICE,
    STUDIO_SERVICE,
    'the tool binds to a service name the host does not register (this is what a rename looks like)',
  )
  assert.equal(
    new Set([BLENDER_STUDIO_SERVICE, BLENDER_RUNTIME_SERVICE]).size,
    2,
    'two services share a name, so `ctx.get` cannot tell them apart',
  )
})

test('each service is registered through its constant, not through a literal', () => {
  // Otherwise the constant above could drift from what is actually registered while the tie passes.
  const files = [
    ['host/lib/index.js', 'BLENDER_STUDIO_SERVICE'],
    ['provider-local/lib/index.js', 'BLENDER_RUNTIME_SERVICE'],
  ]
  for (const [file, constant] of files) {
    const text = readFileSync(join(ROOT, 'packages', 'deepblend', file), 'utf8')
    assert.match(
      text,
      new RegExp(`super\\(ctx, ${constant}\\)`),
      `${file} does not register its service through ${constant}`,
    )
  }
  // ...and the ui plane, which nothing resolves by name yet, still declares its own.
  const ui = readFileSync(join(ROOT, 'packages', 'deepblend', 'ui', 'lib', 'index.js'), 'utf8')
  assert.match(ui, /super\(ctx, BLENDER_UI_SERVICE\)/, 'the ui service is registered through a literal')
})
