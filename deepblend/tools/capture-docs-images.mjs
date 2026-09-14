#!/usr/bin/env node
/**
 * Capture the README's pictures, from the running product.
 *
 * WHY THIS IS A TOOL AND NOT THREE FILES IN A FOLDER
 * -------------------------------------------------
 * A screenshot in a README is a claim: "this is what the thing looks like". Nothing in
 * this repository could check such a claim before this tool existed, and the failure mode
 * is quiet — a screenshot of a page that failed to render is a perfectly valid PNG. So the
 * pictures are PRODUCED by a committed tool, from a real `dsh web`, a real Chrome and a
 * real Blender, on a project built by clicking the same controls `usage.md` tells a user to
 * click; and `contract/docs-images.test.mjs` checks the result: every file decodes, its
 * digest matches the manifest, and each picture is a picture rather than a blank page.
 *
 * WHAT IT DRIVES
 * --------------
 *   create a project by typing a title        → the Projects view
 *   apply a scene patch by typing JSON        → the Scene view, two new revisions
 *   render a preview (real Blender, real PNG) → the Preview view, a contact sheet
 *   patch it again and render again           → the before/after compare
 *   copy the contact sheet out of the store   → the artifact itself, halved in size
 *
 * Every one of those is a `data-action` the client half registers. If a control is renamed
 * this tool fails at the click, instead of silently publishing a picture of a page that no
 * longer offers it — the other half of why it is a tool.
 *
 * THE SCENE, AND WHY IT LOOKS LIKE THE FIXTURE
 * --------------------------------------------
 * The demo is a 0.2 m brushed-steel monolith on a matte plinth with a lit dial and a
 * signal ring, over four cameras with four roles. Its proportions and its three-point
 * lighting are the ones `fixtures/product-turntable` was built and scored with — a recipe
 * that scores 100 in the visual loop at this object scale — rather than wattages invented
 * here. The first version of this tool did invent them, at the SCAFFOLD's scale: the
 * default subject is a 2-metre cube, so four area lights and a camera 0.6 m away produced
 * seven pictures of the inside of a white box. The camera had to be re-aimed and the cube
 * removed in that order too (`PATCH_TARGET_IN_USE`), which is why both patches are DRY-RUN
 * against the project's own SceneSpec before they are submitted: a bad demo patch fails
 * here, with a contract error code, rather than as a red box inside a screenshot of the
 * documentation.
 *
 * Run: node deepblend/tools/capture-docs-images.mjs
 *      node deepblend/tools/capture-docs-images.mjs --out deepblend/docs/images
 *
 * REPRODUCIBLE IN CONTENT, NOT IN BYTES
 * -------------------------------------
 * Two of the three pictures embed a clock — the compare panes carry their render times and
 * the sheet carries the UTC time it was composed — so re-running this tool produces the
 * same pictures with different digests. `workbench-scene.png` carries no clock, and two
 * runs produced it byte-identical (measured; `milestone-status.md` §24). The manifest
 * therefore records the digests of the capture that is ON DISK, which is what makes it
 * useful for noticing a hand-edit; it is not a claim that the next run would match.
 *
 * Owner: DeepBlend Studio — M5
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { applyPatchToSpec, decodePng, encodePng } from '@deepblend/dsh-blender-contracts'

import { Browser } from './browser-driver.mjs'
import { REPO_ROOT, dismissFirstRunDialogs, startWeb, storePatch } from './dsh-web-harness.mjs'

const OUT = (() => {
  const flag = process.argv.indexOf('--out')
  return resolve(flag === -1 ? join(REPO_ROOT, 'deepblend', 'docs', 'images') : process.argv[flag + 1])
})()

/** The viewport every picture is taken at, and the scale factor it is taken with. */
const VIEWPORT = { width: 1500, height: 950, deviceScaleFactor: 2 }

/**
 * How much the published contact sheet is shrunk.
 *
 * The sheet Blender composes is 2952x1812 and 2 MB of PNG. A README is not the place for
 * 2 MB, and a box filter is deterministic, so the halving is done here rather than by hand:
 * `decodePng` box-averages 2x2 blocks and `encodePng` writes the result, which is the same
 * code path the product uses to compose sheets in the first place.
 */
const SHEET_SHRINK = 2

const PROJECT_TITLE = 'product-turntable'
const PROJECT_GOAL = '一把钢制小物件的产品转台：深色台面、一圈发光环、四视角预览。'

/** `{ location, rotationEuler, scale }` with a default orientation and scale. */
const LOCATION = (x, y, z) => ({ location: [x, y, z], rotationEuler: [0, 0, 0], scale: [1, 1, 1] })

/** A generated entity, so the patch below reads as the shape of the object. */
const GENERATOR = (id, generator, materialId, transform, tags) => ({ id, type: 'generator', generator, materialId, transform, tags })

const log = []
function step(message) {
  log.push(message)
  console.log(`── ${message}`)
}

/**
 * The scene the demo project is built into, as an ordinary ScenePatch.
 *
 * Written out rather than generated, so a reader can see exactly what a person would type
 * into the workbench's patch box — and the dry run is what keeps it honest when the
 * vocabulary or the scaffold changes underneath it.
 */
const DEMO_PATCH = [
  // ORDER MATTERS, and the dry run is what enforces it: the scaffold's camera aims at the
  // scaffold's cube, so the camera must stop aiming at it before the cube can be removed
  // (PATCH_TARGET_IN_USE). Every operation here is one a person would type.
  { op: 'camera.update', cameraId: 'camera-main', role: 'active-camera', lens: 50, transform: LOCATION(0, -0.78, 0.2), targetPoint: [0, 0, 0.1] },
  { op: 'entity.remove', entityId: 'subject' },

  { op: 'material.add', material: { id: 'hero-steel', shader: 'principled', parameters: { baseColor: [0.5, 0.525, 0.56, 1], metallic: 0.9, roughness: 0.24 } } },
  { op: 'material.add', material: { id: 'stage-matte', shader: 'principled', parameters: { baseColor: [0.05, 0.053, 0.06, 1], metallic: 0, roughness: 0.5 } } },
  { op: 'material.add', material: { id: 'accent-signal', shader: 'emission', parameters: { emissionColor: [0.16, 0.72, 1, 1], emissionStrength: 5 } } },

  // A 6 m floor, so the object stands on something rather than floating in black.
  { op: 'entity.add', entity: GENERATOR('stage', { shape: 'plane', size: 6 }, 'stage-matte', LOCATION(0, 0, 0), ['environment']) },
  { op: 'entity.add', entity: GENERATOR('monolith', { shape: 'rounded_box', size: 0.2, bevel: { width: 0.01, segments: 4 } }, 'hero-steel', { location: [0, 0, 0.128], rotationEuler: [0, 0, 0], scale: [0.8, 0.5, 1] }, ['hero-product']) },
  { op: 'entity.add', entity: GENERATOR('dial', { shape: 'cylinder', radius: 0.035, depth: 0.005, segments: 64 }, 'accent-signal', { location: [0, -0.051, 0.152], rotationEuler: [1.5707963, 0, 0], scale: [1, 1, 1] }, ['hero-product', 'detail', 'subject-part']) },
  { op: 'entity.add', entity: GENERATOR('plinth', { shape: 'cylinder', radius: 0.13, depth: 0.028, segments: 96 }, 'stage-matte', LOCATION(0, 0, 0.014), ['environment']) },
  { op: 'entity.add', entity: GENERATOR('signal-ring', { shape: 'torus', majorRadius: 0.17, minorRadius: 0.0022, segments: 96, ringCount: 24 }, 'accent-signal', LOCATION(0, 0, 0.0015), ['environment']) },

  // Three-point lighting, at the numbers the product-turntable fixture was lit with.
  { op: 'light.update', lightId: 'key-light', transform: LOCATION(0.75, -1.05, 0.85), energy: 72, color: [1, 0.97, 0.93, 1], size: 0.9 },
  { op: 'light.add', light: { id: 'fill-light', type: 'area', transform: LOCATION(-1.1, -0.7, 0.45), energy: 19.2, color: [0.82, 0.88, 1, 1], size: 1.4 } },
  { op: 'light.add', light: { id: 'rim-light', type: 'area', transform: LOCATION(-0.35, 1.05, 0.7), energy: 48, color: [1, 0.93, 0.86, 1], size: 0.8 } },

  // Four camera ROLES, which is what makes a view plan reproducible rather than positional
  // (SPEC §12.3): the active view, a 45-degree reading, a top-down and a detail close-up.
  { op: 'camera.add', camera: { id: 'camera-3q', role: 'three-quarter', lens: 50, transform: LOCATION(0.55, -0.55, 0.3), targetPoint: [0, 0, 0.1] } },
  { op: 'camera.add', camera: { id: 'camera-top', role: 'top', lens: 50, transform: LOCATION(0, -0.02, 1.1), targetPoint: [0, 0, 0.05] } },
  { op: 'camera.add', camera: { id: 'camera-detail', role: 'detail', lens: 110, transform: LOCATION(0.18, -0.42, 0.26), targetPoint: [0, -0.02, 0.14] } },

  {
    op: 'animation.track.set',
    track: {
      id: 'turntable',
      targetEntityId: 'monolith',
      property: 'rotationEuler.z',
      keyframes: [
        { frame: 1, value: 0, interpolation: 'linear' },
        { frame: 45, value: 3.14159265, interpolation: 'linear' },
        { frame: 90, value: 6.28318531, interpolation: 'linear' },
      ],
    },
  },
  { op: 'project.frameRange.set', frameStart: 1, frameEnd: 90, fps: 30 },
  // 540p at 64 samples: the contact sheet is published in a README, so it has to be
  // legible, and this stays under half a minute of Cycles per preview on the machine this
  // was written on.
  {
    op: 'render.profile.set',
    profileName: 'preview',
    profile: {
      engine: 'cycles',
      resolution: [960, 540],
      samples: 64,
      filmTransparent: false,
      colorManagement: { viewTransform: 'Standard' },
      maxSamplesBudget: 256,
    },
  },
]

/**
 * The second patch: two visible changes, so the before/after compare has two pictures
 * worth comparing. A sharper highlight on the body and a dimmer signal ring.
 */
const SECOND_PATCH = [
  { op: 'material.parameter.update', materialId: 'hero-steel', parameter: 'roughness', value: 0.06 },
  { op: 'material.parameter.update', materialId: 'accent-signal', parameter: 'emissionStrength', value: 1.1 },
]

/** Wait until a selector matches, or fail with the step that was waiting. */
async function waitFor(page, expression, label, timeoutMs = 60000) {
  try {
    await page.waitFor(expression, timeoutMs)
  } catch (error) {
    throw new Error(`while waiting for ${label}: ${error.message}`)
  }
}

/**
 * Click something that produces a result line, and wait for the line to CHANGE.
 *
 * Only the active view is mounted, so the selector matches at most one node — but the
 * result of the previous click is still there, and `waitFor(node !== null)` would return
 * instantly on that OLD one. Waiting for different text is what makes the wait mean "this
 * click was answered".
 *
 * @param {import('./browser-driver.mjs').BrowserPage} page
 * @returns {Promise<string|null>} the new result text
 */
async function clickForResult(page, selector, clickSelector, label, timeoutMs = 120000) {
  const before = await page.text(selector)
  await page.click(clickSelector)
  await waitFor(
    page,
    `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node !== null && node.textContent !== ${JSON.stringify(before)} })()`,
    label,
    timeoutMs,
  )
  const after = await page.text(selector)
  if ((await page.count('[data-result="error"]')) > 0) {
    throw new Error(`${label} reported an error: ${(after ?? '').replace(/\s+/g, ' ')}`)
  }
  return after
}

/** Read a project file out of the store, or null. */
function storeJson(store, ...segments) {
  const path = join(store, 'projects', ...segments)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Submit a patch through the workbench's own patch box. */
async function submitPatch(page, store, projectId, operations, label) {
  const current = storeJson(store, projectId, 'project.json')?.currentRevision
  const spec = storeJson(store, projectId, 'revisions', current, 'scene-spec.json')
  if (spec === null || spec === undefined) throw new Error(`no SceneSpec at ${projectId}/${current}`)

  // Dry-run first. An invalid demo patch should fail HERE, with the contract layer's own
  // error code, rather than as a red box that ends up inside a screenshot of the docs.
  try {
    applyPatchToSpec(spec, { projectId, baseRevision: current, operations })
  } catch (error) {
    throw new Error(`the ${label} patch is not valid against ${projectId}@${current}: ${error.message}`)
  }

  await page.fill('[data-field="scene-patch"]', JSON.stringify({ baseRevision: current, operations }, null, 2))
  const result = await clickForResult(page, '[data-result]', '[data-action="apply-patch"]', `the ${label} patch to commit`, 300000)
  if (!/已提交/.test(result ?? '')) throw new Error(`the ${label} patch did not commit: ${result}`)
  step(`${label} patch committed — ${(result ?? '').replace(/\s+/g, ' ').slice(0, 70)}`)
}

/** Render a preview through the panel and wait for the panel to report it. */
async function renderPreview(page, label) {
  // Seven views at 960x540 and 64 samples is tens of seconds of Cycles, so this is the one
  // wait that is deliberately generous.
  const result = await clickForResult(page, '[data-result]', '[data-action="render-preview"]', `the ${label} preview`, 900000)
  step(`${label} preview — ${(result ?? '').replace(/\s+/g, ' ').slice(0, 90)}`)
}

/** PNG dimensions, straight out of the IHDR chunk. */
function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** Box-average a 2x2 block per output pixel. Deterministic, and no resampling kernel. */
function halve(image) {
  const width = Math.floor(image.width / 2)
  const height = Math.floor(image.height / 2)
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        let sum = 0
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            sum += image.data[((y * 2 + dy) * image.width + (x * 2 + dx)) * 4 + channel]
          }
        }
        data[(y * width + x) * 4 + channel] = Math.round(sum / 4)
      }
    }
  }
  return { width, height, data }
}

/** Screenshot the viewport and record what makes it checkable later. */
async function capture(page, file, kind, note) {
  const path = join(OUT, file)
  await page.screenshot(path)
  const bytes = readFileSync(path)
  const { width, height } = pngSize(bytes)
  step(`captured ${file} — ${width}x${height}, ${(bytes.length / 1024).toFixed(0)} KiB`)
  return { file, kind, note, width, height, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Record an image this tool wrote rather than screenshotted. */
function record(file, kind, note) {
  const bytes = readFileSync(join(OUT, file))
  const { width, height } = pngSize(bytes)
  return { file, kind, note, width, height, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-docs-images-'))
const store = join(scratch, 'store')
let server = null
let browser = null

try {
  mkdirSync(OUT, { recursive: true })
  step(`capturing into ${OUT}`)

  server = await startWeb({ workspacePath: REPO_ROOT, patch: await storePatch(store), keepHome: true })
  step(`a real dsh web on ${server.url.split('?')[0]} (store ${store})`)

  browser = await Browser.launch({ args: [`--window-size=${VIEWPORT.width},${VIEWPORT.height}`] })
  const page = await browser.newPage('about:blank')
  await page.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, mobile: false })
  await page.goto(server.url)
  await dismissFirstRunDialogs(page)
  step('a real Chrome on the real page')

  const images = []

  // -------------------------------------------------------------------------
  // The documented flow, clicked
  // -------------------------------------------------------------------------
  await waitFor(page, 'document.querySelector("button[aria-label=\\"Blender\\"]") !== null', 'the sidebar entry')
  await page.click('button[aria-label="Blender"]')
  await waitFor(page, 'document.querySelector("[data-deepblend-panel=deepblend]") !== null', 'the workbench panel')
  await waitFor(page, 'document.querySelector(\'[data-action="create-project"]\') !== null', 'the create control')

  await page.fill('[data-field="project-title"]', PROJECT_TITLE)
  await page.fill('[data-field="project-goal"]', PROJECT_GOAL)
  const created = await clickForResult(page, '[data-result]', '[data-action="create-project"]', 'the project to be created', 300000)
  step(`project created through the UI — ${(created ?? '').replace(/\s+/g, ' ').slice(0, 60)}`)

  await page.click('[data-view-tab="scene"]')
  await waitFor(page, 'document.querySelector(\'[data-field="scene-patch"]\') !== null', 'the patch box')
  await submitPatch(page, store, PROJECT_TITLE, DEMO_PATCH, 'demo scene')
  await submitPatch(page, store, PROJECT_TITLE, SECOND_PATCH, 'refinement')

  await page.click('[data-view-tab="preview"]')
  await waitFor(page, 'document.querySelector(\'[data-view="preview"]\') !== null', 'the Preview view')
  await renderPreview(page, 'first')
  await renderPreview(page, 'second')
  await waitFor(page, `document.querySelectorAll('[data-compare] img').length >= 1`, 'the compare panes', 60000)
  await new Promise(settle => setTimeout(settle, 2500))

  images.push(await capture(page, 'preview-compare.png', 'preview-compare',
    'the Preview view after two renders: 本次渲染 beside 上一次渲染, each pane keyed on its own digest'))

  await page.click('[data-view-tab="scene"]')
  await waitFor(page, 'document.querySelector(\'[data-view="scene"]\') !== null', 'the Scene view')
  await new Promise(settle => setTimeout(settle, 800))
  images.push(await capture(page, 'workbench-scene.png', 'workbench-scene',
    'the workbench: the project header with its current revision, and the Scene tree the Host serves'))

  // -------------------------------------------------------------------------
  // The rendered artifact itself, copied out of the project store
  // -------------------------------------------------------------------------
  const revision = storeJson(store, PROJECT_TITLE, 'project.json')?.currentRevision
  const sheets = join(store, 'projects', PROJECT_TITLE, 'revisions', revision, 'contact-sheets')
  if (!existsSync(sheets)) throw new Error(`no contact-sheets directory under ${sheets}`)
  const sheet = 'preview-current.png'
  if (!existsSync(join(sheets, sheet))) throw new Error(`${sheet} is not in ${sheets}: ${readdirSync(sheets).join(', ')}`)

  const original = decodePng(readFileSync(join(sheets, sheet)))
  const shrunk = halve(original)
  writeFileSync(join(OUT, 'render-contact-sheet.png'), encodePng(shrunk))
  step(`copied ${sheet} out of the store — ${original.width}x${original.height} → ${shrunk.width}x${shrunk.height}`)
  images.push(record('render-contact-sheet.png', 'render-contact-sheet',
    `the artifact itself: the contact sheet Blender composed for ${revision}, box-averaged ${SHEET_SHRINK}x from the ${original.width}x${original.height} file in the project store`))

  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({
    note: 'Produced by deepblend/tools/capture-docs-images.mjs. Checked by deepblend/tests/contract/docs-images.test.mjs — do not edit these files by hand; re-run the tool.',
    tool: 'deepblend/tools/capture-docs-images.mjs',
    viewport: VIEWPORT,
    project: { id: PROJECT_TITLE, goal: PROJECT_GOAL, revision },
    images,
  }, null, 2)}\n`)

  step(`wrote ${images.length} image(s) and manifest.json`)
  for (const image of images) {
    console.log(`   ${image.file.padEnd(26)} ${image.width}x${image.height}  ${(image.bytes / 1024).toFixed(0)} KiB  ${image.sha256.slice(0, 12)}`)
  }
} finally {
  if (browser !== null) await browser.close().catch(() => {})
  if (server !== null) await server.stop().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}
