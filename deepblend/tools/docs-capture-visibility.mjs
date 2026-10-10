/** Read the browser's actual visible surface before publishing a workbench screenshot. */
import { dismissFirstRunDialogs } from './dsh-web-harness.mjs'

// Evaluated in the real page; keep it free of module closures.
export function workbenchCaptureState() {
  const root = document.querySelector('[data-deepblend-panel=deepblend]')
  if (!root) return { ok: false, reason: 'workbench missing' }
  const rect = root.getBoundingClientRect()
  const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2
  const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2
  const hit = document.elementFromPoint(x, y)
  const dialogs = [...document.querySelectorAll('[role=dialog], dialog[open]')]
    .filter(node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')
  return { ok: rect.width > 0 && rect.height > 0 && root.contains(hit) && dialogs.length === 0,
    centerUnobstructed: root.contains(hit), visibleDialogs: dialogs.length }
}

export async function ensureWorkbenchCaptureReady(page) {
  await dismissFirstRunDialogs(page)
  const state = await page.evaluate(`(${workbenchCaptureState.toString()})()`)
  if (!state.ok) throw Object.assign(new Error('Workbench screenshot blocked: ' + JSON.stringify(state)), { code: 'DOCS_CAPTURE_BLOCKED' })
  return state
}
