import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import * as acp from '@agentclientprotocol/sdk'
import { claudeCliPath } from '@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { claudeCodeFramework } from './claude-code'
import { provisionAppClaudePrivateProfile } from '../settings/claude-config-provision'
import { terminateProcessTree } from '../process-tree'

const instruction = 'ISSUE_3283_PERSONAL_INSTRUCTION'
const rule = 'ISSUE_3283_PERSONAL_RULE'
const appInstruction = 'ISSUE_3283_APP_INSTRUCTION'

type ProbeResult = {
  personalInstruction: boolean
  personalRule: boolean
  appInstruction: boolean
  personalTool: boolean
  appTool: boolean
  startPermissionModes: string[]
  strictMcp: boolean
  initialMode: string | undefined
  appliedMode: string | undefined
  requests: number
  instructionOnEveryTurn: boolean
  permissionRequests: number
  personalPermissionAllowedWrite: boolean
}

// Use only synthetic profiles, a loopback model and a loopback MCP server. Both the ACP adapter
// and Claude CLI are real; no test seam or mocks replace settings loading or request generation.
async function probe(): Promise<ProbeResult> {
  const root = await mkdtemp(join(tmpdir(), 'open-science-claude-settings-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, '.claude')
  await mkdir(workspace)
  await mkdir(join(profile, 'rules'), { recursive: true })
  await writeFile(join(profile, 'CLAUDE.md'), instruction)
  await writeFile(join(profile, 'rules', 'personal.md'), rule)
  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({
      permissions: { defaultMode: 'auto', allow: ['Write'] }
    })
  )
  const requests: string[] = []
  let permissionRequests = 0
  const writeTarget = join(workspace, 'permission-probe.txt')
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if (request.url?.startsWith('/mcp/')) {
      if (request.method !== 'POST') {
        response.writeHead(405).end()
        return
      }
      if (body.id === undefined) {
        response.writeHead(202).end()
        return
      }
      const name = request.url.endsWith('personal') ? 'personal_probe' : 'app_probe'
      let result: unknown = {}
      if (body.method === 'initialize')
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name, version: '1' }
        }
      if (body.method === 'tools/list')
        result = {
          tools: [
            {
              name,
              description: name,
              inputSchema: { type: 'object', properties: {} }
            }
          ]
        }
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      return
    }
    if (request.url?.includes('count_tokens')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}')
      return
    }
    if (!request.url?.startsWith('/v1/messages')) {
      response.writeHead(404).end()
      return
    }
    requests.push(JSON.stringify(body))
    const useTool = requests.length === 1
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_probe',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 }
        }
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: useTool
          ? { type: 'tool_use', id: 'tool_probe', name: 'Write', input: {} }
          : { type: 'text', text: '' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: useTool
          ? {
              type: 'input_json_delta',
              partial_json: JSON.stringify({ file_path: writeTarget, content: 'synthetic probe' })
            }
          : { type: 'text_delta', text: 'OK' }
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 }
      },
      { type: 'message_stop' }
    ]
    response
      .writeHead(200, { 'content-type': 'text/event-stream' })
      .end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const personalConfig = JSON.stringify({
    hasCompletedOnboarding: true,
    mcpServers: { personal: { type: 'http', url: `${baseUrl}/mcp/personal` } }
  })
  await writeFile(join(root, '.claude.json'), personalConfig)
  await writeFile(join(profile, '.claude.json'), personalConfig)
  const native = await claudeCliPath()
  const launcher = join(root, 'claude-probe.js')
  const argvLog = join(root, 'argv.json')
  await writeFile(
    launcher,
    `const {spawn}=require('node:child_process');
require('node:fs').appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2))+'\\n');
const child=spawn(${JSON.stringify(native)}, process.argv.slice(2), {stdio:'inherit'});
process.on('SIGTERM',()=>child.kill('SIGTERM'));
child.on('exit',code=>process.exit(code??1));
`
  )

  const storageRoot = join(root, 'app')
  const privateProfileDir = join(storageRoot, 'claude')
  const privateSettings = await provisionAppClaudePrivateProfile(privateProfileDir)
  const projectionRoot = join(root, 'skills')
  await mkdir(projectionRoot)
  const env: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL'
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: profile,
    CLAUDE_CODE_EXECUTABLE: launcher,
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'local-appdata'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    ANTHROPIC_API_KEY: 'synthetic-settings-probe-key',
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1'
  })
  const setup = claudeCodeFramework.buildSessionSetup({
    systemPromptAppends: [appInstruction],
    // The resolver's shared-provider policy is checked in backend-resolver.test.ts. Exercise
    // that public session-options contract here without importing the multi-provider coordinator.
    sessionOptions: {
      settings: privateSettings,
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: 'default',
      additionalDirectories: [projectionRoot],
      sandbox: {
        filesystem: { allowRead: [projectionRoot], denyWrite: [projectionRoot] }
      }
    }
  })
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js'))],
    { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  let initialMode: string | undefined
  let appliedMode: string | undefined
  try {
    await acp
      .client({ name: 'claude-settings-probe' })
      .onRequest(acp.methods.client.session.requestPermission, () => {
        permissionRequests++
        return { outcome: { outcome: 'cancelled' } }
      })
      .connectWith(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
        ),
        async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {}
          })
          const session = await ctx.request(acp.methods.agent.session.new, {
            cwd: workspace,
            mcpServers: [{ name: 'app', type: 'http', url: `${baseUrl}/mcp/app`, headers: [] }],
            _meta: setup.meta
          })
          initialMode = session.modes?.currentModeId
          await ctx.request(acp.methods.agent.session.setMode, {
            sessionId: session.sessionId,
            modeId: 'default'
          })
          appliedMode = 'default'
          for (let turn = 0; turn < 2; turn++) {
            if (turn === 1) {
              await ctx.request(acp.methods.agent.session.close, { sessionId: session.sessionId })
              await ctx.request(acp.methods.agent.session.resume, {
                sessionId: session.sessionId,
                cwd: workspace,
                mcpServers: [{ name: 'app', type: 'http', url: `${baseUrl}/mcp/app`, headers: [] }],
                _meta: setup.meta
              })
              await ctx.request(acp.methods.agent.session.setMode, {
                sessionId: session.sessionId,
                modeId: 'default'
              })
            }
            const result = await ctx.request(acp.methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: 'text', text: `Reply OK. Turn ${turn}.` }]
            })
            expect(result.stopReason).toBe('end_turn')
          }
          await ctx.request(acp.methods.agent.session.close, { sessionId: session.sessionId })
        }
      )
    expect(requests.length).toBeGreaterThanOrEqual(2)
    const launches = (await readFile(argvLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        return JSON.parse(line) as string[]
      })
    const body = requests.join('\n')
    return {
      personalInstruction: body.includes(instruction),
      personalRule: body.includes(rule),
      appInstruction: body.includes(appInstruction),
      personalTool: body.includes('mcp__personal__personal_probe'),
      appTool: body.includes('mcp__app__app_probe'),
      startPermissionModes: launches.map((argv) => argv[argv.indexOf('--permission-mode') + 1]!),
      strictMcp: launches.every((argv) => argv.includes('--strict-mcp-config')),
      initialMode,
      appliedMode,
      requests: requests.length,
      instructionOnEveryTurn: requests.every((body) => body.includes(instruction)),
      permissionRequests,
      personalPermissionAllowedWrite: await access(writeTarget).then(
        () => true,
        () => false
      )
    }
  } catch (error) {
    throw new Error(`${String(error)}\n${stderr.slice(-5000)}`)
  } finally {
    await terminateProcessTree(child)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

describe('issue 3283: shared Claude personal settings', () => {
  let baseline: ProbeResult
  beforeAll(async () => {
    baseline = await probe()
    console.info('ISSUE_3283_BASELINE', JSON.stringify(baseline))
  }, 60_000)
  it('excludes personal global instructions and rules from actual model requests', () => {
    expect(baseline.appInstruction).toBe(true)
    expect(baseline.personalInstruction).toBe(false)
    expect(baseline.personalRule).toBe(false)
  })
  it('exposes app MCP tools without exposing user-scoped MCP tools', () => {
    expect(baseline.appTool).toBe(true)
    expect(baseline.personalTool).toBe(false)
    expect(baseline.strictMcp).toBe(true)
  })
  it('starts fresh and resumed sessions in the app permission mode', () => {
    expect(baseline.appliedMode).toBe('default')
    expect(baseline.startPermissionModes).toEqual(['default', 'default'])
  })
  it('does not let personal allow rules skip the app permission callback', () => {
    expect(baseline.personalPermissionAllowedWrite).toBe(false)
    expect(baseline.permissionRequests).toBe(1)
  })
})
