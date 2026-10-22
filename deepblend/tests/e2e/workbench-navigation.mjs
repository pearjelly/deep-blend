/** Open the workbench disclosures containing a control through their real summaries. */
export async function revealWorkbenchControl(page, selector) {
  await page.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`, 30000)
  for (let depth = 0; depth < 12; depth += 1) {
    const disclosure = await page.evaluate(`(() => {
      const control = document.querySelector(${JSON.stringify(selector)})
      const closed = []
      for (let parent = control?.parentElement; parent; parent = parent.parentElement) {
        if (parent.matches('details:not([open])')) closed.push(parent)
      }
      const outer = closed.at(-1)
      if (!outer) return null
      const key = outer.getAttribute('data-disclosure')
      if (!key) throw Error('Workbench disclosure has no stable identity')
      return key
    })()`)
    if (disclosure === null) {
      await page.waitFor(`(() => {
        const control = document.querySelector(${JSON.stringify(selector)})
        const rect = control?.getBoundingClientRect()
        return rect && rect.width > 0 && rect.height > 0 && getComputedStyle(control).visibility !== 'hidden'
      })()`, 30000)
      return
    }
    const container = `[data-disclosure=${JSON.stringify(disclosure)}]`
    const clicked = await page.click(`${container} > summary`)
    if (clicked.via !== 'pointer') throw Error(`Workbench disclosure is not reachable by pointer: ${disclosure}`)
    await page.waitFor(`document.querySelector(${JSON.stringify(container)})?.open === true`, 10000)
  }
  throw Error(`Too many nested workbench disclosures for ${selector}`)
}

/** Follow a disclosed control and require the actual pointer to reach it. */
export async function clickWorkbenchControl(page, selector) {
  await revealWorkbenchControl(page, selector)
  // A disclosure may move the creation fields above the gallery on the next paint.
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const clicked = await page.click(selector)
  if (clicked.via !== 'pointer') throw Error(`Workbench control is not reachable by pointer: ${selector}`)
  return clicked
}
