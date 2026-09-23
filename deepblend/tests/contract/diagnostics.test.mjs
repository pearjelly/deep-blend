#!/usr/bin/env node
/**
 * The diagnostic bundle — what a user sends to somebody else.
 *
 * WHY THIS EXISTS
 * ---------------
 * The ledger's row C10 asked whether a user can export diagnostics, and the measured answer was no:
 * the workbench had no export action and the Host had no route behind one. A commercial product
 * whose failures are all branchable (`recovery.md` §10) still fails the moment a user has to
 * DESCRIBE their machine in prose — the maintainer's first three questions are versions, storage
 * location and whether Blender works, and every one of them is a field.
 *
 * Three things are asserted here, and they are three different risks:
 *
 *   1. **The bundle is built by a pure function**, so its shape is a contract rather than whatever
 *      an HTTP handler happened to assemble — including `generatedAt`, which is passed in.
 *   2. **It does not leak what it must not.** It is the first artifact this product makes FOR a user
 *      to hand to a stranger, and the first thing it would carry is absolute paths. The home prefix
 *      becomes `~`; scene documents, artifact bytes, model text and environment variables are not in
 *      it at all, and the bundle SAYS so in `redaction.excluded` rather than leaving a reader to
 *      guess.
 *   3. **It still works on the machine that needs it.** A Blender probe that fails is a value in the
 *      bundle, not an error page: the machine with a broken Blender is exactly the machine whose
 *      bundle somebody is about to send.
 *
 * The version it reports is compared against `deepblend/version.json` — the single source — so the
 * bundle is a READING of the version rather than a second copy of it.
 *
 * Run standalone: `node deepblend/tests/contract/diagnostics.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C10)
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'

import {
  BlenderErrorCode,
  DIAGNOSTICS_FAILURE_LIMIT,
  DIAGNOSTICS_FORMAT,
  DIAGNOSTICS_FORMAT_VERSION,
  DIAGNOSTICS_JOB_LIMIT,
  HOST_API_VERSION,
  UI_ROUTES,
  buildDiagnosticsBundle,
  redactHome,
} from '@deepblend/dsh-blender-contracts'
import { createHandlers } from '@deepblend/dsh-blender-ui'
import { diagnosticConfiguration, readProductVersion } from '@deepblend/dsh-blender-host'

import { importDsh } from '../lib/dsh-deployment.mjs'
import { ROOT } from '../../tools/workspace-layout.mjs'

/** The harness's own definition of lossless JSON — the same one `ui-api.test.mjs` uses. */
const { isJsonValue } = await importDsh('dsh-util-values')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

// ---------------------------------------------------------------------------
// A machine, as a fixture. The home is a made-up one so the assertions below can
// look for it by name.
// ---------------------------------------------------------------------------

const HOME = '/Users/example'

/**
 * The home the HANDLER will redact, which is this process's own.
 *
 * The two are different on purpose: the pure builder is driven with a made-up home so the assertions
 * can look for it by name, while the handler reads `os.homedir()` — so the stub's paths have to sit
 * under the REAL one, or the redaction under test is not the redaction being exercised. MEASURED:
 * the first version of this file used the made-up home for both and reported "a home path reached
 * the wire" about a product that was behaving correctly.
 */
const REAL_HOME = homedir()
const versionSource = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'version.json'), 'utf8')).version

const capabilities = {
  installed: true,
  version: 'Blender 5.2.1 LTS',
  pythonVersion: '3.11.9',
  executable: { requested: `${HOME}/.tools/Blender.app/Contents/MacOS/Blender`, resolved: `${HOME}/.tools/Blender.app/Contents/MacOS/Blender`, advice: null },
  engines: { cycles: { available: true }, workbench: { available: true }, eevee: { available: false } },
  bestAvailableEngine: 'cycles',
  gpu: { available: false, devices: [], preferredBackend: null },
  renderSmokeTest: { ok: true, engine: 'cycles', bytes: 2048, error: null },
  warnings: [{ code: 'BLENDER_GPU_UNAVAILABLE', message: `no GPU at ${HOME}, falling back to CPU` }],
  probedAt: '2026-09-22T00:00:00.000Z',
}

const bundle = buildDiagnosticsBundle({
  generatedAt: '2026-09-22T10:00:00.000Z',
  product: { name: 'DeepBlend Studio', version: versionSource, hostApiVersion: HOST_API_VERSION },
  environment: { node: 'v26.8.2', platform: 'darwin', arch: 'arm64', home: HOME },
  blender: { probed: true, note: 'probed', capabilities, error: null },
  config: { projectsRoot: `${HOME}/.dsh/deepblend/projects`, maxPreviewSamples: 512, requireApprovalAboveFrames: 900 },
  store: {
    projectsRoot: `${HOME}/.dsh/deepblend/projects`,
    workspaceRoot: `${HOME}/.dsh/deepblend`,
    projects: [{ projectId: 'demo', title: 'Demo', jobs: { total: 2, byStatus: { completed: 1, failed: 1 } } }],
  },
  failures: [{
    projectId: 'demo',
    jobId: 'render-0001',
    errorCode: 'ENCODER_NOT_FOUND',
    message: `ffmpeg is not on this machine, so ${HOME}/.dsh/deepblend/projects/demo/frames could not be encoded`,
  }],
})

// ---------------------------------------------------------------------------
// What the document is
// ---------------------------------------------------------------------------

check('the bundle names its own format and format version',
  bundle.format === DIAGNOSTICS_FORMAT && bundle.formatVersion === DIAGNOSTICS_FORMAT_VERSION,
  [bundle.format, bundle.formatVersion])

check('the format version is not the product version — they move for different reasons',
  typeof DIAGNOSTICS_FORMAT_VERSION === 'number' && DIAGNOSTICS_FORMAT_VERSION !== Number(versionSource.split('.')[0]))

check('the product version is the one deepblend/version.json holds, not a copy',
  bundle.product.version === versionSource, [bundle.product.version, versionSource])

check('the runtime reads the same version the source holds',
  readProductVersion() === versionSource, [readProductVersion(), versionSource])

// The rule that put this reader in the Host half: the UI host is the layer the browser talks to, and
// it is asserted to import no filesystem module. Read here as a fact about the source, so a future
// edit that reaches for `readFileSync` in that file fails next to the reason it must not.
{
  const uiHost = readFileSync(join(ROOT, 'packages', 'deepblend', 'ui', 'lib', 'index.js'), 'utf8')
  check('the UI host reads no file itself: the version comes through the facade',
    !uiHost.includes('node:fs') && !uiHost.includes('readFileSync') &&
    /studio\(\)\.productVersion/.test(uiHost),
    uiHost.includes('node:fs') ? 'the UI host imports node:fs' : 'ok')
}

check('the host API version is the declared constant',
  bundle.product.hostApiVersion === HOST_API_VERSION, bundle.product.hostApiVersion)

check('generatedAt is passed in, so the builder has no clock of its own',
  bundle.generatedAt === '2026-09-22T10:00:00.000Z')

check('the route table is the implemented one, so a reader can see the whole surface',
  JSON.stringify(bundle.routes) === JSON.stringify(UI_ROUTES.map(route => `${route.method} ${route.path}`)),
  bundle.routes.length)

check('the whole bundle is lossless JSON, so it survives the wire and a text editor',
  isJsonValue(bundle))

// ---------------------------------------------------------------------------
// What it refuses to carry
// ---------------------------------------------------------------------------

const serialised = JSON.stringify(bundle)
check('no path in the bundle carries the home directory',
  !serialised.includes(HOME), serialised.includes(HOME) ? serialised.slice(serialised.indexOf(HOME) - 60, serialised.indexOf(HOME) + 60) : 'none')

check('a store root under the home is written with a ~ prefix',
  bundle.store.projectsRoot.startsWith('~/') && bundle.store.workspaceRoot.startsWith('~/'),
  [bundle.store.projectsRoot, bundle.store.workspaceRoot])

check('the Blender executable is redacted the same way',
  bundle.blender.executable.resolved.startsWith('~/') && bundle.blender.executable.requested.startsWith('~/'),
  bundle.blender.executable.resolved)

check('a path inside a failure MESSAGE is redacted too, not only a field that is a path',
  bundle.failures[0].message.includes('~/.dsh/deepblend/projects/demo') && !bundle.failures[0].message.includes(HOME),
  bundle.failures[0].message)

check('a warning message is redacted as well — the same rule, wherever text is carried',
  bundle.blender.warnings[0].message.includes('~') && !bundle.blender.warnings[0].message.includes(HOME),
  bundle.blender.warnings[0].message)

check('the bundle says what it excluded, so a reader is not left to guess',
  Array.isArray(bundle.redaction.excluded) && bundle.redaction.excluded.length >= 5 &&
  bundle.redaction.excluded.some(entry => /scene/i.test(entry)) &&
  bundle.redaction.excluded.some(entry => /environment variables/i.test(entry)) &&
  bundle.redaction.excluded.some(entry => /credential|token/i.test(entry)),
  bundle.redaction.excluded)

check('and it says what it replaced, with the character it used',
  bundle.redaction.homePrefix === '~' && bundle.redaction.replaced.length >= 1,
  bundle.redaction.replaced)

check('the environment block names no home directory at all — there is no field for one',
  !('home' in bundle.environment) && JSON.stringify(bundle.environment) === JSON.stringify({ node: 'v26.8.2', platform: 'darwin', arch: 'arm64' }),
  bundle.environment)

// The negative control for the redaction: an empty home must leave the text ALONE rather than
// putting a ~ between every character, which is the failure mode of a naive `split('').join()`.
check('an absent home leaves text alone instead of destroying it',
  redactHome('/Users/example/x', '') === '/Users/example/x' && redactHome('/Users/example/x', null) === '/Users/example/x',
  [redactHome('/Users/example/x', ''), redactHome('/Users/example/x', null)])

check('every occurrence is replaced, not only the first',
  redactHome(`${HOME}/a and ${HOME}/b`, HOME) === '~/a and ~/b',
  redactHome(`${HOME}/a and ${HOME}/b`, HOME))

// ---------------------------------------------------------------------------
// Caps: a bundle has to be attachable to a message
// ---------------------------------------------------------------------------

const many = Array.from({ length: DIAGNOSTICS_FAILURE_LIMIT + 7 }, (_, index) => ({ jobId: `job-${index}` }))
const capped = buildDiagnosticsBundle({ generatedAt: 'x', failures: many, store: { projects: [] }, config: {} })
check('failures are capped, and the bundle says the cap was applied',
  capped.failures.length === DIAGNOSTICS_FAILURE_LIMIT && capped.failuresTruncated === true,
  [capped.failures.length, capped.failuresTruncated])

check('an uncapped list is not reported as truncated',
  buildDiagnosticsBundle({ generatedAt: 'x', failures: [{ jobId: 'a' }], store: { projects: [] }, config: {} }).failuresTruncated === false)

// ---------------------------------------------------------------------------
// The handler: the real one, driven with a stub studio
// ---------------------------------------------------------------------------

const studio = {
  productVersion: () => versionSource,
  describeConfiguration: () => diagnosticConfiguration({ projectsRoot: `${REAL_HOME}/.dsh/deepblend/projects`, workspaceRoot: `${REAL_HOME}/.dsh/deepblend`, maxPreviewSamples: 512, requireApprovalAboveFrames: 900, somethingAddedLater: 'not published' }),
  config: { projectsRoot: `${REAL_HOME}/.dsh/deepblend/projects`, workspaceRoot: `${REAL_HOME}/.dsh/deepblend`, maxPreviewSamples: 512, requireApprovalAboveFrames: 900 },
  async describeCapabilities() { return capabilities },
  async listProjects() {
    return {
      projectsRoot: `${REAL_HOME}/.dsh/deepblend/projects`,
      projects: [
        { projectId: 'demo', title: 'Demo', currentRevision: 'r0002', revisionCount: 3, updatedAt: '2026-09-22T09:00:00.000Z' },
      ],
    }
  },
  async listJobs({ projectId }) {
    return {
      projectId,
      jobs: [
        { jobId: 'render-0001', type: 'final-render', status: 'failed', revision: 'r0002', frames: { total: 450, completed: 0 }, errorCode: 'ENCODER_NOT_FOUND', error: `ffmpeg missing; frames are under ${REAL_HOME}/.dsh/deepblend/projects/demo`, updatedAt: '2026-09-22T09:30:00.000Z' },
        { jobId: 'render-0002', type: 'final-render', status: 'completed', revision: 'r0002', frames: { total: 3, completed: 3 }, errorCode: null, error: null, updatedAt: '2026-09-22T09:40:00.000Z' },
      ],
      unfinished: [],
      recovery: [],
    }
  },
}

const ctx = new Context()
ctx.provide('blenderStudio', studio)
const handlers = createHandlers(ctx)

const live = await handlers.diagnostics({ params: {}, query: {}, body: {} })
check('the handler answers with the bundle, through the same builder the contract drives',
  live.format === DIAGNOSTICS_FORMAT && live.product.hostApiVersion === HOST_API_VERSION)
check('it counts the store: one project, with its jobs by status',
  live.store.projectCount === 1 && live.store.projects[0].jobs.total === 2 &&
  live.store.projects[0].jobs.byStatus.failed === 1 && live.store.projects[0].jobs.byStatus.completed === 1,
  live.store.projects[0].jobs)
check('it lifts the failed jobs into a failures list with their error codes',
  live.failures.length === 1 && live.failures[0].errorCode === 'ENCODER_NOT_FOUND' && live.failures[0].jobId === 'render-0001',
  live.failures)
check('the failures list is redacted by the builder, not by the handler',
  live.failures[0].message.includes('~/.dsh/deepblend/projects/demo') && !JSON.stringify(live).includes(REAL_HOME),
  live.failures[0].message)

// The configuration is an ALLOWLIST: a key nobody named must not be published, because the bundle
// is the last place a future secret-shaped setting should appear by accident.
check('configuration is an allowlist, not a spread of whatever the service holds',
  live.config.maxPreviewSamples === 512 && live.config.requireApprovalAboveFrames === 900 &&
  !('somethingAddedLater' in live.config),
  Object.keys(live.config).filter(key => key === 'somethingAddedLater'))

// The projection itself, driven directly: the property has to hold at the place the keys are named,
// not only through a stub that was written to satisfy it.
check('the projection drops a key nobody named, wherever it is called from',
  diagnosticConfiguration({ maxPreviewSamples: 7, aKeyAddedLater: 'secret' }).maxPreviewSamples === 7 &&
  !('aKeyAddedLater' in diagnosticConfiguration({ aKeyAddedLater: 'secret' })),
  Object.keys(diagnosticConfiguration({ aKeyAddedLater: 'secret' })))

// The caps are declared constants, and the bundle SAYS which ones it applied: a note written by hand
// beside a slice would be a second copy of the limit, and the two would drift the first time one moved.
check('the caps are the declared constants, and the bundle says which it applied',
  DIAGNOSTICS_JOB_LIMIT > 0 && live.notes.some(note => note.includes(String(DIAGNOSTICS_JOB_LIMIT))) &&
  live.notes.some(note => note.includes(String(DIAGNOSTICS_FAILURE_LIMIT))),
  live.notes)

// ---------------------------------------------------------------------------
// The machine whose bundle somebody is about to send: Blender is broken
// ---------------------------------------------------------------------------

const brokenCtx = new Context()
brokenCtx.provide('blenderStudio', {
  productVersion: () => versionSource,
  describeConfiguration: () => ({ projectsRoot: null, workspaceRoot: null }),
  config: {},
  async describeCapabilities() { throw new Error(`the probe could not start ${REAL_HOME}/.tools/Blender.app`) },
  async listProjects() { return { projectsRoot: `${REAL_HOME}/store`, projects: [] } },
  async listJobs() { return { jobs: [], unfinished: [], recovery: [] } },
})
const broken = await createHandlers(brokenCtx).diagnostics({ params: {}, query: {}, body: {} })

check('a failed probe is a VALUE in the bundle, not an error page',
  broken.blender.probed === true && broken.blender.installed === false &&
  broken.blender.error !== null && broken.blender.error.code === BlenderErrorCode.CAPABILITY_PROBE_FAILED,
  broken.blender.error)
check('and the failure message is redacted like every other string',
  broken.blender.error.message.includes('~/.tools/Blender.app') && !broken.blender.error.message.includes(REAL_HOME),
  broken.blender.error.message)
check('the rest of the bundle is still produced on that machine',
  broken.format === DIAGNOSTICS_FORMAT && broken.store.projectCount === 0 && broken.product.version === versionSource)

// ---------------------------------------------------------------------------
// The route, and the link that reaches it
// ---------------------------------------------------------------------------

const route = UI_ROUTES.find(entry => entry.id === 'diagnostics')
check('the route is a READ route: a GET that changes nothing',
  route !== undefined && route.method === 'GET' && route.write === false && route.path === '/deepblend/diagnostics',
  route)
check('and it is not in the write set, so a page can never POST it',
  !UI_ROUTES.filter(entry => entry.write).some(entry => entry.id === 'diagnostics'))

const contracts = readFileSync(join(ROOT, 'deepblend', 'docs', 'tool-contracts.md'), 'utf8')
check('the documented route table carries it, which ui-api.test.mjs compares line for line',
  contracts.includes('| `GET /deepblend/diagnostics` |'))

const client = readFileSync(join(ROOT, 'packages', 'deepblend', 'ui', 'lib', 'client.js'), 'utf8')
check('the workbench offers the export as a download, reachable by a pointer',
  /'data-action': 'export-diagnostics'/.test(client) && /download: 'deepblend-diagnostics\.json'/.test(client) &&
  /href: ROUTES\.diagnostics/.test(client))

// THE DRIFT GUARD FOR THE CLIENT'S OWN COPY OF THE PATHS. The bundle is hand-written and imports
// nothing (D61), so its route table is a second copy — and a renamed route in the contracts package
// would leave the panel fetching a 404 with nothing to notice. This is that notice.
{
  const declared = [...client.matchAll(/^\s{6}(\w+): '(\/deepblend[^']*)',$/gm)].map(match => match[2])
  const known = new Set(UI_ROUTES.map(entry => entry.path))
  check('every route the client bundle names is a route the Host matches',
    declared.length >= 4 && declared.every(path => known.has(path)),
    declared.filter(path => !known.has(path)))
  check('and the diagnostics route is one of them', declared.includes('/deepblend/diagnostics'), declared)
}

// ---------------------------------------------------------------------------

const failed = results.filter(entry => !entry.ok)
console.log(`\ndiagnostics contract: ${results.length - failed.length}/${results.length} check(s) passed`)
process.exit(failed.length === 0 ? 0 : 1)
