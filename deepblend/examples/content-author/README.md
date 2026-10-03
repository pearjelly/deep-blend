# Standalone content author

Copy this directory into a new Node.js 22+ project. Install the packed contracts
package, then run `node author.mjs resolved-scene.json`. The script validates an
authored scene, compiles defaults, applies a material patch, validates again, and
writes a deterministic SceneSpec. It starts no renderer and creates no revision.

`validate-recipe.mjs` checks a recipe directory you choose, using the same public
package. It reads `recipe.json`, `scene-spec.json`, `preview.png` and `LICENSE`,
then prints one JSON report to stdout. It does not change those files.

From the repository, produce the package with:

```sh
npm pack ./packages/deepblend/contracts --pack-destination /absolute/output
```

In the copied directory:

```sh
npm init -y
npm install /absolute/output/deepblend-dsh-blender-contracts-0.2.20.tgz
node author.mjs resolved-scene.json
node validate-recipe.mjs /absolute/my-product
```

To save a submission report or check chosen values:

```sh
node validate-recipe.mjs /absolute/my-product > recipe-report.json
node validate-recipe.mjs /absolute/my-product --parameters values.json > selected-report.json
```

Keep report files outside the recipe directory. `values.json` contains an object
keyed by parameter ID, for example `{ "surface-roughness": 0.3 }`. Exit status 0
means all checks named in the report passed; status 1 includes structured errors.
Use `--help` for the accepted arguments. The report records the actual input
byte counts and hashes, SDK/Node versions, declared/used capabilities, preview
size, and scene/value hashes for each instantiated variant.

The finite checks cover defaults, each numeric minimum/maximum separately and
each color's black/white values separately, with other parameters at defaults.
They also verify that invalid types, out-of-range and unknown parameters are
refused. Chosen values add one variant. These checks do not cover every RGB value
or every parameter combination. A non-empty UTF-8 `LICENSE` proves that text is
present; it does not verify rights, identity or the truth of the license claim.

Package and member symbolic links are refused. Reads are bounded: manifest,
license and chosen-values files are at most 64 KiB; SceneSpec and PNG use the
public SDK's package limits. No declared source URLs are fetched. For a PR,
include the four package files and the report, plus actual Blender construction
and render evidence. Review the default render and the chosen parameters; data
validation does not prove geometry, preview correspondence or artistic quality.
See [recipe submission and versioning](../../docs/recipes.md#提交版本与验证).

All imports use `@deepblend/dsh-blender-contracts/sdk`. No workspace links or
private `lib/` imports are required. To use TypeScript, import `SceneSpec`,
`ScenePatch`, `RecipeManifest`, and `BlenderRuntime` with `import type` from the
same entry. Install TypeScript and Node.js declarations in your own development
environment. See [the public API guide](../../docs/public-api.md) for recipes,
runtime lifecycle, version boundaries, and the strict external-consumer check.

This is a maintained example and package-boundary test, not evidence of an
independent project's adoption or of a successful artistic render.
