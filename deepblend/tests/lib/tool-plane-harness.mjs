/**
 * Compose the DeepBlend tool plane against a stub host, in one process, without Blender.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two questions about the tool plane can only be answered by RUNNING the tools, and neither
 * needs a real `blenderStudio`:
 *
 *   1. WHAT DOES THE PLANE DO WHEN THE HOST IS OLDER THAN THE TOOLS?
 *      (`contract/host-plane-staleness.test.mjs`) The answer is a coded deployment diagnosis,
 *      and the only way to produce it is to give the tools a service that lacks the new
 *      methods.
 *   2. WHAT DOES A TOOL HAND THE MODEL AND THE UI WHEN SOMETHING FAILS — and what card title
 *      does it hand the UI plane? (`contract/tool-plane-output.test.mjs`) The M1 failures and
 *      every `presentCall` were dark in the coverage reading for six rounds, because the only
 *      suite that drives these tools needs a real Blender host and therefore only ever reaches
 *      the success paths.
 *
 * Both callers need the same three things — a `tools` registry that records definitions, a
 * `blenderStudio` the caller controls, and the tool package composed into a `Context` — so they
 * live here. A second copy of "how do you stand up the tool plane" is the shape of defect this
 * repository keeps paying for (D38/D43/D57/D60); the previous copy was in
 * `host-plane-staleness.test.mjs` and this module replaced it (D127).
 *
 * WHY IT SETTLES INSTEAD OF AWAITING A PROMISE
 * --------------------------------------------
 * `ctx.plugin()` returns when the plugin is APPLIED, but the tool package's own apply is what
 * registers the definitions, and a service it waits for resolves on a later tick. So the caller
 * waits for the definitions to appear — polling rather than a fixed sleep, because a fixed sleep
 * is a race that passes on a fast machine and fails on a loaded one (the M4 browser suite paid
 * for that lesson twice).
 *
 * Owner: DeepBlend Studio — M5
 */

import { Context } from '@deepseek-ai/cordis'

/** The maximum time to wait for the tool package to register anything at all. */
const REGISTER_TIMEOUT_MS = 2_000
const POLL_INTERVAL_MS = 10

/**
 * A `tools` registry that records what the plane registers.
 *
 * `execute` is the shape the harness itself uses (`{ name, arguments, callId, signal }`), and the
 * `exec` object a definition receives carries the fields the tools read. An unknown tool throws
 * rather than returning a result: a test that mistypes a tool name must fail loudly, not read as
 * "the tool refused".
 *
 * @param {string} label - the plugin name, so a composition error names its own harness.
 * @returns {{ registered: Map<string, object>, name: string, apply: (ctx: object) => void }}
 */
export function toolRegistryStub(label = 'tool-plane-harness') {
  const registered = new Map()
  return {
    registered,
    name: label,
    apply(ctx) {
      ctx.provide('tools', {
        register(definition) {
          registered.set(definition.name, definition)
          return () => registered.delete(definition.name)
        },
        get: name => registered.get(name),
        schemas: () => [...registered.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
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
            return { isError: false, value, content: definition.output.render(input.arguments ?? {}, value) }
          } catch (error) {
            return {
              isError: true,
              error: { message: error?.message ?? String(error), info: { code: error?.code ?? 'UNKNOWN' } },
              content: [],
            }
          }
        },
      })
    },
  }
}

/**
 * Compose the tool plane: a stub registry, a stub `blenderStudio`, and the real tool package.
 *
 * @param {object} input
 * @param {object} input.studio - the service the tools resolve; the caller owns every method.
 * @param {string} [input.label] - the registry plugin's name.
 * @param {number} [input.expectAtLeast] - how many definitions to wait for before returning.
 * @returns {Promise<{ tools: object, registered: Map<string, object>, ctx: object }>}
 */
export async function composeToolPlane({ studio, label = 'tool-plane-harness', expectAtLeast = 1, services = {} }) {
  const driver = toolRegistryStub(label)
  const root = new Context()
  root.plugin(driver)
  root.plugin({
    name: `${label}-fixture`,
    apply(ctx) {
      ctx.provide('blenderStudio', studio)
      // OPTIONAL COMPOSED SERVICES, so a caller can drive a tool's dependency rather than only its
      // absence. The first caller is the approval gate: whether the operator is ASKED is a different
      // question from what the prompt says when nobody can be asked (`dependency-absent-answers.test.mjs`
      // owns the second), and answering the first used to mean building a second composition recipe here.
      for (const [name, value] of Object.entries(services)) ctx.provide(name, value)
    },
  })
  root.plugin(await import('@deepblend/dsh-blender-tool'))

  const deadline = Date.now() + REGISTER_TIMEOUT_MS
  while (driver.registered.size < expectAtLeast && Date.now() < deadline) {
    await new Promise(settle => setTimeout(settle, POLL_INTERVAL_MS))
  }
  return { tools: root.get('tools'), registered: driver.registered, ctx: root }
}
