import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'

// OpenCode ACP starts an HTTP server on --port. The host already uses that
// loopback for usage snapshots. Live probe 2026-08-22: POST
// /api/session/{id}/prompt with delivery=steer returns 200 `{ data:
// { admittedSeq, delivery: "steer", prompt } }` — v2 inbox admission, not a
// v1 session user message. GET /session/{id}/message does not contain the
// text, so the ACP SessionPrompt loop never sees it. Production Send now
// therefore persists with POST /session/{id}/message `{ parts, noReply: true }`.

export const OPENCODE_HTTP_STEER_PATH = '/api/session/{sessionID}/prompt'
export const OPENCODE_HTTP_STEER_DELIVERY = 'steer' as const

export const buildOpenCodeHttpSteerBody = (
  text: string
): Readonly<{
  delivery: typeof OPENCODE_HTTP_STEER_DELIVERY
  prompt: Readonly<{ text: string }>
}> => Object.freeze({ delivery: OPENCODE_HTTP_STEER_DELIVERY, prompt: Object.freeze({ text }) })

export const LIVE_OPENCODE_HTTP_STEER = Object.freeze({
  v2SteerStatus: 200,
  v2SteerDelivery: 'steer',
  v2QueueStatus: 200,
  v1MessageNoReplyStatus: 200
})

export type OpenCodeHttpSteerAttempt = Readonly<{
  path: string
  label: string
  status: number
  body: string
}>

export type OpenCodeHttpSteerProbe = Readonly<{
  advertisedAcpSteering: boolean
  createdSession: boolean
  sessionId: string | null
  healthOk: boolean
  attempts: readonly OpenCodeHttpSteerAttempt[]
}>

const allocatePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('failed to allocate port'))
        return
      }
      const port = address.port
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
    server.on('error', reject)
  })

const killTree = (child: ChildProcessWithoutNullStreams): void => {
  child.kill('SIGTERM')
  setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL')
  }, 1_000).unref()
}

const waitForHealth = async (
  baseUrl: string,
  authorization: string,
  ms: number
): Promise<boolean> => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    try {
      const response = await fetch(new URL('/global/health', baseUrl), {
        headers: { authorization },
        signal: AbortSignal.timeout(500)
      })
      if (response.ok) return true
    } catch {
      // Retry until the ACP HTTP listener is up.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

export const probeOpencodeHttpSteer = async (): Promise<OpenCodeHttpSteerProbe> => {
  const port = await allocatePort()
  const password = randomUUID()
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn(
    '/opt/homebrew/bin/opencode',
    ['acp', '--port', String(port), '--hostname', '127.0.0.1', '--cwd', '/tmp'],
    {
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  )
  const connection = acp.client({ name: 'open-science-spike' }).connect(stream)
  try {
    const initialize = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'open-science-spike', version: '0' },
      clientCapabilities: {}
    })
    const advertisedAcpSteering =
      initialize !== null &&
      typeof initialize === 'object' &&
      '_meta' in initialize &&
      typeof initialize._meta === 'object' &&
      initialize._meta !== null &&
      'steering' in initialize._meta
    const healthOk = await waitForHealth(baseUrl, authorization, 8_000)
    let createdSession = false
    let sessionId: string | null = null
    try {
      const created = await connection.agent.request(acp.methods.agent.session.new, {
        cwd: '/tmp',
        mcpServers: []
      })
      sessionId = created.sessionId
      createdSession = true
    } catch {
      createdSession = false
    }
    const prompt = sessionId
      ? connection.agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'Reply with the single word ping and stop.' }]
        })
      : undefined
    prompt?.catch(() => undefined)
    if (prompt) await new Promise((resolve) => setTimeout(resolve, 400))
    const attempts: OpenCodeHttpSteerAttempt[] = []
    if (sessionId && healthOk) {
      const bodies: ReadonlyArray<{ path: string; label: string; json: unknown }> = [
        {
          path: `/api/session/${encodeURIComponent(sessionId)}/prompt`,
          label: 'v2-steer-text',
          json: buildOpenCodeHttpSteerBody('http-steer')
        },
        {
          path: `/api/session/${encodeURIComponent(sessionId)}/prompt`,
          label: 'v2-queue-text',
          json: {
            delivery: 'queue',
            prompt: { text: 'http-queue' }
          }
        },
        {
          path: `/session/${encodeURIComponent(sessionId)}/message`,
          label: 'v1-message-noreply',
          json: {
            parts: [{ type: 'text', text: 'http-v1-prompt' }],
            noReply: true
          }
        }
      ]
      for (const body of bodies) {
        try {
          const response = await fetch(new URL(body.path, baseUrl), {
            method: 'POST',
            headers: {
              authorization,
              'content-type': 'application/json'
            },
            body: JSON.stringify(body.json),
            signal: AbortSignal.timeout(8_000)
          })
          attempts.push(
            Object.freeze({
              path: body.path.includes('/api/')
                ? '/api/session/{id}/prompt'
                : '/session/{id}/message',
              label: body.label,
              status: response.status,
              body: (await response.text()).slice(0, 800)
            })
          )
        } catch (error) {
          attempts.push(
            Object.freeze({
              path: body.path.includes('/api/')
                ? '/api/session/{id}/prompt'
                : '/session/{id}/message',
              label: body.label,
              status: 0,
              body: error instanceof Error ? error.message : String(error)
            })
          )
        }
      }
    }
    return Object.freeze({
      advertisedAcpSteering,
      createdSession,
      sessionId,
      healthOk,
      attempts: Object.freeze(attempts)
    })
  } finally {
    connection.close()
    child.stdin.end()
    killTree(child)
  }
}
