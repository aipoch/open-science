import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'

import {
  ACP_STEERING_METHOD,
  parseSteerOutcome,
  readSteeringAdvertisement
} from './native-send-now-capability'
import {
  buildSteeringDispatchRequest,
  retainInitializeCapabilities
} from './native-send-now-steering-dispatch'

// Live ACP probe against latest adapters. Isolated install lives outside the
// shared worktree node_modules. Production pins stay 0.60.0 / 1.1.4 until a
// dedicated compatibility change.

export const LIVE_ADAPTER_ROOT =
  process.env.NATIVE_SEND_NOW_ADAPTER_ROOT ?? '/tmp/os-send-now-latest-install'

export const latestClaudeAcpEntry = (root = LIVE_ADAPTER_ROOT): string =>
  join(root, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js')

export const latestCodexAcpEntry = (root = LIVE_ADAPTER_ROOT): string =>
  join(root, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js')

export const liveClaudeAvailable = (root = LIVE_ADAPTER_ROOT): boolean =>
  existsSync(latestClaudeAcpEntry(root))

export const liveCodexAvailable = (root = LIVE_ADAPTER_ROOT): boolean =>
  existsSync(latestCodexAcpEntry(root))

export const liveOpencodeAvailable = (): boolean => existsSync('/opt/homebrew/bin/opencode')

export type LiveProbeLaunch = Readonly<{
  command: string
  args: readonly string[]
  env?: NodeJS.ProcessEnv
}>

export type LiveSteerResult =
  ReturnType<typeof parseSteerOutcome> | Readonly<{ kind: 'method-not-found'; message: string }>

export type LiveProbeResult = Readonly<{
  adapter: 'claude-code' | 'codex' | 'opencode'
  version: string
  advertised: boolean
  initializeCapabilities: ReturnType<typeof retainInitializeCapabilities>
  idleSteer: LiveSteerResult | null
  createdSession: boolean
  liveSteer?: LiveSteerResult
  promptStarted?: boolean
}>

const initializeParams = {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientInfo: { name: 'open-science-spike', version: '0' },
  clientCapabilities: {}
}

const killTree = (child: ChildProcessWithoutNullStreams): void => {
  child.kill('SIGTERM')
  setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL')
  }, 1_000).unref()
}

export const probeLiveAdapter = async (
  adapter: LiveProbeResult['adapter'],
  launch: LiveProbeLaunch,
  version: string,
  mode: 'idle' | 'inject' = 'idle'
): Promise<LiveProbeResult> => {
  const child = spawn(launch.command, [...launch.args], {
    env: launch.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const stderr: string[] = []
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString('utf8'))
  })
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  )
  const connection = acp.client({ name: 'open-science-spike' }).connect(stream)
  const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${ms}ms: ${stderr.join('').slice(-2000)}`))
          }, ms)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('spawn', () => resolve())
      }),
      10_000,
      `${adapter} spawn`
    )
    const initialize = await withTimeout(
      connection.agent.request(acp.methods.agent.initialize, initializeParams),
      20_000,
      `${adapter} initialize`
    )
    const advertised = readSteeringAdvertisement(initialize).supported
    const initializeCapabilities = retainInitializeCapabilities(initialize)
    let createdSession = false
    let sessionId = 'sess-missing'
    try {
      const created = await withTimeout(
        connection.agent.request(acp.methods.agent.session.new, {
          cwd: process.cwd(),
          mcpServers: []
        }),
        25_000,
        `${adapter} session/new`
      )
      sessionId = created.sessionId
      createdSession = true
    } catch {
      createdSession = false
    }
    const requestSteer = async (text: string, label: string): Promise<LiveSteerResult> => {
      try {
        const raw = await withTimeout(
          connection.agent.request(
            ACP_STEERING_METHOD,
            buildSteeringDispatchRequest(sessionId, [{ type: 'text', text }])
          ),
          15_000,
          `${adapter} ${label}`
        )
        return parseSteerOutcome(raw)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return Object.freeze({ kind: 'method-not-found', message })
      }
    }
    if (mode === 'inject' && createdSession && advertised) {
      const prompt = connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'Reply with the single word ping and stop.' }]
      })
      prompt.catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const liveSteer = await requestSteer('spike-live-steer', 'live steering')
      return Object.freeze({
        adapter,
        version,
        advertised,
        initializeCapabilities,
        idleSteer: null,
        createdSession,
        liveSteer,
        promptStarted: true
      })
    }
    const idleSteer = await requestSteer('spike-idle-steer', 'idle steering')
    return Object.freeze({
      adapter,
      version,
      advertised,
      initializeCapabilities,
      idleSteer,
      createdSession,
      promptStarted: false
    })
  } finally {
    connection.close()
    child.stdin.end()
    killTree(child)
    void stderr
  }
}

export const claudeLatestLaunch = (root = LIVE_ADAPTER_ROOT): LiveProbeLaunch =>
  Object.freeze({
    command: process.execPath,
    args: [latestClaudeAcpEntry(root)],
    env: {
      ...process.env,
      CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE ?? '/Users/eweno/.local/bin/claude'
    }
  })

export const codexLatestLaunch = (
  root = LIVE_ADAPTER_ROOT,
  nativePath?: string
): LiveProbeLaunch => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (nativePath) env.CODEX_PATH = nativePath
  else delete env.CODEX_PATH
  return Object.freeze({
    command: process.execPath,
    args: [latestCodexAcpEntry(root)],
    env
  })
}

export const opencodeLaunch = (): LiveProbeLaunch =>
  Object.freeze({
    command: '/opt/homebrew/bin/opencode',
    args: ['acp']
  })
