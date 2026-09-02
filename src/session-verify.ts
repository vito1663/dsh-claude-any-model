import { createHash } from 'node:crypto'
import { request } from 'node:http'
import type { IncomingMessage } from 'node:http'

/**
 * Session re-verification for non-loopback access.
 *
 * The plugin's own routes are not behind the Host's authentication gate, so a
 * request that arrives for a configured remote authority must prove it carries
 * a browser session the Host itself accepts. The check replays the request's
 * `Cookie` header against the Host's own index page over loopback (same
 * authority in `Host`, so the cookie name and signed audience match) and
 * accepts the session only when the Host answers 200. This uses nothing but
 * HTTP, so it survives Host upgrades that rotate the cookie format or secret.
 *
 * Results are cached briefly per (authority, cookie) pair: same-origin browser
 * fetches repeat the identical header on every poll, and the projection stream
 * plus the settings panels would otherwise add a loopback roundtrip apiece.
 */

const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX_ENTRIES = 128
const MAX_COOKIE_BYTES = 4096

const cache = new Map<string, { ok: boolean; at: number }>()

function cached(key: string, ok: boolean, at: number): boolean {
  cache.set(key, { ok, at })
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
  return ok
}

/**
 * Build the verifier `http.ts` consults for requests on a configured remote
 * authority. The verification target port is read per request from the
 * incoming socket's local port, so the probe always reaches the same listener
 * the request landed on, whatever port the deployment bound.
 */
export function createSessionVerifier(): (req: IncomingMessage) => Promise<boolean> {
  return req => {
    const cookie = req.headers.cookie
    if (cookie === undefined || cookie.length === 0 || cookie.length > MAX_COOKIE_BYTES) return Promise.resolve(false)
    const authority = req.headers.host
    if (authority === undefined || authority.length === 0) return Promise.resolve(false)
    const localPort = req.socket.localPort
    if (localPort === undefined) return Promise.resolve(false)
    const key = createHash('sha256').update(authority).update('\n').update(cookie).digest('hex')
    const hit = cache.get(key)
    if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.ok)
    return new Promise(resolve => {
      const probe = request(
        // `agent: false` — one dedicated socket per probe, closed with the
        // response: the probe must not hold a pooled keep-alive socket to the
        // Host that outlives the verdict. `connection: close` asks the Host
        // to drop its side of the socket with the response too.
        { host: '127.0.0.1', port: localPort, path: '/', method: 'GET', agent: false, headers: { host: authority, cookie, connection: 'close' } },
        res => {
          res.resume()
          resolve(cached(key, res.statusCode === 200, Date.now()))
        },
      )
      probe.on('error', () => resolve(cached(key, false, Date.now())))
      probe.end()
    })
  }
}
