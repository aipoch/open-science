import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { McpServerStatus, Query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  ClaudeAcpAgent,
  waitForMcpServers
} from '@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'

type McpStatusQuery = Pick<Query, 'mcpServerStatus' | 'close'>

const queryWithStatus = (mcpServerStatus: McpStatusQuery['mcpServerStatus']): McpStatusQuery => ({
  mcpServerStatus,
  close: vi.fn()
})

const status = (
  name: string,
  state: McpServerStatus['status'],
  error?: string
): McpServerStatus => ({ name, status: state, ...(error ? { error } : {}) })

describe('claude-agent-acp MCP readiness patch', () => {
  it('waits until every configured MCP server is connected', async () => {
    const mcpServerStatus = vi
      .fn<McpStatusQuery['mcpServerStatus']>()
      .mockResolvedValueOnce([
        status('open-science-activity', 'connected'),
        status('open-science-notebook', 'pending')
      ])
      .mockResolvedValueOnce([
        status('open-science-activity', 'connected'),
        status('open-science-notebook', 'connected')
      ])

    const query = queryWithStatus(mcpServerStatus)

    await waitForMcpServers(query, ['open-science-activity', 'open-science-notebook'], 500)

    expect(mcpServerStatus).toHaveBeenCalledTimes(2)
    expect(query.close).not.toHaveBeenCalled()
  })

  it('ignores MCP servers that were not configured by the ACP client', async () => {
    const mcpServerStatus = vi
      .fn<McpStatusQuery['mcpServerStatus']>()
      .mockResolvedValue([
        status('open-science-notebook', 'connected'),
        status('user-project-server', 'failed', 'not installed')
      ])

    const query = queryWithStatus(mcpServerStatus)

    await expect(waitForMcpServers(query, ['open-science-notebook'], 100)).resolves.toBeUndefined()
    expect(query.close).not.toHaveBeenCalled()
  })

  it.each([
    ['failed', 'process exited'],
    ['needs-auth', 'login required']
  ] as const)('logs a configured MCP server %s state', async (state, detail) => {
    const mcpServerStatus = vi
      .fn<McpStatusQuery['mcpServerStatus']>()
      .mockResolvedValue([status('open-science-notebook', state, detail)])

    const query = queryWithStatus(mcpServerStatus)
    const logger = { error: vi.fn() }

    await expect(waitForMcpServers(query, ['open-science-notebook'], 100, logger)).rejects.toThrow(
      `MCP server open-science-notebook is ${state}: ${detail}`
    )
    expect(logger.error).toHaveBeenCalledWith(
      `[mcp-readiness] MCP server open-science-notebook is ${state}: ${detail}`
    )
    expect(query.close).toHaveBeenCalledOnce()
  })

  it('times out when MCP status does not respond', async () => {
    const mcpServerStatus = vi
      .fn<McpStatusQuery['mcpServerStatus']>()
      .mockReturnValue(new Promise<McpServerStatus[]>(() => undefined))

    const query = queryWithStatus(mcpServerStatus)
    const logger = { error: vi.fn() }

    await expect(waitForMcpServers(query, ['open-science-notebook'], 5, logger)).rejects.toThrow(
      'Timed out waiting for MCP servers: open-science-notebook'
    )
    expect(logger.error).toHaveBeenCalledWith(
      '[mcp-readiness] Timed out waiting for MCP servers: open-science-notebook'
    )
    expect(query.close).toHaveBeenCalledOnce()
  })
})

describe('claude-agent-acp Session deletion patch', () => {
  it('treats a never-materialized Session as already deleted', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const configDir = mkdtempSync(join(tmpdir(), 'open-science-claude-session-delete-'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)

    try {
      const agent = new ClaudeAcpAgent({} as never)
      await expect(agent.deleteSession({ sessionId })).resolves.toEqual({})
    } finally {
      vi.unstubAllEnvs()
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})

// Exercise the installed patch without exporting private upstream helpers as application API.
it('counts Claude cache reads and writes once while excluding completion tokens', () => {
  const source = readFileSync(
    new URL(import.meta.resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js')),
    'utf8'
  )
  const helper = source.match(/function contextTokens\(usage\) \{[\s\S]*?^\}/m)?.[0]
  expect(helper).toBeDefined()
  const contextTokens = new Function(`${helper}; return contextTokens`)() as (
    usage: Record<string, number>
  ) => number
  expect(
    contextTokens({
      input_tokens: 100,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 150_000,
      output_tokens: 5_000
    })
  ).toBe(190_100)
})

it('keeps excluded settings out of initialization, file updates and cwd changes, then disposes watchers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-science-settings-sources-'))
  const entry = join(root, 'settings-probe.mjs')
  writeFileSync(
    entry,
    `
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SettingsManager } from ${JSON.stringify(import.meta.resolve('@agentclientprotocol/claude-agent-acp/dist/settings.js'))};
const root = process.env.HOME;
const profile = process.env.CLAUDE_CONFIG_DIR;
const cwd = join(root, 'workspace');
const nextCwd = join(root, 'next');
await mkdir(profile, {recursive:true});
await mkdir(cwd);
await mkdir(join(nextCwd, '.claude'), {recursive:true});
const writeUser = mode => writeFile(join(profile, 'settings.json'), JSON.stringify({permissions:{defaultMode:mode}}));
await writeUser('auto');
await writeFile(join(nextCwd, '.claude', 'settings.json'), JSON.stringify({permissions:{defaultMode:'plan'}}));
let selectedUpdates = 0;
let excludedUpdates = 0;
const selected = new SettingsManager(cwd, {settingSources:['user'], onChange:()=>selectedUpdates++});
const excluded = new SettingsManager(cwd, {settingSources:[], onChange:()=>excludedUpdates++});
try {
  await selected.initialize();
  await excluded.initialize();
  const initial = excluded.getSettings().permissions?.defaultMode ?? null;
  const selectedInitial = selected.getSettings().permissions?.defaultMode;
  await writeUser('acceptEdits');
  const deadline = Date.now() + 3000;
  while (selected.getSettings().permissions?.defaultMode !== 'acceptEdits' && Date.now() < deadline) await delay(20);
  const updated = excluded.getSettings().permissions?.defaultMode ?? null;
  const selectedUpdated = selected.getSettings().permissions?.defaultMode;
  await excluded.setCwd(nextCwd);
  const moved = excluded.getSettings().permissions?.defaultMode ?? null;
  await delay(150);
  selected.dispose();
  excluded.dispose();
  const updatesBeforeDispose = selectedUpdates + excludedUpdates;
  await writeUser('default');
  await delay(200);
  console.log(JSON.stringify({initial, updated, moved, selectedInitial, selectedUpdated, excludedUpdates,
    updatesAfterDispose: selectedUpdates + excludedUpdates - updatesBeforeDispose}));
} finally {
  selected.dispose();
  excluded.dispose();
}
`
  )
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    SYSTEMROOT: process.env.SYSTEMROOT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    HOME: root,
    USERPROFILE: root,
    CLAUDE_CONFIG_DIR: join(root, '.claude')
  }
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [entry], {
      env,
      timeout: 10_000
    })
    expect(JSON.parse(stdout)).toEqual({
      initial: null,
      updated: null,
      moved: null,
      selectedInitial: 'auto',
      selectedUpdated: 'acceptEdits',
      excludedUpdates: 0,
      updatesAfterDispose: 0
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
