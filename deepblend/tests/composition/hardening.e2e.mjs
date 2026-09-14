#!/usr/bin/env node
/**
 * M5 hardening — "全部高风险操作受控", as an executable claim.
 *
 * WHY THIS EXISTS
 * ---------------
 * SPEC §20's M5 acceptance has five lines and four of them are about restriction:
 * no shell, no arbitrary Python, no creator tool, all high-risk operations
 * controlled. The first three are asserted by `contract/preset-surface.test.mjs`,
 * which checks the preset's ROW SET — a static property of a file.
 *
 * This suite is about the fourth, and it cannot be checked statically: a limit that
 * is CONFIGURED is not a limit that is ENFORCED. Every control below was measured
 * before it was asserted, and each pair of checks is two-sided on purpose — the
 * second one establishes that the first one is what made the difference:
 *
 *   A  the executable allowlist   refuses a PATH name outside it, and ALLOWS the
 *                                 same name once it is inside it, so the refusal is
 *                                 attributable to the allowlist and not to something
 *                                 else that happened to fail first;
 *   B  the deadline               stops a hung renderer at the deadline rather than
 *                                 at the renderer's own convenience, and the process
 *                                 is really gone afterwards (measured, not assumed);
 *   C  the capture cap            bounds what is kept from a child that floods
 *                                 stdout, whatever the child printed;
 *   D  the working directory      is removed when asked, and KEPT when asked — the
 *                                 second half is what makes the first meaningful;
 *   E  the sample ceilings        clamp and SAY SO, the tighter of the two budgets
 *                                 wins, and the preview ceiling is not applied to a
 *                                 delivery render;
 *   F  the workspace boundary     holds at the PRODUCT boundary, not only in the
 *                                 pure function: a symlinked project directory that
 *                                 points outside the root is refused.
 *
 * MEASURED BEFORE WRITTEN
 * -----------------------
 * Every number and code here was observed first. One of them corrected an assertion
 * that would have been wrong: a `grep` for the hung process appeared to find two
 * survivors, which looked like the deadline abandoning its child. It was the
 * checking pipeline matching its own command line. The process table is read in JS
 * below for exactly that reason.
 *
 * Run: node deepblend/tests/composition/hardening.e2e.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const PROJECT_ROOT = resolve(HERE, '..', '..', '..')
const BOOTSTRAP = join(PROJECT_ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-hardening-'))
const workspace = join(scratch, 'ws')
mkdirSync(workspace, { recursive: true })

/** A stand-in "Blender" that does whatever the case needs and nothing else. */
function fakeBlender(name, body) {
  const path = join(scratch, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** Mount one provider with exactly the configuration a case is about. */
async function providerWith(config) {
  const root = new Context()
  root.plugin(LocalSubprocess)
  root.plugin((await import('@deepblend/dsh-blender-provider-local')).default, {
    bootstrapPath: BOOTSTRAP,
    workspaceRoot: workspace,
    ...config,
  })
  await new Promise(settle => setTimeout(settle, 250))
  return root
}

// ---------------------------------------------------------------------------
// A. The executable allowlist
// ---------------------------------------------------------------------------
//
// `sh` is a real binary on PATH that is NOT in the provider's built-in allowlist
// (/Applications, /opt/homebrew/bin, /usr/local/bin, ~/Applications). Using a real
// binary rather than a fixture means the case cannot pass because the fixture is
// missing: resolution succeeds, and the allowlist is the thing that refuses it.

{
  const root = await providerWith({ blenderPath: 'sh' })
  try {
    const resolved = await root.get('blenderRuntime').resolveBlenderExecutable({})
    check('a PATH name outside the allowlist is refused, with a code that names the allowlist',
      resolved.resolved === null && resolved.error?.code === 'BLENDER_EXECUTABLE_OUTSIDE_ALLOWLIST',
      resolved.error?.code ?? resolved.resolved)
    check('and the refusal says how to permit it, rather than only that it refused',
      /executableAllowlist/.test(resolved.error?.message ?? ''), resolved.error?.message)
    check('and nothing was launched: the failure is decided before any process exists',
      resolved.resolved === null)
  } finally {
    await root.stop?.()
  }
}

{
  // The other half: permit `/bin` and the very same name gets through. Without this,
  // the refusal above could be attributed to anything.
  //
  // `getCapabilities` is documented never to throw for an ABSENT Blender, and it does
  // not: absence is resolved before any process exists and comes back as
  // `installed:false` plus a warning. A Blender that RUNS and fails is a different
  // thing, and that one throws — measured here before this assertion was written, and
  // written down because the distinction is easy to get backwards.
  const root = await providerWith({ blenderPath: 'sh', executableAllowlist: ['/bin', '/usr/bin'] })
  try {
    const runtime = root.get('blenderRuntime')
    const resolved = await runtime.resolveBlenderExecutable({})
    check('the same PATH name is permitted once its directory is allowlisted',
      resolved.resolved !== null && resolved.error === null, resolved.error?.code ?? resolved.resolved)

    let outcome = null
    try {
      const capabilities = await runtime.getCapabilities({ refresh: true })
      outcome = `installed:${String(capabilities.installed)}`
    } catch (error) {
      outcome = error?.code
    }
    check('and it then fails for a DIFFERENT reason — the allowlist was what refused it before',
      outcome !== null && outcome !== 'BLENDER_EXECUTABLE_OUTSIDE_ALLOWLIST', outcome)
  } finally {
    await root.stop?.()
  }
}

{
  // An operator's absolute path is a deliberate statement (SPEC §15.2), so it is
  // trusted even outside the allowlist. Asserted because the opposite reading —
  // "everything must be allowlisted" — would break the supported way of pointing
  // DeepBlend at a Blender it did not install.
  const root = await providerWith({ blenderPath: '/bin/sh' })
  try {
    const resolved = await root.get('blenderRuntime').resolveBlenderExecutable({})
    check('an absolute path is trusted as a deliberate operator choice, not allowlist-checked',
      resolved.resolved !== null && resolved.error === null, resolved.error?.code ?? resolved.resolved)
  } finally {
    await root.stop?.()
  }
}

// ---------------------------------------------------------------------------
// B. The deadline, and what happens to the process
// ---------------------------------------------------------------------------

const HANG_SECONDS = 30
const DEADLINE_MS = 1500
const hung = fakeBlender('hanging-blender', `sleep ${HANG_SECONDS}`)

{
  const root = await providerWith({ blenderPath: hung, timeoutMs: DEADLINE_MS })
  try {
    const startedAt = Date.now()
    let code = null
    try {
      await root.get('blenderRuntime').getCapabilities({ refresh: true })
    } catch (error) {
      code = error?.code
    }
    const elapsed = Date.now() - startedAt

    check('a renderer that never returns is stopped with a stable timeout code',
      code === 'BLENDER_TIMEOUT', code ?? '(no error)')
    // Two-sided: it waited for the deadline (not an instant failure), and it did not
    // wait for the child (30 s). A one-sided `< 30s` would pass if the deadline were
    // ignored and something else timed out first.
    check(`it stopped at the deadline (${DEADLINE_MS} ms), not at the child's own convenience (${HANG_SECONDS} s)`,
      elapsed >= DEADLINE_MS - 200 && elapsed < 10_000, `${elapsed} ms`)

    // The process table, read in JS rather than through a grep pipeline: a shell
    // one-liner that greps for this string also matches its own command line, which
    // is how a previous measurement of this very check produced a false positive.
    const listing = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', timeout: 20_000 })
    const survivors = listing.split('\n').filter(line => line.includes(hung))
    check('and the process is really gone, checked in the process table rather than assumed from the signal',
      survivors.length === 0, survivors)
  } finally {
    await root.stop?.()
  }
}

// ---------------------------------------------------------------------------
// C. The capture cap
// ---------------------------------------------------------------------------

const FLOOD_BYTES = 20000 * 41
const CAP_BYTES = 4096
const chatty = fakeBlender('chatty-blender',
  `i=0\nwhile [ $i -lt 20000 ]; do echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; i=$((i+1)); done`)

{
  const root = await providerWith({ blenderPath: chatty, maxOutputBytes: CAP_BYTES, timeoutMs: 20_000 })
  try {
    let kept = null
    try {
      await root.get('blenderRuntime').runBootstrap({ action: 'get_capabilities' }, {})
    } catch (error) {
      kept = typeof error?.detail?.stdout === 'string' ? error.detail.stdout.length : null
    }
    check('a child that floods stdout is reported without keeping what it printed',
      kept !== null && kept > 0, kept)
    check(`what is kept is bounded by maxOutputBytes (${CAP_BYTES}), not by the child (${FLOOD_BYTES} bytes)`,
      kept !== null && kept <= CAP_BYTES, { kept, printed: FLOOD_BYTES, cap: CAP_BYTES })
  } finally {
    await root.stop?.()
  }
}

// ---------------------------------------------------------------------------
// D. The working directory
// ---------------------------------------------------------------------------

const quickExit = fakeBlender('quick-blender', 'exit 0')

for (const keep of [false, true]) {
  const root = await providerWith({
    blenderPath: quickExit,
    keepWorkingDirectory: keep,
    timeoutMs: 10_000,
  })
  try {
    try {
      await root.get('blenderRuntime').runBootstrap({ action: 'get_capabilities' }, {})
    } catch {
      // The fake binary writes no result document; the case is about the working
      // directory, which is cleaned up on the failure path too.
    }
    const tmpRoot = join(workspace, 'tmp')
    const entries = existsSync(tmpRoot) ? readdirSync(tmpRoot).length : 0
    check(keep
      ? 'keepWorkingDirectory:true retains the directory, for a post-mortem'
      : 'keepWorkingDirectory:false leaves nothing behind, including on the failure path',
    keep ? entries > 0 : entries === 0, { keep, entries })
  } finally {
    await root.stop?.()
  }
}

// ---------------------------------------------------------------------------
// E. The sample ceilings (a real Blender, a 64x36 preview)
// ---------------------------------------------------------------------------

const PREVIEW_CEILING = 64

{
  const root = new Context()
  root.plugin(LocalSubprocess)
  root.plugin((await import('@deepblend/dsh-blender-provider-local')).default, {
    blenderPath: process.env.DEEPBLEND_BLENDER_PATH
      ?? join(PROJECT_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender'),
    bootstrapPath: BOOTSTRAP,
    workspaceRoot: workspace,
    timeoutMs: 180_000,
  })
  root.plugin((await import('@deepblend/dsh-blender-host')).default, {
    workspaceRoot: workspace,
    projectsRoot: join(workspace, 'projects'),
    maxPreviewSamples: PREVIEW_CEILING,
    maxFinalSamples: 128,
    serveCachedCapabilities: true,
  })
  await new Promise(settle => setTimeout(settle, 400))

  try {
    const studio = root.get('blenderStudio')
    const spec = JSON.parse(readFileSync(join(PROJECT_ROOT, 'deepblend', 'fixtures', 'interior-room', 'scene-spec.json'), 'utf8'))
    // 64x36 at 8 samples: this section is about the BUDGET, not about the picture, and
    // a tiny render is what keeps the suite inside a minute. `resolution` is a pair —
    // the profile schema is closed, and `width`/`height` are refused (which is how the
    // first version of this section failed).
    const tiny = (profile, maxSamplesBudget) => ({ ...profile, resolution: [64, 36], samples: 8, maxSamplesBudget })
    spec.renderProfiles = {
      preview: tiny(spec.renderProfiles.preview, 128),
      final: tiny(spec.renderProfiles.final, 1024),
    }

    const created = await studio.createProject({
      projectId: 'hardening-budget',
      title: 'Hardening budget',
      goal: 'Prove the sample ceilings are enforced and reported.',
      sceneSpec: spec,
      renderPreview: false,
    })
    check('a project exists to render a budgeted preview from', created.currentRevision === 'r0001', created.currentRevision)

    const preview = await studio.renderPreview({
      projectId: 'hardening-budget',
      revision: 'r0001',
      samples: 100000,
      cameraId: 'camera-main',
    })

    // `profile.samples` is what the RENDER used, taken from the artifact the run
    // produced — a stronger statement than reading back a request, and the reason
    // this is asserted on the return value rather than on the job record.
    check(`a preview asking for 100000 samples is clamped to the host ceiling of ${PREVIEW_CEILING}`,
      preview.profile?.samples === PREVIEW_CEILING, preview.profile?.samples)

    const reduced = (preview.warnings ?? []).find(entry => entry.code === 'RENDER_SAMPLES_REDUCED')
    check('and the clamp is REPORTED rather than silent', reduced !== undefined, (preview.warnings ?? []).map(entry => entry.code))
    check('and the report names both the number asked for and the number used',
      reduced?.detail?.requested === 100000 && reduced?.detail?.used === PREVIEW_CEILING,
      reduced?.detail)

    // The tighter of the profile's own budget and the host ceiling wins. `render.profile.set`
    // takes the WHOLE profile, because a patch operation replaces rather than merges.
    await studio.applyScenePatch({
      projectId: 'hardening-budget',
      baseRevision: 'r0001',
      operations: [{
        op: 'render.profile.set',
        profileName: 'preview',
        profile: { ...spec.renderProfiles.preview, maxSamplesBudget: 16 },
      }],
      note: 'hardening: a profile budget tighter than the host ceiling',
      // A checkpoint, because the next render needs one: with `saveCheckpoint:false`
      // and no earlier checkpoint to fall back on, the render is refused before the
      // budget is ever consulted ("compiled for rendering but produced no
      // checkpoint") — measured, and not what this section is about.
      saveCheckpoint: true,
    })
    const tighter = await studio.renderPreview({
      projectId: 'hardening-budget',
      revision: 'r0002',
      samples: 100000,
      cameraId: 'camera-main',
    })
    check('the TIGHTER of the profile budget and the host ceiling is the one that applies',
      tighter.profile?.samples === 16,
      { used: tighter.profile?.samples, profileBudget: 16, hostCeiling: PREVIEW_CEILING })

    // And the ceiling has a SCOPE: a delivery render must not be clamped by a budget
    // meant for previews, or a legitimate 256-spp delivery would silently become 64.
    //
    // This reads the profile the RENDERER was actually handed — `plan.json` in the job
    // directory, written by the provider before it spawns — rather than the job
    // record. The record is what the HOST believes; the plan is what the child was
    // told, and the two are different claims. (`request.json` beside it holds only the
    // protocol header, which is how the first version of this check read an empty
    // object and looked like a defect in the product.)
    const deliveryProfileOnDisk = jobId => JSON.parse(
      readFileSync(join(workspace, 'projects', 'hardening-budget', 'renders', jobId, 'plan.json'), 'utf8'),
    ).profile

    const delivery = await studio.startFinalRender({
      projectId: 'hardening-budget',
      revision: 'r0002',
      frames: [1],
      samples: 100000,
      cameraId: 'camera-main',
    })
    const handed = deliveryProfileOnDisk(delivery.jobId)
    check('a delivery render is bounded by maxFinalSamples, NOT by the preview ceiling',
      handed?.samples === 128,
      { handed: handed?.samples, maxFinalSamples: 128, previewCeiling: PREVIEW_CEILING })
    await studio.cancelJob({ projectId: 'hardening-budget', jobId: delivery.jobId, reason: 'hardening suite' })

    // The other direction, and the one that actually costs money: a caller who asks
    // for FEWER samples than the profile declares must get fewer. Nothing warns here
    // — nothing was reduced — so if the request ignored the caller, the render would
    // be more expensive than asked for and completely silent about it.
    const cheaper = await studio.startFinalRender({
      projectId: 'hardening-budget',
      revision: 'r0002',
      frames: [2],
      samples: 4,
      cameraId: 'camera-main',
    })
    const cheapened = deliveryProfileOnDisk(cheaper.jobId)
    check('an explicit LOWER sample count on a delivery render is honoured, not silently overridden',
      cheapened?.samples === 4,
      { handed: cheapened?.samples, profileSays: spec.renderProfiles.final.samples, requested: 4 })
    await studio.cancelJob({ projectId: 'hardening-budget', jobId: cheaper.jobId, reason: 'hardening suite' })
  } catch (cause) {
    check('the budget section completed without an unexpected throw', false, cause?.stack ?? String(cause))
  } finally {
    await root.stop?.()
  }
}

// ---------------------------------------------------------------------------
// F. The workspace boundary, at the product boundary
// ---------------------------------------------------------------------------
//
// `contract/store.test.mjs` exercises the pure guard. This is the same claim one
// layer up: a symlink INSIDE the projects root that points outside it must not become
// a way to read or write outside the workspace, and it must be refused by the code
// that a caller actually reaches.

{
  const projectsRoot = join(workspace, 'boundary-projects')
  mkdirSync(projectsRoot, { recursive: true })
  const outside = join(scratch, 'outside-the-workspace')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'project.json'), JSON.stringify({ projectId: 'outside-the-workspace' }))
  symlinkSync(outside, join(projectsRoot, 'sneaky-link'))

  const root = new Context()
  root.plugin(LocalSubprocess)
  root.plugin((await import('@deepblend/dsh-blender-provider-local')).default, {
    blenderPath: quickExit,
    bootstrapPath: BOOTSTRAP,
    workspaceRoot: workspace,
  })
  root.plugin((await import('@deepblend/dsh-blender-host')).default, {
    workspaceRoot: workspace,
    projectsRoot,
  })
  await new Promise(settle => setTimeout(settle, 300))

  try {
    const studio = root.get('blenderStudio')

    let symlinkCode = null
    try {
      await studio.getProject('sneaky-link')
    } catch (error) {
      symlinkCode = error?.code
    }
    check('a symlinked project directory that points outside the workspace is refused',
      symlinkCode === 'PATH_OUTSIDE_WORKSPACE', symlinkCode ?? '(read succeeded)')

    let traversalCode = null
    try {
      await studio.getProject('../outside-the-workspace')
    } catch (error) {
      traversalCode = error?.code
    }
    check('a project id containing a traversal token is refused as a segment, before any path is built',
      traversalCode === 'PATH_SEGMENT_INVALID', traversalCode ?? '(read succeeded)')
  } catch (cause) {
    check('the boundary section completed without an unexpected throw', false, cause?.stack ?? String(cause))
  } finally {
    await root.stop?.()
  }
}

// ---------------------------------------------------------------------------
// G. The mesh ceiling (SPEC §15.2 "Mesh 面数限制"), on geometry that really is heavy
// ---------------------------------------------------------------------------
//
// The count is MEASURED by the compile the revision would have been built from, so this
// case needs a real Blender and a scene whose geometry is genuinely large — a UV sphere
// with 128 segments and 64 rings is about 8 000 faces, which is over a ceiling of 5 000
// and far under the default two million. Both directions are asserted, because a ceiling
// that cannot be satisfied is not a ceiling, it is an outage.
{
  const heavy = JSON.parse(readFileSync(join(PROJECT_ROOT, 'deepblend', 'fixtures', 'interior-room', 'scene-spec.json'), 'utf8'))
  heavy.project = { ...heavy.project, id: 'hardening-heavy', title: 'Hardening heavy', goal: 'A scene with too much geometry.' }
  heavy.entities = [
    {
      id: 'dense-subject',
      type: 'generator',
      generator: { shape: 'uv_sphere', radius: 0.5, segments: 128, ringCount: 64 },
      materialId: heavy.materials[0].id,
      transform: { location: [0, 0, 0.5], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      tags: ['hero-product'],
    },
  ]
  heavy.cameras = [heavy.cameras[0]]
  heavy.animationTracks = []
  heavy.shots = []
  heavy.renderProfiles = {
    preview: { ...heavy.renderProfiles.preview, resolution: [64, 36], samples: 4, maxSamplesBudget: 64 },
    final: { ...heavy.renderProfiles.final, resolution: [64, 36], samples: 4, maxSamplesBudget: 64 },
  }

  /** Mount a host with one ceiling, over the real Blender. */
  const hostWith = async ceiling => {
    const root = new Context()
    root.plugin(LocalSubprocess)
    root.plugin((await import('@deepblend/dsh-blender-provider-local')).default, {
      blenderPath: process.env.DEEPBLEND_BLENDER_PATH
        ?? join(PROJECT_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender'),
      bootstrapPath: BOOTSTRAP,
      workspaceRoot: workspace,
      timeoutMs: 300_000,
    })
    root.plugin((await import('@deepblend/dsh-blender-host')).default, {
      workspaceRoot: workspace,
      projectsRoot: join(workspace, 'weight-projects'),
      maxMeshPolygons: ceiling,
      serveCachedCapabilities: true,
    })
    await new Promise(settle => setTimeout(settle, 400))
    return root
  }

  const tight = await hostWith(5_000)
  try {
    const studio = tight.get('blenderStudio')
    let refusal = null
    try {
      await studio.createProject({ projectId: 'hardening-heavy', title: 'Heavy', goal: 'too much geometry', sceneSpec: heavy, saveCheckpoint: true })
    } catch (error) {
      refusal = error
    }

    check('a scene above maxMeshPolygons is refused with a coded result, not a crash',
      refusal?.code === 'SCENE_TOO_HEAVY', refusal?.code ?? 'the project was created anyway')
    check('and the refusal names the measured count and the ceiling it broke',
      /polygons/.test(refusal?.message ?? '') && /5,000|5000/.test(refusal?.message ?? ''),
      (refusal?.message ?? 'no message').slice(0, 140))

    // ON DISK, not through the facade. The first version of this check called `getProject`
    // and treated any throw as absence — which it was not: MEASURED, the refused create had
    // left a skeleton behind whose record said `revisionCount: 0`, reading it threw
    // `REVISION_ID_INVALID`, and recreating the id threw `PROJECT_EXISTS`. The check PASSED
    // while the claim in its own name was false. A directory listing cannot be satisfied by
    // the wrong exception.
    const directory = join(workspace, 'weight-projects', 'hardening-heavy')
    check('and nothing was left behind: the refused create removed the project it had begun',
      !existsSync(directory), existsSync(directory) ? readdirSync(directory).join(', ') : 'absent')
  } catch (cause) {
    check('the weight section completed without an unexpected throw', false, cause?.stack ?? String(cause))
  } finally {
    await tight.stop?.()
  }

  const generous = await hostWith(2_000_000)
  try {
    const studio = generous.get('blenderStudio')
    const created = await studio.createProject({
      projectId: 'hardening-heavy',
      title: 'Heavy',
      goal: 'the same geometry, under a ceiling it fits',
      sceneSpec: heavy,
      saveCheckpoint: false,
    })
    check('the same geometry commits unchanged under a ceiling it fits under',
      created?.project?.projectId === 'hardening-heavy' || created?.projectId === 'hardening-heavy',
      JSON.stringify(created).slice(0, 120))
  } catch (cause) {
    check('the weight section completed without an unexpected throw', false, cause?.stack ?? String(cause))
  } finally {
    await generous.stop?.()
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

rmSync(scratch, { recursive: true, force: true })

const passed = results.filter(entry => entry.ok).length
console.log(`\nM5 hardening: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
process.exit(0)
