/** Durable creation identity lives in the project record, under a store-scoped writer lease. */
import { join } from 'node:path'
import { BlenderError, BlenderErrorCode, CREATION_REQUEST_VERSION, sha256, sha256Canonical } from '@deepblend/dsh-blender-contracts'
import { resolveInside } from './paths.js'
import { withProjectWriter } from './project-writer.js'

function jsonValue(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Not a JSON value')
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== null && Object.getPrototypeOf(prototype) !== null) throw new Error('Not a JSON object')
  ancestors.add(value)
  for (const entry of Object.values(value)) jsonValue(entry, ancestors)
  ancestors.delete(value)
}

export function creationIdentity(request) {
  if (request.creationKey === undefined) return null
  const key = request.creationKey
  if (typeof key !== 'string' || !key.trim() || key.length > 128 || /[\x00-\x1f\x7f]/.test(key)) {
    throw new BlenderError(BlenderErrorCode.CREATION_REQUEST_INVALID, 'creationKey must be non-empty text of at most 128 characters, without control characters.')
  }
  if (['staging', '.revision-writers', '.creation-requests'].includes(request.projectId)) {
    throw new BlenderError(BlenderErrorCode.PROJECT_ID_INVALID, 'Choose a project id other than a reserved store directory.')
  }
  let requestHash
  try {
    const inputs = { title: request.title?.trim(), goal: request.goal ?? null,
      recipe: request.recipe ?? null, sceneSpec: request.sceneSpec ?? null, projectId: request.projectId ?? null,
      saveCheckpoint: request.saveCheckpoint !== false, renderPreview: request.renderPreview === true, actor: request.actor ?? null }
    jsonValue(inputs)
    requestHash = sha256Canonical(inputs)
  } catch (cause) {
    throw new BlenderError(BlenderErrorCode.CREATION_REQUEST_INVALID, 'Creation inputs must be JSON values.', { cause })
  }
  return { schemaVersion: CREATION_REQUEST_VERSION, keyHash: sha256(key.trim()), requestHash }
}

export async function withCreationRequest(store, request, create, recover) {
  const identity = creationIdentity(request)
  if (!identity) return create(null)
  store.ensureRoot()
  const scope = resolveInside(store.projectsRoot, join(store.projectsRoot, '.creation-requests', identity.keyHash), 'creation request lease')
  // Hosts may use different workspace roots around the same store. The store
  // itself determines this lease's location, so those Hosts still coordinate.
  return withProjectWriter(scope, store.projectsRoot, async () => {
    const matches = store.listProjectIds().map(projectId => ({ projectId, record: store.readRecord(projectId) }))
      .filter(({ record }) => record.creationRequest?.keyHash === identity.keyHash)
    if (matches.length > 1) throw new BlenderError(BlenderErrorCode.CREATION_REQUEST_CONFLICT, 'More than one project claims this creation request. Inspect the records before retrying.')
    if (matches.length) {
      const { projectId, record } = matches[0]
      if (record.projectId !== projectId || record.creationRequest.schemaVersion !== identity.schemaVersion
          || record.creationRequest.requestHash !== identity.requestHash) {
        throw new BlenderError(BlenderErrorCode.CREATION_REQUEST_CONFLICT, 'This creationKey belongs to different creation inputs. Reuse the original inputs, or choose a new key for a new project.')
      }
      if (!(record.revisionCount > 0) || record.currentRevision === 'r0000') {
        throw new BlenderError(BlenderErrorCode.CREATION_REQUEST_CONFLICT, 'The previous creation has no committed revision. Inspect that incomplete project before retrying; a second project was not created.', { detail: { projectId } })
      }
      return recover(projectId)
    }
    return create(identity)
  })
}
