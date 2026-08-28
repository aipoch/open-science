#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone protocol spike uses dynamic JSON-RPC values */

// Focused, login-free CodeBuddy ACP cancellation probe. It uses a local Chat Completions mock and
// fails unless cancellation aborts only the selected Session's active upstream request while leaving
// the ACP process and both Sessions usable.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const binary = process.env.CODEBUDDY_BIN || 'codebuddy'
const root = await mkdtemp(join(tmpdir(), 'open-science-codebuddy-cancel-'))
const configDir = join(root, 'config')
const projectDir = join(root, 'project')
await Promise.all([mkdir(configDir, { recursive: true }), mkdir(projectDir, { recursive: true })])

const requests = []
let cancelRequestStarted
const cancelStarted = new Promise((resolve) => (cancelRequestStarted = resolve))
let cancelRequestClosed
const cancelClosed = new Promise((resolve) => (cancelRequestClosed = resolve))
let cancelBRequestStarted
const cancelBStarted = new Promise((resolve) => (cancelBRequestStarted = resolve))
let cancelBRequestClosed
const cancelBClosed = new Promise((resolve) => (cancelBRequestClosed = resolve))

const writeChunk = (response, content = '', finishReason = null) => {
  response.write(
    `data: ${JSON.stringify({
      id: 'chatcmpl-cancel-spike',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'spike-model',
      choices: [{ index: 0, delta: { content }, finish_reason: finishReason }]
    })}\n\n`
  )
}

const mock = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const parsed = JSON.parse(body)
    const serialized = JSON.stringify(parsed)
    const kind = serialized.includes('Generate a concise')
      ? 'title'
      : serialized.includes('PROMPT_B')
        ? 'prompt-b'
        : serialized.includes('CANCEL_B')
          ? 'cancel-b'
          : serialized.includes('RETRY_A')
            ? 'retry-a'
            : serialized.includes('CANCEL_A')
              ? 'cancel-a'
              : 'other'
    requests.push({ kind, url: request.url })

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    writeChunk(response)

    if (kind === 'cancel-a' || kind === 'cancel-b') {
      if (kind === 'cancel-a') cancelRequestStarted()
      else cancelBRequestStarted()
      const heartbeat = setInterval(() => writeChunk(response, '.'), 100)
      response.on('close', () => {
        clearInterval(heartbeat)
        if (kind === 'cancel-a') cancelRequestClosed()
        else cancelBRequestClosed()
      })
      return
    }

    const text = kind === 'title' ? '{"isNewTopic":true,"title":"Cancel spike"}' : `${kind}:ok`
    writeChunk(response, text)
    writeChunk(response, '', 'stop')
    response.end('data: [DONE]\n\n')
  })
})
await new Promise((resolve, reject) => {
  mock.once('error', reject)
  mock.listen(0, '127.0.0.1', resolve)
})
const address = mock.address()
if (!address || typeof address === 'string') throw new Error('mock listen failed')

const child = spawn(
  binary,
  ['--acp', '--strict-mcp-config', '--setting-sources', 'user', '--tools', ''],
  {
    cwd: projectDir,
    env: {
      ...process.env,
      CODEBUDDY_CONFIG_DIR: configDir,
      CODEBUDDY_API_KEY: 'local-spike-only',
      CODEBUDDY_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      CODEBUDDY_MODEL: 'spike-model',
      CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: '1',
      CODEBUDDY_DISABLE_HOT_RELOAD: '1',
      CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
      CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: '1',
      CODEBUDDY_DISABLE_FORK_SUBAGENT: '1',
      CODEBUDDY_DISABLE_BACKGROUND_TASKS: '1',
      CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CODEBUDDY_DEFER_TOOL_LOADING: '0',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      NO_BROWSER: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  }
)

let nextId = 1
let stdout = ''
let stderr = ''
const pending = new Map()
child.stderr.on('data', (chunk) => (stderr += chunk))
child.stdout.on('data', (chunk) => {
  stdout += chunk.toString().replaceAll('\0', '')
  const lines = stdout.split('\n')
  stdout = lines.pop() || ''
  for (const raw of lines) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      continue
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
      continue
    }
    if (message.id !== undefined && message.method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`)
    }
  }
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const withTimeout = (promise, label, ms = 3_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
const request = (method, params, ms = 10_000) => {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, ms)
    pending.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      else resolve(message.result)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
const notify = (method, params) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

let verdict
try {
  await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'codebuddy-cancel-spike', version: '0.0.0' },
    clientCapabilities: {}
  })
  const sessionA = await request('session/new', { cwd: projectDir, mcpServers: [] })
  const promptA = request(
    'session/prompt',
    { sessionId: sessionA.sessionId, prompt: [{ type: 'text', text: 'CANCEL_A' }] },
    10_000
  )
  await withTimeout(cancelStarted, 'upstream cancel request start')

  const cancelSentAt = Date.now()
  notify('session/cancel', { sessionId: sessionA.sessionId })
  const [cancelResult] = await Promise.all([
    withTimeout(promptA, 'cancelled ACP prompt'),
    withTimeout(cancelClosed, 'cancelled upstream HTTP stream')
  ])
  const cancelLatencyMs = Date.now() - cancelSentAt

  // CodeBuddy intentionally rejects prompts arriving inside its 500ms cancel barrier.
  await wait(600)
  const retryA = await request('session/prompt', {
    sessionId: sessionA.sessionId,
    prompt: [{ type: 'text', text: 'RETRY_A' }]
  })
  const sessionB = await request('session/new', { cwd: projectDir, mcpServers: [] })
  let promptBSettled = false
  const activePromptB = request('session/prompt', {
    sessionId: sessionB.sessionId,
    prompt: [{ type: 'text', text: 'CANCEL_B' }]
  })
  activePromptB.then(
    () => (promptBSettled = true),
    () => (promptBSettled = true)
  )
  await withTimeout(cancelBStarted, 'upstream session B request start')

  notify('session/cancel', { sessionId: sessionA.sessionId })
  await wait(250)
  if (promptBSettled)
    throw new Error('cancelling idle session A incorrectly stopped active session B')

  const cancelBSentAt = Date.now()
  notify('session/cancel', { sessionId: sessionB.sessionId })
  const [cancelBResult] = await Promise.all([
    withTimeout(activePromptB, 'cancelled session B ACP prompt'),
    withTimeout(cancelBClosed, 'cancelled session B upstream HTTP stream')
  ])
  const cancelBLatencyMs = Date.now() - cancelBSentAt

  await wait(600)
  const promptB = await request('session/prompt', {
    sessionId: sessionB.sessionId,
    prompt: [{ type: 'text', text: 'PROMPT_B' }]
  })

  if (cancelResult.stopReason !== 'cancelled') throw new Error('session A did not report cancelled')
  if (retryA.stopReason !== 'end_turn')
    throw new Error('session A was not reusable after cancel barrier')
  if (cancelBResult.stopReason !== 'cancelled')
    throw new Error('session B did not report cancelled')
  if (promptB.stopReason !== 'end_turn')
    throw new Error('session B was not reusable after cancel barrier')
  if (child.exitCode !== null) throw new Error('ACP child exited during per-session cancellation')

  verdict = {
    ok: true,
    cancelLatencyMs,
    cancelResult,
    retryA,
    wrongSessionCancelLeftBRunning: true,
    cancelBLatencyMs,
    cancelBResult,
    promptB,
    childStillRunning: child.exitCode === null,
    requests
  }
} catch (error) {
  verdict = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    childStillRunning: child.exitCode === null,
    requests,
    stderrTail: stderr.slice(-2_000)
  }
} finally {
  child.kill('SIGTERM')
  await new Promise((resolve) => mock.close(resolve))
}

process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)
if (!verdict.ok) process.exitCode = 1
