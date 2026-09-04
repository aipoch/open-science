import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { claudeCodeFramework } from './claude-code'

const temporaryRoots: string[] = []
const inheritedProcessEnvironmentKeys = [
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
] as const

const anthropicMessage = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_memory_probe","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  ''
].join('\n')

const projectKey = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

type MemoryProbeResult = {
  memoryContents: string
  memoryEntries: string[]
  requestContainsSentinel: boolean
}

const runMemoryProbe = async (memoryFlag: '0' | '1'): Promise<MemoryProbeResult> => {
  const root = mkdtempSync(join(tmpdir(), 'open-science-claude-memory-'))
  temporaryRoots.push(root)
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  const canonicalCwd = realpathSync(cwd)
  const sentinel = 'ACP_MEMORY_SENTINEL_DO_NOT_LOAD'
  const memoryDir = join(root, 'config', 'projects', projectKey(canonicalCwd), 'memory')
  const memoryContents = `# Auto memory\n\n${sentinel}\n`
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'MEMORY.md'), memoryContents)

  const requestBodies: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (request.method === 'POST' && request.url?.startsWith('/v1/messages')) {
        requestBodies.push(Buffer.concat(chunks).toString('utf8'))
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(anthropicMessage)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const address = server.address() as AddressInfo
    const apiKey = 'synthetic-memory-probe-key'
    const baseUrl = `http://127.0.0.1:${address.port}`
    const setup = claudeCodeFramework.buildSessionSetup({ systemPromptAppends: [] })
    const frameworkOptions = (
      setup.meta?.claudeCode as { options: Pick<Options, 'env' | 'settings' | 'settingSources'> }
    ).options
    const env: Record<string, string> = {}
    for (const key of inheritedProcessEnvironmentKeys) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
    Object.assign(env, {
      ...frameworkOptions.env,
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_BASE_URL: baseUrl,
      APPDATA: join(root, 'appdata'),
      CLAUDE_CONFIG_DIR: join(root, 'config'),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: memoryFlag,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      HOME: root,
      LOCALAPPDATA: join(root, 'local-appdata'),
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      USERPROFILE: root,
      XDG_CACHE_HOME: join(root, 'xdg-cache'),
      XDG_CONFIG_HOME: join(root, 'xdg-config')
    })
    const settings = {
      ...(frameworkOptions.settings as Exclude<Options['settings'], string | undefined>),
      env: {
        ...((frameworkOptions.settings as { env?: Record<string, string> }).env ?? {}),
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_BASE_URL: baseUrl,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: memoryFlag
      }
    }

    for await (const message of query({
      prompt: 'Reply with OK.',
      options: {
        cwd: canonicalCwd,
        env,
        maxTurns: 1,
        model: 'claude-sonnet-4-5',
        settingSources: frameworkOptions.settingSources,
        settings,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        tools: []
      }
    })) {
      if (message.type === 'result') break
    }

    expect(requestBodies).toHaveLength(1)
    return {
      memoryContents: readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'),
      memoryEntries: readdirSync(memoryDir),
      requestContainsSentinel: requestBodies[0]?.includes(sentinel) ?? false
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Claude Code ACP memory isolation', () => {
  it('keeps seeded auto memory out of model requests only when the ACP session flag is active', async () => {
    const enabled = await runMemoryProbe('0')
    const disabled = await runMemoryProbe('1')

    expect(enabled.requestContainsSentinel).toBe(true)
    expect(disabled).toEqual({
      memoryContents: '# Auto memory\n\nACP_MEMORY_SENTINEL_DO_NOT_LOAD\n',
      memoryEntries: ['MEMORY.md'],
      requestContainsSentinel: false
    })
  }, 30_000)
})
