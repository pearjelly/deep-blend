/** DSH-issued sessions for owned test servers. Cookies never leave this module. */
const sessions = new Map()
const ownOrigin = info => new URL(info.url).origin

export async function registerWebOwnerSession(info) {
  const url = new URL(info.url)
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || !url.searchParams.get('token')) {
    throw new Error('Owner-session bootstrap requires the printed local DSH launch URL')
  }
  const response = await globalThis.fetch(info.url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  if (response.status !== 303) throw new Error(`DSH owner-session bootstrap returned HTTP ${response.status}`)
  const cookies = response.headers.getSetCookie().flatMap(raw => {
    const [pair, ...parts] = raw.split(';').map(value => value.trim())
    const at = pair.indexOf('='), name = pair.slice(0, at), value = pair.slice(at + 1)
    const attributes = new Map(parts.map(part => { const i = part.indexOf('='); return i < 0
      ? [part.toLowerCase(), true] : [part.slice(0, i).toLowerCase(), part.slice(i + 1)] }))
    if (at < 1 || !value || attributes.get('max-age') === '0') return []
    if (!attributes.has('httponly') || String(attributes.get('samesite')).toLowerCase() !== 'strict'
        || attributes.has('secure') && url.protocol !== 'https:') throw new Error('Unexpected DSH owner-cookie attributes')
    return [{ name, value, url: url.origin + '/', path: attributes.get('path') ?? '/',
      httpOnly: true, secure: attributes.has('secure'), sameSite: 'Strict' }]
  })
  await response.arrayBuffer()
  if (!cookies.length) throw new Error('DSH did not issue an owner-session cookie')
  sessions.set(url.origin, { launchUrl: info.url, cookies,
    header: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') })
}

export function forgetWebOwnerSession(info) {
  if (info && sessions.get(ownOrigin(info))?.launchUrl === info.url) sessions.delete(ownOrigin(info))
}

/** Explicit anonymous probes use globalThis.fetch or credentials:'omit'. */
export function fetchFromWebServer(input, init = {}) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  const session = sessions.get(url.origin)
  if (!session || init.credentials === 'omit') return globalThis.fetch(input, init)
  if (init.redirect === 'follow') throw new Error('Owned authenticated requests must not follow redirects')
  const headers = new Headers(init.headers ?? input?.headers)
  if (!headers.has('cookie')) headers.set('cookie', session.header)
  return globalThis.fetch(input, { ...init, headers, redirect: init.redirect ?? 'error' })
}

/** Seed a feature-test page with a real DSH-issued cookie; security E2E also tests real login. */
export async function authenticateWebPage(page, info) {
  const session = sessions.get(ownOrigin(info))
  if (!session || session.launchUrl !== info.url) throw new Error('No session for this owned DSH server')
  await page.send('Network.setCookies', { cookies: session.cookies })
}
