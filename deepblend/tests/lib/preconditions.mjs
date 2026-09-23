/**
 * The preconditions a few contract tests need, and the reasons to skip when they are absent.
 *
 * WHY THIS EXISTS
 * ---------------
 * CI has been red since 2026-09-19, and the failure that hid everything else was `link-workspace.mjs`
 * — so the cases below were never reached, and the ones that need something a CI runner does not have
 * have been failing invisibly. MEASURED on the runner:
 *
 *   - `dsh plugin add` / `dsh plugin remove` answer `pnpm not found on PATH`, because managing profile
 *     plugins is the ecosystem's job and it uses pnpm. CI deliberately has no pnpm: CONTRIBUTING
 *     measured that the DOCUMENTED path needs none, and `verify-clean-clone` walks it without one.
 *   - there is no `$DSH_HOME` at all, so `install-plugin.mjs --check` answers `no profile at
 *     /home/runner/.dsh/profiles/web` and exits 2.
 *
 * Both are the third state this repository keeps rediscovering (D75, D96): **absent entirely is a
 * state, and a test that cannot reach its subject has to say so out loud.** `node:test` prints a skip
 * reason, so these return the reason rather than a boolean — a bare `true` would make the suite look
 * smaller than it is without saying why.
 *
 * WHAT THEY ARE NOT
 * -----------------
 * Not a way to make a failing test pass. A test that skips here is one whose SUBJECT is the ecosystem
 * path or the machine's own deployment; on a developer machine both exist and the cases run. The
 * assertions that the documented path works without pnpm are elsewhere and are not skipped:
 * `contract/setup-steps.test.mjs` holds the walkthrough, and `verify-clean-clone.mjs` runs it.
 *
 * Owner: DeepBlend Studio — commercial readiness (C5, CI)
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Memoized, because a suite asks more than once and the answer cannot change mid-run. */
let pnpmReason
let deploymentReason

/**
 * Why a test that drives the ECOSYSTEM command cannot run here, or `false` when it can.
 *
 * @returns {string|false}
 */
export function withoutPnpm() {
  if (pnpmReason === undefined) {
    const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 30_000 })
    pnpmReason = probe.status === 0
      ? false
      : 'this machine has no pnpm on PATH, and `dsh plugin add`/`remove` need it to manage profile plugins'
  }
  return pnpmReason
}

/**
 * Why a test that inspects the machine's OWN deployment cannot run here, or `false` when it can.
 *
 * The question "is the real `$DSH_HOME` still in sync with this checkout" only has an answer where a
 * deployment was installed from this checkout. A CI runner has none, and a clone's home points
 * somewhere else.
 *
 * @returns {string|false}
 */
export function withoutRealDeployment() {
  if (deploymentReason === undefined) {
    const home = process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`
    const probe = spawnSync('dsh', ['--profile', 'web', '--dump-config'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DSH_HOME: home },
    })
    const manifest = `${home}/profiles/web/package.json`
    deploymentReason = probe.status === 0 && existsSync(manifest)
      ? false
      : `there is no DSH deployment at ${home}, so "the real home was never touched" has no subject`
  }
  return deploymentReason
}

