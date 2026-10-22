# Fixed-revision editable snapshots

The Host methods `exportEditableSnapshot`, `getEditableSnapshot`,
`cancelEditableSnapshot` and `openEditableSnapshot` prepare and download one saved
revision. They do not invoke Blender, publish a release, rewrite native bytes or
produce a project-history import package.

## Request and response

`POST /deepblend/projects/:projectId/editable-snapshots` accepts
`{requestId, revision, videoJobId?, expectedStoreIdentity?}`. A request id is 1–96
ASCII letters/digits/underscores/hyphens, beginning with a letter or digit. Revision
is explicit (`r0001`, for example); “current” is never resolved implicitly.

The first POST durably reserves the request and immediately returns
`{ok:true, snapshot:{exportId, requestId, projectId, revision, videoJobId,
storeIdentity, state:"preparing", phase:"planning", planFrozen:false, ...}}`.
Planning runs in the background under a request-specific writer lease. Asset
verification runs in a terminable worker, so cancellation remains available while
large assets are checked. Request identity is fixed at this point; file identities
are not claimed frozen until `planFrozen:true`.

`GET .../editable-snapshots/:exportId` returns the same envelope. State is
`preparing`, `ready`, `failed` or `cancelled`. Ready adds `archive:{bytes,sha256}`
and a Host-generated `downloadUrl` with a `storeIdentity` query guard.
`POST .../:exportId/cancel` accepts `{expectedStoreIdentity?}`. A ready export
remains ready. Repeating the original create request resumes preparation: an
existing frozen plan is reused; a request cancelled before freezing is replanned
from its original explicit revision. Different revision/video selections under
the same request id fail with `SNAPSHOT_REQUEST_CONFLICT`.

`writtenBytes` and `totalBytes` count source bytes, not compressed output.
`verifiedBytes` also includes the archive's generated file manifest and can be
slightly larger than `totalBytes`; only `state:"ready"` enables download.

The state response advertises `editableSnapshotProtocol:1` only when all four
Host methods exist, plus `storeIdentity` and
`editableSnapshotAvailability:{available,reason?}`. The browser sends its loaded
identity on create/cancel; a changed store fails before writing with
`SNAPSHOT_STORE_CHANGED`. A different project cannot resolve another project's
request id. No product/API version is bumped by this first slice.

## Exact contents and limitations

The ZIP root contains `README.md`, `snapshot-manifest.json`, `licenses.json` and
the archive-generated `file-manifest.json`. Original revision files retain
`revisions/<revision>/...` paths. The native file is `scene.blend`; its binding
must match the selected canonical scene digest and full-document spec hash. Older
revisions require the exact successful compile/patch job referenced by their
manifest and its unique native artifact hash. Unknown provenance is refused.

SceneSpec, validation, operation manifest, referenced recipe lock/parameters and
indexed visual reviews are preserved. Mutable small metadata is captured
byte-for-byte during planning. Prompts, chat history, the whole asset ledger,
arbitrary project files and frame sequences are not collected. Repeated metadata
paths are copied once. Planning enforces 10,000 members and 64 GiB of source bytes
as files are added, before archive creation.

All asset declarations in the selected SceneSpec are retained except external
files used only as observation references. An observation path shared with a
retained texture or locked model resource remains present and is recorded as
shared. Excluded external files remain referenced by the unchanged SceneSpec.
PNG/JPEG/HDR/EXR, locked glTF/GLB/OBJ resources and supported standalone models
without external dependencies are supported; unsupported dependency formats fail
closed. Asset provenance is selected by id/path/hash, including bundle lock
identity, rather than the newest alias. Local provenance paths are omitted from
the derived license summary. License declarations are recorded, not verified.

Dependency parsing uses the existing import profile with additional same-FD
size/hash/identity verification for glTF, GLB, OBJ and MTL metadata. Thus the graph
is derived from the expected bytes, rather than a pathname reopened after a hash.
Large verification runs in a worker, and archive source verification is streamed.

A selected video requires a completed, verified job for the same revision. Its
job and delivery metadata must agree, including exact original SceneSpec/native
byte identities. The payload comes only from
`renders/<jobId>/encoded/<jobId>.mp4`, never `output/final.mp4`. The README records
that relative path, or states that no video was selected.

Native packed images, external links, fonts and materials are not inspected or
removed. Full self-containment, license clearance and reopening after relocation
are not asserted. Native camera/animation behavior is unchanged; plugin shot
switching is not converted to native camera markers. Opening the blend alone does
not promise to reproduce a selected multi-shot video. Historical metadata may
contain source-machine paths; they are evidence, not execution instructions.

## Storage, ownership and recovery

`export-requests/<exportId>/request.json` stores the pending request.
`plan.json` appears only after a complete file plan is frozen. Generated metadata
lives in a private planning subdirectory and is retained with a frozen plan for
retries. `status.json` records progress/terminal evidence; fixed identity fields
always come from the request/plan.

The existing project-writer primitive is keyed by the request directory, not the
project/revision. It therefore prevents competing export owners without blocking
new scene revisions. There is no timeout takeover: only a same-host owner whose
PID is explicitly gone is recovered. Missing/malformed/foreign ownership, reused
live PIDs and interrupted recovery guards fail closed and need inspection after
all writers stop. Cancelling a writer in another Host process returns
`SNAPSHOT_BUSY`; it does not pretend to stop that process.

After acquiring a lease the service rereads the latest plan and ready receipt, so
a stale request-only read cannot overwrite a plan frozen by a previous owner.
Uncommitted work after a process death reports `SNAPSHOT_INTERRUPTED`; repeating
the request recovers through the same ownership rules.

Normal cancellation/failure closes archive FDs and removes only that attempt's
known ZIP and file-manifest payload after matching root/staging identities.
Small failure evidence and the frozen plan remain. ENOSPC may prevent writing the
failure receipt; exact owned payload cleanup still runs before retrying the small
receipt. `failureDirectory` and `partialPayloadRemoved` expose unsuccessful
cleanup accurately. Unknown files, changed directories and crash leftovers are
not swept or recursively removed. A killed process can leave a large incomplete
ZIP requiring inspection; it is never considered ready.

Publication remains one directory rename to
`exports/<exportId>/{snapshot.zip,file-manifest.json,ready.json}`. Successful
exports are never replaced. See [archive primitive](editable-snapshot-archive.md)
for filesystem race and durability boundaries.

## HTTP boundary and download

The existing HTTP carrier has no shared authentication layer. These new routes
therefore require a direct loopback socket and loopback Host, compare Origin to
the actual request scheme/host/port, reject cross-site Fetch Metadata and require
JSON for POST. IPv4, IPv6 loopback and IPv4-mapped loopback are supported.
Forwarded headers are not trusted. No-Origin CLI requests are allowed only on
loopback. Remote proxy/LAN access returns `403 SNAPSHOT_LOCAL_ONLY`.

Download rejects Range before opening a file. It validates the ready/file
manifest against the frozen plan, checks the complete ZIP hash on one FD, then
streams from that same FD under backpressure. Client disconnect cancels prehash
and streaming without cancelling or removing the ready export. The final chunk
is withheld until the final identity/hash check passes, so an altered transfer
ends short of its declared Content-Length. Headers declare a ZIP attachment,
`no-store`, `nosniff` and no range support. Whole archives are never buffered.

## Validation

`contract/editable-snapshots.test.mjs` covers pinned sources, reference/texture
aliasing, historical provenance, dependency replacement races, video binding,
planning/cancellation/recovery, stale-plan ownership, cleanup, guarded download
and real HTTP streaming. It uses small synthetic native/video bytes and does not
prove Blender reopening. Existing asset/OBJ/import and revision-concurrency
regressions cover parser and lease compatibility.

The independent archive boundary probe on Node 24.22.0 used a 4,296,015,872-byte
sparse source with STORE and automatic ZIP64 (no forced ZIP64 option): output
4,296,017,082 bytes, independent Python member CRC/SHA and whole-ZIP SHA passed,
peak RSS 141,590,528 bytes with a 96 MiB V8 heap cap, about 20.6 seconds. Payloads
were removed. Its archive module SHA256 was
`88db01dd4b8e7c504a6e2ad3641f802bd6e93ab0dab890e520e0e8f337eed393`.
This does not establish Windows extractor, network-filesystem or power-loss
behavior. Relocation/reopen checks are separate acceptance work.

## Actual pagoda acceptance, 2026-10-22

The integrated candidate at `d68f6d452b476c8c0b4c8fb6739b13c7ef59112f`
was exercised through the real workbench with an isolated copy of the pagoda
project. Selecting `r0075` and `render-0002`, cancelling during planning, retrying
the same request, reloading and using the download button all passed. The first
planning response returned in 122 ms. The downloaded ZIP was 1,120,937,071 bytes;
independent Python verification checked its whole-file SHA256, every member CRC
and hash, and all 58 original members against the pre-export baseline. The other
four members were generated metadata. All 28 relative references in four glTF
models resolved, and the standalone GLB had no external URI.

Blender 5.2.1 LTS on macOS arm64 opened the extracted native file from a new
directory with factory startup and autoexec disabled. Its 42 packed FILE images
were readable; five cameras and frames 1–900 were preserved; there were no linked
libraries or unpacked resource paths. This check did not edit, save or render.
The native defaults remained 640×360/48 samples; recreating the existing film
still requires the plugin's saved shot orchestration.

Twelve real HTTP checks covered repeated requests, conflicting inputs, store and
local-origin guards, Range rejection, late cancellation and two deliberately
interrupted downloads. The second transfer checked a prefix; the complete ZIP
proof came from the separate browser download. Every one of the 2,169 original
files in both the canonical project and acceptance copy retained its baseline
SHA256. Owned browser and Host processes were closed afterwards.

See the [sanitized acceptance record](../validation/editable-snapshot-1022.json)
for source, archive and evidence digests. This proves one revision's relocation
in the tested environment. It is not a full 75-revision import, generic resource
self-containment, license clearance, Windows/network-filesystem acceptance or a
new stable release. Only the observation-only external file was excluded; native
bytes and their embedded contents were retained unchanged.
