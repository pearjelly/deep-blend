# Standalone runtime conformance

Copy `conformance.mjs`, `run-conformance.mjs`, `scene-spec.json` and
`verify-checkpoint.py` into a Node.js 22+ project. Install the contracts tarball
from the exact candidate you intend to test, using the [public author example](../content-author/README.md).
The checker imports only Node built-ins and public contracts exports. It does not
use workspace-private Host methods or register a DSH service itself.

Provide a module exporting this function:

```js
export async function createRuntime({workspaceRoot, scenario, signal}) {
  // Construct your implementation of the public BlenderRuntime type.
  // "installed" uses a real worker with Cycles. "unavailable" uses an environment
  // without a Blender executable, so absence and advice can be tested.
  // Return {runtime, close: async () => ...} with cleanup owned by this factory.
}
```

This is a factory contract for the checker, separate from the public
`BlenderRuntime` interface. The factory must honor its signal, own its resources
and provide an awaited `close()` function. Each request has a 90-second deadline;
deadline failures report completion/cleanup as unverified. Run the connector in
an isolated test environment. The checker forces batch isolation for compilation
and preview/view rendering. It never treats `dispose()` as proof that every
worker process has exited.

Run from your project:

```sh
node run-conformance.mjs /absolute/factory.mjs /absolute/new-evidence /absolute/blender
```

The third argument is a real, separately installed Blender executable used to
open the saved checkpoint and render an independent CPU reference. It need not
be the adapter's execution process. Use the target candidate's supported Blender
version and record both actual builds. Existing evidence directories are refused.
Use `--help` for the command shape. Exit 0 requires all checks in this profile to
pass and both factory lifecycles to close; exit 1 means failure. Read
`report.json`, preserved outputs and logs for the actual reason. Progress is saved
after each completed check; interrupted `running` records are incomplete.

## Profile and evidence

`cycles-fixture/v1` uses a small animated cylinder, two measured frames, a
noncontiguous frame plan and a cancelled/resumed sequence. It executes all nine
current methods, checks executable absence and engine resolution, asynchronous
checkpoint handoff, callback failure cleanup, real PNG dimensions/bytes,
measured camera/render facts, invalid requests and pre-aborted requests.

The independent Blender script reads actual geometry, volume, UVs, material,
exposure and three saved animation poses. Camera matrices must match the adapter's
per-view measurements. Preview pixels within the independently projected subject
region are compared with a native reference: mean absolute RGB error at most
0.05 and RMS error at most 0.08, on a 0–1 scale. These finite tolerances allow
small rendering differences; they do not certify pixel identity across devices.
The report records the measured errors and thresholds.

Frame tests wait for terminal handles, preserve a complete frame through
idempotent cancellation and request only missing frames on resume. Input and
original checkpoint hashes must remain unchanged. The report records actual
SDK entry and source hashes, Node/runtime/verifier builds, artifacts and outcomes.
Raw checkpoint, PNGs, receipts and sequence files remain available for review.

This profile requires Cycles and local handoff of checkpoint/job artifacts.
An adapter supporting only other engines cannot claim it passed this profile;
that does not by itself prove incompatibility with every public interface use.
Other engines/formats, arbitrary scenes, remote restart/recovery, artistic
quality and independent adoption require their own evidence. A factory can
fabricate returns, so checker results are evidence to inspect, not trust or
ownership certification. Independent native readback helps reject wrong saved
content and mismatched images.

## Maintained local connector

`local-factory.mjs` connects the installed public Cordis/subprocess/local-provider
packages. In a configured repository checkout:

```sh
DEEPBLEND_BLENDER_PATH=/absolute/blender node deepblend/examples/runtime-author/run-conformance.mjs \
  deepblend/examples/runtime-author/local-factory.mjs /absolute/new-evidence /absolute/blender
```

The [native integration suite](../../tests/blender-integration/runtime-conformance.e2e.mjs)
packs contracts, installs offline into a temporary project outside the checkout,
copies the checker and uses this real public connector. Its connector dependencies
still come from the configured DSH/provider deployment. This is maintained
consumer evidence, not a third-party implementation or independent adoption.
Use the [public API](../../docs/public-api.md) for method/lifecycle requirements
and the [human validation guide](../../docs/human-validation.md) for adoption records.
