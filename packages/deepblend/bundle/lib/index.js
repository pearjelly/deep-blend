/**
 * Installable composition and UI entry for DeepBlend.
 * Profile discovery reads dsh.bundle.patch without mounting this module.
 * The patch mounts this package root once as the UI plane, giving the client
 * scanner an exact package identity. Other planes use exported wrappers whose
 * imports resolve from this package's own dependencies in every install route.
 * The optional doctor executable runs only when explicitly invoked.
 */

/** The bundle's patch file, relative to the package root. */
export const PATCH_FILE = 'cordis.patch.yml'

/** Row ids this bundle inserts, in composition order. */
export const ROW_IDS = Object.freeze([
  'deepblend-blender-runtime',
  'deepblend-blender-host',
  'deepblend-blender-ui',
])

// This entry is mounted only by the UI row; bundle discovery still reads dsh.bundle.patch.
export * from '@deepblend/dsh-blender-ui'
export { default } from '@deepblend/dsh-blender-ui'
