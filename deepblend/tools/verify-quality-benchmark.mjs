#!/usr/bin/env node
/** Verify completed artifacts without launching Blender or changing run/result records. */
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalStringify, compileSceneSpec, decodePng } from '../../packages/deepblend/contracts/lib/index.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const equal = (a, b) => canonicalStringify(a ?? null) === canonicalStringify(b ?? null)
const frameNumbers = Array.from({ length: 48 }, (_, index) => index + 1)

/** Byte hashes identify artifacts. Pixel hashes deliberately exclude PNG metadata. */
export function pngFacts(bytes) {
  const decoded = decodePng(bytes)
  return { width: decoded.width, height: decoded.height, bytes: bytes.length,
    sha256: hash(bytes), pixelSha256: hash(Buffer.from(decoded.data)) }
}

export function hasPixelMotion(frames) {
  return Array.isArray(frames) && frames.length > 1 &&
    frames.every(frame => /^[a-f0-9]{64}$/.test(frame.pixelSha256 ?? '')) &&
    frames.slice(1).some(frame => frame.pixelSha256 !== frames[0].pixelSha256)
}

export function verifyBenchmark(output) {
  const root = resolve(output)
  const report = { schemaVersion: 'deepblend.benchmark-artifact-verification/v1',
    status: 'failed', artisticReviewRequired: true, output: root,
    verifiedAt: new Date().toISOString(), verifierSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    contractCompilerSha256: hash(readFileSync(new URL('../../packages/deepblend/contracts/lib/scene-spec.js', import.meta.url))),
    compilationEvidence: 'Saved original SceneSpecs are recompiled with the current contracts package. The compiler file hash is recorded; clay provenance is not independently reconstructed.',
    errors: [], evidenceLimitations: [], cases: [] }
  const check = (condition, message) => { if (!condition) report.errors.push(message); return Boolean(condition) }
  const match = (actual, expected, message) => check(equal(actual, expected), `${message}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`)
  const number = (actual, expected, message) => check(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-6, `${message}: expected ${expected}, found ${actual}`)
  const safePath = value => {
    if (typeof value !== 'string' || value.length === 0) throw new Error('Artifact path is missing')
    const path = resolve(root, value), local = relative(root, path)
    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(`Artifact path escapes output: ${value}`)
    return path
  }
  const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
  const readArtifact = (path, recordedHash, label) => {
    const bytes = readFileSync(path)
    check(typeof recordedHash === 'string' && /^[a-f0-9]{64}$/.test(recordedHash), `${label}: recorded SHA256 is missing or invalid`)
    match(hash(bytes), recordedHash, `${label} file SHA256`)
    return bytes
  }
  const config = (actual, expected, label, requireExposure = false) => {
    if (!check(actual && typeof actual === 'object', `${label}: renderConfig is missing`)) return
    match(actual.engine, 'CYCLES', `${label} engine`)
    match(actual.resolution, expected.resolution, `${label} resolution`)
    number(actual.samples, expected.samples, `${label} samples`)
    match(actual.viewTransform, expected.viewTransform, `${label} view transform`)
    if (requireExposure || actual.exposure !== undefined) number(actual.exposure, expected.exposure, `${label} exposure`)
    if (actual.fps !== undefined) number(actual.fps, 24, `${label} fps`)
    if (actual.fpsBase !== undefined) number(actual.fpsBase, 1, `${label} fps base`)
    if (actual.frameStart !== undefined) number(actual.frameStart, 1, `${label} first frame`)
    if (actual.frameEnd !== undefined) number(actual.frameEnd, 48, `${label} last frame`)
  }

  let runPath, originalRunBytes, run
  try {
    runPath = join(root, 'run.json')
    originalRunBytes = readFileSync(runPath)
    run = JSON.parse(originalRunBytes)
    report.runSha256 = hash(originalRunBytes)
    report.tier = run.tier
    report.coverage = run.selectedViews ? 'selected-views' : 'complete-tier'
    match(run.schemaVersion, 'deepblend.benchmark-run/v1', 'Run schema')
    check(['technical-pass-review-required', 'partial-run-review-required'].includes(run.status) && Boolean(run.finishedAt), 'Run must be complete and technically successful before artifact verification')
    check(Array.isArray(run.cases) && run.cases.length > 0, 'Run contains no cases')
    check(new Set((run.cases ?? []).map(entry => entry.id)).size === run.cases?.length, 'Run repeats a case id')
    const isFinal = run.tier === 'final'

    // New runs retain exact source bytes. Earlier draft runs recorded only their hashes.
    const snapshotRoot = join(root, 'source-snapshot')
    if (existsSync(snapshotRoot)) {
      match(hash(canonicalStringify(run.sourceSnapshot)), run.sourceSnapshotSha256, 'Source snapshot inventory SHA256')
      for (const entry of run.sourceSnapshot ?? []) {
        const path = safePath(join('source-snapshot', entry.path))
        try { readArtifact(path, entry.sha256, `Source snapshot ${entry.path}`) }
        catch (error) { check(false, `Source snapshot ${entry.path}: ${error.message}`) }
      }
      const manifestPath = join(snapshotRoot, 'deepblend/benchmarks/manifest.json')
      if (existsSync(manifestPath)) readArtifact(manifestPath, run.manifestSha256, 'Saved benchmark manifest')
    } else if (isFinal) check(false, 'Final run has no retained source-snapshot directory')
    else report.evidenceLimitations.push('This earlier draft retained a source-hash inventory without its source files; source bytes cannot be rechecked.')

    for (const entry of run.cases ?? []) {
      const verified = { id: entry.id, variants: {}, motion: null }
      report.cases.push(verified)
      try {
        if (!/^[a-z][a-z0-9-]*$/.test(entry.id)) throw new Error(`Invalid case id ${entry.id}`)
        match(entry.status, 'technical-pass', `${entry.id} case status`)
        const caseDirectory = safePath(entry.id)
        const persisted = readJson(join(caseDirectory, 'result.json'))
        match(persisted.variants, entry.variants, `${entry.id} run/result variant evidence`)
        match(persisted.motion ?? null, entry.motion ?? null, `${entry.id} run/result motion evidence`)
        match(persisted.inputs, entry.inputs, `${entry.id} run/result input hashes`)
        const budget = entry.budget
        if (!budget?.resolution || !Number.isInteger(budget.samples)) throw new Error(`${entry.id}: recorded budget is missing`)
        let retainedManifest = null, retainedCase = null
        const manifestPath = join(snapshotRoot, 'deepblend/benchmarks/manifest.json')
        if (existsSync(manifestPath)) {
          const manifest = readJson(manifestPath)
          retainedManifest = manifest; retainedCase = manifest.cases?.find(item => item.id === entry.id)
          match(budget, manifest.tiers?.[run.tier], `${entry.id} budget vs saved manifest`)
          check(manifest.cases?.some(item => item.id === entry.id), `${entry.id}: case is absent from the retained manifest`)
        }
        // A --case run legitimately covers a subset of the retained manifest. Bind every
        // case it does contain to the original bytes, not just run/result agreement.
        let originalSpecs = null
        if (existsSync(snapshotRoot)) {
          const savedCase = join(snapshotRoot, 'deepblend/benchmarks', entry.id)
          for (const name of ['scene-spec.json', 'baseline-scene-spec.json', 'geometry-checks.json', 'brief.md']) {
            const path = `deepblend/benchmarks/${entry.id}/${name}`
            check(run.sourceSnapshot?.some(source => source.path === path), `${entry.id}: original ${name} is absent from the hashed source inventory`)
          }
          const candidate = readJson(join(savedCase, 'scene-spec.json'))
          const baseline = readJson(join(savedCase, 'baseline-scene-spec.json'))
          const geometryChecks = readJson(join(savedCase, 'geometry-checks.json'))
          const brief = readFileSync(join(savedCase, 'brief.md'), 'utf8')
          const bindings = { candidate: hash(canonicalStringify(candidate)), baseline: hash(canonicalStringify(baseline)),
            brief: hash(brief), geometryChecks: hash(canonicalStringify(geometryChecks)) }
          for (const [key, actualHash] of Object.entries(bindings)) match(entry.inputs?.[key], actualHash, `${entry.id} ${key} input vs saved original`)
          verified.sourceBindings = bindings
          originalSpecs = { candidate, baseline }
        }
        const expectedVariants = ['candidate', ...(budget.baseline ? ['baseline'] : []), ...(budget.clay ? ['clay'] : [])]
        match(Object.keys(entry.variants ?? {}).sort(), expectedVariants.sort(), `${entry.id} expected variants`)

        let candidateSpec
        for (const [name, variant] of Object.entries(entry.variants ?? {})) {
          try {
            if (!['candidate', 'baseline', 'clay'].includes(name)) throw new Error(`Unexpected variant ${name}`)
            const directory = join(caseDirectory, name), label = `${entry.id}/${name}`
            const specPath = join(directory, 'scene-spec.json'), specBytes = readFileSync(specPath)
            const spec = JSON.parse(specBytes)
            if (originalSpecs && name !== 'clay') {
              const rebuilt = JSON.parse(JSON.stringify(compileSceneSpec(originalSpecs[name]).spec))
              match(spec, rebuilt, `${label} compiled SceneSpec vs saved original`)
            }
            if (name === 'candidate') candidateSpec = spec
            match(spec.project.fps, 24, `${label} source fps`)
            match([spec.project.frameStart, spec.project.frameEnd], [1, 48], `${label} source range`)
            const profile = spec.renderProfiles?.[budget.profile]
            if (!profile) throw new Error(`${label}: ${budget.profile} profile is missing`)
            match(profile.engine, 'cycles', `${label} source engine`)
            const color = profile.colorManagement ?? {}
            const expected = { resolution: budget.resolution, samples: budget.samples,
              viewTransform: color.viewTransform ?? 'AgX', exposure: color.exposure ?? 0 }
            const checkpointExpected = { ...expected, resolution: profile.resolution, samples: profile.samples }
            // Draft is an explicit lower-budget override. Review/final must equal the authored profile.
            if (run.tier !== 'draft') {
              match(budget.resolution, profile.resolution, `${label} budget/source resolution`)
              match(budget.samples, profile.samples, `${label} budget/source samples`)
            }
            const checkpointPath = join(directory, 'scene.blend')
            const checkpointHash = hash(readArtifact(checkpointPath, variant.checkpointSha256, `${label} checkpoint`))
            const compile = readJson(join(directory, 'compile.json')), views = readJson(join(directory, 'views.json'))
            match(compile.status, 'success', `${label} compile receipt status`)
            match(views.status, 'success', `${label} view receipt status`)
            config(compile.result?.renderConfig, checkpointExpected, `${label} compile receipt`)
            config(variant.renderConfig, expected, `${label} recorded view budget`)
            config(views.result?.renderConfig, expected, `${label} actual view receipt`)
            match(views.result?.renderConfig, variant.renderConfig, `${label} persisted renderConfig`)
            const facts = verified.variants[name] = { checkpointSha256: checkpointHash,
              sceneSpecSha256: hash(specBytes), expectedRenderConfig: expected, actualRenderConfig: variant.renderConfig,
              compiledSourceVerified: Boolean(originalSpecs && name !== 'clay'), images: {} }

            // The old render_views receipt omits exposure. A separately reopened checkpoint
            // provides that evidence because render_views never changes color management.
            const geometryPath = join(directory, 'verification-geometry.json')
            if (existsSync(geometryPath)) {
              const inspectedBytes = readFileSync(geometryPath), inspected = JSON.parse(inspectedBytes)
              match(inspected.checkpointSha256, checkpointHash, `${label} independent inspection checkpoint hash`)
              config(inspected.checkpointRenderConfig, checkpointExpected, `${label} independent checkpoint`, true)
              if (inspected.checkpointRenderConfig?.gamma !== undefined) number(inspected.checkpointRenderConfig.gamma, 1, `${label} checkpoint gamma`)
              facts.exposureEvidence = { kind: 'independent-checkpoint-inspection', path: relative(root, geometryPath),
                sha256: hash(inspectedBytes), exposure: inspected.checkpointRenderConfig?.exposure,
                explanation: 'Read from the actual checkpoint; render_views preserves its color management. The original static-render receipt did not report exposure.' }
            } else if (Number.isFinite(views.result?.renderConfig?.exposure)) {
              number(views.result.renderConfig.exposure, expected.exposure, `${label} view exposure`)
              facts.exposureEvidence = { kind: 'actual-render-receipt', exposure: views.result.renderConfig.exposure }
            } else {
              facts.exposureEvidence = { kind: 'source-declared-only', exposure: expected.exposure, verified: false }
              if (isFinal) check(false, `${label}: final static exposure has no actual-checkpoint or render-receipt evidence`)
              else report.evidenceLimitations.push(`${label}: actual exposure is absent from this draft's receipts; ${expected.exposure} is source-declared only.`)
            }
            const expectedViews = run.selectedViews ?? (name === 'clay' ? ['hero', 'detail']
              : name === 'baseline' || run.tier === 'draft' ? ['hero', 'detail', 'reverse']
                : ['hero', 'detail', 'reverse', 'motion-mid', 'motion-end'])
            match(Object.keys(variant.images ?? {}).sort(), [...expectedViews].sort(), `${label} view coverage`)
            for (const [view, recorded] of Object.entries(variant.images ?? {})) {
              const expectedView = retainedManifest?.views?.find(item => item.id === view)
              if (expectedView) {
                match(recorded.frame, expectedView.frame, `${label}/${view} frame`)
                match(recorded.cameraId, view.startsWith('motion-') ? retainedCase?.motionCameraId ?? expectedView.cameraId : expectedView.cameraId, `${label}/${view} camera`)
              }
              const receiptViews = views.result?.views
              if (Array.isArray(receiptViews)) {
                const matches = receiptViews.filter(item => item.viewId === view)
                match(matches.length, 1, `${label}/${view} actual receipt coverage`)
                const actualView = matches[0]
                if (actualView) {
                  match(actualView.cameraId, recorded.cameraId, `${label}/${view} actual camera`)
                  match(actualView.frame, recorded.frame, `${label}/${view} actual frame`)
                  match([actualView.width, actualView.height], expected.resolution, `${label}/${view} actual dimensions`)
                  number(actualView.bytes, recorded.bytes, `${label}/${view} actual byte length`)
                }
              } else if (isFinal) check(false, `${label}/${view}: actual per-view receipt is missing`)
              const path = safePath(recorded.path)
              match(path, join(directory, `${view}.png`), `${label}/${view} artifact path`)
              const image = pngFacts(readArtifact(path, recorded.sha256, `${label}/${view}`))
              match([image.width, image.height], expected.resolution, `${label}/${view} decoded dimensions`)
              match([recorded.width, recorded.height], [image.width, image.height], `${label}/${view} recorded dimensions`)
              number(image.bytes, recorded.bytes, `${label}/${view} byte length`)
              if (recorded.pixelSha256 !== undefined) match(image.pixelSha256, recorded.pixelSha256, `${label}/${view} pixel SHA256`)
              facts.images[view] = { path: relative(root, path), ...image, frame: recorded.frame, cameraId: recorded.cameraId }
            }
          } catch (error) { check(false, `${entry.id}/${name}: ${error.message}`) }
        }

        const needsMotion = Boolean(budget.motion) && !run.selectedViews
        if (needsMotion && !entry.motion) check(false, `${entry.id}: required motion artifact is missing`)
        if (entry.motion) {
          const label = `${entry.id}/motion`, directory = join(caseDirectory, 'motion')
          const plan = readJson(join(directory, 'plan.json')), envelope = readJson(join(directory, 'result.json'))
          match(envelope.status, 'success', `${label} render receipt status`)
          const actual = envelope.result
          match(plan.frames, frameNumbers, `${label} planned frames`)
          match(plan.cameraId, retainedCase?.motionCameraId ?? retainedManifest?.motion?.cameraId ?? 'hero', `${label} planned camera`)
          match(plan.profile.resolution, [384, 288], `${label} planned resolution`)
          number(plan.profile.samples, 24, `${label} planned samples`)
          match(actual.renderedFrames, frameNumbers, `${label} rendered frame ids`)
          number(actual.renderedCount, 48, `${label} rendered count`)
          match((actual.frames ?? []).map(frame => frame.frame), frameNumbers, `${label} artifact frame ids`)
          match((entry.motion.frames ?? []).map(frame => frame.frame), frameNumbers, `${label} recorded frame ids`)
          const color = candidateSpec?.renderProfiles?.preview?.colorManagement ?? {}
          const motionExpected = { resolution: [384, 288], samples: 24,
            viewTransform: color.viewTransform ?? 'AgX', exposure: color.exposure ?? 0 }
          config(actual.renderConfig, motionExpected, `${label} actual render budget`, true)
          config(entry.motion.renderConfig, motionExpected, `${label} persisted render budget`, true)
          match(actual.renderConfig, entry.motion.renderConfig, `${label} persisted renderConfig`)
          const decoded = []
          for (const frame of actual.frames ?? []) {
            const filename = `frame_${String(frame.frame).padStart(4, '0')}.png`
            const path = join(directory, 'frames', filename)
            match(resolve(frame.path), path, `${label}/${frame.frame} actual output path`)
            match(frame.file, filename, `${label}/${frame.frame} actual filename`)
            const recorded = entry.motion.frames?.find(item => item.frame === frame.frame)
            if (!recorded) { check(false, `${label}/${frame.frame}: missing recorded frame`); continue }
            const facts = pngFacts(readArtifact(path, recorded.sha256, `${label}/${frame.frame}`))
            match([facts.width, facts.height], [384, 288], `${label}/${frame.frame} decoded dimensions`)
            match([recorded.width, recorded.height], [facts.width, facts.height], `${label}/${frame.frame} recorded dimensions`)
            number(facts.bytes, frame.bytes, `${label}/${frame.frame} receipt byte length`)
            number(facts.bytes, recorded.bytes, `${label}/${frame.frame} recorded byte length`)
            if (recorded.pixelSha256 !== undefined) match(facts.pixelSha256, recorded.pixelSha256, `${label}/${frame.frame} pixel SHA256`)
            decoded.push({ frame: frame.frame, path: relative(root, path), ...facts })
          }
          const different = decoded.slice(1).filter(frame => frame.pixelSha256 !== decoded[0]?.pixelSha256).map(frame => frame.frame)
          check(hasPixelMotion(decoded), `${label}: every decoded frame has identical pixels; PNG metadata differences do not prove motion`)
          const videoPath = safePath(entry.motion.path)
          match(videoPath, join(directory, 'motion.mp4'), `${label} MP4 path`)
          const videoHash = hash(readArtifact(videoPath, entry.motion.sha256, `${label} MP4`))
          const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,nb_read_frames,avg_frame_rate,codec_name,pix_fmt', '-of', 'json', videoPath],
          { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 }))
          if (!check(probe.streams?.length === 1, `${label}: expected one video stream`)) throw new Error(`${label}: video stream is missing`)
          const stream = probe.streams[0], [numerator, denominator] = String(stream.avg_frame_rate).split('/').map(Number)
          number(Number(stream.nb_read_frames), 48, `${label} decoded video frame count`)
          match([stream.width, stream.height], [384, 288], `${label} actual video dimensions`)
          number(numerator / denominator, 24, `${label} actual video fps`)
          match(stream.codec_name, 'h264', `${label} video codec`)
          match(stream.pix_fmt, 'yuv420p', `${label} video pixel format`)
          verified.motion = { path: relative(root, videoPath), sha256: videoHash, ffprobe: stream,
            actualRenderConfig: actual.renderConfig, pixelDifferentFromFirst: different, frames: decoded,
            motionEvidence: 'At least one later decoded RGBA image differs from frame 1; PNG metadata is excluded. Visual motion magnitude and artistic quality still require review.' }
        }
      } catch (error) { check(false, `${entry.id}: ${error.message}`) }
    }
    match(hash(readFileSync(runPath)), report.runSha256, 'Run record changed during verification')
  } catch (error) { check(false, error.message) }
  report.status = report.errors.length ? 'failed' : 'technical-artifact-pass'
  if (existsSync(root) && statSync(root).isDirectory()) writeFileSync(join(root, 'artifact-verification.json'), `${JSON.stringify(report, null, 2)}\n`)
  return report
}

function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--output' || args[1].startsWith('--')) throw new Error('Usage: node deepblend/tools/verify-quality-benchmark.mjs --output <completed-run-directory>')
  const report = verifyBenchmark(args[1])
  console.log(JSON.stringify({ status: report.status, artisticReviewRequired: report.artisticReviewRequired,
    report: join(report.output, 'artifact-verification.json'), cases: report.cases.length,
    errors: report.errors, evidenceLimitations: report.evidenceLimitations }, null, 2))
  if (report.status !== 'technical-artifact-pass') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
