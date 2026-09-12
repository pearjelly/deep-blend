/**
 * @deepblend/dsh-blender-bundle
 *
 * This package is **patch-only**: it contributes no runtime plugin, no service
 * and no tool of its own. Its entire contribution is `cordis.patch.yml`,
 * declared through `dsh.bundle.patch` and composed by the profile boot before
 * the profile's own patch layer.
 *
 * The module exists so the package is a well-formed, importable ESM package —
 * an `exports` map with no `.` entry makes `require.resolve('@deepblend/dsh-blender-bundle')`
 * fail, which breaks tooling that introspects a profile's bundle list.
 *
 * The rows it inserts are:
 *   - `deepblend-blender-runtime` → `@deepblend/dsh-blender-provider-local`
 *   - `deepblend-blender-host`    → `@deepblend/dsh-blender-host`
 *   - `deepblend-blender-ui`      → `@deepblend/dsh-blender-ui`
 */

/** The bundle's patch file, relative to the package root. */
export const PATCH_FILE = 'cordis.patch.yml'

/** Row ids this bundle inserts, in composition order. */
export const ROW_IDS = Object.freeze([
  'deepblend-blender-runtime',
  'deepblend-blender-host',
  'deepblend-blender-ui',
])

export default { PATCH_FILE, ROW_IDS }
