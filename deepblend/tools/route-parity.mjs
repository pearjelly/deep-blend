/**
 * Comparing the three install routes' readings — the check itself, as a function.
 *
 * WHY IT IS A LIBRARY AND NOT PART OF THE PROBE
 * ---------------------------------------------
 * The comparison IS the check; the three installs are only how it gets its input. Leaving it inside
 * `release-route-parity.mjs` would make it untestable without the network — MEASURED: importing that
 * script to reach this function runs the whole probe, three installs and all. So the function lives
 * here, the probe imports it, and `contract/route-parity.test.mjs` drives it with readings, which is
 * what lets the negative controls run in milliseconds instead of minutes.
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C2)
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The three routes, in the order the manual lists them, each with the spec that selects it. */
export const ROUTES = [
  { id: 'source', spec: 'github:pearjelly/deep-blend#path:/packages/deepblend/bundle', fetched: '7' },
  { id: 'npm', spec: '@deepblend/dsh-blender-bundle', fetched: '7' },
  { id: 'tarball', spec: 'https://github.com/pearjelly/deep-blend/releases/latest/download/deepblend-bundle.tgz', fetched: '1' },
]

/** The label a probe line carries, and the reading a caller should pull out of it. */
export const READING_LABELS = Object.freeze({
  version: 'installed version',
  workbench: 'workbench route',
  fetched: 'packages pnpm fetched',
  presets: 'presets deployed',
  verdict: 'result',
})

/**
 * One `label: value` line out of a probe's output.
 *
 * @param {string} output
 * @param {string} label
 * @returns {string|null}
 */
export function reading(output, label) {
  const match = output.match(new RegExp(`^${label}: (.*)$`, 'm'))
  return match === null ? null : match[1].trim()
}

/**
 * The version `deepblend/version.json` states — the repository's own answer to "what is this".
 *
 * @param {string} root
 * @returns {string}
 */
export function repositoryVersion(root) {
  return JSON.parse(readFileSync(join(root, 'deepblend', 'version.json'), 'utf8')).version
}

/**
 * Compare what the three routes reported, and say what is wrong.
 *
 * A PURE FUNCTION, exported, because the comparison is the check and the installs are only how it
 * gets its input. Testing it through three real installs would cost minutes per case and would make
 * every mutation of this logic a network operation; `contract/route-parity.test.mjs` drives it with
 * readings instead, which is what lets the negative controls run in milliseconds.
 *
 * @param {{ readings: Array<{id: string, version: string|null, workbench: string|null, fetched: string|null, presets: string|null, verdict: string|null}>, routes: Array<{id: string, fetched: string}>, expected: string }} input
 * @returns {{ lines: string[], problems: string[] }}
 */
export function compareRoutes({ readings, routes, expected }) {
  const lines = []
  const problems = []
  const say = (label, value) => lines.push(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)

  for (const entry of readings) say(`${entry.id} installed`, entry.version ?? '(none)')
  const versions = new Set(readings.map(entry => entry.version).filter(version => version !== null))
  if (versions.size > 1) {
    problems.push(`the three routes serve ${versions.size} different versions: ${[...versions].join(' | ')}`)
  } else if (versions.size === 1) {
    say('all three serve', [...versions][0])
  }

  // AND THEY MUST AGREE WITH THE REPOSITORY. Two stale routes agreeing with each other is a state this
  // check would otherwise call healthy.
  if (versions.size === 1) {
    const served = [...versions][0]
    if (!served.endsWith(`@${expected}`)) {
      problems.push(`the three routes serve ${served}, and deepblend/version.json says ${expected}`)
    } else {
      say('and the repository says', expected)
    }
  }

  for (const entry of readings) {
    if (entry.workbench === null || !/HTTP 200/.test(entry.workbench)) {
      problems.push(`${entry.id}: \`GET /deepblend/workbench\` answered ${entry.workbench ?? '(nothing)'}, and only the current version has that route`)
    } else {
      say(`${entry.id} workbench route`, 'HTTP 200')
    }
  }

  const presets = new Set(readings.map(entry => entry.presets).filter(value => value !== null))
  if (presets.size > 1) problems.push(`the routes deployed different presets: ${[...presets].join(' | ')}`)
  else if (presets.size === 1) say('all three deployed presets', [...presets][0])

  // THE DIFFERENCE THAT MUST EXIST. A check that only looks for agreement would pass on three routes
  // that all measured nothing; the tarball route is the one that carries its siblings, and the count
  // is how a reader can see the three really were different paths to the same product.
  for (const entry of readings) {
    const wanted = routes.find(route => route.id === entry.id)?.fetched
    if (entry.fetched !== wanted) {
      problems.push(`${entry.id} fetched ${entry.fetched ?? '(nothing)'} package(s), and this route is expected to fetch ${wanted}`)
    } else {
      say(`${entry.id} packages pnpm fetched`, entry.fetched)
    }
  }

  return { lines, problems }
}

