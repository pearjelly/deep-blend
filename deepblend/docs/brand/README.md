# DeepBlend Studio brand assets

The orange cube mark and dark navy canvas identify DeepBlend Studio. The headline is
**Create. Refine. Render.** — a short description of the scene creation and revision workflow.

| Asset | Use | Size |
| --- | --- | --- |
| `logo.svg` / `logo.png` | Square project mark | 512 × 512 |
| `banner.svg` / `banner.png` | Repository, npm and market introduction | 1440 × 520 |
| `social-card.svg` / `social-card.png` | GitHub repository social preview | 1280 × 640 |

These are original project illustrations under the repository's MIT license. The mark continues the
project's existing orange cube design. The workflow cards are schematic artwork, not a screenshot or
Blender output. Actual renders have their own benchmark or tutorial provenance; interface captures
come from `capture-docs-images.mjs`.

SVGs use local Arial/Helvetica and Menlo/Consolas fallbacks, with no remote fonts, photos or Ruflo assets.
The SVG includes a subtle signal animation and respects `prefers-reduced-motion`; the PNG is a static
fallback for GitHub, npm and the plugin market.

```sh
npm run brand:render   # Rasterize the SVG sources and refresh manifest hashes
npm run brand:check    # Verify source/output hashes and PNG dimensions
```

`manifest.json` records the source SVG, output digest, dimensions and rendering tool. The bundle ships
an identical copy in `assets/`; the check also rejects a stale package copy. Raster text can vary with
installed fonts, so regenerate on the authoring machine and commit the resulting manifest together.
Keep the mark's proportions, maintain readable contrast, and label workflow illustrations honestly.
