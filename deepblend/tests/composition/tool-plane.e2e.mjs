/**
 * M0 preset-plane tool test.
 *
 * Proves the OTHER half of the vertical slice from `activation.e2e.mjs`:
 *
 *   @deepblend/dsh-blender-tool (agent preset plane)
 *     → registers `blender_capabilities` into the `tools` registry
 *     → resolves `blenderStudio` from the scope
 *     → executes against the real Blender binary
 *     → returns Canonical JSON
 *
 * The host composition is supplied exactly as the bundle composes it, so the
 * only thing stubbed is DSH's own tool registry seam — and only the three
 * methods this test needs, so the assertions stay about DeepBlend's behaviour
 * rather than about DSH internals.
 *
 * It also covers the degradation path that matters operationally: when the
 * DeepBlend Host Bundle is NOT composed, the tool must still be visible and must
 * fail with a stable, explanatory code instead of throwing or silently passing.
 *
 * Run: node deepblend/tests/composition/tool-plane.e2e.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = import.meta.dirname
const PROJECT_ROOT = resolve(HERE, '..', '..', '..')
const BLENDER_PATH = process.env.DEEPBLEND_BLENDER_PATH
  ?? join(PROJECT_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

/**
 * Minimal stand-in for the `tools` registry seam: it records registrations and
 * dispatches a call through the definition's own output contract, which is all
 * the assertions below observe.
 */
function toolRegistryStub() {
  const registered = new Map()
  return {
    name: 'tool-registry-stub',
    apply(ctx) {
      ctx.provide('tools', {
        register(definition) {
          if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
          registered.set(definition.name, definition)
          return () => registered.delete(definition.name)
        },
        get(name) {
          return registered.get(name)
        },
        schemas() {
          return [...registered.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
        },
        async execute(input) {
          const definition = registered.get(input.name)
          if (definition === undefined) throw new Error(`UNKNOWN_TOOL ${input.name}`)
          try {
            const value = await definition.execute(input.arguments ?? {}, {
              ...input,
              def: definition,
              deferContext() {},
              concludeTurn() {},
            })
            return { isError: false, value, content: definition.output.render(input.arguments, value) }
          } catch (error) {
            return {
              isError: true,
              error: { message: error?.message ?? String(error), info: { name: 'BlenderError', code: error?.code ?? 'UNKNOWN' } },
              content: [],
            }
          }
        },
        restrict() { return () => {} },
        guard() { return () => {} },
      })
    },
  }
}

const root = new Context()

try {
  root.plugin(toolRegistryStub())
  root.plugin(LocalSubprocess)
  // The DeepBlend Host half, composed exactly as the bundle does it.
  root.plugin(
    (await import('@deepblend/dsh-blender-provider-local')).default,
    {
      blenderPath: BLENDER_PATH,
      bootstrapPath: join(PROJECT_ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py'),
      workspaceRoot: join(PROJECT_ROOT, '.deepblend'),
      timeoutMs: 180_000,
      maxOutputBytes: 1024 * 1024,
      maxSpillBytes: 64 * 1024 * 1024,
      executableAllowlist: [join(PROJECT_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS')],
      capabilitiesCacheMs: 60_000,
      keepWorkingDirectory: false,
    },
  )
  root.plugin((await import('@deepblend/dsh-blender-host')).default, {
    projectsRoot: join(PROJECT_ROOT, '.deepblend', 'projects'),
    serveCachedCapabilities: true,
  })
  // ...and the agent-preset row.
  root.plugin(await import('@deepblend/dsh-blender-tool'))

  await new Promise(resolveTick => setTimeout(resolveTick, 400))

  const tools = root.get('tools')
  const definition = tools?.get('blender_capabilities')
  check('preset row registers the model-visible tool', definition !== undefined, definition?.name)
  check(
    'tool exposes a description the model can act on',
    typeof definition?.description === 'string' && definition.description.length > 60,
    definition?.description?.slice(0, 60),
  )
  check('tool exposes a parameters schema', typeof definition?.parameters === 'object')
  check(
    'tool schema exposes only the refresh parameter',
    JSON.stringify(Object.keys(definition?.parameters?.properties ?? {})) === '["refresh"]',
    Object.keys(definition?.parameters?.properties ?? {}),
  )

  if (tools !== undefined && definition !== undefined) {
    const result = await tools.execute({
      callId: 'm0-tool-plane',
      name: 'blender_capabilities',
      arguments: { refresh: true },
      signal: AbortSignal.timeout(180_000),
    })
    check('tool call succeeds', result.isError === false, result.isError ? JSON.stringify(result.error) : undefined)
    check(
      'tool result carries Canonical JSON with real Blender data',
      result.value?.data?.installed === true && typeof result.value?.data?.version === 'string',
      { installed: result.value?.data?.installed, version: result.value?.data?.version },
    )
    check(
      'tool text is model-readable and names the usable engines',
      typeof result.value?.text === 'string'
        && result.value.text.includes('CYCLES')
        && result.value.text.includes('Canonical JSON:'),
    )
    check(
      'tool result propagates the behavioural engine verdict',
      result.value?.data?.engines?.CYCLES?.available === true,
      result.value?.data?.engines?.CYCLES,
    )
  }

  // --- degradation path: no host bundle composed -----------------------------
  const orphan = new Context()
  orphan.plugin(toolRegistryStub())
  orphan.plugin(await import('@deepblend/dsh-blender-tool'))
  await new Promise(resolveTick => setTimeout(resolveTick, 200))

  const orphanTools = orphan.get('tools')
  check(
    'tool stays registered even when the host bundle is absent',
    orphanTools?.get('blender_capabilities') !== undefined,
  )
  if (orphanTools !== undefined) {
    const degraded = await orphanTools.execute({
      callId: 'm0-tool-plane-orphan',
      name: 'blender_capabilities',
      arguments: {},
      signal: AbortSignal.timeout(10_000),
    })
    check(
      'absent host bundle yields a stable, explanatory failure (not a throw)',
      degraded.isError === false
        && degraded.value?.data?.code === 'BLENDER_RUNTIME_UNAVAILABLE'
        && degraded.value.text.includes('dsh-blender-bundle'),
      degraded.value?.data?.code,
    )
  }
  await orphan.stop?.()
} catch (cause) {
  check('tool-plane run completed without an unexpected throw', false, cause?.stack ?? String(cause))
} finally {
  await root.stop?.()
}

const failed = results.filter(entry => !entry.ok)
console.log('')
console.log(`M0 preset tool plane: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('Failed checks:')
  for (const entry of failed) console.log(`  - ${entry.name}`)
  process.exit(1)
}
process.exit(0)
