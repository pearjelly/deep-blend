#!/usr/bin/env node
/** Select Cycles' official Metal device override before the installed plugin runs.
 * This launcher changes render-device selection only; SceneSpec still owns the scene.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const binary = process.env.DEEPBLEND_BLENDER_BINARY ?? resolve(import.meta.dirname, '../../.tools/Blender.app/Contents/MacOS/Blender')
const args = process.argv.slice(2)
const index = args.indexOf('--factory-startup')
if (index >= 0) args.splice(index + 1, 0, '--python-expr', "import _cycles; assert _cycles.set_device_override('METAL'), 'Metal render-device override unavailable'")
const run = spawnSync(binary, args, { stdio: 'inherit', env: process.env })
if (run.error) throw run.error
process.exit(run.status ?? 1)
