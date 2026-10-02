# Standalone content author

Copy this directory into a new Node.js 22+ project. Install the packed contracts
package, then run `node author.mjs resolved-scene.json`. The script validates an
authored scene, compiles defaults, applies a material patch, validates again, and
writes a deterministic SceneSpec. It starts no renderer and creates no revision.

From the repository, produce the package with:

```sh
npm pack ./packages/deepblend/contracts --pack-destination /absolute/output
```

In the copied directory:

```sh
npm init -y
npm install /absolute/output/deepblend-dsh-blender-contracts-0.2.20.tgz
node author.mjs resolved-scene.json
```

All imports use `@deepblend/dsh-blender-contracts/sdk`. No workspace links or
private `lib/` imports are required. To use TypeScript, import `SceneSpec`,
`ScenePatch`, `RecipeManifest`, and `BlenderRuntime` with `import type` from the
same entry. Install TypeScript and Node.js declarations in your own development
environment. See [the public API guide](../../docs/public-api.md) for recipes,
runtime lifecycle, version boundaries, and the strict external-consumer check.

This is a maintained example and package-boundary test, not evidence of an
independent project's adoption or of a successful artistic render.
