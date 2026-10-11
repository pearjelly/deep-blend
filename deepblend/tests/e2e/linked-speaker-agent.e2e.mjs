#!/usr/bin/env node
/** Explicit live-model acceptance; not part of automatic CI or offline tests. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Browser } from '../../tools/browser-driver.mjs'
import { REAL_HOME, REPO_ROOT, dismissFirstRunDialogs, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
const output = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend', 'quality', `linked-speaker-agent-${Date.now()}`))
if (existsSync(output)) throw Error('Evidence directory already exists')
mkdirSync(output, { recursive: true })
const root = join(output, 'store'), checks = []
const json = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n')
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`); if (!ok) throw Error(name) }
const prompt = '使用已有的模块化桌面音箱设计，创建标题为 agent-linked-width 的可编辑 Blender 项目。箱体宽 300 mm、深 138 mm、高 162 mm。保留编织格栅、控制旋钮、外壳与内腔的尺寸差和按钮按压动画，保存模型并生成主图预览。请自行选择合适的已安装配方，只报告实际结果，不要生成脚本或改配置。'
let server, browser, page, failure, shutdown
try {
  check('a local credential store and installed development preset are available', existsSync(join(REAL_HOME, '.credentials.yaml')) && existsSync(join(REAL_HOME, '.agent-presets/deepblend-dev/preset.yml')))
  const rows = JSON.parse(await storePatch(root))
  rows.find(r => r.id === 'deepblend-blender-runtime').config.blenderPath = process.env.DEEPBLEND_BLENDER_PATH || join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
  rows.find(r => r.id === 'deepblend-blender-host').config.maxPreviewSamples = 8
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), inheritUserConfig: true, keepHome: false })
  browser = await Browser.launch({ args: ['--window-size=1500,1100'] }); page = await browser.newPage()
  await page.goto(server.url); await dismissFirstRunDialogs(page)
  await page.waitFor('document.querySelector("[contenteditable=true]")!==null', 30000)
  const opened = await page.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='标准模式');b?.click();return Boolean(b)})()`)
  check('the real console offers preset selection', opened)
  await page.waitFor(`[...document.querySelectorAll('*')].some(b=>b.textContent.trim().startsWith('DeepBlend 开发模式'))`, 15000)
  await page.evaluate(`(()=>{const entries=[...document.querySelectorAll('[role=menuitem],[role=option],li,button,div')].filter(b=>b.textContent.trim().startsWith('DeepBlend 开发模式'));entries.at(-1).click();return true})()`)
  await page.waitFor(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='DeepBlend 开发模式')`, 20000)
  await page.evaluate(`(()=>{document.querySelector('[contenteditable=true]').focus();return true})()`)
  await page.send('Input.insertText', { text: prompt })
  await page.waitFor(`document.querySelector('button[aria-label="发送消息"]')?.disabled===false`, 15000)
  check('the natural-language request is sent through a real pointer event', (await page.click('button[aria-label="发送消息"]')).via === 'pointer')
  await page.waitFor(`document.querySelector('[contenteditable=true]')?.textContent.trim()===''&&document.body.innerText.includes(${JSON.stringify(prompt)})`, 15000)
  json('request.json', { prompt, submissions: 1, scope: 'Natural-language installed-recipe task; no tool names or parameter IDs supplied to the model.' })
  const manifestPath = join(root, 'projects/agent-linked-width/revisions/r0001/revision-manifest.json')
  const deadline = Date.now() + 300000
  while (!existsSync(manifestPath) && Date.now() < deadline) {
    const failureText = await page.evaluate(`(()=>{const text=document.body.innerText;const at=text.indexOf('本轮运行失败');return at<0?null:text.slice(at,at+250)})()`)
    if (failureText) throw Error('The actual model session failed before project creation: ' + failureText)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const cards = await page.attributes('[data-tool-card]', 'data-tool-card')
  json('tool-cards.json', { cards, states: await page.attributes('[data-tool-card]', 'data-tool-state') })
  check('the model discovers local recipes through the actual tool', cards.includes('blender_recipe_list'), cards)
  check('the model creates the requested project through the actual tool', existsSync(manifestPath) && cards.includes('blender_project_create'), cards)
  const manifest = JSON.parse(readFileSync(manifestPath)), directory = join(root, 'projects/agent-linked-width/revisions/r0001')
  const lock = JSON.parse(readFileSync(join(directory, manifest.recipe.lockPath))), spec = JSON.parse(readFileSync(join(directory, 'scene-spec.json')))
  check('the model selects the linked speaker and the requested millimetre values', lock.id === 'deepblend.modular-speaker' && lock.version === '2.0.0' && lock.values['cabinet-width-mm'] === 300 && lock.values['cabinet-depth-mm'] === 138 && lock.values['cabinet-height-mm'] === 162, lock.values)
  check('the real creation has an editable saved assembly and rendered preview', spec.entities.length === 111 && existsSync(join(directory, 'scene.blend')) && manifest.previews.length > 0)
  json('recipe-lock.json', lock); json('manifest.json', manifest)
  await page.screenshot(join(output, 'result.png'))
} catch (error) { failure = error.stack || String(error); console.error(error) }
finally {
  if (page) try { json('console-result.json', { text: await page.evaluate('document.body.innerText.slice(-12000)') }) } catch {}
  for (const [name, close] of [['browser', () => browser?.close()], ['server', () => server?.stop()]]) {
    try { const result = await close(); if (name === 'server') shutdown = result } catch (error) { failure ??= String(error) }
  }
  json('report.json', { status: failure ? 'failed' : 'passed', checks, failure, shutdown,
    scope: 'Real DSH console and natural-language request. Model success requires actual tool cards plus a saved project; a UI submit alone is insufficient. Not an aggregate success rate, proof of arbitrary modeling, existing-assembly editing or external adoption.' })
}
console.log(`Linked speaker live Agent: ${checks.filter(c => c.ok).length}/${checks.length}; ${output}`)
if (failure) process.exitCode = 1
