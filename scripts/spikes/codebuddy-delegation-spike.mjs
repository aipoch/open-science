#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone protocol spike uses dynamic JSON-RPC values */

// PROTOTYPE: login-free proof that app-owned delegation can run isolated CodeBuddy ACP children.
// It intentionally exercises the same primitives as the production delegate runtime: one ACP
// process per child, an injected Notebook MCP server, ACP cancellation, and child reuse.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const binary = process.env.CODEBUDDY_BIN || 'codebuddy'
const version = spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim()
const root = await mkdtemp(join(tmpdir(), 'open-science-codebuddy-delegation-'))
const mcpPath = join(root, 'delegated-notebook-mcp.mjs')
const blockedNativeTools = [
  'Agent',
  'Workflow',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage'
]
const injectedToolName = 'mcp__open_science_notebook__delegate_probe'

await writeFile(
  mcpPath,
  `let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\\n')
  buffer = lines.pop() || ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.id === undefined) continue
    let result = {}
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'delegated-notebook-spike', version: '0.0.0' }
      }
    } else if (message.method === 'tools/list') {
      result = {
        tools: [{
          name: 'delegate_probe',
          description: 'Prove that an app-owned delegated Notebook MCP reached this child.',
          inputSchema: {
            type: 'object',
            properties: { child: { type: 'string' } },
            required: ['child'],
            additionalProperties: false
          }
        }]
      }
    } else if (message.method === 'tools/call' && message.params?.name === 'delegate_probe') {
      result = {
        content: [{
          type: 'text',
          text: 'DELEGATED_MCP_RESULT_' + process.env.SPIKE_CHILD
        }]
      }
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
  }
})
`
)

const requests = []
const longRequests = new Map()
const observeLongRequest = (label) => {
  let resolveStarted
  const started = new Promise((resolve) => (resolveStarted = resolve))
  let resolveClosed
  const closed = new Promise((resolve) => (resolveClosed = resolve))
  longRequests.set(label, { started, closed, resolveStarted, resolveClosed })
}
observeLongRequest('A')
observeLongRequest('B')

const writeChunk = (response, id, delta, finishReason = null) => {
  response.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 0,
      model: 'spike-model',
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}\n\n`
  )
}

const mock = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const parsed = JSON.parse(body)
    const serialized = JSON.stringify(parsed)
    const isTitle = serialized.includes('Generate a concise')
    const lastUser = [...(parsed.messages || [])]
      .reverse()
      .find((message) => message?.role === 'user')
    const prompt = JSON.stringify(lastUser?.content || '')
    const label = prompt.includes('CHILD_A') ? 'A' : prompt.includes('CHILD_B') ? 'B' : undefined
    const toolNames = Array.isArray(parsed.tools)
      ? parsed.tools
          .map((tool) => tool?.function?.name || tool?.name)
          .filter((name) => typeof name === 'string')
      : []
    // CodeBuddy carries earlier user turns forward. Prefer the newest probe markers over markers
    // retained from the cancelled/slow turn in the serialized conversation.
    const kind = isTitle
      ? 'title'
      : serialized.includes('RETRY_CHILD_A')
        ? 'retry-a'
        : serialized.includes('MESSAGE_CHILD_B')
          ? 'message-b'
          : serialized.includes('CANCEL_CHILD_A')
            ? 'cancel-a'
            : serialized.includes('SLOW_CHILD_B')
              ? 'slow-b'
              : serialized.includes('MCP_CHILD_')
                ? `mcp-${label?.toLowerCase()}`
                : 'other'
    requests.push({ kind, label, toolNames })

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const id = `chatcmpl-delegation-${requests.length}`
    writeChunk(response, id, { role: 'assistant', content: '' })

    if (kind === 'cancel-a') {
      const state = longRequests.get('A')
      state.resolveStarted()
      const heartbeat = setInterval(() => writeChunk(response, id, { content: '.' }), 100)
      response.on('close', () => {
        clearInterval(heartbeat)
        state.resolveClosed()
      })
      return
    }

    if (kind === 'slow-b') {
      const state = longRequests.get('B')
      state.resolveStarted()
      const timer = setTimeout(() => {
        writeChunk(response, id, { content: 'SLOW_CHILD_B_OK' })
        writeChunk(response, id, {}, 'stop')
        response.end('data: [DONE]\n\n')
      }, 900)
      response.on('close', () => {
        clearTimeout(timer)
        state.resolveClosed()
      })
      return
    }

    const hasMcpResult = label && serialized.includes(`DELEGATED_MCP_RESULT_${label}`)
    if (kind.startsWith('mcp-') && !hasMcpResult && toolNames.includes(injectedToolName)) {
      writeChunk(response, id, {
        tool_calls: [
          {
            index: 0,
            id: `call_delegate_${label}`,
            type: 'function',
            function: {
              name: injectedToolName,
              arguments: JSON.stringify({ child: label })
            }
          }
        ]
      })
      writeChunk(response, id, {}, 'tool_calls')
      response.end('data: [DONE]\n\n')
      return
    }

    const text = isTitle
      ? '{"isNewTopic":true,"title":"Delegation spike"}'
      : hasMcpResult
        ? `MCP_CHILD_${label}_OK`
        : `${kind.toUpperCase()}_OK`
    writeChunk(response, id, { content: text })
    writeChunk(response, id, {}, 'stop')
    response.end('data: [DONE]\n\n')
  })
})
await new Promise((resolve, reject) => {
  mock.once('error', reject)
  mock.listen(0, '127.0.0.1', resolve)
})
const address = mock.address()
if (!address || typeof address === 'string') throw new Error('mock listen failed')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const withTimeout = (promise, label, ms = 5_000) =>
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

const spawnClient = async (label) => {
  const configDir = join(root, `config-${label}`)
  const projectDir = join(root, `project-${label}`)
  await Promise.all([mkdir(configDir, { recursive: true }), mkdir(projectDir, { recursive: true })])
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
  const permissionRequests = []
  const notificationMethods = []
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
      if (
        message.id !== undefined &&
        (message.result !== undefined || message.error !== undefined)
      ) {
        pending.get(message.id)?.(message)
        pending.delete(message.id)
        continue
      }
      if (message.id !== undefined && message.method) {
        permissionRequests.push(message.method)
        const allowOnce = message.params?.options?.find(
          (option) => option.kind === 'allow_once' || option.optionId === 'allow'
        )
        const result =
          message.method === 'session/request_permission' && allowOnce
            ? { outcome: { outcome: 'selected', optionId: allowOnce.optionId } }
            : {}
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
        continue
      }
      if (message.method) notificationMethods.push(message.method)
    }
  })

  const request = (method, params, timeoutMs = 15_000) => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${label} ${method} timed out`))
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(`${label} ${method}: ${JSON.stringify(message.error)}`))
        else resolve(message.result)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  await request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: `codebuddy-delegation-spike-${label}`, version: '0.0.0' },
    clientCapabilities: {}
  })
  const mcpServers = [
    {
      name: 'open-science-notebook',
      command: process.execPath,
      args: [mcpPath],
      env: [{ name: 'SPIKE_CHILD', value: label }]
    }
  ]
  const session = await request('session/new', {
    cwd: projectDir,
    mcpServers
  })
  return {
    label,
    child,
    sessionId: session.sessionId,
    request,
    notify,
    activate: () =>
      request('session/resume', { sessionId: session.sessionId, cwd: projectDir, mcpServers }),
    permissionRequests,
    notificationMethods,
    getStderr: () => stderr
  }
}

const clients = []
let verdict
try {
  const [clientA, clientB] = await Promise.all([spawnClient('A'), spawnClient('B')])
  clients.push(clientA, clientB)

  const [mcpA, mcpB] = await Promise.all([
    clientA.request('session/prompt', {
      sessionId: clientA.sessionId,
      prompt: [{ type: 'text', text: 'MCP_CHILD_A' }]
    }),
    clientB.request('session/prompt', {
      sessionId: clientB.sessionId,
      prompt: [{ type: 'text', text: 'MCP_CHILD_B' }]
    })
  ])
  await Promise.all([clientA.activate(), clientB.activate()])

  const cancelA = clientA.request(
    'session/prompt',
    {
      sessionId: clientA.sessionId,
      prompt: [{ type: 'text', text: 'CANCEL_CHILD_A' }]
    },
    20_000
  )
  const slowB = clientB.request(
    'session/prompt',
    {
      sessionId: clientB.sessionId,
      prompt: [{ type: 'text', text: 'SLOW_CHILD_B' }]
    },
    20_000
  )
  await Promise.all([
    withTimeout(longRequests.get('A').started, 'child A upstream start'),
    withTimeout(longRequests.get('B').started, 'child B upstream start')
  ])

  const cancelSentAt = Date.now()
  clientA.notify('session/cancel', { sessionId: clientA.sessionId })
  const [cancelOutcome, slowBResult] = await Promise.all([
    withTimeout(cancelA, 'child A cancellation').then((result) => ({
      result,
      latencyMs: Date.now() - cancelSentAt
    })),
    withTimeout(slowB, 'child B completion'),
    withTimeout(longRequests.get('A').closed, 'child A upstream close')
  ])
  const cancelResult = cancelOutcome.result
  const cancelLatencyMs = cancelOutcome.latencyMs

  await wait(600)
  const [retryA, messageB] = await Promise.all([
    clientA.request('session/prompt', {
      sessionId: clientA.sessionId,
      prompt: [{ type: 'text', text: 'RETRY_CHILD_A' }]
    }),
    clientB.request('session/prompt', {
      sessionId: clientB.sessionId,
      prompt: [{ type: 'text', text: 'MESSAGE_CHILD_B' }]
    })
  ])

  const nonTitleRequests = requests.filter((entry) => entry.kind !== 'title')
  const injectedForA = requests.some(
    (entry) => entry.label === 'A' && entry.toolNames.includes(injectedToolName)
  )
  const injectedForB = requests.some(
    (entry) => entry.label === 'B' && entry.toolNames.includes(injectedToolName)
  )
  const observedBlockedNativeTools = [
    ...new Set(
      nonTitleRequests.flatMap((entry) =>
        entry.toolNames.filter((name) => blockedNativeTools.includes(name))
      )
    )
  ]
  const authRequested = clients.some((client) =>
    client.notificationMethods.includes('_codebuddy.ai/authUrl')
  )

  if (mcpA.stopReason !== 'end_turn' || mcpB.stopReason !== 'end_turn') {
    throw new Error('injected MCP probe did not complete for both children')
  }
  if (!injectedForA || !injectedForB)
    throw new Error('delegated MCP tool was not injected per child')
  if (observedBlockedNativeTools.length > 0) {
    throw new Error(`native delegation tools leaked: ${observedBlockedNativeTools.join(', ')}`)
  }
  if (cancelResult.stopReason !== 'cancelled') throw new Error('child A did not report cancelled')
  if (slowBResult.stopReason !== 'end_turn')
    throw new Error('child B was interrupted by child A cancel')
  if (retryA.stopReason !== 'end_turn')
    throw new Error('child A was not reusable after cancellation')
  if (messageB.stopReason !== 'end_turn') throw new Error('child B did not accept a follow-up turn')
  if (clients.some((client) => client.child.exitCode !== null)) {
    throw new Error('a delegated ACP child exited before cleanup')
  }
  if (authRequested) throw new Error('CodeBuddy requested an authentication URL')

  verdict = {
    ok: true,
    version,
    loginRequested: authRequested,
    architecture: 'one-codebuddy-acp-process-per-delegated-child',
    injectedNotebookMcp: { childA: injectedForA, childB: injectedForB },
    nativeDelegationToolsObserved: observedBlockedNativeTools,
    childACancel: {
      stopReason: cancelResult.stopReason,
      upstreamClosed: true,
      processStillRunning: clientA.child.exitCode === null,
      reusable: retryA.stopReason === 'end_turn',
      latencyMs: cancelLatencyMs
    },
    childBUnaffected: {
      completedDuringChildACancel: slowBResult.stopReason === 'end_turn',
      processStillRunning: clientB.child.exitCode === null,
      followupAccepted: messageB.stopReason === 'end_turn'
    },
    permissionCallbacks: {
      childA: clientA.permissionRequests,
      childB: clientB.permissionRequests
    }
  }
} catch (error) {
  verdict = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    requests,
    children: clients.map((client) => ({
      label: client.label,
      running: client.child.exitCode === null,
      stderrTail: client.getStderr().slice(-1_500)
    }))
  }
} finally {
  for (const client of clients) client.child.kill('SIGTERM')
  await new Promise((resolve) => mock.close(resolve))
}

process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`)
if (!verdict.ok) process.exitCode = 1
