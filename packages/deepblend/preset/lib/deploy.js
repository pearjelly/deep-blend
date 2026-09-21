/**
 * @deepblend/dsh-blender-preset — the deployment rule.
 *
 * WHAT THIS FILE IS
 * -----------------
 * One answer to "what files is a preset made of, and how does an installed copy
 * differ from the shipped one". Three callers need that answer and must not be
 * allowed to disagree:
 *
 *   - `lib/index.js`, the plugin row that deploys the presets when the profile
 *     composes this package (the path a plugin-market user takes);
 *   - `deepblend/tools/install-presets.mjs`, the repository's operator tool;
 *   - `deepblend/tools/sync-plugin-presets.mjs`, which keeps the copy this
 *     package ships identical to `deepblend/presets/` (SPEC §5.2).
 *
 * A rule reachable only through one of them is a rule the other two can drift
 * from silently — which is the failure this repository has paid for repeatedly
 * (D38, D43, D57, D60: a list copied into a second place rots in the copy).
 *
 * WHY THE WHOLE DIRECTORY TRAVELS
 * -------------------------------
 * `REQUIRED_FILES` is what a preset cannot be without, not what is copied. The
 * rest of the directory travels too: a preset's `skills/` directory is loaded
 * through `customSkillDirs`, resolved against the composition's own base URL, so
 * copying a fixed file list silently drops the skill the persona tells the model
 * to load — the preset mounts, every tool arrives, and the skill is simply not
 * in the catalog.
 *
 * THREE STATES, NOT TWO
 * ---------------------
 * `absent` (nothing of this preset is installed) is a state, not drift: that is
 * every fresh machine, and reporting it as drift is what made the operator tool
 * exit 1 on a machine where nothing was wrong. `partial` is drift, because a
 * half-present preset is broken rather than absent.
 *
 * Owner: DeepBlend Studio — M6 (plugin-market packaging)
 * Plane: Agent preset
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The presets this package ships, resolved relative to this module.
 *
 * A URL rather than a path computed from `process.cwd()`: the package is
 * installed into a profile's `node_modules` and the process may be started from
 * anywhere, so its own location is the only stable anchor.
 */
export const PRESET_SOURCE = fileURLToPath(new URL('../presets/', import.meta.url))

/** The writable preset root under the harness home (`@deepseek-ai/dsh-agent-presets`). */
export const USER_PRESET_DIR = '.agent-presets'

/** Files a preset directory cannot be without. A preset missing one is not deployed at all. */
export const REQUIRED_FILES = ['preset.yml', 'agent.cordis.yml']

/** Directories inside a preset that are never part of it. */
export const IGNORED_DIRECTORIES = new Set(['node_modules', '.git'])

/**
 * The harness home this process would deploy into.
 *
 * `DSH_HOME` first because that is what the launcher itself honours, so a plugin
 * running inside a deployment writes to the same home the deployment reads.
 *
 * @returns {string}
 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** The default target root: `<DSH_HOME>/.agent-presets`. */
export function defaultTarget() {
  return join(dshHome(), USER_PRESET_DIR)
}

/**
 * Every file under `directory`, as paths relative to it, in a stable order.
 *
 * Sorted because the result is compared between two trees: an unsorted walk
 * makes a difference report depend on the filesystem's own order.
 *
 * @param {string} directory
 * @returns {string[]}
 */
export function filesUnder(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue
      for (const nested of filesUnder(join(directory, entry.name))) found.push(join(entry.name, nested))
    } else if (entry.isFile()) {
      found.push(entry.name)
    }
  }
  return found
}

/**
 * The preset ids a source root holds, in a stable order.
 *
 * @param {string} [source]
 * @returns {string[]}
 */
export function presetIds(source = PRESET_SOURCE) {
  if (!existsSync(source)) return []
  return readdirSync(source)
    .filter(name => statSync(join(source, name)).isDirectory())
    .sort()
}

/**
 * What a preset's `preset.yml` and composition directory look like to a deployer.
 *
 * @typedef {object} PresetPlan
 * @property {string} id
 * @property {string} source
 * @property {string} target
 * @property {string[]} files        every file the shipped copy has
 * @property {string[]} missing      shipped files the target does not have
 * @property {string[]} drifted      shipped files whose bytes differ
 * @property {string[]} stale        target files the shipped copy no longer has
 * @property {boolean} absent        the target holds none of this preset
 * @property {string|null} problem   why this preset cannot be deployed at all
 */

/**
 * Compare one shipped preset against one installed copy, writing nothing.
 *
 * @param {object} input
 * @param {string} input.source - the shipped preset directory.
 * @param {string} input.target - where the preset would be installed.
 * @param {string} [input.id] - the preset id, for the report.
 * @returns {PresetPlan}
 */
export function planPreset({ source, target, id = source.split('/').pop() }) {
  const missingRequired = REQUIRED_FILES.filter(file => !existsSync(join(source, file)))
  if (missingRequired.length > 0) {
    // A preset without its composition is not a preset; refusing beats writing half of one.
    return {
      id, source, target,
      files: [], missing: [], drifted: [], stale: [], absent: !existsSync(target),
      problem: `missing ${missingRequired.join(', ')} in the shipped copy`,
    }
  }

  const files = filesUnder(source)
  const targetFiles = existsSync(target) ? filesUnder(target) : []
  const missing = []
  const drifted = []
  for (const file of files) {
    const installed = join(target, file)
    if (!existsSync(installed)) {
      missing.push(file)
      continue
    }
    if (readFileSync(join(source, file), 'utf8') !== readFileSync(installed, 'utf8')) drifted.push(file)
  }
  return {
    id, source, target, files, missing, drifted,
    stale: targetFiles.filter(file => !files.includes(file)),
    // "Nothing of this preset is here" — the state every fresh machine is in, and not drift.
    absent: targetFiles.length === 0,
    problem: null,
  }
}

/**
 * Deploy one planned preset: write what differs, remove what the shipped copy no
 * longer has, and leave everything else alone.
 *
 * The target is a user-owned root — a person may have authored presets of their
 * own beside these — so this only ever touches the files of the preset it was
 * given, and never the root itself.
 *
 * @param {PresetPlan} plan
 * @returns {{written: string[], removed: string[]}}
 */
export function applyPreset(plan) {
  if (plan.problem !== null) return { written: [], removed: [] }
  const written = []
  const removed = []
  for (const stale of plan.stale) {
    rmSync(join(plan.target, stale), { force: true })
    removed.push(stale)
  }
  for (const file of [...plan.missing, ...plan.drifted]) {
    const to = join(plan.target, file)
    mkdirSync(join(to, '..'), { recursive: true })
    copyFileSync(join(plan.source, file), to)
    written.push(file)
  }
  return { written, removed }
}

/**
 * Deploy every preset a source root holds, and report what each one needed.
 *
 * @param {object} [options]
 * @param {string} [options.source] - the shipped preset root.
 * @param {string} [options.target] - the installed preset root.
 * @param {string[]} [options.ids] - restrict to these preset ids.
 * @returns {Array<{id: string, plan: PresetPlan, written: string[], removed: string[]}>}
 */
export function deployPresets({ source = PRESET_SOURCE, target = defaultTarget(), ids } = {}) {
  const wanted = ids === undefined ? presetIds(source) : ids
  const reports = []
  for (const id of wanted) {
    const plan = planPreset({ source: join(source, id), target: join(target, id), id })
    const { written, removed } = applyPreset(plan)
    reports.push({ id, plan, written, removed })
  }
  return reports
}
