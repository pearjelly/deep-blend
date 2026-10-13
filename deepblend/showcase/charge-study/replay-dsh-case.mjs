#!/usr/bin/env node
// Submit the packaged SceneSpec to the installed plugin in an existing DSH web runtime.
// This helper imports no DeepBlend implementation and runs no Blender or scene scripts.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.includes('--help') || !args.length) {
  console.log('Usage: node replay-dsh-case.mjs http://127.0.0.1:PORT [project-id]\nStart dsh web with deep-blend 0.5.0 installed first. This creates only the stage; continue with agent-prompt.zh.txt in DeepBlend Studio.')
  process.exit(0)
}
const url = new URL(args[0])
if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Use the local DSH web address')
const projectId = args[1] ?? 'charge-night-shift'
if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(projectId)) throw Error('Invalid project id')
const directory = dirname(fileURLToPath(import.meta.url))
const sceneSpec = JSON.parse(readFileSync(resolve(directory, 'industrial-stage.json'), 'utf8'))
sceneSpec.project.id = projectId
const request = {
  projectId, title: sceneSpec.project.title, goal: sceneSpec.project.goal,
  sceneSpec, creationKey: `charge-stage-050-${projectId}`, renderPreview: false,
}
const response = await fetch(new URL('/deepblend/projects', url.origin), {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(request), signal: AbortSignal.timeout(600000),
})
const result = await response.json()
const receipt = resolve(directory, `stage-receipt-${projectId}.json`)
writeFileSync(receipt, JSON.stringify({ method: 'POST', path: '/deepblend/projects', status: response.status, request, result }, null, 2) + '\n')
if (!response.ok || !result.ok) throw Error(`The DSH plugin refused the request. See ${receipt}`)
console.log(`DSH plugin created ${result.project.projectId} / ${result.project.revision?.revision ?? result.project.revision?.id ?? result.project.currentRevision}. Receipt: ${receipt}`)
console.log('Continue in the DeepBlend Studio session using agent-prompt.zh.txt; replace its project id and local asset path if needed.')
