/** Authenticated owner fixture for handler/stream unit tests, not an auth proof. */
import { Context } from '@deepseek-ai/cordis'

export function ownerHttpContext() {
  const context = new Context()
  context.provide('connection', { requestRejection: () => undefined, authorizeIndex: () => true })
  return context
}
