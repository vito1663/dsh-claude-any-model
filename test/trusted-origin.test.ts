import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { setTrustedOriginAccess, trustedRequestExtended, type TrustedOriginAccess } from '../src/http.ts'
import { createSessionVerifier } from '../src/session-verify.ts'

afterEach(() => {
  setTrustedOriginAccess(undefined)
})

/** Minimal request stub: `trustedRequestExtended` reads headers and socket facts only. */
function fakeRequest(headers: Record<string, string>, remote = '127.0.0.1'): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress: remote, localPort: 0 },
  } as unknown as IncomingMessage
}

describe('trustedRequestExtended', () => {
  it('keeps loopback behaviour with no allowlist configured', async () => {
    setTrustedOriginAccess(undefined)
    await expect(trustedRequestExtended(fakeRequest({ host: '127.0.0.1:3080' }), [])).resolves.toBe(true)
    await expect(trustedRequestExtended(fakeRequest({ host: 'dsh.example.com' }), [])).resolves.toBe(false)
  })

  it('admits a configured authority only when the session verifies and the origin matches', async () => {
    // A unique authority keeps this test's verdicts out of the verifier cache other tests use.
    const verdicts: boolean[] = []
    setTrustedOriginAccess({
      hosts: async () => ['dsh-test.example.com', '10.0.0.5:8443'],
      verifySession: async () => verdicts.shift() ?? false,
    })
    // No verifySession success → denied even with the host allowlisted.
    verdicts.push(false)
    await expect(trustedRequestExtended(fakeRequest({ host: 'dsh-test.example.com' }), ['dsh-test.example.com'])).resolves.toBe(false)
    // Verified session, matching authority → admitted.
    verdicts.push(true)
    await expect(trustedRequestExtended(fakeRequest({ host: 'dsh-test.example.com', origin: 'https://dsh-test.example.com' }), ['dsh-test.example.com'])).resolves.toBe(true)
    // Port-less entry matches any port; explicit port matches exactly.
    verdicts.push(true)
    await expect(trustedRequestExtended(fakeRequest({ host: 'dsh-test.example.com:8443' }), ['dsh-test.example.com'])).resolves.toBe(true)
    await expect(trustedRequestExtended(fakeRequest({ host: '10.0.0.5:443' }), ['10.0.0.5:8443'])).resolves.toBe(false)
    // Origin from another authority is refused before verification.
    verdicts.push(true)
    await expect(trustedRequestExtended(fakeRequest({ host: 'dsh-test.example.com', origin: 'https://evil.example' }), ['dsh-test.example.com'])).resolves.toBe(false)
    // Cross-site fetch marker is refused outright, as on loopback.
    verdicts.push(true)
    await expect(trustedRequestExtended(fakeRequest({ host: 'dsh-test.example.com', 'sec-fetch-site': 'cross-site' }), ['dsh-test.example.com'])).resolves.toBe(false)
    // Unlisted authority stays denied.
    verdicts.push(true)
    await expect(trustedRequestExtended(fakeRequest({ host: 'other.example.com' }), ['dsh-test.example.com'])).resolves.toBe(false)
  })

  it('loopback keeps requiring a loopback peer even with an allowlist configured', async () => {
    setTrustedOriginAccess({
      hosts: async () => ['dsh-loopback.example.com'],
      verifySession: async () => true,
    })
    await expect(trustedRequestExtended(fakeRequest({ host: '127.0.0.1:3080' }, '10.1.2.3'), ['dsh-loopback.example.com'])).resolves.toBe(false)
    await expect(trustedRequestExtended(fakeRequest({ host: '127.0.0.1:3080' }), ['dsh-loopback.example.com'])).resolves.toBe(true)
  })
})

describe('createSessionVerifier', () => {
  let server: Server | undefined

  afterEach(() => {
    // Force-close every socket the probe opened, then stop accepting. Waiting
    // for `close()`'s callback alone can stall on a half-closed probe socket.
    server?.closeAllConnections()
    server?.close()
    server = undefined
  })

  function startServer(status: number): Promise<number> {
    return new Promise(resolve => {
      server = createServer((req, res) => {
        res.statusCode = status
        res.end('ok')
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server!.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
  }

  function verifyAgainst(port: number, authority: string, cookie: string): Promise<boolean> {
    const req = {
      headers: { host: authority, cookie },
      socket: { remoteAddress: '127.0.0.1', localPort: port },
    } as unknown as IncomingMessage
    return createSessionVerifier()(req)
  }

  it('accepts a session the probe answers 200 for, and caches the verdict', async () => {
    const port = await startServer(200)
    await expect(verifyAgainst(port, 'accept.example.com', 'dsh-auth-x=y')).resolves.toBe(true)
    // Second call is served from the cache even though the server now fails.
    server = undefined
    await expect(verifyAgainst(port, 'accept.example.com', 'dsh-auth-x=y')).resolves.toBe(true)
  })

  it('refuses a 401 verdict, a missing cookie, and an unreachable probe', async () => {
    const port = await startServer(401)
    await expect(verifyAgainst(port, 'refuse.example.com', 'dsh-auth-x=y')).resolves.toBe(false)
    const noCookie = { headers: { host: 'refuse.example.com' }, socket: { remoteAddress: '127.0.0.1', localPort: port } } as unknown as IncomingMessage
    await expect(createSessionVerifier()(noCookie)).resolves.toBe(false)
    // A closed port: nothing listens there (the refuser server uses its own port).
    await expect(verifyAgainst(1, 'refuse.example.com', 'dsh-auth-x=y')).resolves.toBe(false)
  })
})

describe('probe target port', () => {
  it('reaches the local port the request landed on', async () => {
    const seen: { paths: string[] } = { paths: [] }
    // The verifier runs against the SERVER-side request of this server, whose
    // `socket.localPort` is the port the request actually landed on; the probe
    // therefore comes back to this very server on `/`.
    const server = await new Promise<Server>(resolve => {
      const s = createServer((req, res) => {
        seen.paths.push(req.url ?? '')
        if (req.url === '/') {
          // The verifier's own probe: answer plainly, no recursion.
          res.statusCode = 200
          res.end('ok')
          return
        }
        createSessionVerifier()(req).then(ok => {
          res.statusCode = 200
          res.end(ok ? 'true' : 'false')
        })
      })
      s.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const port = (server.address() as { port: number }).port
      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: '/authorize-me', method: 'GET', headers: { host: 'probe.example.com', cookie: 'dsh-auth-probe=1' } },
          res => {
            let data = ''
            res.on('data', chunk => { data += chunk })
            res.on('end', () => resolve(data))
          },
        )
        req.on('error', reject)
        req.end()
      })
      expect(body).toBe('true')
      expect(seen.paths).toEqual(['/authorize-me', '/'])
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  })
})
