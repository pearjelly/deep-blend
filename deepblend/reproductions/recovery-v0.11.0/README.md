# Minimal animation recovery reproduction — DeepBlend 0.11.0
Measured on 14 October 2026; packaged for public review on 15 October 2026.

This is a comparison proposal, not a blender-cli integration.

- [Exact implementation tested: 210b039d7d216df08cd732db20759b4c4ce332c4](https://github.com/pearjelly/deep-blend/commit/210b039d7d216df08cd732db20759b4c4ce332c4)
- [Pinned implementation tree](https://github.com/pearjelly/deep-blend/tree/210b039d7d216df08cd732db20759b4c4ce332c4)
- [Reproduction release](https://github.com/pearjelly/deep-blend/releases/tag/repro-recovery-v0.11.0-20261015)

The reproduction release tag identifies the repository commit containing these
materials. It does **not** change the implementation under test: the driver clones
and checks the exact v0.11.0 commit above, even when the default branch is newer.
In a repository checkout, run the setup below from this directory. In a downloaded
reproduction ZIP, run it from the extracted package directory.

Before installing dependencies or running Blender, verify the downloaded files:

```sh
python3 verify-package.py
```

The verifier checks package hashes, frame hashes, saved revision/checkpoint/video
identity, the actual resume plan/journal, and the measured r0001/r0002 result.
See [OBSERVED.txt](OBSERVED.txt) for actual measurements and [evidence/](evidence/)
for the captured records. Machine-specific paths in textual evidence are redacted;
media bytes are preserved. The package file list was regenerated for publication.


## 1. What is in this package

scene-spec.json: the editable input; one orange cuboid, a plane, one area light,
one fixed camera, and two linear animation tracks (translation and rotation).
scene-r0001.blend: the actual original DeepBlend checkpoint used in the measured run.
source-r0001.scene-spec.json: the exact saved revision corresponding to that checkpoint.
repro.mjs: an external driver of the unmodified public DeepBlend host and provider.
versions.json: measured runtime identities and release commit.
evidence/: step logs, interruption/recovery findings, corruption injection,
resume plan, per-frame SHA-256 values, job records, and final delivery manifest.
frames/: all 24 verified output PNGs. final.mp4: the verified 1-second sequence.
SHA256SUMS: byte checksums for every other file in the package.

No external models, textures, credentials, LLM calls, or DSH web profile are needed.
Do not open the .blend with a different Blender version and save over it when
comparing checkpoint identity. Work on a copy if you want to change the scene.

## 2. Pins and measured environment

DeepBlend: v0.11.0, commit 210b039d7d216df08cd732db20759b4c4ce332c4.
Node.js: 26.11.1. DSH and dsh-subprocess-local: 0.1.5-rc.2.
Cordis: 4.0.2. Dependencies: the exact committed development package-lock.json,
installed using npm ci through DeepBlend's dev:setup (no global DSH fallback needed).
Blender: 5.2.1 LTS, build hash 9e2066aef7ef, official macOS ARM64 build.
Blender DMG SHA-256: 6409e21de80994db5f4c4a34486b6fd43cea21085b912f7491c53e923acb65a3.
ffmpeg and ffprobe: 8.1. Hardware: Apple M1 Max, Mac Studio, 32 GB RAM.
OS: macOS 27.0.1, build 26A434, arm64. The end-to-end SIGKILL test was run on macOS.
Do not interpret this as a Windows recovery test.

Render: frames 1–24 inclusive, 24 fps, 320x180 at 100%, Cycles, 64 samples,
AgX / look None / exposure 0, denoising enabled, opaque PNG, final H.264 MP4, 1.000 second.
The supplied checkpoint has cycles.device=GPU. Device selection and timing can
vary by installation; we do not claim a verified GPU backend identity here.
Do not compare pixel hashes across hardware/backends; compare preserved frames
within each run. Fresh checkpoint binary hashes can differ because files contain
per-run metadata; all revision checks below compare against that run's own r0001.

## 3. Setup (macOS or another POSIX environment; only macOS was measured)

Use Node 26.11.1 (for example, nvm install 26.11.1 and nvm use 26.11.1).
Install Blender 5.2.1 LTS plus ffmpeg/ffprobe 8.1. Select their executables below.
The driver checks versions and the exact DeepBlend release commit before each step.

From this extracted package directory:

  git clone --depth 1 --branch v0.11.0 https://github.com/pearjelly/deep-blend.git source-v0.11.0
  export DEEPBLEND_REPO="$PWD/source-v0.11.0"
  git -C "$DEEPBLEND_REPO" rev-parse HEAD
  (cd "$DEEPBLEND_REPO" && npm run dev:setup)
  export DEEPBLEND_BLENDER_PATH="/absolute/path/to/Blender.app/Contents/MacOS/Blender"
  export DEEPBLEND_FFMPEG_PATH="/absolute/path/to/ffmpeg"
  export DEEPBLEND_FFPROBE_PATH="/absolute/path/to/ffprobe"
  export REPRO_STORE="$PWD/run-local"

The git command must print 210b039d7d216df08cd732db20759b4c4ce332c4.
Use a clean checkout with no source edits. REPRO_STORE must be a new directory;
the automatic driver refuses to overwrite a previous run.

## 4. Automatic test

  node repro.mjs run

This performs the same separate-process steps shown below. It kills only the
recorded host whose command line identifies this reproduction driver. Recovery
uses DeepBlend's own process identity checks and orphan termination.
Success ends with a JSON event "verified", "ok":true. Assertions fail loudly.
Evidence and the resulting project live in REPRO_STORE; results from the supplied
measured run are separately included under evidence/ and frames/.

## 5. Exact manual steps (use a fresh REPRO_STORE)

Terminal A:
  node repro.mjs init
  node repro.mjs start

Leave start running. Terminal B, with the same exported variables:
  node repro.mjs interrupt
  node repro.mjs recover
  node repro.mjs damage
  node repro.mjs inspect
  node repro.mjs edit
  node repro.mjs resume
  node repro.mjs verify

interrupt waits for at least four structurally complete PNGs, identifies the
recorded host command line, then sends SIGKILL to that Node host. It deliberately
does NOT cancel the Blender renderer. A fast machine may finish extra frames
before recovery stops Blender; the detected set is authoritative, not a fixed
counter. If all 24 have already finished, interruption fails rather than passing
without an interrupted sequence.

recover constructs a new host in a new process, awaits reconciliation, checks
that the old Blender process/group is gone, saves the frame ledger and SHA-256
values, and confirms no automatic resume occurs. It leaves status recovering.
If an orphan cannot be safely stopped, recovery must refuse resume.

damage runs only after the recorded renderer is gone. It deletes frame_0001.png
and truncates frame_0002.png to half its byte length. This is intentional fault
injection to make absent and torn PNG cases reproducible; it is not a claim that
the host kill naturally damaged either frame. inspect starts another host and
checks the missing/corrupt classification.

edit changes the cuboid's material from orange to blue and saves r0002. It checks
that r0001's .blend bytes remain unchanged. resume then uses the OLD job ID,
not a new final render for the current project revision.

resume asserts that the requested frame list equals missing plus corrupt, uses
r0001, waits for delivery, and verifies preserved PNG hashes. verify also checks
the actual renderer journal against the requested list; no valid preserved frame
may appear in that journal. It fully decodes all final PNGs with ffmpeg, measures
the MP4 with ffprobe, and checks checkpoint, SceneSpec and video SHA-256 values
and the saved scene digest against the delivery manifest. It checks complete,
uniform frame provenance across attempts, and that the animation changes frames.

## 6. Expected behavior and observed result

Host crash: completed frames survive; detached Blender can survive the host.
Restart: stop the orphan first; rebuild counts from files; status recovering;
no renderer is automatically relaunched.
Fault injection: report deleted frame 1 as missing and truncated frame 2 as
corrupt (reason unterminated). Resume exactly the union of missing and corrupt;
keep all other valid PNGs unchanged, finish encoding, and publish a verified manifest.
Revision: current r0002 must not redirect the unfinished r0001 job; the final
manifest and source hashes must still identify r0001.

See OBSERVED.txt for the measured counts, preserved frames, final video properties,
and hashes from the complete run of the included driver.

## 7. Using the same scene for a blender-cli comparison

DeepBlend 0.11.0 does not depend on or invoke blender-cli. It launches the Blender
executable through DSH subprocess management, runs its own bootstrap.py and
Python/bpy frame renderer, derives recovery from persisted PNGs/job records,
and encodes with ffmpeg. Source details are in SOURCE-AUDIT.txt.

scene-r0001.blend is the common minimal animation input for a separate blender-cli
run. Please choose and record an exact blender-cli release/commit on your side;
none has been tested or asserted here. Match frame range, fps, engine, samples,
resolution, color management and compute device when comparing behavior.
The DeepBlend driver recreates its project from scene-spec.json rather than
importing this binary so that native saved-revision provenance is exercised.
The included binary is the exact scene from the recorded DeepBlend run.

Suggested comparison points: renderer survival after host/job interruption,
explicit vs automatic resumption, byte preservation, absent/torn PNG classification,
and output-to-revision/checkpoint identity. These describe observable contracts,
not a claim that the two tools offer identical commands or feature sets.

## 8. Limits

This tests a host SIGKILL and deliberately absent/truncated PNGs. It does not test
power loss, disk full, every shutdown mode, or every type of PNG corruption.
DeepBlend's frequent ledger checks sample PNG signature, dimensions, minimum size
and IEND; they are not a full image decoder or proof against all internal CRC/pixel
corruption. The package driver separately decodes the final PNGs and verifies hashes.
The run checks identity against saved revision metadata, not an adversarially
modified project store. No comparative blender-cli run has been made yet.

License: MIT. DeepBlend author/repository attribution is preserved in LICENSE.
Please agree on findings and attribution with both maintainers before publishing
a joint write-up. This release publishes the reproduction evidence only; it is not a joint article
or a completed blender-cli comparison. No new email was sent during publication.
