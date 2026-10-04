# Reference images for DeepBlend review

Use this workflow when a design goal includes photographs, sketches or material
examples. References guide artistic review; they do not become geometry, material
maps or environment lighting unless explicitly bound for those separate uses.

## Save the target before reviewing

1. Read the current revision with `blender_scene_get`. Identify what each image
   should guide: `geometry`, `materials`, `lighting` or `goalFit`.
2. Import the image using `blender_asset_ingest {projectId, sourcePath}`. A remote
   `sourceUrl` uses that tool's existing approval flow. Reviews never fetch an image
   URL directly. Keep the returned `assetId`, `type`, `path` and `sha256`.
3. Send one `blender_scene_patch` against the revision you read. Use `asset.add`
   for new assets, followed by `project.brief.set {goal, referenceImages}`. This
   operation replaces the entire brief: preserve every reference still wanted.
4. Review the resulting revision with `blender_visual_review`. Use
   `blender_visual_autofix` when bounded corrective changes are wanted. Both read
   the saved revision's references automatically.

Each reference has this shape (replace the digest placeholder with the actual
ingest result):

```json
{
  "id": "finish-reference",
  "assetId": "finish-photo",
  "sha256": "<returned-sha256>",
  "label": "Brushed champagne metal",
  "purposes": ["materials", "lighting"],
  "notes": "Match the finish and highlights, not the object shape"
}
```

Rules that affect the request:

- At most four static PNG/JPEG references. Each must be at most 8 MiB,
  16,000,000 pixels and 8192 pixels per side. A smaller deployment asset limit
  can constrain uploads further. Animated or malformed images are refused.
- `id` must be unique. `purposes` must contain one to four distinct allowed values.
  `label` is 1–160 characters; optional `notes` is at most 1000.
- The asset must be declared in the same revision, with matching `sha256` and
  `assets/raw/<sha256>.<type>` path. Do not resolve a newer same-name asset alias.
- `goal` is at most 2000 characters. Both brief fields are required; `goal:""`
  and `referenceImages:[]` clear the target. Clear a reference before removing
  its asset, including when both operations share one patch.
- UI uploads store assets only. The user must save the brief to create its new
  revision. An unsaved draft does not change the reference set used for review.

## Choose the main review subject

Use `project.reviewSubject.set {entityId}` to save the entity measured for framing,
exposure and occlusion; `entityId:null` restores automatic selection. Choose an
existing non-empty entity, commonly the product body. This does not move cameras
or replace the brief. Clear or replace the binding before removing the entity.
A hidden bound entity stays selected and is reported unavailable.

Automatic selection can choose a long accessory by bounding radius. For multipart
products, inspect the resolved subject and save an explicit choice when needed.
`subject-part` marks required body parts; independent `subject` objects are not
implicitly parts. Artistic review must still inspect the full product and scene.
Read the actual saved `review.subject` and its availability/reason in QA, not an
unsaved selector draft. Missing measurements cannot establish technical or artistic
pass even when the remaining numeric score is high.

## Interpret the evidence

`visual_review.score`, `pass` and `technicalPass` describe technical measurements.
Read `artistic` separately. Each dimension needs an actual rendered `viewId`,
specific visible evidence and sufficient confidence. For dimensions with references:

- `pass` must cite **all** applicable `referenceIds`.
- `needs_work` must cite at least one applicable reference showing a mismatch.
- `unassessable` need not claim reference coverage. Hidden or missing evidence is
  not approval; invented, duplicate or wrong-purpose IDs are rejected.

The recorded `referenceImages` identify verified image inputs; check
`reviewer.error` and `referenceInputError` before saying the model inspected them.
Preserved images and hashes establish which inputs were used, not that the model's
artistic judgment is correct. Do not claim online visual validation from scripted
model replies or a green local test suite.

## Keep the evaluation target fixed

Autofix fixes the baseline's actual subject ID across candidate renders, including
when camera targets, tags or dimensions change. It refuses subject selection,
removal or hiding operations. A missing, hidden or unmeasured subject stops the
baseline or conditionally restores the candidate. `REVIEW_SUBJECT_OPERATION_REFUSED`,
`REVIEW_SUBJECT_CHANGED` and `REVIEW_SUBJECT_UNAVAILABLE` are round/handover reasons.

Autofix cannot change the brief or delete/replace referenced assets. It compares
`reviewInputsDigest` before accepting candidates. `REVIEW_INPUT_OPERATION_REFUSED`
means the proposal was blocked; `REVIEW_INPUTS_CHANGED` means the candidate cannot
be accepted against the earlier target. These are round/handover reasons.

A failed candidate is restored only if the project is still on that candidate.
On `REVISION_CONFLICT`, read the current revision and inspect intervening changes.
Do not bypass that guard. On missing or changed reference bytes, restore the
original asset or deliberately import and save a new target; do not silently
substitute another picture. A legitimate target change starts a new review.
