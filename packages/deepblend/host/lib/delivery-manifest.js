/**
 * Delivery manifest — what a delivered package contains, without opening it.
 *
 * SPEC §10.4 and §20 M3 require the final package to carry the SceneSpec, the
 * `.blend`, the video, the manifest and QA, and the M3 brief's design question 5
 * states the test: "它要能让人**不看磁盘**就判断交付是否完整" — a reader must be
 * able to judge completeness from the manifest alone. So this module writes down
 * everything that judgement needs: the frame range and per-frame inventory, the
 * video's CLAIMED properties, the MEASURED properties ffprobe reported, the
 * disagreements between them, and the digests that tie the video back to the exact
 * frames and the exact scene.
 *
 * WHY THE CLAIM AND THE MEASUREMENT BOTH APPEAR
 * ---------------------------------------------
 * A manifest that only recorded what the encoder intended would be a manifest
 * that agrees with itself. Recording `video.probed` beside `video.expected`, plus
 * the problems found between them, is what makes the file falsifiable by anyone
 * who reads it — and it is why `verified` is a fact about a comparison rather than
 * a boolean the encoder sets.
 *
 * Owner: DeepBlend Studio — M3
 * Plane: Host composition
 */

import { basename } from 'node:path'

import {
  DELIVERY_MANIFEST_VERSION,
  deliveryCompleteness,
  verifyVideoProperties,
} from '@deepblend/dsh-blender-contracts'

import { fileSha256, fileSize } from './paths.js'

/**
 * Build the delivery manifest for a finished render job.
 *
 * @param {object} input
 * @param {object} input.record - the render job record
 * @param {object} input.ledger - the verified frame ledger
 * @param {object} input.probed - the ffprobe measurement
 * @param {object} input.encode - `{ outputPath, bytes, argv, durationMs }`
 * @param {object} input.publish - `{ videoPath, relativeTo }`
 * @param {object} input.sources - `{ sceneSpec, checkpoint, qa }` absolute paths
 * @param {object} input.runtimeIdentity - Blender/runtime identity (SPEC §9.5)
 * @returns {object}
 */
export function buildDeliveryManifest(input) {
  const record = input.record
  const frameCount = record.frameEnd - record.frameStart + 1
  const relative = absolute => relativeTo(input.publish.relativeTo, absolute)

  const claimed = {
    frameStart: record.frameStart,
    frameEnd: record.frameEnd,
    frameCount,
    fps: record.fps,
    width: record.renderConfig?.resolution?.[0],
    height: record.renderConfig?.resolution?.[1],
  }
  const verdict = verifyVideoProperties({
    claimed,
    probed: {
      durationSeconds: input.probed.durationSeconds,
      fps: input.probed.fps,
      width: input.probed.width,
      height: input.probed.height,
      nbFrames: input.probed.nbFrames,
      codec: input.probed.codec,
    },
  })

  const manifest = {
    schemaVersion: DELIVERY_MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    projectId: record.projectId,
    revisionId: record.revisionId,
    jobId: record.jobId,
    attempt: record.attempt,

    source: {
      sceneSpec: sourceEntry(input.sources.sceneSpec, relative),
      checkpoint: sourceEntry(input.sources.checkpoint, relative),
      qa: sourceEntry(input.sources.qa, relative),
      sceneSpecDigest: record.sceneSpecDigest ?? null,
    },

    frames: {
      directory: relative(record.framesDirectory ?? null),
      prefix: record.filePrefix ?? 'frame_',
      padding: record.filePadding ?? 4,
      first: record.frameStart,
      last: record.frameEnd,
      expected: frameCount,
      rendered: input.ledger.presentCount,
      // The per-frame inventory is a list of NUMBERS, not of digests: 450 sha256
      // lines would triple the manifest to answer a question ("is every frame
      // there") that the count plus the ledger verdict already answers.
      renderedFrames: input.ledger.present.map(entry => entry.frame),
      corrupt: input.ledger.corrupt.map(entry => ({ frame: entry.frame, reason: entry.reason })),
      bytes: input.ledger.present.reduce((total, entry) => total + entry.bytes, 0),
    },

    render: {
      profileName: record.profileName ?? null,
      config: record.renderConfig ?? null,
      cameraId: record.cameraId ?? null,
      meanMsPerFrame: record.meanMsPerFrame ?? null,
      renderDurationMs: record.renderDurationMs ?? null,
      blender: input.runtimeIdentity ?? null,
    },

    video: {
      path: relative(input.publish.videoPath),
      container: 'mp4',
      bytes: input.encode.bytes,
      sha256: fileSha256(input.publish.videoPath),
      expected: claimed,
      probed: {
        durationSeconds: input.probed.durationSeconds,
        fps: input.probed.fps,
        width: input.probed.width,
        height: input.probed.height,
        frameCount: input.probed.nbFrames,
        // Kept separate from `frameCount` on purpose: the container's own claim and
        // the decoded count are different facts, and a delivery where they disagree
        // is worth seeing even when the decoded count is right.
        containerClaimedFrameCount: input.probed.nbClaimedFrames ?? null,
        codec: input.probed.codec,
      },
      problems: verdict.problems,
      verified: verdict.ok,
      encode: {
        durationMs: input.encode.durationMs,
        argv: input.encode.argv,
      },
    },

    // The QA verdict travels WITH the manifest, for the same reason the video's
    // measured properties do: a reader must be able to judge the package without
    // opening it, and "the QA report exists at this path" cannot answer "did it
    // pass". The path is recorded beside it (`source.qa`) for the audit trail.
    qa: {
      path: relative(input.sources.qa ?? null),
      report: input.qa ?? record.qa ?? null,
    },
  }

  manifest.completeness = deliveryCompleteness(manifest)
  return manifest
}

function sourceEntry(path, relative) {
  if (path === null || path === undefined) return { path: null, bytes: null, sha256: null }
  return { path: relative(path), bytes: fileSize(path), sha256: fileSha256(path) }
}

/**
 * Express a path relative to the project root, or in full when it is outside it.
 *
 * A stored manifest must survive the workspace being moved (the same rule the
 * M1 artifact records follow), so paths are project-relative. A path that cannot
 * be made relative is reported in full rather than as a plausible-looking relative
 * one: a silently wrong path in a delivery manifest is worse than an absolute one.
 *
 * @param {string} root
 * @param {string|null|undefined} absolute
 * @returns {string|null}
 */
export function relativeTo(root, absolute) {
  if (absolute === null || absolute === undefined) return null
  if (root === null || root === undefined) return absolute
  const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root
  if (absolute === normalizedRoot) return basename(absolute)
  if (absolute.startsWith(`${normalizedRoot}/`)) return absolute.slice(normalizedRoot.length + 1)
  return absolute
}
