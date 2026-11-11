# Building inspectable models

[简体中文](modeling.md) · [Object editing](usage.en.md#edit-an-existing-object)

Detail starts with silhouette, structure, thickness and seams. More render samples reduce noise; they do not repair the model. Use the workbench's object editor for supported dimensions, profile/path points and ordered operations, then apply and inspect the saved version. The UI uses millimeters/degrees. The examples below use meters/radians, with one scene unit interpreted as one meter. Object scale affects the final dimensions.

## Revolved profiles

`lathe` revolves a `[radius, height]` boundary around local Z. For an open vessel with an inner wall and a base:

```json
{
  "id": "cup-body",
  "type": "generator",
  "generator": {
    "shape": "lathe",
    "segments": 96,
    "profile": [[0, 0], [0.04, 0], [0.045, 0.09], [0.041, 0.09], [0.036, 0.004], [0, 0.004]],
    "capEnds": true
  },
  "materialId": "ceramic"
}
```

First define `ceramic` with `material.add`, then add this entity with `entity.add`. The boundary runs from the outer base up to the lip and back down the inner wall. This example leaves an open mouth and a 4 mm base. Its six points explain the structure; a rounded product needs denser sampling along curved sections.

| Parameter | Meaning and limits |
| --- | --- |
| `profile` | 2–128 boundary points; nonnegative radii, no self-intersection or reversal. Axis points belong only at the ends. |
| `segments` | Circumferential segments, default 96, maximum 512. More segments do not smooth a coarse vertical profile. |
| `capEnds` | Default true; caps end rings with nonzero radius. False permits open tube ends. |
| `closedProfile` | Default false; true joins the final point to the first. Do not repeat the first point. |
| `bevel` | Rounds sharp generated edges using a width in local units. |

Profile segments are straight. U follows the circumference and V follows profile arc length; end caps use planar UVs. Repeated points, zero radius everywhere, zero height, negative radii and self-intersection are rejected.

## A connected handled cup

`handled_cup` builds an open cup with inner wall, rounded lip/base and a semicircular handle in one closed connected mesh. Its two roots share boundaries with the cup wall and use quintic transitions. It is intended for cylindrical ceramic cups; other silhouettes require their own construction.

```json
{ "id": "cup", "type": "generator", "generator": { "shape": "handled_cup" }, "materialId": "ceramic" }
```

The default radius is 40 mm, height 105 mm, wall 3 mm and base 5 mm. The handle section radius is 5.5 mm, root centers are at 28/78 mm height, root radius is 10.5 mm and transition length is 8 mm.

| Parameter | Default and supported range |
| --- | --- |
| `radius` / `height` | 0.04 / 2.625 × radius; radius 0.02–0.08, height 1.8–4 × radius |
| `wallThickness` / `baseThickness` | 0.075 / 0.125 × radius; allowed 0.025–0.15 / 0.05–0.25 × radius |
| `footRound` | min(wall thickness, 0.8 × base thickness); 0.01–0.15 × radius, also no larger than that minimum |
| `handleRadius` | 0.1375 × radius; allowed 0.05–0.2 × radius |
| `handleLower` / `handleUpper` | 4/15 / 26/35 × height; local Z coordinates of the root centers |
| `rootRadius` | 0.2625 × radius; allowed 0.12–0.35 × radius and 1.4–3 × handle section radius |
| `rootLength` | 0.2 × radius; allowed 0.4–1.2 × root radius |
| `rootTension` | Dimensionless; default 1, allowed 1–2.5 |
| `segments` | Wall circumference: default 192; 64–256, multiple of 4 |
| `sectionSegments` | Lip/handle section: default 96; 32–96, multiple of 4 |
| `handleSegments` | Handle arc: default 96; 24–128, multiple of 4 |
| `rootSegments` / `wallRows` | Default 32 / 40; integer ranges 8–48 / 16–64 |

These constraints interact. Half the root-center separation must be at least 1.1 × root radius and 2 × handle section radius. Transition length cannot exceed 0.8 × that half separation. The lower root must clear the base round plus 0.01 × cup radius; the upper root must lie below the cup height minus half wall thickness and 0.01 × cup radius. A single valid-looking dimension can still make the combination invalid. Defaults derive from radius/height; the editor saves explicit effective parameters.

`rootTension` changes endpoint parameter speeds of the transition; second derivatives scale with speed squared while adjoining surfaces/positions stay fixed. Value 1 preserves the original transition; higher values spread it. The glazed cup recipe 3.0.0 explicitly uses 2.5; recipe 2.0.0 used 1.5. Older scenes without the field use 1. Non-default values require `geometry.handled_cup.tension`; values above 1.5 additionally require `geometry.handled_cup.tension.extended`. Older consumers reject unsupported requirements.

The constructor checks connectivity, closure, topology, positive volume, triangle area, UVs, corner normals and illegal intersections within explicit tolerances/budgets. Analytic surface normals reduce triangulation highlights, but do not establish artistic quality. These checks do not prove the full continuous parameter domain, manufacturing wall thickness or a curvature-continuity grade. Later transforms/modifiers need their own final-result checks.

Use the [complete cup fixture](../fixtures/handled-cup/scene-spec.json) for fixed lighting, three cameras and glaze. Inspect roots/interior in clay, then inspect highlights in beauty. Maintainers can reproduce the finite [parameter matrix](../fixtures/handled-cup/parameter-cases.json):

```bash
blender --background --factory-startup --python-exit-code 1 \
  --python deepblend/tools/check-handled-cup.py -- /absolute/fresh/cup-check
```

The output directory must be new. The tool records actual source, runtime, inputs and per-case results. Reference mesh hashes require exact agreement only for the recorded Blender build/platform/architecture; other runtimes still need to pass geometry checks. Passing finite cases does not establish universal shape quality.

## Curves for handles, cables and hoses

`curve` sweeps a circular section along local 3D points:

```json
{
  "id": "handle",
  "type": "generator",
  "generator": {
    "shape": "curve",
    "path": [[0.04, 0, 0.08], [0.075, 0, 0.085], [0.085, 0, 0.045], [0.04, 0, 0.015]],
    "radius": 0.005,
    "pathInterpolation": "bezier",
    "curveResolution": 24,
    "bevelResolution": 8,
    "capEnds": true
  },
  "materialId": "ceramic"
}
```

`path` has 2–128 points; closed paths need at least three, without repeating the first. `radius` defaults to 0.01. `pathInterpolation` defaults to `poly`; `bezier` uses automatic smooth handles and may extend beyond the polyline. `curveResolution` defaults to 16 (1–64); `bevelResolution` controls circular section resolution, default 8 (0–16). It is distinct from a sharp-edge bevel. `pathClosed` defaults false and `capEnds` defaults true; closed paths have no end caps.

Output is a real UV mesh with welded cap rims. Consecutive duplicate points and path reversals are rejected. Complex curves can still self-intersect, and overlap with another entity does not weld them. Arbitrary-section sweeps are not implemented.

## Mesh control geometry and subdivision

`shape:"mesh"` accepts numeric local `vertices`, winding-preserving zero-based `faces` and optional per-corner `faceUvs`. Each face has 3–32 distinct indices. Budgets are 32,768 vertices, 32,768 faces and 131,072 corners, with coordinate magnitude at most 1,000,000. Duplicate faces, invalid indices, degenerate area and mismatched UVs are rejected. Omitted UVs get planar defaults; inspect them before applying directional textures. `smooth` defaults false and changes normal interpolation.

The subdivision modifier accepts `levels:1|2|3`, `scheme:"catmull-clark"|"simple"` (default Catmull–Clark) and `boundaryMode:"all"|"preserve-corners"` (default all). It applies to the saved real mesh while retaining the editable control mesh in SceneSpec. Estimated output above 500,000 faces per entity is rejected before allocation. Mesh and subdivision require their declared runtime features; an old runtime refuses them.

## Ordered modeling operations

`entity.generator.set` replaces a generator definition. `entity.modifiers.set` replaces the ordered operation array; `[]` clears it. Both retain identity, transform, material and animation references. Generator replacement requires a generator entity; empty entities cannot receive either edit. The full scene is validated before saving.

At most eight modifiers run in order and are baked before animation/simulation. A generator's own bevel runs first. To round boolean-created edges, put a separate bevel **after** the boolean.

| Operation | Parameters and behavior |
| --- | --- |
| `solidify` | Nonzero local `thickness`; `offset` −1 to 1, default −1 (inward) |
| `mirror` | Local origin, `axis` x/y/z; `merge` defaults true |
| `array` | `count` 2–64, nonzero local displacement `offset`; object rotation/scale apply afterward |
| `boolean` | `operation` union/difference/intersect and another `targetEntityId` |
| `bevel` | Positive local `width`, `segments` 1–16 (default 4), `angle` 0–180 degrees (default 30); `miterInner` arc/sharp, default arc |
| `subdivision` | Levels/scheme/boundary handling as above |

```json
{
  "modifiers": [
    { "type": "boolean", "operation": "difference", "targetEntityId": "bore-cutter" },
    { "type": "bevel", "width": 0.001, "segments": 4, "angle": 30, "miterInner": "sharp" }
  ]
}
```

Declare the cutter as a separate intersecting closed entity; it may be hidden so it participates without appearing twice. `miterInner` controls how inner bevel junctions meet; the edge still uses width/segments. Omitted values preserve arc. Sharp improved the tested curved-bore fixture, but does not guarantee all boolean seams or handle roots. The generator's own bevel does not accept this field.

Boolean targets finish their own operations first, independent of list order. Cyclic dependencies and deleting a referenced target are rejected. Each participating entity must have exactly one mesh; split multi-mesh imports first. Empty boolean output is an error. The 500,000-face limit applies after each operation, with early estimates for arrays/subdivision. Bevel overlap limiting can reduce the realized width; more segments cannot fix that.

Use consistently oriented shells for solidify and closed, non-self-intersecting boolean inputs. Check thin walls, narrow faces, intersections and normal direction. A union removes internal overlap but does not automatically sculpt a rounded ceramic root. For arrays along world directions, transform the desired displacement through the full inverse local basis; dividing by scale alone is insufficient.

## Repeating-texture UVs

Use `entity.uv.project` on a mesh generator whose faces are planar. `quarterTurns` is 0–3, default 0; `scale` is 0.0001–10000, default 1. U follows each face's longest local edge and V lies perpendicular in that face. UV coordinates rotate counterclockwise by the requested quarter turns. One shared normalization uses the control mesh's longest local bounding span, preserving face proportions and relative density. `scale` sets repeats across that span; transforms and modifiers apply afterward.

This reconstructs `faceUvs` without changing geometry, transforms, materials or photography. Non-planar faces are rejected. Islands may overlap: this is for repeating textures, not atlas packing, seamless cross-face painting or arbitrary curved unwrapping. It does not detect the woodgrain direction in the image. Save, inspect the actual material, and adjust orientation if needed. See the [original UV evidence](mesh-uv-projection.md).

## What to inspect

1. Clay from several views: proportions, silhouette and member placement.
2. Geometry close-ups: rounds, wall thickness, seams, overlaps and interior construction.
3. Materials/light: highlights describing the shape, credible texture density and contact shadows.
4. Animation frames: interpenetration, cropping and visible details over time.

The [Chinese companion](modeling.md) retains native reproduction commands and their historical scope. The [English tool guide](tool-contracts.en.md) explains saved edits and measurements. Technical checks and exposure/composition scores support this inspection; they do not replace your goal/reference comparison.
