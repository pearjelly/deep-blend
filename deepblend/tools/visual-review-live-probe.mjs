#!/usr/bin/env node
/**
 * M2 live probe — a direct, host-side multimodal model call.
 *
 * WHY THIS EXISTS
 * ---------------
 * The M2 acceptance criterion "自动修复后评分提高" needs a score that is
 * measured, not asserted. So the visual review loop is owned by the HOST: it
 * renders, measures, asks the model exactly one question, validates the answer
 * against the measurements, and applies a patch. That design only works if the
 * host can make its own model call — the Agent's model call belongs to the
 * Agent loop, and a tool cannot consume its own conversation.
 *
 * This script answers that question against the REAL provider stack, not a
 * mock: real settings, real credential store, real attachment store, real
 * `@deepseek-ai/dsh-llm` runtime and the real official DeepSeek adapter. It
 * sends a real rendered PNG as an image content block and prints what the model
 * said about it.
 *
 * Run: node deepblend/tools/visual-review-live-probe.mjs
 *
 * Owner: DeepBlend Studio — M2
 */

import { StudioConfig } from '@deepblend/dsh-blender-host'
import { Context } from '@deepseek-ai/cordis'

import { importDsh, resolveDshHome } from '../tests/lib/dsh-deployment.mjs'
import { devStoreRoot } from './operator-layer.mjs'

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')
const DSH_HOME = resolveDshHome()
const DEFAULT_PNG = join(
  devStoreRoot(PROJECT_ROOT), 'projects', 'watch-commercial',
  'revisions', 'r0002', 'previews', 'frame22-camera-top.png',
)
const PNG = process.argv[2] ?? DEFAULT_PNG

// THE PRODUCT'S OWN ROUTE, not a second copy of it. MEASURED: this probe used to name the model
// itself, so when the shipped default stopped being served the probe kept asking for the dead name —
// it reported the 404 the product was getting, and the fix to the product changed nothing here. A
// probe whose subject is "can the vision reviewer see" has to ask the same question the reviewer does.
const PROVIDER = process.env.DEEPBLEND_PROBE_PROVIDER ?? StudioConfig({}).visualReviewProvider
const MODEL = process.env.DEEPBLEND_PROBE_MODEL ?? StudioConfig({}).visualReviewModel

if (!existsSync(PNG)) {
  console.error(`No PNG at ${PNG}. Render a preview first, or pass a path.`)
  process.exit(2)
}

const llmModule = await importDsh('dsh-llm')
const LlmRuntime = llmModule.default
const { createMessage } = llmModule
const LocalCredentialProvider = (await importDsh('dsh-credentials-local')).default
const FileSettingsProvider = (await importDsh('dsh-settings-file')).default
const LocalAttachmentStore = (await importDsh('dsh-attachment-local')).default
const deepSeek = await importDsh('dsh-llm-deepseek')

const root = new Context()
root.plugin(FileSettingsProvider, { path: join(DSH_HOME, 'settings.yaml'), dshHome: DSH_HOME })
root.plugin(LocalCredentialProvider, { path: join(DSH_HOME, '.credentials.yaml'), dshHome: DSH_HOME })
root.plugin(LocalAttachmentStore, {
  dshHome: DSH_HOME,
  normalizedImageMaxBytes: 4 * 1024 * 1024,
  normalizedImageMaxPixels: 4_000_000,
})
root.plugin(LlmRuntime)
// The adapter ships as a Cordis plugin with a NAMED `apply` export, and its
// `inject: ['llm']` declaration sits on the module namespace rather than on the
// function. Both facts matter for loading it:
//
//   root.plugin(deepSeek.apply)              -> "cannot get property llm without inject"
//   root.plugin(ctx => deepSeek.apply(ctx))  -> the registration is disposed with the
//                                               temporary fiber, so providers stay empty
//
// Handing Cordis the pair { apply, inject } is what makes the adapter's own
// dependency declaration apply. The API key is deliberately NOT inlined: only the
// credential reference is passed, exactly as a profile row would.
root.plugin({ apply: deepSeek.apply, inject: deepSeek.inject }, { apiKeyEnv: 'DEEPSEEK_API_KEY' })

await new Promise(settle => setTimeout(settle, 400))

const llm = root.get('llm')
const attachments = root.get('attachments')
if (llm === undefined || attachments === undefined) {
  console.error('llm or attachments service did not mount')
  process.exit(2)
}

console.log('providers:', JSON.stringify(llm.listProviders()))
const catalog = await llm.listModels(PROVIDER)
console.log('catalog:', JSON.stringify(catalog.map(m => ({ id: m.id, modalities: m.inputModalities }))))
const info = await llm.resolveModelInfo(PROVIDER, MODEL)
console.log('resolved route:', JSON.stringify({
  provider: PROVIDER, model: info.id, name: info.name,
  inputModalities: info.inputModalities, context: info.context,
}))

const bytes = readFileSync(PNG)
const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'probe-preview.png' })
console.log('saved attachment:', JSON.stringify(ref))
const request = await attachments.readImageRequest(ref, { maxPixels: 640_000, maxBytes: 1024 * 1024 })
console.log('request version:', JSON.stringify({
  variantId: String(request.variantId), mediaType: request.mediaType, bytes: request.bytes,
  width: request.width, height: request.height,
}))

const message = createMessage({
  role: 'user',
  content: [
    {
      type: 'text',
      text:
        'This is a rendered preview frame of a 3D scene. Answer in one short line, no preamble: ' +
        'what object is shown, what colour is its main body, and roughly where does it sit in the frame?',
    },
    { type: 'image', attachment: ref },
  ],
})

const started = Date.now()
const chunks = []
for await (const chunk of llm.stream({
  provider: PROVIDER,
  model: MODEL,
  messages: [message],
  // THE PRODUCT'S BUDGET TOO. MEASURED: at this probe's own 400-token budget the model spent all
  // of it on REASONING and emitted no text at all (`finish: max-tokens`, empty answer) — which is
  // the exact failure `visualReviewMaxTokens` exists to prevent, reproduced by the probe keeping a
  // second copy of a number the product already owns.
  maxTokens: StudioConfig({}).visualReviewMaxTokens,
})) {
  chunks.push(chunk)
}
const finish = chunks.find(chunk => chunk.type === 'finish')
const usage = chunks.find(chunk => chunk.type === 'usage')
const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')

console.log('elapsedMs:', Date.now() - started)
console.log('finish:', JSON.stringify(finish?.reason ?? null))
console.log('usage:', JSON.stringify(usage?.usage ?? null))
console.log('MODEL SAID:')
console.log(text)
process.exit(0)
