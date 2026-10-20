import { expect } from '@playwright/test'
import { request } from 'node:http'

import { test } from '../fixtures/electron-app'

const REMOTE_HOST = 'electron-e2e.r3proxy.com'

const remoteRequest = async (
  port: number,
  path: string,
  cookie?: string
): Promise<{ body: string; setCookie: string[]; status: number }> =>
  new Promise((resolveRequest, rejectRequest) => {
    const outgoing = request(
      {
        agent: false,
        headers: {
          host: REMOTE_HOST,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/124.0',
          ...(cookie ? { cookie } : {})
        },
        host: '127.0.0.1',
        path,
        port
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          resolveRequest({
            body,
            setCookie: response.headers['set-cookie'] ?? [],
            status: response.statusCode ?? 0
          })
        })
      }
    )
    outgoing.once('error', rejectRequest)
    outgoing.end()
  })

const cookieValue = (headers: string[], name: string): string | undefined =>
  headers.map((header) => header.split(';', 1)[0]).find((cookie) => cookie.startsWith(`${name}=`))

test('re-enters with a trusted browser after the Electron app restarts', async ({ app }) => {
  let page = await app.completeOnboarding()
  page = await app.enableFakeRemoteIt()
  const enabled = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: {
        remoteAccess: {
          setMode: (request: { mode: 'remoteit' }) => Promise<{
            enabled: boolean
            lifecycle: string
            remoteIt: { service?: { port: number } }
          }>
        }
      }
    }
    return bridge.api.remoteAccess.setMode({ mode: 'remoteit' })
  })
  expect(enabled).toMatchObject({ enabled: true, lifecycle: 'running' })
  const port = enabled.remoteIt.service?.port
  if (!port) throw new Error('The remote service did not report its local port.')

  const pairing = await remoteRequest(port, '/')
  expect(pairing.status).toBe(200)
  expect(pairing.body).toContain('Approve this browser')
  const pairingCookie = cookieValue(pairing.setCookie, 'open_science_remote_pairing')
  expect(pairingCookie).toBeDefined()

  const approved = await page.evaluate(async () => {
    const bridge = globalThis as unknown as {
      api: {
        remoteAccess: {
          approve: (request: { decision: 'always'; requestId: string }) => Promise<{
            pendingRequests: Array<{ id: string }>
            trustedBrowsers: Array<{ id: string }>
          }>
          getSnapshot: () => Promise<{ pendingRequests: Array<{ id: string }> }>
        }
      }
    }
    const snapshot = await bridge.api.remoteAccess.getSnapshot()
    const pending = snapshot.pendingRequests[0]
    if (!pending) throw new Error('The remote browser pairing request was not surfaced.')
    return bridge.api.remoteAccess.approve({ requestId: pending.id, decision: 'always' })
  })
  expect(approved.trustedBrowsers).toHaveLength(1)

  const status = await remoteRequest(
    port,
    '/__open_science_remote/pair/status',
    pairingCookie as string
  )
  expect(status.status).toBe(200)
  expect(JSON.parse(status.body)).toEqual({ status: 'approved' })
  const sessionCookie = cookieValue(status.setCookie, 'open_science_remote_session')
  expect(sessionCookie).toBeDefined()
  expect((await remoteRequest(port, '/api/bootstrap', sessionCookie)).status).toBe(200)

  page = await app.restart()
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const bridge = globalThis as unknown as {
            api: {
              remoteAccess: {
                getSnapshot: () => Promise<{ enabled: boolean; lifecycle: string }>
              }
            }
          }
          return bridge.api.remoteAccess.getSnapshot()
        }),
      { timeout: 30_000 }
    )
    .toMatchObject({ enabled: true, lifecycle: 'running' })

  const restoredPort = await page.evaluate(async () => {
    const snapshot = await window.api.remoteAccess.getSnapshot()
    return snapshot.remoteIt.service?.port
  })
  if (!restoredPort) throw new Error('The restored remote service did not report its local port.')
  const reentered = await remoteRequest(restoredPort, '/api/bootstrap', sessionCookie)
  expect(reentered.status).toBe(200)
  expect(JSON.parse(reentered.body)).toMatchObject({
    appName: expect.stringContaining('Open-Science')
  })
})
