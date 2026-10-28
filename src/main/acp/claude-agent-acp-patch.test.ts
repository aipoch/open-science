import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import type { McpServerStatus, Query } from '@anthropic-ai/claude-agent-sdk'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  ClaudeAcpAgent,
  waitForMcpServers
} from '@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'

type McpStatusQuery = Pick<Query, 'mcpServerStatus' | 'close'>

it.runIf(process.platform === 'win32')(
  'recovers launch files only after both owning processes exit',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-launch-recovery-'))
    const entry = join(root, 'probe.mjs')
    const launchRoot = join(root, '.open-science-launch')
    writeFileSync(
      entry,
      `
import { once } from 'node:events';
import { spawnWithFileConfiguration } from ${JSON.stringify(import.meta.resolve('@agentclientprotocol/claude-agent-acp/dist/open-science-launch.js'))};
const child = spawnWithFileConfiguration({command:process.execPath,
  args:['-e',process.env.HOLD ? 'setInterval(()=>{},1000)' : '', '--', '--settings', JSON.stringify({env:{TOKEN:'synthetic'}})],
  env:process.env,cwd:process.env.CLAUDE_CONFIG_DIR});
await once(child, 'spawn');
console.log(JSON.stringify({childPid:child.pid}));
await once(child, 'close');
`
    )
    const env = { ...process.env, CLAUDE_CONFIG_DIR: root }
    const owner = spawn(process.execPath, [entry], { env: { ...env, HOLD: '1' }, stdio: 'pipe' })
    let childPid: number | undefined
    try {
      const [data] = await once(owner.stdout, 'data')
      childPid = JSON.parse(data.toString()).childPid
      const [directory] = readdirSync(launchRoot)
      const relaunch = (): Promise<{ stdout: string; stderr: string }> =>
        promisify(execFile)(process.execPath, [entry], { env, timeout: 5000 })
      await relaunch()
      expect(readdirSync(launchRoot)).toEqual([directory])
      const closed = once(owner, 'close')
      owner.kill('SIGKILL')
      await closed
      // Some Windows hosts terminate the whole job with the adapter. Model a still-live CLI
      // through the persisted ownership boundary so recovery must check both identities.
      const receipt = join(launchRoot, directory, 'owner.json')
      const originalReceipt = readFileSync(receipt, 'utf8')
      writeFileSync(receipt, JSON.stringify({ pid: owner.pid, childPid: process.pid }))
      await relaunch()
      expect(readdirSync(launchRoot)).toEqual([directory])
      writeFileSync(receipt, originalReceipt)
      try {
        process.kill(childPid!, 'SIGKILL')
      } catch {
        // The host may already have stopped the whole job.
      }
      await vi.waitFor(() => expect(() => process.kill(childPid!, 0)).toThrow(), { timeout: 3000 })
      childPid = undefined
      await relaunch()
      expect(readdirSync(launchRoot)).toEqual([])
    } finally {
      owner.kill('SIGKILL')
      if (childPid) {
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {
          /* Already exited. */
        }
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
)

it.each(['mcp', 'settings'])(
  'creates a session with large %s configuration without exceeding the process launch limit',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'acp-launch-'))
    const cli = join(root, 'cli.mjs')
    const entry = join(root, 'probe.mjs')
    writeFileSync(
      cli,
      `
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
if (process.env.PROBE_EXIT === 'exit') process.exit(7);
const flag = process.env.PROBE_KIND === 'mcp' ? '--mcp-config' : '--settings';
const value = process.argv[process.argv.indexOf(flag) + 1];
const config = JSON.parse(value.startsWith('{') ? value : readFileSync(value, 'utf8'));
const payload = process.env.PROBE_KIND === 'mcp' ? config.mcpServers.fixture.env.FIXTURE_PAYLOAD : config.env.FIXTURE_PAYLOAD;
assert.equal(payload, 'x'.repeat(Number(process.env.PROBE_LENGTH)));
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.type !== 'control_request') return;
  if (process.env.PROBE_EXIT === 'reject') {
    process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:request.request_id,error:'fixture-rejected'}})+'\\n');
    return;
  }
  const response = request.request.subtype === 'initialize'
    ? {commands:[],models:[{value:'fixture',displayName:'Fixture',description:''}],agents:[],account:{}}
    : request.request.subtype === 'mcp_status'
      ? {mcpServers:[{name:'fixture',status:'connected'}]} : {};
  process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response}})+'\\n');
});
`
    )
    writeFileSync(
      entry,
      `
import { ClaudeAcpAgent } from ${JSON.stringify(import.meta.resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'))};
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const outcomes = [];
const launchRoot = join(process.env.CLAUDE_CONFIG_DIR, '.open-science-launch');
const remaining = () => existsSync(launchRoot) ? readdirSync(launchRoot).length : 0;
for (const [length, fail] of [[10, ''], [40000, ''], [40000, 'exit'], [40000, 'reject']]) {
  process.env.PROBE_LENGTH = String(length);
  process.env.PROBE_EXIT = fail;
  const agent = new ClaudeAcpAgent({sessionUpdate:async()=>{}}, {log(){},error(){}});
  try {
    const payload = 'x'.repeat(length);
    const result = await agent.newSession({cwd:${JSON.stringify(root)},
      mcpServers: process.env.PROBE_KIND === 'mcp'
        ? [{name:'fixture',command:process.execPath,args:[],env:[{name:'FIXTURE_PAYLOAD',value:payload}]}] : [],
      _meta:{claudeCode:{options:{settingSources:[],
        ...(process.env.PROBE_KIND === 'settings' ? {settings:{env:{FIXTURE_PAYLOAD:payload}}} : {})}}}
    });
    outcomes.push({length,created:!!result.sessionId});
  } catch(error) {
    outcomes.push(fail && (error.message.includes('code 7') || error.message === 'fixture-rejected') ? {length,failed:true} : {length,error:error.message});
  } finally {
    await agent.dispose();
    const deadline = Date.now() + 2000;
    while (remaining() && Date.now() < deadline) await delay(20);
    outcomes.at(-1).remaining = remaining();
  }
}
console.log(JSON.stringify(outcomes));
`
    )
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [entry], {
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: root,
          TMP: root,
          TMPDIR: root,
          HOME: root,
          USERPROFILE: root,
          CLAUDE_CONFIG_DIR: root,
          CLAUDE_CODE_EXECUTABLE: cli,
          PROBE_KIND: kind
        },
        timeout: 10_000
      })
      expect(JSON.parse(stdout)).toEqual([
        { length: 10, created: true, remaining: 0 },
        { length: 40000, created: true, remaining: 0 },
        { length: 40000, failed: true, remaining: 0 },
        { length: 40000, failed: true, remaining: 0 }
      ])
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
)

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
