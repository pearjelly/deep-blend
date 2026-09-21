#!/usr/bin/env node
/**
 * Project the repository's listing entry into the file the plugin list accepts.
 *
 * WHY THIS EXISTS
 * ---------------
 * The submission to `awesome-dsh-plugin` is ONE file whose name the gate derives
 * from the entry's `url`:
 *
 *     data/plugins/pearjelly__deep-blend--packages-deepblend-bundle.yml
 *
 * That file lives in a DIFFERENT repository, so it cannot be read by this one's
 * test suite — and that is exactly the shape this repository treats as a defect:
 * two copies of one fact, edited in two places, drifting apart with nothing to
 * notice ("write the same thing in two places and one will rot" — D38, D43, D57,
 * D60). The submission was in that state: the branch's file had already lost one
 * of the source's comment lines, because somebody trimmed it by hand.
 *
 * So the relationship is made explicit and mechanical instead of maintained by
 * discipline:
 *
 *   **`deepblend/docs/listing-entry.yml` is the SOURCE. The submitted file is its
 *   PROJECTION, and this tool is the only writer of that projection.**
 *
 * THE PROJECTION RULE
 * -------------------
 * One sentence, and the whole of it: *the projection is the source from its first
 * permitted top-level key to the end of the file.*
 *
 * Everything above that line is this repository's own analysis — the packaging
 * decision, the three install routes, what each one still needs — which a reviewer
 * of the list has no use for and the gate would reject as keys it does not permit.
 * Everything from that line down IS the entry: the five permitted keys, the blank
 * lines between them, and the comments that explain a choice to the human reading
 * the pull request.
 *
 * The rule is deliberately not "strip the comments". Those comments are the entry's
 * rationale — why `#bundle` and not a prettier `#deepblend` — and the person who
 * reviews the submission never sees this repository, so a projection that dropped
 * them would trade one hand-maintained copy for a worse-informed review. Keeping
 * them costs nothing: they are carried mechanically, so changing one here changes
 * it there with no second edit.
 *
 * WHY A SUFFIX RATHER THAN A RE-SERIALIZATION
 * -------------------------------------------
 * Parsing the entry and printing it back would need a YAML emitter to be correct,
 * and the entry's description contains `": "` and non-ASCII text — the two things a
 * naive emitter gets wrong. A suffix cannot reformat anything, so it cannot change
 * a value: byte equality is the rule, not a hope. The contract test asserts the
 * suffix property directly.
 *
 * Usage:
 *   node deepblend/tools/project-listing-entry.mjs                  # print the projection
 *   node deepblend/tools/project-listing-entry.mjs --out <path>     # write it
 *   node deepblend/tools/project-listing-entry.mjs --check <path>   # compare a file with it
 *   node deepblend/tools/project-listing-entry.mjs --check-remote   # compare the submitted branch
 *
 * `--check-remote` reads the file from the pull request's branch through `gh`. It
 * needs the network and an authenticated `gh`, so it is NOT part of the contract
 * layer — it is a step an operator runs before touching the submission, and the
 * exit codes say which of the three states it found.
 *
 * Owner: DeepBlend Studio — M6 (plugin-market packaging)
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from './workspace-layout.mjs'

/** The entry this repository submits, and the only place its data is written. */
export const SOURCE_PATH = join(ROOT, 'deepblend', 'docs', 'listing-entry.yml')

/** The keys the ecosystem permits, in the order the gate documents them. */
export const PERMITTED_KEYS = Object.freeze(['url', 'name', 'category', 'description', 'tarball'])

/** Where the submission is read from, and the branch it is submitted on. */
export const SUBMISSION_REPO = 'pearjelly/awesome-dsh-plugin'
export const SUBMISSION_BRANCH = 'add-pearjelly-deep-blend'

/**
 * The first line of the entry, or `-1` when the file declares no permitted key.
 *
 * A top-level key is a line that starts in column zero with a permitted key name and
 * a colon. Nothing in the analysis above it matches — that text is prose and is
 * indented where it is not.
 *
 * @param {string} source
 * @returns {number} the character offset the entry begins at, or -1.
 */
export function entryOffset(source) {
  for (const line of source.split('\n')) {
    if (new RegExp(`^(${PERMITTED_KEYS.join('|')}):`).test(line)) return source.indexOf(line)
  }
  return -1
}

/**
 * The submitted file, derived from the source.
 *
 * @param {string} source - the contents of `deepblend/docs/listing-entry.yml`.
 * @returns {string} the projection, ending in exactly one newline.
 * @throws {Error} when the source declares no permitted key, which would make the
 *   projection empty — a submission the gate rejects on its first line.
 */
export function project(source) {
  const offset = entryOffset(source)
  if (offset < 0) {
    throw new Error(
      `no top-level ${PERMITTED_KEYS.join('/')} key in the listing entry, so there is nothing to submit`,
    )
  }
  // Trailing blank lines are collapsed to exactly one final newline. A file that ends
  // in two is not wrong, but "differs from the source by its trailing whitespace" is a
  // drift report nobody can act on.
  return `${source.slice(offset).replace(/\s*$/, '')}\n`
}

/**
 * The entry's data as flat `key: value` pairs, for comparing a projection with its
 * source without a YAML dependency. Only the top level is read; `description.en` and
 * `description.zh` are reached by their own pattern in the caller.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function topLevel(text) {
  const pairs = {}
  for (const line of text.split('\n')) {
    const match = /^([a-z]+):\s*(.*)$/.exec(line)
    if (match !== null) pairs[match[1]] = match[2].trim()
  }
  return pairs
}

/** The submission's path inside the list's repository, derived from the source's url. */
export function submissionPath(source) {
  const { url } = topLevel(project(source))
  const path = url.replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')
  const repo = path.split('/').slice(0, 2).join('/')
  const sub = path.includes('/tree/') ? path.split('/tree/')[1].replace(/^[^/]+\//, '') : null
  const base = repo.replaceAll('/', '__')
  return `data/plugins/${sub ? `${base}--${sub.replaceAll('/', '-')}` : base}.yml`
}

/** Fetch the submitted file's current contents from the pull request's branch. */
export function fetchRemote() {
  const path = submissionPath(readFileSync(SOURCE_PATH, 'utf8'))
  const raw = execFileSync(
    'gh',
    ['api', `repos/${SUBMISSION_REPO}/contents/${path}?ref=${SUBMISSION_BRANCH}`, '--jq', '.content'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return Buffer.from(raw.trim(), 'base64').toString('utf8')
}

/** Report the projection, or how a file differs from it. */
function main() {
  const argv = process.argv.slice(2)
  const flag = (name) => {
    const index = argv.indexOf(name)
    return index < 0 ? undefined : argv[index + 1]
  }
  const source = readFileSync(SOURCE_PATH, 'utf8')
  const projection = project(source)
  const relative = (path) => path.replace(`${ROOT}/`, '')

  const out = flag('--out')
  if (out !== undefined) {
    writeFileSync(out, projection)
    console.log(`wrote: ${relative(out)} (${projection.length} bytes)`)
    return 0
  }

  const check = flag('--check')
  if (check !== undefined) {
    const found = readFileSync(check, 'utf8')
    if (found === projection) {
      console.log(`result: ${relative(check)} is the projection of ${relative(SOURCE_PATH)}`)
      return 0
    }
    console.log(`${relative(check)}: DRIFTED from the projection of ${relative(SOURCE_PATH)}`)
    console.log(`fix: node deepblend/tools/project-listing-entry.mjs --out ${relative(check)}`)
    return 1
  }

  if (argv.includes('--check-remote')) {
    const path = submissionPath(source)
    let remote
    try {
      remote = fetchRemote()
    } catch (cause) {
      // Three states, three exit codes, and a stack is none of them: an operator who
      // cannot reach the list must be able to tell that from a drifted submission.
      console.log(`result: could not read ${SUBMISSION_REPO}:${SUBMISSION_BRANCH} — ${String(cause.message).split('\n')[0]}`)
      return 2
    }
    if (remote === projection) {
      console.log(`result: ${SUBMISSION_REPO} ${path} is the projection of ${relative(SOURCE_PATH)}`)
      return 0
    }
    console.log(`${SUBMISSION_REPO} ${path}: DRIFTED from the projection of ${relative(SOURCE_PATH)}`)
    console.log(`  submitted ${remote.length} bytes, projection ${projection.length} bytes`)
    console.log(`fix: node deepblend/tools/project-listing-entry.mjs --out <the branch's copy>, then push to ${SUBMISSION_BRANCH}`)
    return 1
  }

  process.stdout.write(projection)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main())
