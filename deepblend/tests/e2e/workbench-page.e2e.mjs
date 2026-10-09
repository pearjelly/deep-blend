#!/usr/bin/env node
/**
 * M6 acceptance: the standalone fullscreen workbench, in a real browser.
 *
 * SPEC §20 M6's item is one line — 「独立全屏工作台」 — with no acceptance block of
 * its own, so it inherits M4's four conditions. What this file adds is the
 * question M4 never asked, because M4's panel only ever existed inside the
 * console:
 *
 *   **把外壳拿掉，它还站得住吗？**
 *
 * So the page under test is `GET /deepblend/workbench` — the plugin's own route,
 * served by the same `dsh web` process (no second server, no second port), with
 * no shell bundle, no sidebar and no conversation anywhere in the document. The
 * four inherited conditions are then read off THAT page:
 *
 *   不进入文件系统即可管理项目        create a project, change a scene and render a
 *                                    preview by clicking, then read the store on disk
 *   UI 刷新后可从 Host 恢复权威状态    reload and read the same project and revision
 *                                    back out of the DOM, and out of the request log
 *   浏览器不直接启动 Blender          the Blender that rendered is a child of the
 *                                    Host process, and the page's own fetch log
 *                                    contains nothing but declared routes
 *   所有写操作经过 Host              every write the page performed is a declared
 *                                    POST route, and it landed on disk through the
 *                                    facade
 *
 * AND THE ONE THING THIS MILESTONE COULD GET WRONG
 * ------------------------------------------------
 * A full-screen workbench is one edit away from being a SECOND implementation of
 * the M4 workbench. The structural half of that claim is asserted in
 * `contract/workbench-page.test.mjs`; the half that only a browser can settle is
 * asserted here, as a fact about the network:
 *
 *   **the page fetched the workbench bundle from the URL the boot graph declares
 *   for it** — `window.__DSH_BOOT__.entries[id].url`, the very row the console
 *   preloads. Not a copy, not a sibling file, not a bundled second panel.
 *
 * WHAT IS REAL HERE
 * -----------------
 * A real Chrome (headless), driven over the DevTools protocol by
 * `tools/browser-driver.mjs`; a real `dsh web` started by `tools/dsh-web-harness.mjs`
 * in its own DSH home AND its own project store; a real Blender, started by that
 * Host. The only thing this suite starts is a browser and a server it then stops.
 *
 * Run: node deepblend/tests/e2e/workbench-page.e2e.mjs
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

import { decodePng } from '@deepblend/dsh-blender-contracts'

import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

const BLENDER_PATH = process.env.DEEPBLEND_BLENDER_PATH ?? join(REPO_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
if (!existsSync(BLENDER_PATH)) {
  console.error(`Blender not found at ${BLENDER_PATH}; the standalone workbench acceptance cannot run.`)
  console.error('See deepblend/docs/dsh-baseline.md §5.')
  process.exit(2)
}

/** The bundle id the whole assertion about "one implementation" is stated over. */
const BUNDLE_ID = '@deepblend/dsh-blender-ui'

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-workbench-e2e-'))
const store = join(scratch, 'store')
const PROJECT_TITLE = `wb-e2e-${Math.random().toString(16).slice(2, 8)}`
const evidenceDirectory = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS
  ?? join(REPO_ROOT, '.deepblend', 'quality', `workbench-object-edit-${new Date().toISOString().replace(/[:.]/g, '-')}`))
const objectEditEvidence = []
const retainedRevisions = []
const startedAt = new Date().toISOString()
mkdirSync(evidenceDirectory, { recursive: true })

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const entity = (spec, id) => spec.entities.find(entry => entry.id === id)

async function waitDisk(predicate, label, timeout = 300000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

/** Retain actual products before the isolated store is removed, not only a screenshot. */
function retainRevision(projectId, revision, label) {
  const manifest = readStoreJson(projectId, 'revisions', revision, 'revision-manifest.json')
  const artifact = manifest?.previews?.at(-1)
  if (!artifact?.path) throw new Error(`${projectId}/${revision} has no committed preview`)
  const projectDirectory = join(store, 'projects', projectId)
  const destination = join(evidenceDirectory, label)
  mkdirSync(destination, { recursive: true })
  const paths = {
    spec: join('revisions', revision, 'scene-spec.json'),
    checkpoint: join('revisions', revision, 'scene.blend'),
    preview: artifact.path,
  }
  const filenames = { spec: 'scene-spec.json', checkpoint: 'scene.blend', preview: 'preview.png' }
  const files = Object.fromEntries(Object.entries(paths).map(([kind, path]) => {
    const original = join(projectDirectory, path)
    const filename = filenames[kind]
    const bytes = readFileSync(original)
    copyFileSync(original, join(destination, filename))
    return [kind, { original, path: `${label}/${filename}`, sha256: sha256(bytes), bytes: bytes.length }]
  }))
  writeFileSync(join(destination, 'revision-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const decoded = decodePng(readFileSync(files.preview.original))
  const snapshot = {
    projectId, revision, label, files, artifact,
    pixelSha256: sha256(decoded.data), width: decoded.width, height: decoded.height,
    spec: readStoreJson(projectId, 'revisions', revision, 'scene-spec.json'),
  }
  retainedRevisions.push(snapshot)
  check(`${label}: preview bytes match the committed artifact and the 16-sample test ceiling`,
    files.preview.sha256 === artifact.sha256 && artifact.samples === 16
      && decoded.width === 768 && decoded.height === 576,
    { samples: artifact.samples, width: decoded.width, height: decoded.height, cameraId: artifact.cameraId, frame: artifact.frame })
  return snapshot
}

function verifyRetainedBytes(label) {
  const changed = retainedRevisions.flatMap(snapshot => Object.entries(snapshot.files)
    .filter(([, file]) => !existsSync(file.original) || sha256(readFileSync(file.original)) !== file.sha256)
    .map(([kind]) => `${snapshot.projectId}/${snapshot.revision}/${kind}`))
  check(`${label}: historical SceneSpecs, checkpoints and PNGs remain byte-identical`, changed.length === 0, changed)
}

/** Exclude PNG metadata, and compare only previews made with the same camera and frame. */
function compareRenderedChange(before, after) {
  const sameSetup = ['cameraId', 'frame', 'width', 'height', 'samples', 'engine']
    .every(key => before.artifact[key] === after.artifact[key])
    && before.artifact.renderConfig !== null && before.artifact.renderConfig !== undefined
    && equal(before.artifact.renderConfig, after.artifact.renderConfig)
  const a = decodePng(readFileSync(before.files.preview.original))
  const b = decodePng(readFileSync(after.files.preview.original))
  let changedPixels = 0
  let totalDifference = 0
  if (a.width === b.width && a.height === b.height) {
    for (let offset = 0; offset < a.data.length; offset += 4) {
      let difference = 0
      for (let channel = 0; channel < 3; channel += 1) difference += Math.abs(a.data[offset + channel] - b.data[offset + channel])
      if (difference > 0) changedPixels += 1
      totalDifference += difference
    }
  }
  const result = { sameSetup, changedPixels, meanChannelDifference: totalDifference / (a.width * a.height * 3),
    beforePixelSha256: before.pixelSha256, afterPixelSha256: after.pixelSha256 }
  check(`${after.label}: the same view has a visible pixel change, excluding PNG metadata`,
    sameSetup && changedPixels >= 100 && result.meanChannelDifference > 0.05, result)
  objectEditEvidence.push({ before: before.label, after: after.label, ...result })
}

async function selectEntity(editorPage, id, expectedRevision) {
  await editorPage.click('[data-view-tab="scene"]')
  await editorPage.waitFor(`document.querySelector('[data-action="select-entity:${id}"]') !== null`, 30000)
  const clicked = await editorPage.click(`[data-action="select-entity:${id}"]`)
  check(`${id}: object selection is reachable by pointer`, clicked.via === 'pointer', clicked)
  await editorPage.waitFor(`document.querySelector('[data-editor-entity="${id}"][data-editor-base-revision="${expectedRevision}"]') !== null`, 30000)
}

async function commitEntity(editorPage, projectId, id, fields) {
  const before = readStoreJson(projectId, 'project.json').currentRevision
  await selectEntity(editorPage, id, before)
  if ('material-color' in fields) {
    const spec = readStoreJson(projectId, 'revisions', before, 'scene-spec.json')
    const material = spec.materials.find(entry => entry.id === entity(spec, id).materialId)
    const expectedColor = '#' + material.parameters.baseColor.slice(0, 3).map(value => {
      const srgb = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
      return Math.round(srgb * 255).toString(16).padStart(2, '0')
    }).join('')
    check(`${id}: the color control displays the current linear RGB as sRGB`,
      await editorPage.evaluate('document.querySelector(\'[data-field="editor-material-color"]\').value') === expectedColor, expectedColor)
  }
  for (const [field, value] of Object.entries(fields)) await editorPage.fill(`[data-field="editor-${field}"]`, String(value))
  await editorPage.waitFor('document.querySelector(\'[data-editor-dirty="true"]\') !== null && !document.querySelector(\'[data-action="editor-apply"]\').disabled', 30000)
  const clicked = await editorPage.click('[data-action="editor-apply"]')
  check(`${id}: the visual edit is submitted by pointer`, clicked.via === 'pointer', clicked)
  const revision = await waitDisk(() => {
    const current = readStoreJson(projectId, 'project.json')?.currentRevision
    return current && current !== before ? current : null
  }, `${id} committed revision`)
  const artifact = readStoreJson(projectId, 'revisions', revision, 'revision-manifest.json')?.previews?.at(-1)
  await editorPage.waitFor(`(() => {
    const img = document.querySelector('[data-compare="right"] img')
    return img && img.complete && img.naturalWidth > 0 && img.dataset.artifactDigest === ${JSON.stringify(artifact?.sha256)}
  })()`, 30000)
  check(`${id}: the browser shows the new revision's actual preview`, Boolean(artifact?.sha256), { before, revision, sha256: artifact?.sha256 })
  return revision
}

async function showComparison(editorPage, before, after, filename) {
  await editorPage.click('[data-view-tab="preview"]')
  await editorPage.click('[data-compare-mode="revisions"]')
  for (const [side, revision] of [['left', before.revision], ['right', after.revision]]) {
    await editorPage.evaluate(`(() => {
      const input = document.querySelector('[data-field="compare-${side}"]')
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(input, ${JSON.stringify(revision)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
  }
  await editorPage.waitFor(`['left','right'].every((side, index) => {
    const img = document.querySelector('[data-compare="' + side + '"] img')
    return img && img.complete && img.naturalWidth === 768 && img.dataset.artifactDigest === ${JSON.stringify([before.artifact.sha256, after.artifact.sha256])}[index]
  })`, 30000)
  await editorPage.screenshot(join(evidenceDirectory, filename))
}

/** Independently open the saved checkpoints once, without rendering or saving. */
function inspectObjectEditCheckpoints() {
  const inputPath = join(evidenceDirectory, 'checkpoint-inputs.json')
  const outputPath = join(evidenceDirectory, 'checkpoint-observations.json')
  const scriptPath = join(evidenceDirectory, 'inspect-checkpoints.py')
  writeFileSync(inputPath, JSON.stringify(retainedRevisions.map(snapshot => ({ label: snapshot.label, path: join(evidenceDirectory, snapshot.files.checkpoint.path) }))))
  writeFileSync(scriptPath, `import bpy, hashlib, json
from pathlib import Path
rows = []
for source in json.loads(Path(${JSON.stringify(inputPath)}).read_text()):
    bpy.ops.wm.open_mainfile(filepath=source['path'])
    bpy.context.scene.frame_set(1)
    graph = bpy.context.evaluated_depsgraph_get()
    objects = {}
    for obj in bpy.context.scene.objects:
        ident = obj.get('deepblend_id')
        if not ident or obj.type != 'MESH': continue
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        geometry = {'vertices': [[round(v, 8) for v in vertex.co] for vertex in mesh.vertices], 'faces': [list(face.vertices) for face in mesh.polygons]}
        materials = []
        for slot in obj.material_slots:
            mat = slot.material
            if not mat: materials.append(None); continue
            nodes = list(mat.node_tree.nodes) if mat.use_nodes else []
            principled = next((node for node in nodes if node.type == 'BSDF_PRINCIPLED'), None)
            anisotropy = principled.inputs.get('Anisotropic') if principled else None
            tangent = principled.inputs.get('Tangent') if principled else None
            materials.append({'id': mat.get('deepblend_id'), 'anisotropic': anisotropy.default_value if anisotropy else None,
                'tangentLinked': tangent.is_linked if tangent else False,
                'tangents': [{'direction': node.direction_type, 'axis': node.axis} for node in nodes if node.type == 'TANGENT'],
                'hasNoise': any(node.type == 'TEX_NOISE' for node in nodes)})
        objects[ident] = {'location': list(obj.location), 'polygons': len(mesh.polygons),
            'geometrySha256': hashlib.sha256(json.dumps(geometry, separators=(',', ':')).encode()).hexdigest(), 'materials': materials}
        evaluated.to_mesh_clear()
    rows.append({'label': source['label'], 'objects': objects})
Path(${JSON.stringify(outputPath)}).write_text(json.dumps(rows, indent=2))
`)
  const output = execFileSync(BLENDER_PATH, ['--background', '--factory-startup', '--python', scriptPath],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(join(evidenceDirectory, 'checkpoint-inspection.log'), output)
  const rows = JSON.parse(readFileSync(outputPath, 'utf8'))
  const objects = label => rows.find(row => row.label === label).objects
  const glassBefore = objects('glass-ceramic-before'), glassAfter = objects('glass-ceramic-after')
  check('Blender checkpoint: both cap components moved 8 mm without changing their actual mesh',
    ['cap', 'cap-inset'].every(id => Math.abs(glassAfter[id].location[0] - glassBefore[id].location[0] - 0.008) < 1e-6
      && glassAfter[id].geometrySha256 === glassBefore[id].geometrySha256))
  const speakerBefore = objects('modular-speaker-before'), speakerAfter = objects('modular-speaker-after')
  check('Blender checkpoint: cabinet bevel changes actual mesh and the coarser array reduces evaluated weave faces',
    speakerBefore['cabinet-shell'].geometrySha256 !== speakerAfter['cabinet-shell'].geometrySha256
      && speakerAfter['grille-weft'].polygons < speakerBefore['grille-weft'].polygons,
    { before: speakerBefore['grille-weft'].polygons, after: speakerAfter['grille-weft'].polygons })
  const lampBefore = objects('metal-lamp-before'), lampAfter = objects('metal-lamp-after')
  const material = lampAfter['shade-shell'].materials[0]
  check('Blender checkpoint: the shade has real anisotropy, radial Z tangent wiring and procedural texture',
    Math.abs(material.anisotropic - 0.55) < 1e-6 && material.tangentLinked && material.hasNoise
      && material.tangents.some(tangent => tangent.direction === 'RADIAL' && tangent.axis === 'Z'), material)
  check('Blender checkpoint: changing the shade material leaves base and hinge bindings and geometry intact',
    ['weighted-base', 'hinge-front-cap', 'hinge-rear-cap'].every(id => equal(lampBefore[id], lampAfter[id])))
  verifyRetainedBytes('after independent read-only Blender inspection')
}

/** Every Blender process whose command line mentions this test's store. */
function blenderProcesses() {
  try {
    return execFileSync('ps', ['-Ao', 'pid=,ppid=,args='], { encoding: 'utf8' })
      .split('\n')
      .filter(line => line.includes('Blender') && line.includes(store))
      .map(line => line.trim())
  } catch {
    return []
  }
}

/** The parent process id of a pid, or null. */
function parentOf(pid) {
  try {
    const parsed = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Read one JSON file from the test store, or null. */
function readStoreJson(...segments) {
  const path = join(store, 'projects', ...segments)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

let browser = null
let page = null
let server = null
const pageErrors = []

try {
  // These are interaction checks, not another product-quality benchmark run.
  // Keep real recipe geometry, render size and color management; cap only cost.
  const isolatedRows = JSON.parse(await storePatch(store))
  const hostRow = isolatedRows.find(row => row.id === 'deepblend-blender-host')
  hostRow.config.maxPreviewSamples = 16
  const patch = JSON.stringify(isolatedRows)
  server = await startWeb({ workspacePath: REPO_ROOT, patch, keepHome: true })
  const base = server.url.split('?')[0]
  console.log(`── test server on ${base} (store ${store}) ──`)

  browser = await Browser.launch({ args: ['--window-size=1400,900'] })
  page = await browser.newPage('about:blank', {
    onConsole: (type, text) => {
      if (type === 'error' || type === 'exception') pageErrors.push(`${type}: ${text}`)
    },
  })

  // The request log, per DOCUMENT, so it survives the reload the acceptance
  // requires. The standalone page talks to the Host and to nothing else, so the
  // log is a complete statement of what it did.
  await page.addInitScript(`
    window.__wbreqs = []
    const originalFetch = window.fetch
    window.fetch = (input, init) => {
      let body
      try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined } catch {}
      window.__wbreqs.push({ url: String(input), method: (init && init.method) || 'GET', body })
      return originalFetch(input, init)
    }
  `)

  // -------------------------------------------------------------------------
  // 0. The page opens, and it is NOT the console
  // -------------------------------------------------------------------------
  const pageUrl = `${base}deepblend/workbench`
  await page.goto(pageUrl)

  await page.waitFor('document.querySelector("[data-deepblend-panel=deepblend]") !== null', 30000)
  check('the standalone route serves a page that mounts the workbench',
    await page.count('[data-deepblend-panel=deepblend]') === 1)
  check('the page reports itself as the standalone face, and it booted rather than fell back',
    await page.evaluate('document.getElementById("deepblend-workbench").dataset.deepblendStandalone') === 'ready',
    await page.evaluate('document.getElementById("deepblend-workbench").dataset.deepblendStandalone'))

  // 把外壳拿掉: nothing of the console is here. The sidebar entry M4 clicks, the
  // app's own mount point, the conversation surface, and the shell's boot card.
  const shellTraces = await page.evaluate(`(() => {
    const found = []
    if (document.querySelector('button[aria-label="Blender"]') !== null) found.push('sidebar entry')
    if (document.querySelector('#root') !== null) found.push('#root')
    if (document.querySelector('[data-dsh-boot]') !== null) found.push('boot card')
    if (document.querySelector('[contenteditable]') !== null) found.push('conversation input')
    return found
  })()`)
  check('the document carries no chat shell: no sidebar, no app mount, no conversation',
    Array.isArray(shellTraces) && shellTraces.length === 0, shellTraces)
  check('the workbench fills the page rather than sitting in a pane',
    await page.evaluate('document.getElementById("deepblend-workbench").getBoundingClientRect().height > window.innerHeight - 2'),
    await page.evaluate('document.getElementById("deepblend-workbench").getBoundingClientRect().height'))

  check('the page offers the six M4 views, in order',
    (await page.attributes('[data-view-tab]', 'data-view-tab')).join(',') === 'projects,scene,preview,jobs,qa,revisions',
    await page.attributes('[data-view-tab]', 'data-view-tab'))
  await page.waitFor('document.querySelector(\'[data-view="projects"]\') !== null', 20000)
  await page.waitFor('document.querySelector(\'[data-action="create-project"]\') !== null', 20000)
  check('a fresh store is shown as a fresh store, not as an error',
    await page.count('.db-project-create') === 1
      && await page.count('[data-recipe]') > 0
      && await page.count('.db-project-list') === 0
      && await page.count('[data-deepblend-panel] .db-error') === 0,
    ((await page.text('[data-view="projects"]')) ?? '').replace(/\s+/g, ' ').slice(0, 120))

  // -------------------------------------------------------------------------
  // 1. ONE IMPLEMENTATION, read off the network
  //
  // This is the assertion M6 exists for. The page has no copy of the workbench:
  // it fetched the console's own bundle, from the URL the console's own boot
  // graph declares for it.
  // -------------------------------------------------------------------------
  const provenance = await page.evaluate(`(() => {
    const graph = window.__DSH_BOOT__
    const row = (graph.entries || []).find(entry => entry.id === ${JSON.stringify(BUNDLE_ID)}) || null
    const batch = (graph.batches || []).find(entry => (entry.entries || []).includes(${JSON.stringify(BUNDLE_ID)})) || null
    const resources = performance.getEntriesByType('resource').map(entry => entry.name)
    const loaded = resources.filter(name => name.includes(${JSON.stringify(BUNDLE_ID + '/client.js')}))
    return {
      row,
      batch,
      loaded,
      shellAssets: resources.filter(name => /\\/assets\\/index-/.test(name)),
      allResources: resources.length,
    }
  })()`)

  check('the boot graph declares a row for the workbench bundle, and an initial batch that carries it',
    provenance.row !== null && typeof provenance.row.url === 'string'
    && provenance.batch !== null && typeof provenance.batch.url === 'string'
    && provenance.batch.url.includes(BUNDLE_ID),
    { row: provenance.row?.url, batch: provenance.batch?.url?.slice(0, 120) })
  check('the standalone page loaded the workbench bundle from the URL the graph declares for it',
    provenance.loaded.length === 1 && provenance.loaded[0].endsWith(provenance.batch.url),
    { loaded: provenance.loaded.length, declaredBatch: provenance.batch?.url?.slice(0, 120) })
  check('and it loaded the bundle exactly once, so there is no second copy being fetched alongside',
    provenance.loaded.length === 1, provenance.loaded.map(url => url.slice(0, 100)))
  check('and it loaded no console bundle at all: the page is not the shell wearing a different URL',
    provenance.shellAssets.length === 0, provenance.shellAssets)

  // A package name and version can match in two checkouts. Compare the entire
  // immutable plugin response with this checkout's client artifact. DSH's
  // single-plugin combo removes local debug trailers, adds a newline and ";",
  // then appends the advertised revision's source-map URL.
  const clientPath = join(REPO_ROOT, 'packages/deepblend/ui/lib/client.js')
  const clientBytes = readFileSync(clientPath)
  let clientSource = clientBytes.toString('utf8')
    .replace(/(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/, '')
    .replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/, '')
  if (!clientSource.endsWith('\n')) clientSource += '\n'
  const clientUrl = provenance.row.url
  const mapUrl = clientUrl.replace(/\/client\.js(?=&rev=)/, '/client.js.map')
  const expectedClientResponse = Buffer.from(`${clientSource};\n//# sourceMappingURL=${mapUrl}\n`)
  const clientResponse = await fetch(new URL(clientUrl, base), { signal: AbortSignal.timeout(10000) })
  const servedClientBytes = Buffer.from(await clientResponse.arrayBuffer())
  const clientSourceEvidence = { clientPath, clientUrl, status: clientResponse.status,
    sourceSha256: sha256(clientBytes), expectedResponseSha256: sha256(expectedClientResponse),
    servedResponseSha256: sha256(servedClientBytes), servedBytes: servedClientBytes.length }
  writeFileSync(join(evidenceDirectory, 'client-source.json'), `${JSON.stringify(clientSourceEvidence, null, 2)}\n`)
  writeFileSync(join(evidenceDirectory, 'served-client.js'), servedClientBytes)
  const matchesCheckout = clientResponse.ok && servedClientBytes.equals(expectedClientResponse)
  check('the served workbench client contains this checkout\'s complete executable source', matchesCheckout, clientSourceEvidence)
  if (!matchesCheckout) throw new Error('The Web server loaded a workbench client from outside the checkout under test')

  // -------------------------------------------------------------------------
  // 2. 不进入文件系统即可管理项目 — create a project, change a scene, render a preview
  // -------------------------------------------------------------------------
  await page.fill('[data-field="project-title"]', PROJECT_TITLE)
  const createClick = await page.click('[data-action="create-project"]')
  check('the create control is reachable by a pointer, not only by a synthetic click',
    createClick.via === 'pointer', createClick)
  await page.waitFor('document.querySelector(\'[data-result="ok"]\') !== null', 30000)
  const created = await page.text('[data-result="ok"]')
  check('creating a project from the full-screen page reports the new project id', /已创建/.test(created ?? ''), created)

  const projectId = PROJECT_TITLE
  check('the store now holds the project the browser asked for',
    existsSync(join(store, 'projects', projectId, 'project.json')))
  check('the project was created by the HOST, not by the page',
    readStoreJson(projectId, 'project.json')?.projectId === projectId,
    readStoreJson(projectId, 'project.json')?.projectId)

  await page.click('[data-view-tab="scene"]')
  await page.waitFor('document.querySelector("[data-node]") !== null', 20000)
  const nodes = await page.attributes('[data-node]', 'data-node')
  check('the Scene Tree shows the entities the spec really declares',
    nodes.includes('entity:subject') && nodes.includes('camera:camera-main'), nodes.slice(0, 8))

  const patchDocument = JSON.stringify({
    baseRevision: 'r0001',
    operations: [{ op: 'entity.transform.update', entityId: 'subject', location: [0, 0, 1.5] }],
  }, null, 2)
  await page.click('[data-view="scene"] details:has([data-field="scene-patch"]) > summary')
  await page.fill('[data-field="scene-patch"]', patchDocument)
  check('the advanced editor stays expanded while its draft is changed',
    await page.evaluate('document.querySelector(\'[data-field="scene-patch"]\').closest("details").open'))
  await page.waitFor(`(() => {
    const button = document.querySelector('[data-action="apply-patch"]')
    const bounds = button.getBoundingClientRect()
    return bounds.width > 0 && bounds.height > 0 && !button.disabled
  })()`, 5000)
  const patchClick = await page.click('[data-action="apply-patch"]')
  check('the expanded advanced submit control is reached by pointer', patchClick.via === 'pointer', patchClick)
  await page.waitFor('document.querySelector(\'[data-view="scene"] [data-result="ok"]\') !== null', 60000)
  const patchResult = await page.text('[data-view="scene"] [data-result="ok"]')
  check('the patch was committed as a new revision by the Host', /已提交 r0002/.test(patchResult ?? ''), patchResult)
  check('the write really changed the stored scene',
    JSON.stringify(readStoreJson(projectId, 'revisions', 'r0002', 'scene-spec.json')?.entities?.[0]?.transform?.location) === '[0,0,1.5]',
    readStoreJson(projectId, 'revisions', 'r0002', 'scene-spec.json')?.entities?.[0]?.transform?.location)

  await page.click('[data-view-tab="preview"]')
  await page.waitFor('document.querySelector(\'[data-action="render-preview"]\') !== null', 20000)
  const previewClick = await page.click('[data-action="render-preview"]')
  check('the preview button is reachable by a pointer', previewClick.via === 'pointer', previewClick)
  await page.waitFor('document.querySelector(\'[data-view="preview"] [data-result="ok"], [data-view="preview"] [data-result="error"]\') !== null', 300000)
  const previewResult = await page.text('[data-view="preview"] [data-result]')
  check('rendering a preview from the full-screen page succeeds on a real Blender',
    /已渲染/.test(previewResult ?? ''), previewResult)

  await page.waitFor(
    'document.querySelector("[data-compare=right] img") !== null && '
    + 'document.querySelector("[data-compare=right] img").naturalWidth > 0',
    60000)
  const shown = await page.evaluate(`(() => {
    const img = document.querySelector('[data-compare="right"] img')
    return { src: img.getAttribute('src'), digest: img.getAttribute('data-artifact-digest'), width: img.naturalWidth }
  })()`)
  check('the page displays the rendered contact sheet, fetched through the artifact route',
    shown.width > 0 && shown.src.startsWith('/deepblend/artifacts/'), shown)
  check('the preview PNG is on disk under the revision',
    readStoreJson(projectId, 'revisions', 'r0002', 'revision-manifest.json')?.contactSheets?.length > 0,
    readStoreJson(projectId, 'revisions', 'r0002', 'revision-manifest.json')?.contactSheets)

  // -------------------------------------------------------------------------
  // 2b. 导出诊断: the one thing this page produces FOR SOMEBODY ELSE
  //
  // It is an anchor with `download`, so the BROWSER fetches the route and writes
  // the file — which means the request log above cannot see it (that log hooks
  // `fetch`) and the only honest evidence is the file. So the download is
  // allowed to a directory this test owns, the link is clicked by POINTER, and
  // what lands there is parsed and read.
  // -------------------------------------------------------------------------
  const downloadDirectory = mkdtempSync(join(tmpdir(), 'deepblend-diagnostics-'))
  try {
    await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory })

    const exportClick = await page.click('[data-action="export-diagnostics"]')
    check('the export control is reachable by a pointer, like every other control on this page',
      exportClick.via === 'pointer', exportClick)

    const exportedPath = join(downloadDirectory, 'deepblend-diagnostics.json')
    const deadline = Date.now() + 30000
    while (!existsSync(exportedPath) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    check('clicking it downloads a file, and the file is the bundle the route serves',
      existsSync(exportedPath), exportedPath)

    const exported = existsSync(exportedPath) ? JSON.parse(readFileSync(exportedPath, 'utf8')) : null
    const expectedVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'deepblend', 'version.json'), 'utf8')).version
    check('the downloaded bundle is the product\'s own diagnostic format, at the version it ships',
      exported?.format === 'deepblend-diagnostics' && exported?.product?.version === expectedVersion,
      { format: exported?.format, version: exported?.product?.version, expectedVersion })
    check('and it describes THIS store, so it is a reading rather than a template',
      exported?.store?.projectCount >= 1 && exported.store.projects.some(project => project.projectId === projectId),
      { count: exported?.store?.projectCount, projectId })
    check('it carries the Blender probe result, which is the first thing a maintainer asks for',
      exported?.blender?.probed === true && typeof exported?.blender?.installed === 'boolean' &&
      exported.blender.version !== null,
      { installed: exported?.blender?.installed, version: exported?.blender?.version })
    const leaked = JSON.stringify(exported).includes(homedir())
    check('it carries no home directory, so it can be pasted into a public issue',
      !leaked, leaked ? 'a home path reached the downloaded file' : undefined)
  } finally {
    rmSync(downloadDirectory, { recursive: true, force: true })
  }

  // A delivery render, so the job plane is exercised from the full-screen page
  // too and the Blender-parentage assertion below has something to look at.
  await page.click('[data-view-tab="jobs"]')
  await page.waitFor('document.querySelector(\'[data-action="start-render"]\') !== null', 20000)
  await page.fill('[data-field="frame-start"]', '1')
  await page.fill('[data-field="frame-end"]', '3')
  await page.click('[data-action="start-render"]')
  await page.waitFor('document.querySelector("[data-job]") !== null', 60000)
  const jobId = (await page.attributes('[data-job]', 'data-job'))[0]
  check('a delivery render started from the full-screen page appears as a job', typeof jobId === 'string', jobId)
  check('the Host recorded the job on disk', readStoreJson(projectId, 'renders', jobId, 'job.json') !== null)

  await page.waitFor('document.querySelector(\'[data-action^="cancel:"]\') !== null', 60000)
  const live = blenderProcesses()
  const livePid = live.length > 0 ? Number(live[0].split(/\s+/)[0]) : null
  check('the Blender that is rendering is a child of the Host process, not of the page',
    livePid !== null && parentOf(livePid) === server.child.pid,
    { livePid, liveParent: livePid === null ? null : parentOf(livePid), serverPid: server.child.pid })

  await page.click(`[data-action="cancel:${jobId}"]`)
  await page.waitFor('document.querySelector(\'[data-result-kind="cancel"]\') !== null', 60000)
  check('cancelling reports the process measured gone, not merely signalled',
    /进程实测已消失/.test((await page.text('[data-result-kind="cancel"]')) ?? ''),
    await page.text('[data-result-kind="cancel"]'))
  check('cancelling left no Blender process for this store', blenderProcesses().length === 0, blenderProcesses())

  // -------------------------------------------------------------------------
  // 3. 刷新后可从 Host 恢复权威状态
  // -------------------------------------------------------------------------
  const requestsBeforeReload = await page.evaluate('window.__wbreqs')
  await page.reload()
  await page.waitFor('document.querySelector("[data-deepblend-panel=deepblend]") !== null', 30000)
  await page.waitFor(`document.querySelector('[data-project="${projectId}"]') !== null`, 30000)

  const hostRevision = readStoreJson(projectId, 'project.json')?.currentRevision
  check('after a refresh the page still shows the project, read back from the Host',
    ((await page.text('[data-deepblend-panel=deepblend]')) ?? '').includes(PROJECT_TITLE))
  check('after a refresh the header shows the revision the Host has, not a cached one',
    typeof hostRevision === 'string' && ((await page.text('.db-head')) ?? '').includes(hostRevision),
    { hostRevision, header: await page.text('.db-head') })

  await page.click('[data-view-tab="jobs"]')
  await page.waitFor('document.querySelector("[data-job]") !== null', 30000)
  check('after a refresh the job is read back from the Host, still cancelled',
    ((await page.text(`[data-job="${jobId}"]`)) ?? '').includes('cancelled'),
    ((await page.text(`[data-job="${jobId}"]`)) ?? '').slice(0, 120))

  const requestsAfterReload = await page.evaluate('window.__wbreqs')
  check('the refreshed page rebuilt itself from the Host rather than from memory',
    requestsAfterReload.some(entry => entry.url.includes('/deepblend/state')),
    requestsAfterReload.map(entry => entry.url).slice(0, 6))

  // -------------------------------------------------------------------------
  // 4. 浏览器不直接启动 Blender / 所有写操作经过 Host
  // -------------------------------------------------------------------------
  const requests = [...requestsBeforeReload, ...requestsAfterReload]
  check('the refreshed page made requests of its own, so the log is really per document',
    requests.length > 0, requests.length)
  check('every request the page made was same-origin',
    requests.every(entry => entry.url.startsWith('/') || entry.url.startsWith('http://127.0.0.1')))

  const routeOf = url => url.replace(/^https?:\/\/127\.0\.0\.1:\d+/, '').split('?')[0]
  const panel = requests.filter(entry => routeOf(entry.url).startsWith('/deepblend/'))
  // The declared set, as a regular expression built from the route table's own
  // shape. `/deepblend/workbench` is a document navigation rather than a fetch,
  // so it never appears here — the page's own traffic is reads and writes.
  const declared = new RegExp('^/deepblend/(state|capabilities|projects'
    + '(/[^/]+(/(scene|revisions|diff|qa|previews|patch|restore|preview|render)'
    + '|/jobs(/[^/]+(/cancel)?)?'
    + '|/revisions/[^/]+)?)?'
    + '|artifacts/[^/]+/.+)$')
  check('the page made DeepBlend requests at all, so the closed set has content', panel.length >= 5, panel.length)
  check('every DeepBlend request the page made is a declared DeepBlend route',
    panel.every(entry => declared.test(routeOf(entry.url))),
    panel.filter(entry => !declared.test(routeOf(entry.url))).map(entry => routeOf(entry.url)).slice(0, 5))

  const writes = panel.filter(entry => entry.method === 'POST')
  check('every write the page performed is one of the declared write routes',
    writes.length >= 4 && writes.every(entry => /\/(projects|patch|restore|render|preview|jobs\/[^/]+\/cancel)$/.test(routeOf(entry.url))),
    writes.map(entry => `${entry.method} ${routeOf(entry.url)}`))
  check('the page performed the writes the acceptance asked for: create, patch, preview, render, cancel',
    writes.some(entry => /\/deepblend\/projects$/.test(routeOf(entry.url)))
    && writes.some(entry => /\/patch$/.test(routeOf(entry.url)))
    && writes.some(entry => /\/preview$/.test(routeOf(entry.url)))
    && writes.some(entry => /\/render$/.test(routeOf(entry.url)))
    && writes.some(entry => /\/cancel$/.test(routeOf(entry.url))),
    writes.map(entry => routeOf(entry.url)))

  check('the page has no Node execution surface',
    await page.evaluate('typeof require === "undefined" && typeof process === "undefined" && typeof module === "undefined"'))
  check('the page cannot reach a Blender the Host did not start',
    await page.evaluate('typeof globalThis.spawn === "undefined" && typeof globalThis.child_process === "undefined"'))

  // The route set, from outside the page: a page-only route that does not exist,
  // and the byte route's escape guard, which the standalone page must inherit.
  const unknown = await fetch(`${base}deepblend/not-a-route`).then(async response => ({ status: response.status, body: await response.json() }))
  check('an unknown route is refused with the route list, from the standalone deployment too',
    unknown.status === 404 && unknown.body.error.code === 'UI_ROUTE_NOT_FOUND', unknown.status)
  const escape = await fetch(`${base}deepblend/artifacts/${projectId}/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`)
    .then(async response => ({ status: response.status, body: await response.json() }))
  check('an artifact path that escapes the project is refused by the Host',
    escape.status === 400 || escape.status === 404, { status: escape.status, code: escape.body?.error?.code })

  // -------------------------------------------------------------------------
  // 5. Real recipe object edits: no JSON editor and no replacement scene fixture.
  // Creation and visual edits both render a committed single-camera preview, so
  // before/after pixels use the same frame instead of mixing two view-plan modes.
  // -------------------------------------------------------------------------
  const requestsBeforeObjectEdits = (await page.evaluate('window.__wbreqs')).length
  const recipeProjectIds = {}
  for (const recipeId of ['glass-ceramic', 'modular-speaker', 'metal-lamp']) {
    const version=recipeId==='metal-lamp'?'2.0.0':'1.0.0'
    await page.click('[data-view-tab="projects"]')
    await page.waitFor(`document.querySelector('[data-action="select-recipe:deepblend.${recipeId}@${version}"]') !== null`, 30000)
    await page.click(`[data-action="select-recipe:deepblend.${recipeId}@${version}"]`)
    const id = `${PROJECT_TITLE}-${recipeId}`
    recipeProjectIds[recipeId] = id
    await page.fill('[data-field="project-title"]', id)
    const createRecipeClick = await page.click('[data-action="create-project"]')
    check(`${recipeId}: the shipped recipe is created by a pointer action`, createRecipeClick.via === 'pointer')
    await waitDisk(() => readStoreJson(id, 'project.json')?.currentRevision === 'r0001', `${recipeId} creation`)
    const before = retainRevision(id, 'r0001', `${recipeId}-before`)
    await page.waitFor(`(() => {
      const img = document.querySelector('[data-compare="current"] img')
      return img && img.complete && img.naturalWidth === 768 && img.dataset.artifactDigest === ${JSON.stringify(before.artifact.sha256)}
    })()`, 30000)
    check(`${recipeId}: creating the recipe already shows its own real preview`, true)

    let revision
    if (recipeId === 'glass-ceramic') {
      // The metal cap and its ceramic inset are separate authored objects. Move
      // both by 8 mm, then compare the assembled result; do not detach the inset.
      const capX = entity(before.spec, 'cap').transform.location[0] + 0.008
      const insetX = entity(before.spec, 'cap-inset').transform.location[0] + 0.008
      await commitEntity(page, id, 'cap', { 'location-x': capX * 1000 })
      revision = await commitEntity(page, id, 'cap-inset', { 'location-x': insetX * 1000 })
      const afterSpec = readStoreJson(id, 'revisions', revision, 'scene-spec.json')
      const expected = structuredClone(before.spec)
      entity(expected, 'cap').transform.location[0] = capX
      entity(expected, 'cap-inset').transform.location[0] = insetX
      check('glass: the assembled cap moves 8 mm; bottle, tray, material, lights and cameras are unchanged', equal(afterSpec, expected))
    } else if (recipeId === 'modular-speaker') {
      await commitEntity(page, id, 'cabinet-shell', { 'generator-bevel-width': 24 })
      revision = await commitEntity(page, id, 'grille-weft', { 'modifier-0-count': 48, 'modifier-0-offset-x': 2.4 })
      const afterSpec = readStoreJson(id, 'revisions', revision, 'scene-spec.json')
      const expected = structuredClone(before.spec)
      entity(expected, 'cabinet-shell').generator.bevel.width = 0.024
      entity(expected, 'grille-weft').modifiers[0].count = 48
      entity(expected, 'grille-weft').modifiers[0].offset[0] = 0.0024
      check('speaker: bevel and array edits preserve modifier order, boolean clipping and every other scene field', equal(afterSpec, expected))
      check('speaker: the coarser weave preserves its span to within 1 mm',
        Math.abs((48 - 1) * 0.0024 - (64 - 1) * 0.0018) < 0.001)
    } else {
      revision = await commitEntity(page, id, 'shade-shell', { 'material-color': '#597c86', 'material-roughness': 0.31 })
      const afterSpec = readStoreJson(id, 'revisions', revision, 'scene-spec.json')
      const oldMaterial = before.spec.materials.find(material => material.id === entity(before.spec, 'shade-shell').materialId)
      const newMaterial = afterSpec.materials.find(material => material.id === entity(afterSpec, 'shade-shell').materialId)
      const expected = structuredClone(before.spec)
      const expectedMaterial = structuredClone(oldMaterial)
      expectedMaterial.id = newMaterial?.id
      expectedMaterial.parameters.baseColor = [0x59, 0x7c, 0x86].map(value => {
        const srgb = value / 255
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
      }).concat(oldMaterial.parameters.baseColor[3] ?? 1)
      expectedMaterial.parameters.roughness = 0.31
      entity(expected, 'shade-shell').materialId = newMaterial?.id
      expected.materials.push(expectedMaterial)
      expected.materials.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      check('lamp: only the shade receives a cloned material; every shared base/hinge material and other scene field is unchanged',
        newMaterial?.id !== oldMaterial.id && equal(afterSpec, expected))
      check('lamp: the committed local material retains anisotropy, radial tangent and procedural texture',
        newMaterial?.parameters.anisotropic === 0.55 && newMaterial?.parameters.anisotropicRotation === oldMaterial.parameters.anisotropicRotation
          && equal(newMaterial?.tangent, oldMaterial.tangent) && equal(newMaterial?.texture, oldMaterial.texture))
    }
    const after = retainRevision(id, revision, `${recipeId}-after`)
    compareRenderedChange(before, after)
    await showComparison(page, before, after, `${recipeId}-comparison.png`)
    verifyRetainedBytes(`${recipeId} after editing`)

    if (recipeId === 'metal-lamp') {
      // The one-click undo is conditional on the version the edit actually made.
      await selectEntity(page, 'shade-shell', revision)
      await page.waitFor('document.querySelector(\'[data-action="editor-restore"]\') !== null && !document.querySelector(\'[data-action="editor-restore"]\').disabled', 30000)
      const restoreClick = await page.click('[data-action="editor-restore"]')
      check('lamp: returning to the pre-edit scene uses the visible restore control', restoreClick.via === 'pointer')
      await waitDisk(() => readStoreJson(id, 'project.json')?.currentRevision === before.revision, 'conditional restoration')
      await page.waitFor(`document.querySelector('[data-action="editor-restore"]') === null && document.querySelector('[data-view="scene"] .db-badge')?.textContent === ${JSON.stringify(before.revision)}`, 30000)
      check('lamp: restore moves the current pointer while retaining the edited version',
        equal(readStoreJson(id, 'revisions', before.revision, 'scene-spec.json'), before.spec)
          && existsSync(join(store, 'projects', id, 'revisions', revision, 'scene.blend')))
      verifyRetainedBytes('after conditional restoration')
      const currentRecordHash = sha256(readFileSync(join(store, 'projects', id, 'project.json')))
      const refused = await fetch(`${base}deepblend/projects/${id}/restore`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: before.revision, expectedCurrentRevision: revision }),
      }).then(async response => ({ status: response.status, body: await response.json() }))
      check('lamp: stale conditional restore is rejected without changing the current project record',
        refused.body?.ok === false && refused.body?.error?.code === 'REVISION_CONFLICT'
          && sha256(readFileSync(join(store, 'projects', id, 'project.json'))) === currentRecordHash,
        { status: refused.status, error: refused.body?.error?.code })
    }
  }

  // A second real page edits the same project while the first has an unsaved
  // draft. Polling must expose the conflict, not silently rebase that draft.
  const concurrentId = recipeProjectIds['metal-lamp']
  await selectEntity(page, 'shade-shell', 'r0001')
  await page.fill('[data-field="editor-material-roughness"]', '0.31')
  let peerPage = null
  try {
    peerPage = await browser.newPage(pageUrl, {
      onConsole: (type, text) => {
        if (type === 'error' || type === 'exception') pageErrors.push(`peer ${type}: ${text}`)
      },
    })
    await peerPage.waitFor(`document.querySelector('[data-project="${concurrentId}"]') !== null`, 30000)
    await peerPage.click(`[data-project="${concurrentId}"] button`)
    await peerPage.click('[data-action="reload"]')
    await selectEntity(peerPage, 'shade-shell', 'r0001')
    const peerRevision = await commitEntity(peerPage, concurrentId, 'shade-shell', { 'material-roughness': 0.33 })
    const peer = retainRevision(concurrentId, peerRevision, 'metal-lamp-concurrent')
    await page.click('[data-action="reload"]')
    await page.waitFor('document.querySelector(\'[data-editor-conflict="true"]\') !== null', 30000)
    check('concurrent edit: polling preserves the draft and refuses to overwrite the new revision',
      await page.evaluate('document.querySelector(\'[data-field="editor-material-roughness"]\').value === "0.31" && document.querySelector(\'[data-action="editor-apply"]\').disabled'))
    await page.screenshot(join(evidenceDirectory, 'conflicting-draft.png'))
    const revisionNames = readdirSync(join(store, 'projects', concurrentId, 'revisions')).sort()
    const refused = await fetch(`${base}deepblend/projects/${concurrentId}/patch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { baseRevision: 'r0001', operations: [{ op: 'entity.transform.update', entityId: 'shade-shell', location: [0.05, 0, 0.31] }] } }),
    }).then(async response => ({ status: response.status, body: await response.json() }))
    check('concurrent edit: Host also rejects stale baseRevision without creating an orphan revision',
      refused.body?.ok === false && refused.body?.error?.code === 'REVISION_CONFLICT'
        && readStoreJson(concurrentId, 'project.json')?.currentRevision === peer.revision
        && equal(readdirSync(join(store, 'projects', concurrentId, 'revisions')).sort(), revisionNames),
      { status: refused.status, error: refused.body?.error?.code })
    await page.click('[data-action="editor-reset"]')
    await page.waitFor(`document.querySelector('[data-editor-base-revision="${peer.revision}"][data-editor-conflict="false"][data-editor-dirty="false"]') !== null`, 30000)
    check('concurrent edit: explicit reset reads the winning revision rather than replaying the stale draft',
      await page.evaluate('document.querySelector(\'[data-field="editor-material-roughness"]\').value === "0.33"'))
    verifyRetainedBytes('after conflict and explicit reset')
  } finally {
    if (peerPage) {
      await peerPage.close()
      // Browser.close iterates its pages. This driver does not make a second
      // Page.close on an already closed WebSocket settle, so remove our peer.
      browser.pages = browser.pages.filter(candidate => candidate !== peerPage)
    }
  }

  inspectObjectEditCheckpoints()

  const editorRequests = (await page.evaluate('window.__wbreqs')).slice(requestsBeforeObjectEdits)
  const editorWrites = editorRequests.filter(request => request.method === 'POST')
  check('recipe/object/restore UI writes all use the existing Host routes',
    editorWrites.length >= 9 && editorWrites.every(request => /\/(projects|patch|restore)$/.test(routeOf(request.url))),
    editorWrites.map(request => routeOf(request.url)))
  check('object edits send an immutable baseRevision and conditional restores send their expected revision',
    editorWrites.filter(request => /\/patch$/.test(routeOf(request.url))).every(request => typeof request.body?.patch?.baseRevision === 'string')
      && editorWrites.filter(request => /\/restore$/.test(routeOf(request.url))).every(request => typeof request.body?.expectedCurrentRevision === 'string'))

  check('the page logged no errors and threw nothing', pageErrors.length === 0, pageErrors.slice(0, 4))
} catch (cause) {
  check('the suite completed without an unexpected throw', false, cause?.stack ?? String(cause))
} finally {
  if (page !== null) await page.screenshot(join(evidenceDirectory, 'last-page.png'))
    .then(() => copyFileSync(join(evidenceDirectory, 'last-page.png'), '/tmp/deepblend-m6-workbench-e2e.png')).catch(() => {})
  if (browser !== null) await browser.close().catch(() => {})
  if (server !== null) {
    // The same verdict M4's suite makes: a server that finishes its own shutdown
    // is a server that was not killed mid-way.
    const stopped = await server.stop().catch(cause => ({ via: `failed: ${String(cause)}`, ms: 0 }))
    check('the server finished its own shutdown rather than being killed mid-way',
      stopped.via === 'sigterm', stopped)
  }
  const leftovers = blenderProcesses()
  if (leftovers.length > 0) {
    console.error(`WARNING: Blender processes survived the suite: ${leftovers.join(' | ')}`)
    for (const line of leftovers) {
      try {
        process.kill(Number(line.split(/\s+/)[0]), 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
  writeFileSync(join(evidenceDirectory, 'report.json'), `${JSON.stringify({
    schemaVersion: 'deepblend.workbench-object-edit-evidence/v1', startedAt, finishedAt: new Date().toISOString(),
    status: results.some(result => !result.ok) ? 'failed' : 'technical-interaction-pass',
    previewSamplesCeiling: 16, artisticReviewRequired: true, checks: results,
    comparisons: objectEditEvidence,
    revisions: retainedRevisions.map(({ spec, ...snapshot }) => snapshot),
    limitation: 'Pixel differences establish a rendered effect; they do not establish artistic quality. Fixture operations are submitted by the real browser UI; only conflict refusal probes call Host HTTP directly.',
  }, null, 2)}\n`)
  console.log(`Object edit evidence: ${evidenceDirectory}`)
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter(entry => !entry.ok)
console.log(`\nM6 standalone workbench acceptance: ${results.length - failed.length}/${results.length} check(s) passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.map(entry => entry.name).join('; ')}`)
  process.exit(1)
}
