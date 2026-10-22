# Editable snapshot archive primitive

This is the first implementation slice for “保存可编辑副本”. It is an internal
Host module, not a public export method. No route, UI, model tool, revision
resolver, license interpretation, Blender operation or download stream is added
by this slice.

## Integration contract

`packages/deepblend/host/lib/editable-snapshot-archive.js` exports:

- `pinSnapshotSource(projectRoot, sourcePath, { bytes, sha256 })`: inspect a
  Host-selected relative source without following symlinks, and return its
  serializable filesystem identity. The caller must obtain `bytes` and `sha256`
  from the selected native producer binding, locked asset or fixed provenance
  record. Pinning does not assert that the bytes match that digest.
- `createEditableSnapshotArchive({ projectRoot, exportId, files, signal?,
  onProgress?, compress?, forceZip64? })`: copy the fixed allowlist into a ZIP,
  verify it, and publish a ready receipt. `projectRoot` is a trusted Host
  capability. Neither source nor output member names accept absolute paths.

Every `files` entry contains `sourcePath`, archive `path`, `sourceType`, `bytes`,
`sha256` and the `identity` returned by pinning. The identity fields are decimal
strings: `dev`, `ino`, `size`, `mtimeNs`, `ctimeNs`. A planning layer can persist
this exact plan alongside its revision/job/request binding. Retrying must not
repin a changed source silently. `sourceType` is an explicit lowercase label,
such as `native`, `asset`, `provenance` or `video`.

```js
const source = await pinSnapshotSource(projectRoot, selectedNative.path, {
  bytes: selectedNative.bytes,
  sha256: selectedNative.sha256,
})
const receipt = await createEditableSnapshotArchive({
  projectRoot,
  exportId,
  files: [{ ...source, path: 'native/model.blend', sourceType: 'native' }],
  signal,
  onProgress: progress => updatePreparingReceipt(progress),
})
```

`onProgress` is synchronous. It reports `state: preparing`, phase
`preparing/writing/verifying/publishing`, cumulative `writtenBytes`,
`verifiedBytes`, source `totalBytes` and the current member. `verifiedBytes`
includes the generated manifest and can exceed source `totalBytes`. Throttle
durable/UI updates in the caller; do not perform an asynchronous write for every
chunk. Cancel through the supplied `AbortSignal`. A callback exception fails
the preparation before publication.

The fixed plan is copied before the first asynchronous operation. Only explicitly
named files enter the ZIP. The primitive does not crawl directories, infer an
asset closure, exclude references, resolve native provenance, or establish that
a `.blend` has no unsupported external links. Those remain the resolver's work.
The original SceneSpec/native bytes are preserved. File SHA256 is not a
canonical spec hash or scene digest.

## Output and publication

Successful publication creates exactly these initial files under
`exports/<exportId>/`:

| File | Meaning |
| --- | --- |
| `snapshot.zip` | Allowlisted payload members plus `file-manifest.json` |
| `file-manifest.json` | Payload path, byte count, SHA256, source type and project-relative source path |
| `ready.json` | Archive byte count, SHA256, filesystem identity, manifest SHA256 and totals |

The file manifest excludes itself to avoid a self-referential digest. Its exact
bytes are verified as an archive member and bound separately by the ready
receipt. Source machine absolute paths are not copied into this generated
manifest. The resolver must curate any supplied provenance files separately;
their content is intentionally copied unchanged.

An archive is written once, through bounded streams, to a fresh
`exports/.preparing-<exportId>-<uuid>/` directory on the same filesystem. Its
source streams use the same open file descriptor for pre-read identity, bytes,
SHA256 and post-read identity checks. Path components are inspected before and
after reading; symlinks and special files are rejected. After writing, a
separate ZIP reader verifies every member against the fixed plan and the
generated manifest. The same archive descriptor then verifies the whole ZIP
digest and size. Sources and the archive path are rechecked before publication.

The external manifest and ready metadata are written and read back through the
same descriptor, then their filesystem identities are rechecked before commit.
Ready metadata is fsynced inside staging, then one directory rename makes the
complete export visible. Every successful destination is nonempty; a competing
writer's directory rename cannot overwrite it. The losing writer reports
`SNAPSHOT_EXISTS`. There is no persistent publication lock to strand requests
after process termination. Output is private to the host user until later
download handling.

On failure, the partial archive and `failed.json` remain in the hidden staging
directory, and the thrown `SnapshotArchiveError` includes a relative
`failureDirectory`. A failure receipt is best effort when storage itself has
failed. Cancellation is a failure with code `SNAPSHOT_CANCELLED`; it does not
produce a ready export. A later attempt may use the same export id while
retaining the earlier failure directory.

A process kill can leave an incomplete staging directory without `failed.json`;
it never publishes a partial final directory. A kill just before rename can
leave `ready.json` inside hidden staging. That document is not a published
success: consumers must only resolve the fixed final `exports/<exportId>` path,
never discover ready records by recursively scanning staging. A new attempt
can publish that id while preserving the abandoned staging for diagnosis.
This primitive does not implement request-id idempotency, source-plan recovery,
retention cleanup, or the project write-lease integration. Cancellation is
checked immediately before the rename call, which is the commit boundary;
once the rename has begun, its successful outcome wins over a later cancellation.

The filesystem checks defend against changed inputs and symlinks with pinned
identities and content digests. They are not a native `openat`/directory-FD
capability sandbox against a malicious process running as the same OS user.
Node offers no portable rename-no-replace operation for directory targets:
the no-overwrite guarantee covers existing nonempty successful exports, not
an external process racing to create an empty target directory after the
pre-publication existence check.
Directory fsync is used on supported POSIX filesystems; Windows retains atomic
rename visibility, while power-loss durability depends on its filesystem.

## Dependency and size decisions

The writer pins [yazl 3.3.1](https://github.com/thejoshwolfe/yazl): its documented
lazy read-stream API keeps only the current source open and emits ZIP64 when
sizes require it. The verifier pins
[yauzl 3.4.0](https://github.com/thejoshwolfe/yauzl): it reads the central directory,
streams entries lazily, validates sizes, and supports an existing descriptor.
The libraries are JavaScript plus Node's built-in streams/zlib. Their only new
transitive runtime packages are `buffer-crc32` and `pend`. No system `zip`/`unzip`
program is required, and no ZIP format writer was hand-implemented. Exact
dependencies are declared in Host and both isolated development runtime locks.

`compress` defaults to `false` (ZIP STORE), avoiding expensive recompression of
already compressed native/media files. Optional compression uses level 1.
The free-space estimate is conservative and checked before writing, but cannot
reserve capacity against other processes; subsequent I/O failures still fail
closed. `forceZip64` exists for compatibility verification and defaults false.

The current hard ceilings are 10,000 payload files, 16 GiB per source, 64 GiB of
source bytes, an 80 GiB archive, and an 8 MiB generated manifest. The source and
archive hashing chunk size is 256 KiB. ZIP central-directory metadata scales
with the bounded member count; native payloads never become one large Buffer.
These are rejection limits, not claims that every ceiling has been exercised.

## Reproducible checks and remaining acceptance

```sh
node deepblend/tests/contract/editable-snapshot-archive.test.mjs
node deepblend/tests/integration/editable-snapshot-large.e2e.mjs
```

The contract suite covers exact native/source preservation, independent ZIP
readback, forced ZIP64 and compression, portable path and case conflicts,
source/parent/output symlinks, single-segment byte limits, wrong SHA with unchanged identity, replaced
inodes, a separate process modifying an open source, late source changes,
cancellation in three phases, corrupted archive bytes, a modified external
manifest, injected ENOSPC, concurrent publication, and SIGKILL both during
writing and immediately before rename followed by retry.

On 2026-10-22, the standalone large-file probe on Node 26.11.1 created a real
1,073,741,824-byte sparse source (32,768 allocated bytes), then wrote a
1,073,742,444-byte STORE archive. It cancelled one attempt at 67,108,864 input
bytes, removed that probe-owned failure, and successfully retried the same id.
The process used a 96 MiB V8 heap limit. Peak RSS was 157,614,080 bytes
(about 150 MiB), from 61,702,144 bytes baseline; total time was 5,984 ms including
source hashing, the cancelled attempt, independent member verification and
whole-archive verification. The executable acceptance thresholds are a 256 MiB
peak RSS and 160 MiB RSS growth. The probe cleaned all of its sources and outputs.

ZIP64 was exercised through forced records on small archives. Actual members
or archive offsets beyond 4 GiB, a 10,000-member archive, Windows extraction,
network filesystems and power-loss recovery remain unmeasured. No canonical
pagoda file was read or copied by these tests. No Blender, model API or rendering
was invoked. The real r75 relocation/reopen, selected video identity, public
Host/UI workflow, streaming download/disconnect/retry, and full release
acceptance belong to the later integrated implementation.
