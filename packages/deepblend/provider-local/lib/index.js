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
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import {
  BLENDER_PROTOCOL_VERSION,
  BlenderError,
  BlenderErrorCode,
  CANDIDATE_RENDER_ENGINES,
  EXPECTED_EXPORT_FORMATS,
  EXPECTED_IMPORT_FORMATS,
  BlenderWarningCode,
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
   * Absolute path to the Blender executable, or a bare PATH name.
   * SPEC §17 configures an absolute path; a bare name is accepted so a
   * PATH-installed Blender works without reconfiguration.
   */
  blenderPath: z.string().default('blender'),
  /** Absolute path to bootstrap.py. Defaults to the copy shipped in this package. */
  bootstrapPath: z.string(),
  /**
   * Workspace root. Per-invocation working directories are created here, keeping
   * every write inside the project workspace (SPEC §15.2 "工作区路径边界").
   */
  workspaceRoot: z.string(),
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
    this.config = config
    this.bootstrapPath = this._resolveBootstrapPath(config.bootstrapPath)
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
    const requested = this.config.blenderPath
    try {
      // `ctx.subprocess.resolveExecutable` verifies absolute paths and resolves
      // bare names against the provider's scrubbed PATH. Relative paths with
      // separators are rejected by the service itself.
      const resolved = await this.ctx.subprocess.resolveExecutable(requested, undefined, options.signal)
      const canonical = this._assertAllowed(resolved)
      return { resolved: canonical, requested, error: null }
    } catch (cause) {
      if (cause instanceof BlenderError) return { resolved: null, requested, error: cause }
      return {
        resolved: null,
        requested,
        error: new BlenderError(
          BlenderErrorCode.NOT_FOUND,
          `Blender executable could not be resolved from "${requested}". ` +
            `Install Blender or set deepblend.blenderPath to its absolute path.`,
          { cause },
        ),
      }
    }
  }

  /**
   * Enforce the executable allowlist against the real (symlink-resolved) path.
   *
   * An operator-supplied absolute `blenderPath` is trusted as a deliberate
   * choice; anything resolved from a bare name must land inside the allowlist.
   * @param {string} candidate
   * @returns {string} the canonical path
   */
  _assertAllowed(candidate) {
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
    const configuredIsAbsolute = isAbsolute(this.config.blenderPath)
    if (!configuredIsAbsolute && !this._insideAllowlist(canonical)) {
      throw new BlenderError(
        BlenderErrorCode.EXECUTABLE_OUTSIDE_ALLOWLIST,
        `Blender resolved from PATH to ${canonical}, which is outside the configured allowlist. ` +
          `Add its directory to deepblend.executableAllowlist to permit it.`,
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
    const root = resolve(this.config.workspaceRoot, 'tmp')
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
   * @param {{ signal?: AbortSignal }} [options]
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
        `Blender executable could not be resolved from "${this.config.blenderPath}".`,
      )
    }

    const { jobId, directory } = this._createWorkingDirectory()
    const correlationId = typeof request.jobId === 'string' && request.jobId.length > 0
      ? request.jobId
      : jobId
    const requestPath = join(directory, 'request.json')
    const resultPath = join(directory, 'result.json')

    const requestDocument = {
      protocolVersion: BLENDER_PROTOCOL_VERSION,
      jobId: correlationId,
      action,
      ...request.payload !== undefined ? { payload: request.payload } : {},
    }
    await import('node:fs/promises').then(fs =>
      fs.writeFile(requestPath, JSON.stringify(requestDocument, null, 2), 'utf8'),
    )

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
        cwd: directory,
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
    const cacheKey = this.config.blenderPath
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
      executable: { requested: resolved.requested, resolved: null, found: false },
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
 * bootstrap.py reports bare codes (`UNSUPPORTED_ACTION`); the contract exposes
 * them prefixed (`BLENDER_UNSUPPORTED_ACTION`) so a model or UI can tell a
 * DeepBlend failure apart from any other tool's code.
 *
 * @param {unknown} code
 * @returns {string}
 */
function normaliseErrorCode(code) {
  if (typeof code !== 'string' || code.length === 0) return BlenderErrorCode.SCRIPT_ERROR
  if (code.startsWith('BLENDER_')) return code
  return `BLENDER_${code}`
}

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
