/** The UI source is authoritative; the bundle entry changes only the factory's package ID. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './workspace-layout.mjs'
export function bundleClientSource(source) {
  const marker = "id: '@deepblend/dsh-blender-ui'"
  if (source.split(marker).length !== 2) throw Error('Expected exactly one canonical UI factory ID')
  return source.replace(marker, "id: '@deepblend/dsh-blender-bundle'")
}
const source = join(ROOT, 'packages/deepblend/ui/lib/client.js')
const target = join(ROOT, 'packages/deepblend/bundle/lib/client.js')
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expected = bundleClientSource(readFileSync(source, 'utf8'))
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== expected) throw Error('Bundle client differs from its canonical UI source; run npm run client:sync')
    console.log('Bundle client matches the authoritative UI implementation')
  } else { writeFileSync(target, expected); console.log('Bundle client synchronized from the authoritative UI source') }
}
