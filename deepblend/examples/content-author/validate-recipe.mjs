#!/usr/bin/env node
/** Standalone, read-only recipe submission check using the public SDK. */
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import metadata from '@deepblend/dsh-blender-contracts/package.json' with { type: 'json' }
import {
  RECIPE_LIMITS, validateRecipePackage, instantiateRecipe, recipeCapabilitiesForScene,
  sceneSpecDigest, sha256,
} from '@deepblend/dsh-blender-contracts/sdk'

const scope = {
  checked: 'Package bytes, license text presence, declared capabilities, defaults, each parameter endpoint independently, and explicit parameter refusals.',
  unverified: ['Blender compilation and mesh validity', 'rendered preview correspondence', 'artistic quality', 'author identity and license rights', 'all parameter combinations'],
}
const report = { schemaVersion: 'deepblend.recipe-author-report/v1', status: 'failed',
  runtime: { node: process.version, contractsVersion: metadata.version }, scope,
  files: [], variants: [], refusals: [], errors: [] }
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

function readBounded(path, limit) {
  const before = lstatSync(path)
  if (before.isSymbolicLink() || !before.isFile()) fail('AUTHOR_FILE_INVALID', 'Input must be a regular file without a symbolic link')
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) fail('AUTHOR_FILE_LIMIT', `Input byte count must be in [1, ${limit}]`)
    const buffer = Buffer.alloc(limit + 1)
    let length = 0, count
    do { count = readSync(descriptor, buffer, length, buffer.length - length, null); length += count } while (count && length < buffer.length)
    if (!length || length > limit) fail('AUTHOR_FILE_LIMIT', 'Input changed beyond its byte limit while reading')
    return Buffer.from(buffer.subarray(0, length))
  } finally { closeSync(descriptor) }
}

function text(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { fail('AUTHOR_TEXT_INVALID', 'Text input must contain valid UTF-8') }
}
function json(bytes, label) {
  try { return JSON.parse(text(bytes)) }
  catch { fail('AUTHOR_JSON_INVALID', `${label} must contain valid UTF-8 JSON`) }
}

function variant(bundle, name, parameters) {
  const result = instantiateRecipe(bundle, parameters)
  report.variants.push({ name, parameters, values: result.values,
    sceneDigest: sceneSpecDigest(result.spec), valuesSha256: result.recipe.valuesSha256,
    notices: result.notices })
}

function refusal(bundle, name, parameters, expectedCode) {
  try { instantiateRecipe(bundle, parameters) }
  catch (error) {
    if (error.code !== expectedCode) throw error
    report.refusals.push({ name, parameters, code: error.code }); return
  }
  fail('AUTHOR_REFUSAL_FAILED', `${name} unexpectedly succeeded`)
}

const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node validate-recipe.mjs <recipe-directory> [--parameters <values.json>]\nOutputs one JSON report to stdout; exit 0 means the listed data checks passed. Files are read only. Blender/render/artistic checks remain required.')
} else {
  try {
    if (!(args.length === 1 || (args.length === 3 && args[1] === '--parameters')) || args[0].startsWith('--')) {
      fail('AUTHOR_ARGUMENT_INVALID', 'Expected <recipe-directory> [--parameters <values.json>]; use --help')
    }
    const directory = resolve(args[0]), stat = lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('AUTHOR_DIRECTORY_INVALID', 'Recipe must be a real directory without a symbolic link')
    const bytes = {}
    for (const [name, limit] of [['recipe.json', 65536], ['scene-spec.json', RECIPE_LIMITS.sceneBytes],
      ['preview.png', RECIPE_LIMITS.previewBytes], ['LICENSE', 65536]]) {
      bytes[name] = readBounded(join(directory, name), limit)
      report.files.push({ name, bytes: bytes[name].length, sha256: sha256(bytes[name]) })
    }
    if (!text(bytes.LICENSE).trim()) fail('AUTHOR_LICENSE_EMPTY', 'LICENSE must contain non-empty UTF-8 text; license rights still require review')
    const bundle = { manifest: json(bytes['recipe.json'], 'recipe.json'),
      sceneBytes: bytes['scene-spec.json'], previewBytes: bytes['preview.png'] }
    const checked = validateRecipePackage(bundle)
    if (!checked.ok) throw Object.assign(new Error(checked.summary), { code: checked.errors[0].code, issues: checked.errors })
    report.package = { id: bundle.manifest.id, version: bundle.manifest.version,
      manifestSha256: sha256(bytes['recipe.json']), license: bundle.manifest.license,
      author: bundle.manifest.author, source: bundle.manifest.source }
    report.capabilities = { declared: bundle.manifest.compatibility.capabilities,
      used: recipeCapabilitiesForScene(checked.sceneSpec) }
    report.preview = { width: bundle.previewBytes.readUInt32BE(16), height: bundle.previewBytes.readUInt32BE(20) }
    variant(bundle, 'default', {})
    for (const parameter of bundle.manifest.parameters) {
      const endpoints = parameter.type === 'color'
        ? [['black', [0, 0, 0]], ['white', [1, 1, 1]]]
        : [['minimum', parameter.minimum], ['maximum', parameter.maximum]]
      for (const [name, value] of endpoints) variant(bundle, `${parameter.id}:${name}`, { [parameter.id]: value })
      refusal(bundle, `${parameter.id}:invalid-type`, { [parameter.id]: 'invalid' }, 'RECIPE_PARAMETER_INVALID')
      refusal(bundle, `${parameter.id}:outside-range`, { [parameter.id]: parameter.type === 'color' ? [1.1, 0, 0] : parameter.maximum + 1 }, 'RECIPE_PARAMETER_INVALID')
    }
    let unknown = 'unlisted-parameter'
    while (bundle.manifest.parameters.some(parameter => parameter.id === unknown)) unknown += '-x'
    refusal(bundle, 'unknown-parameter', { [unknown]: 0 }, 'RECIPE_PARAMETER_UNKNOWN')
    if (args.length === 3) {
      const selected = readBounded(resolve(args[2]), 65536)
      report.parameterInput = { bytes: selected.length, sha256: sha256(selected) }
      variant(bundle, 'selected', json(selected, 'Parameter input'))
    }
    report.status = 'passed'
  } catch (error) {
    report.errors = error.issues ?? error.details?.errors ?? [{ code: error.code ?? 'AUTHOR_CHECK_FAILED', path: '', message: error.message }]
    process.exitCode = 1
  }
  console.log(JSON.stringify(report, null, 2))
}
