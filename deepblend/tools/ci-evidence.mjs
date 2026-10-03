#!/usr/bin/env node
/** Initialize evidence only after GitHub has assigned a runner. */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { arch, platform, release } from 'node:os'

if (!process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) throw new Error('CI evidence requires RUNNER_TEMP and GITHUB_ENV')
const directory = join(process.env.RUNNER_TEMP, 'deepblend-ci')
mkdirSync(directory, { recursive: true })
appendFileSync(process.env.GITHUB_ENV, `DEEPBLEND_CI_EVIDENCE=${directory}\n`)
writeFileSync(join(directory, 'context.json'), JSON.stringify({
  sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
  imageVersion: process.env.ImageVersion ?? null, platform: platform(), arch: arch(), release: release(), node: process.version,
}, null, 2) + '\n')
console.log(`Evidence directory: ${directory}`)
