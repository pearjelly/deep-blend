/**
 * @deepblend/dsh-blender-provider-local
 *
 * The Local Blender Provider: the concrete `BlenderRuntime` Service over
 * `ctx.subprocess` (SPEC §7.1, §9.1, §9.2).
 *
 * Responsibilities, and deliberately nothing more:
 *   - resolve and allowlist the Blender executable (SPEC §15.2);
 *   - prepare an isolated per-invocation working directory;
 *   - launch `Blender --background --factory-startup --python bootstrap.py -- ...`
 *     as an **argv array** through `ctx.subprocess.spawn` — never a shell string;
 *   - read, validate and type the JSON result envelope bootstrap.py writes;
 *   - classify every failure into a stable error code (SPEC §9.4);
 *   - own the deadline, the AbortSignal and process termination.
 *
 * It holds NO business state machine, NO revision logic and NO orchestration.
 *
 * Owner: DeepBlend Studio — M0
 * Plane: Host composition (registered by @deepblend/dsh-blender-bundle)
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import {
  BLENDER_ENGINE_BY_KEY,
  BLENDER_PROTOCOL_VERSION,
  FRAME_PLAN_VERSION,
  BlenderError,
  BlenderErrorCode,
  CANDIDATE_RENDER_ENGINES,
  EXPECTED_EXPORT_FORMATS,
  EXPECTED_IMPORT_FORMATS,
  BlenderWarningCode,
  assertKnownConfigKeys,
  managedBlenderCandidates,
  resolveWorkspaceRoot,
  warning,
} from '@deepblend/dsh-blender-contracts'

/** Service key registered into the Cordis context. */
export const BLENDER_RUNTIME_SERVICE = 'blenderRuntime'

/** Default cap for captured Blender stdout/stderr before spilling. */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
/** Default cap for the spill file that holds the complete stream. */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** Grace period between SIGTERM and SIGKILL when terminating Blender. */
const TERMINATE_GRACE_MS = 10_000

/**
 * The `blenderPath` value meaning "find one": managed install first, then PATH.
 * @see ProviderConfig.blenderPath
 */
const AUTO_BLENDER_PATH = 'auto'

/** What `'auto'` falls back to when no managed install exists. */
const FALLBACK_BLENDER_NAME = 'blender'

/** How far up from `lib/` the managed-install search walks before giving up. */
const MANAGED_ROOT_SEARCH_DEPTH = 6

/**
 * Directories a resolved Blender executable is permitted to live in.
 *
 * The first entry is the workspace-managed install produced during M0 setup.
 * An explicit absolute `blenderPath` in configuration is additionally allowed,
 * because an operator who writes an absolute path has already made a deliberate
 * statement; a *bare name* resolves through PATH and must land inside this list.
 * This is the SPEC §15.2 allowlist, made realpath-aware so a symlink cannot
 * escape it.
 */
function defaultAllowlist() {
  const home = process.env.HOME ?? ''
  return [
    '/Applications',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    home ? join(home, 'Applications') : '',
  ].filter(entry => entry.length > 0)
}

/**
 * Configuration schema. Every field is validated at load time (SPEC §17), so a
 * malformed composition row fails loudly at mount rather than at first use.
 *
 * Named `ProviderConfig`, NOT `Config`. The class below declares `static Config`,
 * and a module-scope `Config` would be shadowed by that class field inside the
 * class body — making `static Config = Config` a temporal-dead-zone
 * ReferenceError during module evaluation. That throws at bundle load and takes
 * the whole row down with it, which no import-time test can see.
 */
export const ProviderConfig = z.object({
  /**
   * Where to find Blender, in one of three forms:
   *
   *   `'auto'` (the default) — the workspace-managed install that
   *            `deepblend/tools/install-blender.mjs` produces, if one exists,
   *            otherwise a bare `blender` resolved through PATH;
   *   an absolute path — trusted as a deliberate operator choice (SPEC §15.2),
   *            with the allowlist bypassed;
   *   a bare name — resolved through the scrubbed PATH and required to land
   *            inside the allowlist.
   *
   * The managed install is tried FIRST because it is the build the integration
   * suites measured; preferring whatever happens to be on PATH would let the
   * product run a different Blender from the one the tests verified.
   */
  blenderPath: z.string().default('auto'),
  /**
   * Absolute path to bootstrap.py. Left unset, the copy shipped inside THIS
   * package is used (`lib/` → `../python/bootstrap.py`), which is why the bundle
   * patch no longer needs to name a machine's path here.
   */
  bootstrapPath: z.string().default(''),
  /**
   * Workspace root. Per-invocation working directories are created here, keeping
   * every write inside the project workspace (SPEC §15.2 "工作区路径边界").
   *
   * Unset, it defaults to `<DSH_HOME>/deepblend` (SPEC §17). It must be the SAME
   * root the host row resolves, or a staging path the host hands out is one this
   * provider refuses; both resolve it through `resolveWorkspaceRoot`, so they
   * agree by construction rather than by an operator remembering to set both.
   */
  workspaceRoot: z.string().default(''),
  /** Deadline for a single bootstrap invocation, in ms. */
  timeoutMs: z.number().default(180_000),
  /** Cap on captured stdout bytes before spilling to a file. */
  maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
  /** Cap on the spill file holding the complete stream. */
  maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
  /** Extra directories added to the executable allowlist. */
  executableAllowlist: z.array(z.string()).default([]),
  /** How long a capabilities result may be reused before re-probing. */
  capabilitiesCacheMs: z.number().default(60_000),
  /** Retain per-invocation working directories for post-mortem inspection. */
  keepWorkingDirectory: z.boolean().default(false),
})

/**
 * @typedef {object} BootstrapRunOutcome
 * @property {Record<string, unknown>} envelope - the parsed result document.
 * @property {string} stdout - captured stdout tail.
 * @property {string} stderr - captured stderr tail.
 * @property {number|null} exitCode
 * @property {number} durationMs
 * @property {string} workingDirectory
 */

/**
 * Local Blender provider.
 *
 * Register by loading this package as a host composition row; it publishes the
 * `blenderRuntime` Service.
 */
export default class LocalBlenderRuntime extends Service {
  // `subprocess` is a hard dependency: this provider cannot function without it,
  // so declaring it makes Cordis hold the row in `waiting` until it appears
  // rather than throwing at first call.
  static inject = ['subprocess']

  static Config = ProviderConfig

  /** @type {Map<string, import('@deepblend/dsh-blender-contracts').BlenderCapabilities>} */
  _capabilitiesCache = new Map()

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {import('z').infer<typeof ProviderConfig>} config - validated by schemastery before construction.
   */
  constructor(ctx, config) {
    super(ctx, BLENDER_RUNTIME_SERVICE)
    // See the host's constructor: a key this row does not read is a startup error, because the schema
    // accepts it silently (SPEC §17's nested groups versus this package's flat keys).
    assertKnownConfigKeys(ProviderConfig, config, 'deepblend-blender-runtime')
    this.config = config
    this.bootstrapPath = this._resolveBootstrapPath(config.bootstrapPath)
    /** Resolved once: the host must be configured with the same value. */
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot)
  }

  /**
   * The `blenderPath` request to hand to `ctx.subprocess.resolveExecutable`.
   *
   * `'auto'` means "the managed install if there is one, else PATH" — and the
   * CHOICE is made here, once, because two other places need to agree with it:
   * `_assertAllowed` decides whether the allowlist applies from this string, and
   * `getCapabilities` keys its cache on it. Resolving it twice is how a probe
   * reports one binary while a render launches another.
   *
   * @returns {string} an absolute path, or a bare name for PATH resolution
   */
  _requestedBlenderPath() {
    const configured = this.config.blenderPath
    if (configured !== AUTO_BLENDER_PATH) return configured
    for (const candidate of managedBlenderCandidates(this._managedRoots())) {
      if (existsSync(candidate)) return candidate
    }
    return FALLBACK_BLENDER_NAME
  }

  /**
   * Directories that might contain the `.tools` managed install.
   *
   * Derived from THIS package's location rather than configured, because a
   * package can always find its own repository and no configuration can be
   * correct on a machine it was not written on. Walking up a bounded number of
   * levels covers both a plain checkout (`packages/deepblend/provider-local/lib`)
   * and a profile symlink pointing into one; the first level that has a `.tools`
   * directory wins, and a published package outside any repository simply finds
   * nothing and falls back to PATH.
   *
   * @returns {string[]}
   */
  _managedRoots() {
    const roots = []
    let directory = import.meta.dirname
    for (let level = 0; level < MANAGED_ROOT_SEARCH_DEPTH; level += 1) {
      const parent = resolve(directory, '..')
      if (parent === directory) break
      roots.push(parent)
      directory = parent
    }
    return roots
  }

  /**
   * Resolve bootstrap.py, preferring the configured path and falling back to the
   * copy shipped beside this package so the default composition needs no config.
   * @param {string} configured
   * @returns {string}
   */
  _resolveBootstrapPath(configured) {
    if (configured && configured.trim().length > 0) return resolve(configured)
    // lib/ -> package root -> python/bootstrap.py
    return resolve(import.meta.dirname, '..', 'python', 'bootstrap.py')
  }

  /**
   * Resolve the Blender executable WITHOUT throwing, so `getCapabilities` can
   * report absence as data (SPEC §9.4 distinguishes "executable not found" from
   * every other failure; M0 must describe a machine that has no Blender).
   *
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ resolved: string|null, requested: string, error: BlenderError|null }>}
   */
  async resolveBlenderExecutable(options = {}) {
    const requested = this._requestedBlenderPath()
    try {
      // `ctx.subprocess.resolveExecutable` verifies absolute paths and resolves
      // bare names against the provider's scrubbed PATH. Relative paths with
      // separators are rejected by the service itself.
      const resolved = await this.ctx.subprocess.resolveExecutable(requested, undefined, options.signal)
      const canonical = this._assertAllowed(resolved, requested)
      return { resolved: canonical, requested, error: null }
    } catch (cause) {
      // The ADVICE travels with the failure, because two readers need the same sentence: the settings
      // card a human opens and the capability text a model reads. Composing it in either of them would
      // be a second copy of "what to do when there is no Blender", and this repository has paid for
      // that shape often enough (see `_blenderPathAdvice`).
      const advice = blenderPathAdvice({ requested, fallbackName: FALLBACK_BLENDER_NAME })
      if (cause instanceof BlenderError) return { resolved: null, requested, error: cause, advice }
      return {
        resolved: null,
        requested,
        advice,
        error: new BlenderError(
          BlenderErrorCode.NOT_FOUND,
          `Blender executable could not be resolved from "${requested}". ` +
            `Run deepblend/tools/install-blender.mjs, install Blender, or set ` +
            `deepblend.blenderPath to its absolute path.`,
          { cause },
        ),
      }
    }
  }

  /**
   * Enforce the executable allowlist against the real (symlink-resolved) path.
   *
   * The rule depends on WHAT WAS ASKED FOR, not on what the config literally
   * says. `'auto'` is not what gets resolved — `_requestedBlenderPath()` turns it
   * into either the managed install's absolute path (a deliberate choice, like an
   * operator's) or the bare name `blender` (a PATH lookup, which must satisfy the
   * allowlist). Reading `this.config.blenderPath` here instead would test the
   * string `'auto'`, find it is not absolute, and then refuse the managed install
   * the repository ships — the exact failure this distinction exists to avoid.
   *
   * @param {string} candidate
   * @param {string} requested - what `_requestedBlenderPath()` produced
   * @returns {string} the canonical path
   */
  _assertAllowed(candidate, requested) {
    if (!isAbsolute(candidate)) {
      throw new BlenderError(
        BlenderErrorCode.NOT_FOUND,
        `Resolved Blender path is not absolute: ${candidate}`,
      )
    }

    let canonical
    try {
      canonical = realpathSync(candidate)
    } catch (cause) {
      throw new BlenderError(
        BlenderErrorCode.NOT_FOUND,
        `Blender executable does not exist: ${candidate}`,
        { cause },
      )
    }

    let stats
    try {
      stats = statSync(canonical)
    } catch (cause) {
      throw new BlenderError(
        BlenderErrorCode.NOT_FOUND,
        `Blender executable is not stat-able: ${canonical}`,
        { cause },
      )
    }
    if (stats.isDirectory()) {
      throw new BlenderError(
        BlenderErrorCode.EXECUTABLE_NOT_EXECUTABLE,
        `Configured Blender path is a directory, not an executable: ${canonical}`,
      )
    }

    // A bare name was resolved through PATH, so it must satisfy the allowlist.
    // An absolute request — the operator's or the managed install's — is trusted.
    const requestedIsAbsolute = isAbsolute(requested)
    if (!requestedIsAbsolute && !this._insideAllowlist(canonical)) {
      throw new BlenderError(
        BlenderErrorCode.EXECUTABLE_OUTSIDE_ALLOWLIST,
        `Blender resolved from PATH to ${canonical}, which is outside the configured allowlist. ` +
          `Add its directory to deepblend.executableAllowlist to permit it, or set ` +
          `deepblend.blenderPath to its absolute path.`,
      )
    }
    return canonical
  }

  /**
   * @param {string} canonical realpath'd candidate
   * @returns {boolean}
   */
  _insideAllowlist(canonical) {
    const roots = [...defaultAllowlist(), ...this.config.executableAllowlist]
    for (const root of roots) {
      let canonicalRoot
      try {
        canonicalRoot = realpathSync(root)
      } catch {
        continue // A non-existent allowlist root simply permits nothing.
      }
      if (canonical === canonicalRoot) return true
      if (canonical.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep)) {
        return true
      }
    }
    return false
  }

  /**
   * Create an isolated per-invocation working directory inside the workspace.
   * @returns {{ jobId: string, directory: string }}
   */
  _createWorkingDirectory() {
    const jobId = `m0-${randomUUID()}`
    const root = resolve(this.workspaceRoot, 'tmp')
    mkdirSync(root, { recursive: true })
    const directory = join(root, jobId)
    mkdirSync(directory, { recursive: true })
    return { jobId, directory }
  }

  /**
   * Read a collected stream from offset 0.
   *
   * `SubprocessHandle.collected` readers are offset-based and non-consuming, so
   * readFrom(0) always returns the whole captured stream.
   * @param {import('@deepseek-ai/dsh-subprocess').SubprocessOutputReader|undefined} reader
   * @returns {string}
   */
  _readAll(reader) {
    if (!reader) return ''
    try {
      return reader.readFrom(0).text ?? ''
    } catch {
      return ''
    }
  }

  /**
   * Run one bootstrap action end-to-end.
   *
   * The result is transported via a JSON **file**, not stdout: Blender writes its
   * own banners and add-on chatter to stdout, so a stdout-scraping protocol
   * would be fragile. stdout/stderr are captured only for diagnostics.
   *
   * @param {import('@deepblend/dsh-blender-contracts').BlenderBootstrapRequest} request
   * @param {{
   *   signal?: AbortSignal,
   *   args?: string[],
   *   cwd?: string,
   *   projectRoot?: string,
   *   prepareDirectory?: (info: { directory: string, jobId: string }) => void|Promise<void>,
   *   onWorkingDirectory?: (info: {
   *     directory: string, jobId: string, envelope: object,
   *     requestPath: string, resultPath: string,
   *   }) => void|Promise<void>,
   * }} [options]
   * @returns {Promise<BootstrapRunOutcome>}
   */
  async runBootstrap(request, options = {}) {
    const action = request?.action
    if (typeof action !== 'string' || action.length === 0) {
      throw new BlenderError(BlenderErrorCode.UNSUPPORTED_ACTION, 'A bootstrap action name is required.')
    }

    if (!existsSync(this.bootstrapPath)) {
      throw new BlenderError(
        BlenderErrorCode.BOOTSTRAP_MISSING,
        `bootstrap.py not found at ${this.bootstrapPath}.`,
      )
    }

    const resolvedExecutable = await this.resolveBlenderExecutable({ signal: options.signal })
    if (resolvedExecutable.error !== null || resolvedExecutable.resolved === null) {
      throw resolvedExecutable.error ?? new BlenderError(
        BlenderErrorCode.NOT_FOUND,
        `Blender executable could not be resolved from "${resolvedExecutable.requested}".`,
      )
    }

    const { jobId, directory } = this._createWorkingDirectory()
    const correlationId = typeof request.jobId === 'string' && request.jobId.length > 0
      ? request.jobId
      : jobId
    const requestPath = join(directory, 'request.json')
    const resultPath = join(directory, 'result.json')

    // Some actions need input that is not a flat flag: a view PLAN is a list of
    // records, and expressing it as parallel `--camera`/`--frame` arrays would let
    // them disagree in length. `prepareDirectory` writes such a document into the
    // invocation directory before the process starts, so the action reads it by
    // relative path and the file dies with the directory.
    if (typeof options.prepareDirectory === 'function') {
      await options.prepareDirectory({ directory, jobId })
    }

    const requestDocument = {
      protocolVersion: BLENDER_PROTOCOL_VERSION,
      jobId: correlationId,
      action,
      ...request.payload !== undefined ? { payload: request.payload } : {},
    }
    writeFileSync(requestPath, JSON.stringify(requestDocument, null, 2), 'utf8')

    const argv = [
      resolvedExecutable.resolved,
      '--background',
      '--factory-startup',
      '--python',
      this.bootstrapPath,
      '--',
      '--request',
      requestPath,
      '--result',
      resultPath,
      ...(options.args ?? []),
    ]

    // Compose the caller's signal with our own deadline so either can terminate
    // the managed process range (SPEC §9.4 "超时" and "用户取消").
    const deadlineController = new AbortController()
    const timer = setTimeout(() => deadlineController.abort(), this.config.timeoutMs)
    const signals = [deadlineController.signal]
    if (options.signal) signals.push(options.signal)
    const composedSignal = AbortSignal.any(signals)

    const startedAt = Date.now()
    let handle
    try {
      handle = this.ctx.subprocess.spawn({
        argv,
        cwd: options.cwd ?? directory,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.config.maxOutputBytes, spill: { maxBytes: this.config.maxSpillBytes } },
          stderr: { maxBytes: this.config.maxOutputBytes, spill: { maxBytes: this.config.maxSpillBytes } },
        },
        graceMs: TERMINATE_GRACE_MS,
        signal: composedSignal,
        env: {
          // Scrub anything that could carry a secret into the child (SPEC §15.5:
          // the DeepSeek API key must never reach the Blender subprocess).
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          TMPDIR: process.env.TMPDIR ?? '',
          // Deterministic, unbuffered Python so partial output is never lost.
          PYTHONUNBUFFERED: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          DEEPBLEND_JOB_ID: correlationId,
        },
      })
    } catch (cause) {
      clearTimeout(timer)
      this._cleanup(directory)
      throw new BlenderError(
        BlenderErrorCode.SPAWN_FAILED,
        `Failed to spawn Blender at ${resolvedExecutable.resolved}.`,
        { cause },
      )
    }

    /** @type {import('@deepseek-ai/dsh-subprocess').SubprocessOutcome|null} */
    let outcome = null
    /** @type {unknown} */
    let spawnFailure = null
    try {
      outcome = await handle.done
    } catch (cause) {
      spawnFailure = cause
    } finally {
      clearTimeout(timer)
    }

    const stdout = this._readAll(handle.collected?.stdout)
    const stderr = this._readAll(handle.collected?.stderr)
    const durationMs = Date.now() - startedAt

    const aborted = composedSignal.aborted
    const timedOut = aborted && options.signal?.aborted !== true

    // Classify BEFORE reading the result: a terminated process may still have
    // written a partial result document, and a timeout must never be reported as
    // a successful probe.
    if (timedOut) {
      this._cleanup(directory)
      throw new BlenderError(
        BlenderErrorCode.TIMEOUT,
        `Blender bootstrap exceeded its ${this.config.timeoutMs} ms deadline.`,
        { detail: { stderr: stderr.slice(-4000) } },
      )
    }
    if (aborted) {
      this._cleanup(directory)
      throw new BlenderError(BlenderErrorCode.ABORTED, 'Blender bootstrap was cancelled by the caller.')
    }
    if (spawnFailure !== null) {
      this._cleanup(directory)
      throw new BlenderError(
        BlenderErrorCode.SPAWN_FAILED,
        'Blender bootstrap process failed to start.',
        { cause: spawnFailure },
      )
    }

    if (!existsSync(resultPath)) {
      const exitCode = outcome?.exitCode ?? null
      this._cleanup(directory)
      throw new BlenderError(
        exitCode === 0 ? BlenderErrorCode.RESULT_MISSING : BlenderErrorCode.NONZERO_EXIT,
        `Blender exited with code ${exitCode} without writing a result document. ` +
          `stderr tail: ${stderr.slice(-2000) || '<empty>'}`,
        { detail: { exitCode, stdout: stdout.slice(-2000) } },
      )
    }

    let envelope
    try {
      envelope = JSON.parse(readFileSync(resultPath, 'utf8'))
    } catch (cause) {
      this._cleanup(directory)
      throw new BlenderError(
        BlenderErrorCode.RESULT_UNPARSEABLE,
        `Blender wrote a result document that is not valid JSON at ${resultPath}.`,
        { cause },
      )
    }

    if (envelope?.protocolVersion !== BLENDER_PROTOCOL_VERSION) {
      this._cleanup(directory)
      throw new BlenderError(
        BlenderErrorCode.PROTOCOL_VERSION_MISMATCH,
        `bootstrap.py reported protocolVersion "${envelope?.protocolVersion}", ` +
          `expected "${BLENDER_PROTOCOL_VERSION}".`,
      )
    }

    if (envelope.status === 'error') {
      const code = normaliseErrorCode(envelope?.error?.code)
      this._cleanup(directory)
      throw new BlenderError(
        code,
        envelope?.error?.message ?? 'bootstrap.py reported an unspecified error.',
      )
    }

    // A successful probe leaves nothing worth keeping either: bootstrap.py does
    // its own renders in a private temp dir, and the request/result documents
    // are already parsed into memory. Retaining them would make every tool call
    // accumulate residue in the workspace.
    //
    // An action that produced real artifacts — a compiled `.blend`, a rendered
    // frame — needs the opposite: the caller must be able to move those bytes
    // somewhere durable BEFORE the directory is removed. `onWorkingDirectory` is
    // that window, and it is awaited so a slow move cannot race the cleanup.
    if (typeof options.onWorkingDirectory === 'function') {
      await options.onWorkingDirectory({ directory, jobId, envelope, requestPath, resultPath })
    }

    this._cleanup(directory)

    return { envelope, stdout, stderr, exitCode: outcome?.exitCode ?? null, durationMs, workingDirectory: directory }
  }

  /**
   * Remove a per-invocation directory unless the operator asked to keep it.
   * @param {string} directory
   */
  _cleanup(directory) {
    if (this.config.keepWorkingDirectory) return
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // A retained temp directory is not worth failing a classified error over.
    }
  }

  /**
   * Probe the Blender runtime and return a behavioral capability report.
   *
   * Never throws for "Blender is not installed": absence is reported as
   * `installed: false` plus a warning, because a probe is exactly where a
   * missing toolchain must be describable (SPEC §9.4).
   *
   * @param {{ refresh?: boolean, signal?: AbortSignal }} [options]
   * @returns {Promise<import('@deepblend/dsh-blender-contracts').BlenderCapabilities>}
   */
  async getCapabilities(options = {}) {
    const cacheKey = this._requestedBlenderPath()
    const cached = this._capabilitiesCache.get(cacheKey)
    const now = Date.now()
    if (options.refresh !== true && cached && now - cached.probedAt < this.config.capabilitiesCacheMs) {
      return cached
    }

    const resolved = await this.resolveBlenderExecutable({ signal: options.signal })
    if (resolved.resolved === null || resolved.error !== null) {
      const absent = this._absentCapabilities(resolved, resolved.error)
      this._capabilitiesCache.set(cacheKey, absent)
      return absent
    }

    const startedAt = Date.now()
    const run = await this.runBootstrap({ action: 'get_capabilities' }, { signal: options.signal })
    const raw = run.envelope.capabilities ?? {}

    /** @type {import('@deepblend/dsh-blender-contracts').BlenderCapabilities} */
    const capabilities = {
      protocolVersion: BLENDER_PROTOCOL_VERSION,
      installed: true,
      executable: {
        requested: resolved.requested,
        resolved: resolved.resolved,
        found: true,
      },
      blenderVersion: raw.blenderVersion ?? null,
      blenderVersionTuple: raw.blenderVersionTuple ?? null,
      pythonVersion: raw.pythonVersion ?? null,
      buildHash: raw.buildHash ?? null,
      binaryPath: raw.binaryPath ?? null,
      renderEngines: normaliseEngineProbes(raw.renderEngines),
      bestAvailableEngine: typeof raw.bestAvailableEngine === 'string' ? raw.bestAvailableEngine : null,
      renderEngineEnumItems: normaliseEngineEnumItems(raw.renderEngineDiagnostics),
      gpu: normaliseGpu(raw.gpuDevices),
      exportFormats: Array.isArray(raw.exportFormats) ? raw.exportFormats : [],
      importFormats: Array.isArray(raw.importFormats) ? raw.importFormats : [],
      unavailableFormats: normaliseUnavailableFormats(raw.formatDiagnostics),
      renderSmokeTest: raw.renderSmokeTest ?? null,
      cyclesSmokeTest: raw.cyclesSmokeTest ?? null,
      textBlockApi: raw.textBlockApi === true,
      frameApi: raw.frameApi === true,
      hostPlatform: typeof raw.hostPlatform === 'string' ? raw.hostPlatform : null,
      warnings: collectWarnings(raw),
      probedAt: now,
      durationMs: Date.now() - startedAt,
      commandLine: null,
    }

    // Derived convenience flag so every caller agrees on what "has a GPU" means.
    capabilities.gpuAvailable = capabilities.gpu.gpuDeviceNames.length > 0

    this._capabilitiesCache.set(cacheKey, capabilities)
    return capabilities
  }

  /**
   * Describe a machine with no resolvable Blender.
   * @param {{ requested: string, resolved: string|null }} resolved
   * @param {BlenderError|null} error
   * @returns {import('@deepblend/dsh-blender-contracts').BlenderCapabilities}
   */
  _absentCapabilities(resolved, error) {
    return {
      protocolVersion: BLENDER_PROTOCOL_VERSION,
      installed: false,
      executable: { requested: resolved.requested, resolved: null, found: false, advice: resolved.advice ?? null },
      blenderVersion: null,
      blenderVersionTuple: null,
      pythonVersion: null,
      buildHash: null,
      binaryPath: null,
      renderEngines: Object.fromEntries(
        CANDIDATE_RENDER_ENGINES.map(id => [id, { assignable: false, readback: null, error: 'Blender not installed' }]),
      ),
      bestAvailableEngine: null,
      renderEngineEnumItems: [],
      gpu: emptyGpuReport(),
      exportFormats: [],
      importFormats: [],
      unavailableFormats: [],
      renderSmokeTest: null,
      cyclesSmokeTest: null,
      textBlockApi: false,
      frameApi: false,
      hostPlatform: null,
      warnings: [
        warning(
          BlenderWarningCode.BLENDER_NOT_INSTALLED,
          error?.message ?? `Blender executable could not be resolved from "${resolved.requested}".`,
          { configuredPath: resolved.requested },
        ),
      ],
      probedAt: Date.now(),
      durationMs: 0,
      commandLine: null,
    }
  }

  /**
   * Drop the capabilities cache. Called on settings change so a corrected
   * `blenderPath` takes effect without a restart (SPEC §17).
   */
  invalidateCapabilities() {
    this._capabilitiesCache.clear()
  }

  // ---------------------------------------------------------------------------
  // M1: batch scene actions
  //
  // Both of these are thin, honest transports. They compose an argv, run one
  // bootstrap action, and return what Bootstrap.py measured — no business logic,
  // no revision state, no retries. Orchestration belongs to `blenderStudio`
  // (SPEC §7.1: "负责具体 Blender 执行，不包含业务状态机").
  // ---------------------------------------------------------------------------

  /**
   * Compile a SceneSpec into a `.blend` checkpoint and technically validate it.
   *
   * Nothing is published: the checkpoint is written to the caller's working
   * directory, and `onWorkingDirectory` is the caller's chance to move it into a
   * revision before the directory is cleaned up. That split is what lets a
   * compile failure leave no trace anywhere in the project.
   *
   * @param {object} request
   * @param {string} request.sceneSpecPath - absolute path to the SceneSpec JSON.
   * @param {(info: {directory: string, envelope: object, jobId: string}) => void|Promise<void>} request.onWorkingDirectory
   * @param {string} [request.profile]
   * @param {string} [request.projectRoot]
   * @param {string} [request.jobId]
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<{report: object, envelope: object, durationMs: number, stdout: string, stderr: string}>}
   */
  async compileScene(request) {
    const outputBlend = 'result.blend'
    if (typeof request?.sceneSpecPath !== 'string' || request.sceneSpecPath.length === 0) {
      throw new BlenderError(
        BlenderErrorCode.SCENE_SPEC_INVALID,
        'compileScene needs an absolute path to a SceneSpec document.',
      )
    }

    const args = ['--scene-spec', request.sceneSpecPath, '--output-blend', outputBlend]
    if (request.profile !== undefined) args.push('--profile', String(request.profile))
    if (request.projectRoot !== undefined) args.push('--project-root', request.projectRoot)

    const run = await this.runBootstrap(
      { action: 'compile_scene', jobId: request.jobId },
      {
        signal: request.signal,
        args,
        projectRoot: request.projectRoot,
        onWorkingDirectory: request.onWorkingDirectory,
      },
    )

    const report = run.envelope.result ?? {}
    return {
      report,
      envelope: run.envelope,
      durationMs: run.durationMs,
      stdout: run.stdout,
      stderr: run.stderr,
    }
  }

  /**
   * Render one preview frame from an existing `.blend` checkpoint.
   *
   * @param {object} request
   * @param {string} request.checkpointPath - absolute path to the `.blend`.
   * @param {string} request.outputPath - absolute path for the PNG.
   * @param {string} [request.cameraId]
   * @param {string} [request.engine] - SceneSpec engine key (`cycles`/`eevee`/`workbench`).
   * @param {number} [request.width]
   * @param {number} [request.height]
   * @param {number} [request.samples]
   * @param {number} [request.frame]
   * @param {string} [request.jobId]
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<{report: object, envelope: object, durationMs: number, stdout: string, stderr: string}>}
   */
  async renderPreview(request) {
    if (typeof request?.checkpointPath !== 'string' || request.checkpointPath.length === 0) {
      throw new BlenderError(
        BlenderErrorCode.REVISION_CHECKPOINT_MISSING,
        'renderPreview needs an absolute path to a .blend checkpoint.',
      )
    }
    if (typeof request?.outputPath !== 'string' || request.outputPath.length === 0) {
      throw new BlenderError(BlenderErrorCode.RENDER_NO_OUTPUT, 'renderPreview needs an absolute output path.')
    }

    const args = ['--blend', request.checkpointPath, '--output', request.outputPath]
    if (request.cameraId !== undefined) args.push('--camera', String(request.cameraId))
    if (request.engine !== undefined) args.push('--engine', String(request.engine))
    if (request.width !== undefined) args.push('--width', String(request.width))
    if (request.height !== undefined) args.push('--height', String(request.height))
    if (request.samples !== undefined) args.push('--samples', String(request.samples))
    if (request.frame !== undefined) args.push('--frame', String(request.frame))

    const run = await this.runBootstrap(
      { action: 'render_preview', jobId: request.jobId },
      { signal: request.signal, args, onWorkingDirectory: request.onWorkingDirectory },
    )

    const report = run.envelope.result ?? {}
    return {
      report,
      envelope: run.envelope,
      durationMs: run.durationMs,
      stdout: run.stdout,
      stderr: run.stderr,
    }
  }

  /**
   * Render a PLAN of views out of one checkpoint, in one Blender process, and
   * measure each one (SPEC §12.3 "预览默认包含：主相机 / 45 度 / 俯视 / 近景").
   *
   * WHY A PLAN AND NOT A LOOP OVER `renderPreview`
   * ---------------------------------------------
   * Measured: a Blender cold start is about 0.4 s and a preview render 2-3 s. The
   * M2 visual loop renders four views per round for up to five rounds, so a launch
   * per view would spend roughly two minutes on startup alone. One process also
   * guarantees the views describe ONE scene state — four launches could in
   * principle open four different files if the checkpoint changed in between.
   *
   * The per-view measurements come back inside the same envelope because they are
   * computed from pixels that only exist in that process (see `deepblend_views.py`).
   * Re-deriving them later would mean either a second Blender launch or a second
   * PNG decoder in a second language, and a duplicate decoder is the kind of thing
   * that drifts.
   *
   * @param {object} request
   * @param {string} request.checkpointPath - absolute path to the `.blend`.
   * @param {object[]} request.views - `{ id, role?, cameraId?, frame? }`, in reading order.
   * @param {string[]} [request.track] - object ids to measure by isolation.
   * @param {string[]} [request.parts] - object ids that are part of the subject's own
   *   body, so a ray reaching them has reached the subject rather than been blocked.
   * @param {string} [request.engine] - SceneSpec engine key.
   * @param {number} [request.width]
   * @param {number} [request.height]
   * @param {number} [request.samples]
   * @param {string} [request.jobId]
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<{report: object, pngs: Record<string, Buffer>, envelope: object, durationMs: number}>}
   */
  /**
   * Start a frame-sequence render and RETURN THE LIVE HANDLE (M3, SPEC §10).
   *
   * WHY THIS DOES NOT AWAIT, UNLIKE EVERY OTHER METHOD HERE
   * ------------------------------------------------------
   * `renderViews` blocks the caller for the length of a Blender launch, which is
   * correct for a preview measured in seconds. A delivery render is 19.6-41.4 s
   * PER FRAME (measured on this machine for `watch-commercial` at 1920x1080 /
   * Cycles / 256 spp), so 450 frames is ~3.4 hours. Awaiting that inside the tool
   * call that started it would block the Agent for the whole afternoon, which is
   * the first M3 acceptance condition ("长任务不阻塞 Agent").
   *
   * So this method is split in two: `startFrameSequence` spawns and returns, and
   * `awaitFrameSequence` does the awaiting. The host owns the handle in between —
   * and, crucially, owns writing the pid to disk, because a Harness that dies
   * cannot tell anyone which process it left behind.
   *
   * The invocation directory is CALLER-SUPPLIED and PERSISTENT. Everywhere else
   * in this provider the directory is a per-invocation scratch that dies with the
   * call; a resumable render's directory is the thing that survives the crash, so
   * the frames, the plan, the journal and the result all live in one directory the
   * host names (inside the project, never in the shared scratch root).
   *
   * @param {object} request
   * @param {string} request.checkpointPath - absolute path to the `.blend`.
   * @param {number[]} request.frames - the frames to render, in order.
   * @param {string} request.jobDirectory - absolute, persistent, inside the workspace.
   * @param {string} [request.cameraId]
   * @param {string} [request.profileName] - the SceneSpec profile the plan came from.
   * @param {object} [request.profile] - the resolved render profile to apply.
   * @param {[number, number]} [request.frameRange] - the project's own frame range.
   * @param {string} [request.jobId]
   * @returns {Promise<{handle: object, jobDirectory: string, framesDirectory: string,
   *   requestPath: string, planPath: string, resultPath: string, eventsPath: string,
   *   processPath: string, argv: string[], startedAt: number, executable: string}>}
   */
  async startFrameSequence(request) {
    if (typeof request?.checkpointPath !== 'string' || request.checkpointPath.length === 0) {
      throw new BlenderError(
        BlenderErrorCode.REVISION_CHECKPOINT_MISSING,
        'startFrameSequence needs an absolute path to a .blend checkpoint.',
      )
    }
    const frames = Array.isArray(request.frames) ? request.frames : []
    if (frames.length === 0) {
      throw new BlenderError(
        BlenderErrorCode.SCRIPT_ERROR,
        'startFrameSequence needs at least one frame to render; an empty frame list would report ' +
          'success while writing nothing.',
      )
    }
    if (typeof request.jobDirectory !== 'string' || request.jobDirectory.length === 0) {
      throw new BlenderError(
        BlenderErrorCode.SCRIPT_ERROR,
        'startFrameSequence needs a persistent job directory to render into.',
      )
    }
    if (!existsSync(this.bootstrapPath)) {
      throw new BlenderError(
        BlenderErrorCode.BOOTSTRAP_MISSING,
        `bootstrap.py not found at ${this.bootstrapPath}.`,
      )
    }

    const resolvedExecutable = await this.resolveBlenderExecutable({ signal: request.signal })
    if (resolvedExecutable.error !== null || resolvedExecutable.resolved === null) {
      throw resolvedExecutable.error ?? new BlenderError(
        BlenderErrorCode.NOT_FOUND,
        `Blender executable could not be resolved from "${resolvedExecutable.requested}".`,
      )
    }

    const jobDirectory = resolve(request.jobDirectory)
    const framesDirectory = join(jobDirectory, 'frames')
    mkdirSync(framesDirectory, { recursive: true })

    const requestPath = join(jobDirectory, 'request.json')
    const planPath = join(jobDirectory, 'plan.json')
    const resultPath = join(jobDirectory, 'result.json')
    const eventsPath = join(jobDirectory, 'events.jsonl')
    const processPath = join(jobDirectory, 'process.json')

    // A resumed attempt must not inherit ANY of the previous attempt's files, and
    // `process.json` is the one that matters most. MEASURED: without it here, a
    // resumed render read the dead attempt's pid out of the old file and recorded
    // THAT as the process doing the work — so a second restart would go looking for
    // a process that no longer exists and leave the live renderer orphaned, which is
    // precisely the failure the acceptance condition forbids. The journal is listed
    // for the same reason: two attempts interleaved into one stream cannot be told
    // apart. The old `result.json` is listed because reading a stale success envelope
    // for an attempt that has not finished is how a failed render reports success.
    for (const stale of [eventsPath, resultPath, processPath]) {
      if (!existsSync(stale)) continue
      try {
        rmSync(stale, { force: true })
      } catch {
        // A stale file that cannot be cleared is a diagnostic problem, not a
        // reason to refuse to render: the ledger is derived from the frames.
      }
    }

    const plan = {
      // One spelling for the document type. The contracts package owns the string
      // and the contracts test pins it; a second literal here is the shape of
      // defect that has already cost this repository four times (D38, D43) — a
      // vocabulary written twice rots in the copy nobody exercises.
      schemaVersion: FRAME_PLAN_VERSION,
      jobId: request.jobId ?? null,
      // The token travels with the plan so the child can stamp its identity document
      // with it. The host refuses an identity whose token is not the one this attempt
      // was started with, which turns "the pid is from the current attempt" from a
      // convention about deleting files into a fact that is checked.
      attemptToken: request.attemptToken ?? null,
      checkpoint: request.checkpointPath,
      cameraId: request.cameraId ?? null,
      profileName: request.profileName ?? null,
      profile: request.profile ?? {},
      frameRange: request.frameRange ?? null,
      frames: frames.map(frame => Number(frame)),
      outputDirectory: framesDirectory,
      filePrefix: request.filePrefix ?? 'frame_',
      padding: request.padding ?? 4,
    }
    writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8')
    writeFileSync(requestPath, JSON.stringify({
      protocolVersion: BLENDER_PROTOCOL_VERSION,
      jobId: request.jobId ?? null,
      action: 'render_frames',
    }, null, 2), 'utf8')

    const argv = [
      resolvedExecutable.resolved,
      '--background',
      '--factory-startup',
      '--python',
      this.bootstrapPath,
      '--',
      '--request',
      requestPath,
      '--result',
      resultPath,
      '--frames',
      planPath,
      '--events',
      eventsPath,
      '--proc',
      processPath,
    ]

    const startedAt = Date.now()
    let handle
    try {
      handle = this.ctx.subprocess.spawn({
        argv,
        cwd: jobDirectory,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.config.maxOutputBytes, spill: { maxBytes: this.config.maxSpillBytes } },
          stderr: { maxBytes: this.config.maxOutputBytes, spill: { maxBytes: this.config.maxSpillBytes } },
        },
        graceMs: TERMINATE_GRACE_MS,
        // Deliberately NO AbortSignal here. A frame sequence is not bounded by the
        // preview deadline, and binding a signal would make the provider's own
        // timeout indistinguishable from a caller's cancellation in the record.
        // Cancellation goes through `handle.terminate()`, which the host calls
        // from `cancelJob`.
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          TMPDIR: process.env.TMPDIR ?? '',
          PYTHONUNBUFFERED: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          DEEPBLEND_JOB_ID: String(request.jobId ?? ''),
        },
      })
    } catch (cause) {
      throw new BlenderError(
        BlenderErrorCode.SPAWN_FAILED,
        `Failed to spawn Blender at ${resolvedExecutable.resolved}.`,
        { cause },
      )
    }

    return {
      handle,
      jobDirectory,
      framesDirectory,
      requestPath,
      planPath,
      resultPath,
      eventsPath,
      processPath,
      argv,
      startedAt,
      attemptToken: request.attemptToken ?? null,
      executable: resolvedExecutable.resolved,
    }
  }

  /**
   * Wait for a frame-sequence render started by {@link startFrameSequence}.
   *
   * Failure classification mirrors `runBootstrap`, and for the same reason: a
   * terminated process may still have written a partial result document, so being
   * killed must never be reported as a successful render. It is returned as data
   * rather than thrown because a frame sequence legitimately ends two ways — all
   * frames rendered, or killed mid-sequence with the completed frames intact —
   * and the caller must record both without losing the evidence.
   *
   * @param {Awaited<ReturnType<LocalBlenderRuntime['startFrameSequence']>>} run
   * @returns {Promise<{envelope: object|null, stdout: string, stderr: string, exitCode: number|null, signal: string|null, durationMs: number, spawnFailure: unknown}>}
   */
  async awaitFrameSequence(run) {
    let outcome = null
    let spawnFailure = null
    try {
      outcome = await run.handle.done
    } catch (cause) {
      spawnFailure = cause
    }

    const stdout = this._readAll(run.handle.collected?.stdout)
    const stderr = this._readAll(run.handle.collected?.stderr)
    const durationMs = Date.now() - run.startedAt

    /** @type {object|null} */
    let envelope = null
    if (existsSync(run.resultPath)) {
      try {
        envelope = JSON.parse(readFileSync(run.resultPath, 'utf8'))
      } catch {
        envelope = null
      }
    }

    return {
      envelope,
      stdout,
      stderr,
      exitCode: outcome?.exitCode ?? null,
      signal: outcome?.signal ?? null,
      durationMs,
      spawnFailure,
    }
  }

  /**
   * Render a PLAN of views out of one checkpoint, in one Blender process, and
   * measure each one (SPEC §12.3 "预览默认包含：主相机 / 45 度 / 俯视 / 近景").
   *
   * @param {object} request
   * @param {string} request.checkpointPath - absolute path to the `.blend`.
   * @param {object[]} request.views - `{ id, role?, cameraId?, frame? }`, in reading order.
   * @param {string[]} [request.track] - object ids to measure by isolation.
   * @param {string[]} [request.parts] - object ids that are part of the subject's own
   *   body, so a ray reaching them has reached the subject rather than been blocked.
   * @param {string} [request.engine] - SceneSpec engine key.
   * @param {number} [request.width]
   * @param {number} [request.height]
   * @param {number} [request.samples]
   * @param {string} [request.jobId]
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<{report: object, pngs: Record<string, Buffer>, envelope: object, durationMs: number}>}
   */
  async renderViews(request) {
    if (typeof request?.checkpointPath !== 'string' || request.checkpointPath.length === 0) {
      throw new BlenderError(
        BlenderErrorCode.REVISION_CHECKPOINT_MISSING,
        'renderViews needs an absolute path to a .blend checkpoint.',
      )
    }
    const views = Array.isArray(request.views) ? request.views : []
    if (views.length === 0) {
      throw new BlenderError(BlenderErrorCode.SCRIPT_ERROR, 'renderViews needs at least one view in its plan.')
    }
    for (const view of views) {
      if (typeof view?.id !== 'string' || view.id.length === 0) {
        throw new BlenderError(BlenderErrorCode.SCRIPT_ERROR, 'every view in a render plan needs an id.')
      }
    }

    /** @type {Record<string, Buffer>} */
    const pngs = {}

    const run = await this.runBootstrap(
      { action: 'render_views', jobId: request.jobId },
      {
        signal: request.signal,
        args: ['--views', 'views.json'],
        // The plan names outputs by BARE file name: Blender must write somewhere
        // that dies with the invocation, or a failed render would leave images
        // where the host could mistake them for artifact bytes.
        prepareDirectory: ({ directory }) => {
          const plan = {
            checkpoint: request.checkpointPath,
            engine: request.engine,
            width: request.width,
            height: request.height,
            samples: request.samples,
            track: Array.isArray(request.track) ? request.track : [],
            // Entities that are part of the subject's own body rather than things in
            // front of it. The renderer needs them to decide what counts as occlusion.
            parts: Array.isArray(request.parts) ? request.parts : [],
            views: views.map(view => ({
              id: view.id,
              role: view.role ?? null,
              cameraId: view.cameraId,
              frame: view.frame,
              output: `${view.id}.png`,
            })),
          }
          writeFileSync(join(directory, 'views.json'), JSON.stringify(plan, null, 2), 'utf8')
        },
        onWorkingDirectory: async info => {
          // By the time this runs Blender has finished, so the directory holds the
          // plan, the renders, the isolation masks and the result document. Read
          // the PNG bytes out before the cleanup removes all of it: a Buffer is
          // serializable across this boundary, while a path is not.
          const result = info.envelope?.result ?? {}
          for (const entry of Array.isArray(result.views) ? result.views : []) {
            if (typeof entry?.outputPath !== 'string') continue
            try {
              pngs[entry.viewId] = await readFile(entry.outputPath)
            } catch {
              // A view whose bytes cannot be read is already reported as missing by
              // the render report; failing the whole plan here would discard the
              // views that did render.
            }
          }
        },
      },
    )

    const report = run.envelope.result ?? {}
    return {
      report,
      pngs,
      envelope: run.envelope,
      durationMs: run.durationMs,
    }
  }

  /**
   * The Blender engine identifier that will actually be used for a SceneSpec
   * engine key, plus a warning when it is not the requested one.
   *
   * Kept on the provider because engine availability is a property of the
   * RUNTIME, not of the request (finding D1). The host asks this before it
   * spends a render, so a downgrade is a recorded decision rather than a
   * surprise in the artifact.
   *
   * @param {string} engineKey
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ blenderEngine: string|null, requested: string|null, downgraded: boolean, warning: object|null }>}
   */
  async resolveEngineKey(engineKey, options = {}) {
    const requested = BLENDER_ENGINE_BY_KEY[engineKey] ?? null
    if (requested === null) {
      throw new BlenderError(
        BlenderErrorCode.RENDER_PROFILE_MISSING,
        `"${engineKey}" is not a SceneSpec render engine; expected one of ${Object.keys(BLENDER_ENGINE_BY_KEY).join(', ')}.`,
      )
    }

    const capabilities = await this.getCapabilities(options)
    if (capabilities.installed !== true) {
      return { blenderEngine: null, requested, downgraded: false, warning: null }
    }
    if (capabilities.renderEngines[requested]?.assignable === true) {
      return { blenderEngine: requested, requested, downgraded: false, warning: null }
    }
    for (const candidate of CANDIDATE_RENDER_ENGINES) {
      if (candidate === requested) continue
      if (capabilities.renderEngines[candidate]?.assignable === true) {
        return {
          blenderEngine: candidate,
          requested,
          downgraded: true,
          warning: warning(
            BlenderWarningCode.ENGINE_DOWNGRADED,
            `engine "${engineKey}" (${requested}) is not assignable in this Blender build; ${candidate} will be used instead`,
            { requested, used: candidate },
          ),
        }
      }
    }
    throw new BlenderError(
      BlenderErrorCode.ENGINE_UNAVAILABLE,
      `none of ${CANDIDATE_RENDER_ENGINES.join(', ')} is assignable in this Blender build.`,
    )
  }

  /** Terminate nothing itself — `ctx.subprocess` owns its managed process range. */
  dispose() {
    this._capabilitiesCache.clear()
  }
}

/**
 * Coerce the probe map into the declared shape, so a malformed bootstrap result
 * degrades rather than crashing the host.
 * @param {unknown} raw
 * @returns {Record<string, { assignable: boolean, readback: string|null, error: string|null }>}
 */
function normaliseEngineProbes(raw) {
  const result = {}
  for (const id of CANDIDATE_RENDER_ENGINES) {
    const probe = raw && typeof raw === 'object' ? raw[id] : undefined
    result[id] = {
      assignable: probe?.assignable === true,
      readback: typeof probe?.readback === 'string' ? probe.readback : null,
      error: typeof probe?.error === 'string' ? probe.error : null,
    }
  }
  return result
}

/** @returns {import('@deepblend/dsh-blender-contracts').BlenderGpuReport} */
function emptyGpuReport() {
  return {
    availableBackends: [],
    preferredBackend: null,
    gpuDeviceNames: [],
    cpuDeviceNames: [],
    backendSupport: {},
  }
}

/**
 * Normalise the bootstrap's GPU report.
 *
 * An unsupported backend raises on assignment rather than returning nothing, so
 * `backendSupport[x].supported === false` is a normal result carrying an error
 * string — it is not a probe failure and must not be treated as one.
 *
 * @param {unknown} raw
 * @returns {import('@deepblend/dsh-blender-contracts').BlenderGpuReport}
 */
function normaliseGpu(raw) {
  if (!raw || typeof raw !== 'object') return emptyGpuReport()
  const report = raw
  const backendSupport = {}
  const support = report.backendSupport && typeof report.backendSupport === 'object' ? report.backendSupport : {}
  for (const [backend, value] of Object.entries(support)) {
    backendSupport[backend] = {
      supported: value?.supported === true,
      gpuDevices: Array.isArray(value?.gpuDevices) ? value.gpuDevices : [],
      cpuDevices: Array.isArray(value?.cpuDevices) ? value.cpuDevices : [],
      error: typeof value?.error === 'string' ? value.error : null,
    }
  }

  const availableBackends = Array.isArray(report.availableBackends)
    ? report.availableBackends.filter(entry => typeof entry === 'string')
    : []
  const gpuDeviceNames = Array.isArray(report.gpuDeviceNames)
    ? report.gpuDeviceNames.filter(entry => typeof entry === 'string')
    : []
  const cpuDeviceNames = Array.isArray(report.cpuDeviceNames)
    ? report.cpuDeviceNames.filter(entry => typeof entry === 'string')
    : []

  return {
    availableBackends,
    preferredBackend: typeof report.preferredBackend === 'string' ? report.preferredBackend : null,
    gpuDeviceNames,
    cpuDeviceNames,
    backendSupport,
  }
}

/**
 * Extract the "attribute exists but the operator is not registered" list.
 *
 * This is the trap behind `hasattr(bpy.ops.export_scene, 'obj')`: it is True on
 * this build while the operator cannot actually be invoked. Surfacing the names
 * lets M1 refuse an unsupported export with a precise message.
 *
 * @param {unknown} diagnostics
 * @returns {string[]}
 */
function normaliseUnavailableFormats(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return []
  const names = new Set()
  for (const [key, value] of Object.entries(diagnostics)) {
    // Direction-specific keys: exportUnregisteredButPresent / importUnregisteredButPresent.
    if (!Array.isArray(value) || !/unregistered/i.test(key)) continue
    for (const entry of value) if (typeof entry === 'string') names.add(entry)
  }
  return [...names].sort()
}

/**
 * Read the informational engine enum out of the bootstrap's diagnostics block.
 *
 * This value is NEVER used to decide availability (D1) — it exists so an
 * operator can see the enum disagree with behaviour, which is the single most
 * confusing fact about this Blender build.
 *
 * @param {unknown} diagnostics
 * @returns {string[]}
 */
function normaliseEngineEnumItems(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return []
  const block = diagnostics.engineEnumItemsInformational
  if (!block || typeof block !== 'object') return []
  return Array.isArray(block.identifiers)
    ? block.identifiers.filter(entry => typeof entry === 'string')
    : []
}

/**
 * Map a bootstrap error code onto the stable contract code space.
 *
 * bootstrap.py reports BARE codes, and they are of two kinds:
 *
 *   - the Blender-runtime family, whose contract spelling IS the bare name with a
 *     `BLENDER_` prefix (`UNSUPPORTED_ACTION` -> `BLENDER_UNSUPPORTED_ACTION`);
 *   - the DOMAIN family, whose contract spelling has NO prefix at all
 *     (`SCENE_VALIDATION_FAILED`, `REVISION_CHECKPOINT_MISSING`, `SCENE_CAMERA_MISSING`, ...).
 *
 * The version of this function that prefixed EVERYTHING invented codes for the second kind: the
 * Python side's most common failure (`SCENE_VALIDATION_FAILED`, 27 sites) reached the model as
 * `BLENDER_SCENE_VALIDATION_FAILED`, which is not in `BlenderErrorCode` at all — so nothing could
 * branch on it, `docs/recovery.md`'s index by code could not find it, and the SAME failure carried a
 * different code depending on whether the host's own validation or Blender's reported it.
 *
 * So the prefix is applied only when the contract actually exposes that prefixed form, a bare code
 * that the contract defines is passed through unchanged, and anything else — an unknown code from a
 * NEWER bootstrap.py than this build knows — becomes `SCRIPT_ERROR`, which is exactly what "this
 * failure has no code I can branch on" means.
 *
 * @param {unknown} code
 * @returns {string}
 */
function normaliseErrorCode(code) {
  if (typeof code !== 'string' || code.length === 0) return BlenderErrorCode.SCRIPT_ERROR
  const known = CONTRACT_ERROR_CODES
  if (code.startsWith('BLENDER_')) return known.has(code) ? code : BlenderErrorCode.SCRIPT_ERROR
  const prefixed = `BLENDER_${code}`
  if (known.has(prefixed)) return prefixed
  if (known.has(code)) return code
  return BlenderErrorCode.SCRIPT_ERROR
}

/** The contract's whole error space, as a set: the one place this file may map INTO. */
const CONTRACT_ERROR_CODES = new Set(Object.values(BlenderErrorCode))

/**
 * Derive operator-visible warnings from a probe result (D1, D2, SPEC §2.2 gap).
 * @param {Record<string, any>} raw
 * @returns {{ code: string, message: string, detail?: unknown }[]}
 */
function collectWarnings(raw) {
  const warnings = []
  const probes = normaliseEngineProbes(raw.renderEngines)
  const enumItems = normaliseEngineEnumItems(raw.renderEngineDiagnostics)

  for (const [id, probe] of Object.entries(probes)) {
    // The Blender 5.2.1 trap: assignable but absent from the static enum.
    if (probe.assignable && enumItems.length > 0 && !enumItems.includes(id)) {
      warnings.push(
        warning(
          BlenderWarningCode.ENGINE_NOT_IN_STATIC_ENUM,
          `Render engine ${id} is assignable but absent from the static engine enum ` +
            `(${enumItems.join(', ')}). Availability must be decided behaviorally, never from the enum.`,
          { engine: id, enumItems },
        ),
      )
    }
  }

  if (probes.CYCLES && !probes.CYCLES.assignable) {
    warnings.push(
      warning(
        BlenderWarningCode.ENGINE_UNAVAILABLE,
        'Cycles is not available in this Blender build. Final render must fall back to EEVEE; ' +
          'render profiles requesting CYCLES will be downgraded.',
        { engine: 'CYCLES' },
      ),
    )
  }

  if (normaliseGpu(raw.gpuDevices).gpuDeviceNames.length === 0) {
    warnings.push(
      warning(BlenderWarningCode.GPU_UNAVAILABLE, 'No GPU compute device was detected; rendering will use the CPU.'),
    )
  }

  const imports = Array.isArray(raw.importFormats) ? raw.importFormats : []
  const exports = Array.isArray(raw.exportFormats) ? raw.exportFormats : []
  for (const format of EXPECTED_IMPORT_FORMATS) {
    if (!imports.includes(format)) {
      warnings.push(
        warning(
          BlenderWarningCode.FORMAT_UNAVAILABLE,
          `Import format "${format}" is not provided by this Blender build and cannot be offered yet.`,
          { direction: 'import', format },
        ),
      )
    }
  }
  for (const format of EXPECTED_EXPORT_FORMATS) {
    if (!exports.includes(format)) {
      warnings.push(
        warning(
          BlenderWarningCode.FORMAT_UNAVAILABLE,
          `Export format "${format}" is not provided by this Blender build and cannot be offered yet.`,
          { direction: 'export', format },
        ),
      )
    }
  }

  // Bootstrap-reported warnings are already precise; pass them through verbatim
  // under a generic code rather than re-labelling them as add-on failures.
  for (const message of Array.isArray(raw.warnings) ? raw.warnings : []) {
    if (typeof message === 'string' && message.length > 0) {
      warnings.push(warning(BlenderWarningCode.PROBE_WARNING, message))
    }
  }

  return warnings
}

/**
 * Validate that a configured path is a usable Blender executable, without
 * launching it. Exposed for the settings card's "test path" affordance and for
 * unit tests that must not require Blender to be installed.
 *
 * @param {string} candidate
 * @returns {{ ok: boolean, reason?: string }}
 */
export function inspectExecutablePath(candidate) {
  try {
    const canonical = realpathSync(candidate)
    const stats = statSync(canonical)
    if (stats.isDirectory()) return { ok: false, reason: 'path is a directory' }
    // Blender ships a macOS .app wrapper; the real binary lives under Contents/MacOS.
    if (!stats.isFile()) return { ok: false, reason: 'path is not a regular file' }
    return { ok: true }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * What to DO about a Blender that could not be resolved, as one sentence.
 *
 * This is where the package's two previously-uncalled helpers finally have a caller, and where the
 * comment above them ("exposed for the settings card's test path affordance") becomes true. MEASURED,
 * round 35: `inspectExecutablePath` and `discoverBlenderOnPath` were exported — and required by
 * `contract/imports.test.mjs` — with NO caller anywhere in the product, while the settings card showed
 * `可执行文件: 未解析到` and nothing else: a dead end for the human, on the one screen whose job is to
 * say what is wrong with the install. The tool text told the model what to do; the card told the
 * operator nothing.
 *
 * The two lookups arrive as parameters because the branches have to be drivable without arranging the
 * machine: "a configured path that does not work", "a Blender on PATH that was not configured" and
 * "nothing anywhere" are three different sentences, and only the first is reachable by configuration.
 * Same trade as `reconcileRenderJob`'s injectable store.
 *
 * Order matters and is deliberate: a path the operator CONFIGURED and that does not work is the most
 * specific thing to report, so it wins over a suggestion to go looking on PATH.
 *
 * @param {{ requested: string, fallbackName?: string }} input
 * @param {{ inspect?: (candidate: string) => {ok: boolean, reason?: string}, discover?: () => string|null }} [deps]
 * @returns {string}
 */
export function blenderPathAdvice(input, deps = {}) {
  const inspect = deps.inspect ?? inspectExecutablePath
  const discover = deps.discover ?? discoverBlenderOnPath
  const requested = typeof input?.requested === 'string' ? input.requested : ''
  const fallback = input?.fallbackName ?? FALLBACK_BLENDER_NAME
  const configured = requested.length > 0 && requested !== fallback ? requested : null

  if (configured !== null) {
    const verdict = inspect(configured)
    if (verdict.ok !== true) {
      return `The configured path "${configured}" is not usable: ${verdict.reason}. ` +
        'Run deepblend/tools/install-blender.mjs, or point deepblend.blenderPath at a real Blender executable.'
    }
  }
  const found = discover()
  if (found !== null) {
    return `A Blender was found on PATH at ${found}. Set deepblend.blenderPath to that absolute path ` +
      '(or add its directory to deepblend.executableAllowlist if a bare name should resolve).'
  }
  return 'No Blender was found. Run deepblend/tools/install-blender.mjs to install the managed build, ' +
    'or set deepblend.blenderPath to an absolute path.'
}

/**
 * Locate a Blender executable on the host PATH synchronously.
 *
 * Used only by the settings card's discovery affordance to *suggest* a path.
 * Never used to bypass `ctx.subprocess.resolveExecutable` on the execution path.
 *
 * @returns {string|null}
 */
export function discoverBlenderOnPath() {
  const pathValue = process.env.PATH
  if (!pathValue) return null
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue
    const candidate = join(directory, 'blender')
    if (!existsSync(candidate)) continue
    const sync = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 20_000 })
    if (sync.status === 0) return candidate
  }
  return null
}
