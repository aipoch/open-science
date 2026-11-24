import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { registerMcpGroup } from './agent-mcp-readiness.mjs'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const cli = resolve('packages/open-science/cli.mjs')
let dependencyRoot = dirname(
  createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/package.json')
)
while (basename(dependencyRoot) !== 'node_modules') dependencyRoot = dirname(dependencyRoot)
const exec = promisify(execFile)
const runCli = (
  args: string[],
  input?: string,
  env?: Record<string, string>
): ReturnType<typeof exec> => {
  const promise = exec(process.execPath, [cli, ...args], {
    timeout: 5000,
    env: { ...process.env, ...env }
  })
  promise.child.stdin?.end(input)
  return promise
}

async function connectMcp(
  profile: string,
  env?: Record<string, string>,
  entry = cli,
  group?: 'core' | 'research' | 'literature'
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, 'mcp', ...(group ? ['--group', group] : []), '--profile', profile],
    stderr: 'pipe',
    env
  })
  const client = new Client({ name: 'external-agent', version: '1.0.0' })
  cleanup.push(() => client.close())
  await client.connect(transport)
  return client
}

it('retries a failed background startup on the same profile-less grouped connection', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-group-retry-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const client = new Client({ name: 'retry-client', version: '1' })
  cleanup.push(() => client.close())
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `
      import { runResearchMcpServer } from './packages/open-science/mcp.mjs'
      let starts = 0
      await runResearchMcpServer({ version: '1', group: 'core', startService: async () => {
        if (++starts === 1) throw new Error('transient startup failure')
        return ${JSON.stringify(profile)}
      } })
    `
      ],
      stderr: 'pipe'
    })
  )
  const result = await client.callTool({ name: 'list_capabilities', arguments: {} })
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toHaveProperty('result')
})

it('exposes filtered tools through each real stdio MCP group', async () => {
  const agent = await resourceAgents(() => undefined)
  const clients = await Promise.all(
    (['core', 'research', 'literature'] as const).map((group) =>
      connectMcp(agent.profile, undefined, cli, group)
    )
  )

  const tools = await Promise.all(clients.map((client) => client.listTools()))
  const names = tools.map(({ tools: groupTools }) => new Set(groupTools.map((tool) => tool.name)))
  expect([...names[0]]).toEqual(expect.arrayContaining(['doctor', 'get_setup_status']))
  expect(names[0]).not.toContain('list_projects')
  expect([...names[1]]).toEqual(expect.arrayContaining(['list_projects', 'get_run']))
  expect(names[1]).not.toContain('search_literature')
  expect([...names[2]]).toEqual(
    expect.arrayContaining(['search_literature', 'get_literature_item'])
  )
  expect(names[2]).not.toContain('list_projects')
})

it('waits for grouped registration before the first setup call', async () => {
  const agent = await resourceAgents((request, response) => {
    if (request.url === '/api/v1/doctor') {
      response.end(JSON.stringify({ data: { ready: true, checks: {} } }))
      return
    }
    response.writeHead(404).end(JSON.stringify({ error: { code: 'not_found' } }))
  })
  const core = await connectMcp(agent.profile, undefined, cli, 'core')
  const result = await core.callTool({ name: 'get_setup_status' })
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toMatchObject({
    result: { profile: agent.profile, readiness: { service: 'ready' } }
  })
})

it('runs Research and Literature operations through their grouped stdio servers', async () => {
  const literaturePage = { entries: [{ id: 'item-grouped', item: { title: 'Grouped Atlas' } }] }
  const agent = await resourceAgents(
    async (request, response) => {
      if (request.url === '/api/v1/projects') {
        response.end(JSON.stringify({ data: [{ id: 'p1', name: 'Grouped project' }] }))
        return
      }
      if (request.url === '/rpc/literature%3Asearch') {
        response.end(JSON.stringify({ ok: true, result: literaturePage }))
        return
      }
      if (request.url === '/rpc/literature%3Aimport-records') {
        response.end(
          JSON.stringify({ ok: true, result: { imported: { itemIds: ['item-grouped'] } } })
        )
        return
      }
      if (request.url === '/rpc/literature%3Atransact') {
        response.end(
          JSON.stringify({
            ok: true,
            result: { projectId: 'p1', itemIds: ['item-grouped'], included: true }
          })
        )
        return
      }
      if (request.url === '/api/v1/run-submissions/request-grouped' && request.method === 'PUT') {
        response.end(
          JSON.stringify({
            data: {
              requestId: 'request-grouped',
              status: 'accepted',
              runId: 'run-grouped',
              sessionId: 'session-grouped'
            }
          })
        )
        return
      }
      if (request.url === '/api/v1/run-submissions/request-grouped-2' && request.method === 'PUT') {
        response.end(
          JSON.stringify({
            data: {
              requestId: 'request-grouped-2',
              status: 'accepted',
              runId: 'run-grouped-2',
              sessionId: 'session-grouped'
            }
          })
        )
        return
      }
      response.writeHead(404).end(JSON.stringify({ error: { code: 'not_found' } }))
    },
    ['durable-submissions']
  )
  const [core, research, literature] = await Promise.all(
    (['core', 'research', 'literature'] as const).map((group) =>
      connectMcp(agent.profile, undefined, cli, group)
    )
  )
  await vi.waitFor(async () => {
    const listed = await core.callTool({ name: 'list_capabilities' })
    expect(listed.structuredContent).toMatchObject({
      result: {
        mcp: {
          groups: {
            core: { status: 'connected' },
            research: { status: 'connected' },
            literature: { status: 'connected' }
          }
        }
      }
    })
  })

  const projects = await research.callTool({ name: 'list_projects' })
  expect(projects.structuredContent).toEqual({
    result: [{ id: 'p1', name: 'Grouped project' }]
  })
  const receipt = await research.callTool({
    name: 'start_run',
    arguments: { requestId: 'request-grouped', projectId: 'p1', prompt: 'Run the grouped study.' }
  })
  expect(receipt.structuredContent).toMatchObject({
    result: {
      requestId: 'request-grouped',
      status: 'accepted',
      runId: 'run-grouped',
      sessionId: 'session-grouped'
    }
  })
  const secondReceipt = await research.callTool({
    name: 'start_run',
    arguments: {
      requestId: 'request-grouped-2',
      projectId: 'p1',
      sessionId: 'session-grouped',
      prompt: 'Continue the grouped study with a second research turn.'
    }
  })
  expect(secondReceipt.structuredContent).toMatchObject({
    result: {
      requestId: 'request-grouped-2',
      status: 'accepted',
      runId: 'run-grouped-2',
      sessionId: 'session-grouped'
    }
  })
  const searched = await literature.callTool({
    name: 'search_literature',
    arguments: { projectId: 'p1' }
  })
  expect(searched.structuredContent).toEqual({ result: literaturePage })
  const imported = await literature.callTool({
    name: 'import_literature',
    arguments: { mode: 'commit', content: '@article{grouped}', projectId: 'p1' }
  })
  expect(imported.structuredContent).toMatchObject({
    result: { imported: { itemIds: ['item-grouped'] } }
  })
})

it('allows reverse-order grouped MCP startup and reaches dependency readiness after Core connects', async () => {
  const agent = await resourceAgents(() => undefined)
  const clients: Client[] = []
  for (const group of ['literature', 'research', 'core'] as const) {
    clients.push(await connectMcp(agent.profile, undefined, cli, group))
  }
  const core = clients[2]
  await vi.waitFor(async () => {
    const listed = await core.callTool({ name: 'list_capabilities' })
    expect(listed.structuredContent).toMatchObject({
      result: {
        mcp: {
          groups: {
            core: { status: 'connected' },
            research: { status: 'connected' },
            literature: { status: 'connected' }
          },
          fullLoopReady: false
        }
      }
    })
  })
})

it('keeps a single Core group connected without claiming full-loop readiness', async () => {
  const agent = await resourceAgents(() => undefined)
  const core = await connectMcp(agent.profile, undefined, cli, 'core')
  await vi.waitFor(async () => {
    const listed = await core.callTool({ name: 'list_capabilities' })
    expect(listed.structuredContent).toMatchObject({
      result: {
        mcp: {
          groups: {
            core: { status: 'connected' },
            research: { status: 'missing' },
            literature: { status: 'missing' }
          },
          fullLoopReady: false
        }
      }
    })
  })
})

it('registers all grouped MCP servers during parallel startup', async () => {
  const agent = await resourceAgents(() => undefined)
  const [core] = await Promise.all(
    (['core', 'research', 'literature'] as const).map((group) =>
      connectMcp(agent.profile, undefined, cli, group)
    )
  )
  await vi.waitFor(async () => {
    const listed = await core.callTool({ name: 'list_capabilities' })
    expect(listed.structuredContent).toMatchObject({
      result: {
        mcp: {
          groups: {
            core: { status: 'connected' },
            research: { status: 'connected' },
            literature: { status: 'connected' }
          }
        }
      }
    })
  })
})

it('recovers a downstream Research group after its Core dependency connects', async () => {
  let projectRequests = 0
  const agent = await resourceAgents(async (request, response) => {
    if (request.url === '/api/v1/projects') {
      projectRequests += 1
      response.end(JSON.stringify({ data: [{ id: 'p1', name: 'Recovered project' }] }))
      return
    }
    response.writeHead(404).end(JSON.stringify({ error: { code: 'not_found' } }))
  })
  const research = await connectMcp(agent.profile, undefined, cli, 'research')
  const blocked = await research.callTool({ name: 'list_projects' })
  expect(blocked.structuredContent).toMatchObject({
    error: { code: 'mcp_dependency_unavailable', group: 'research', dependency: 'core' }
  })
  expect(projectRequests).toBe(0)

  await connectMcp(agent.profile, undefined, cli, 'core')
  await vi.waitFor(async () => {
    const recovered = await research.callTool({ name: 'list_projects' })
    expect(recovered.structuredContent).toEqual({
      result: [{ id: 'p1', name: 'Recovered project' }]
    })
  })
  expect(projectRequests).toBe(1)
})

it('re-registers a grouped MCP process after restart', async () => {
  type GroupStatus = {
    result: { mcp: { groups: { core: { processId?: string } } } }
  }
  const agent = await resourceAgents(() => undefined)
  const first = await connectMcp(agent.profile, undefined, cli, 'core')
  const firstStatus = await first.callTool({ name: 'list_capabilities' })
  const firstProcess = (firstStatus.structuredContent as GroupStatus).result.mcp.groups.core
    .processId
  await first.close()

  const second = await connectMcp(agent.profile, undefined, cli, 'core')
  await vi.waitFor(async () => {
    const status = await second.callTool({ name: 'list_capabilities' })
    expect(status.structuredContent).toMatchObject({
      result: { mcp: { groups: { core: { status: 'connected' } } } }
    })
    expect((status.structuredContent as GroupStatus).result.mcp.groups.core.processId).not.toBe(
      firstProcess
    )
  })
})

it('reconnects a grouped MCP client after the persistent service state moves to a restarted service', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-service-restart-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const token = 'service-restart-token'
  let generation = 0
  let service: ReturnType<typeof createServer>
  const requests: number[] = []
  const start = async (): Promise<void> => {
    generation += 1
    const current = generation
    service = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end()
        return
      }
      response.setHeader('content-type', 'application/json')
      if (request.url === '/api/bootstrap') {
        response.end(JSON.stringify({ taskCapabilities: ['doctor'] }))
        return
      }
      if (request.url === '/api/v1/doctor') {
        requests.push(current)
        response.end(
          JSON.stringify({
            data: {
              ready: true,
              checks: {
                runtime: { status: 'ready', framework: 'codex' },
                provider: { status: 'ready' }
              }
            }
          })
        )
        return
      }
      response.writeHead(404).end(JSON.stringify({ error: { code: 'not_found' } }))
    })
    service.listen(0, '127.0.0.1')
    await once(service, 'listening')
    await writeFile(join(profile, 'web-token'), token)
    await writeFile(
      join(profile, 'web-service.json'),
      JSON.stringify({
        pid: process.pid,
        port: (service.address() as { port: number }).port,
        startedAt: new Date().toISOString()
      })
    )
  }
  await start()
  cleanup.push(async () => {
    service.closeAllConnections()
    await new Promise<void>((done) => service.close(() => done()))
  })

  const core = await connectMcp(profile, undefined, cli, 'core')
  expect((await core.callTool({ name: 'doctor' })).structuredContent).toMatchObject({
    result: { readiness: { service: 'ready', agent: 'ready' } }
  })
  service.closeAllConnections()
  await new Promise<void>((done) => service.close(() => done()))
  await start()
  expect((await core.callTool({ name: 'doctor' })).structuredContent).toMatchObject({
    result: { readiness: { service: 'ready', agent: 'ready' } }
  })
  expect(requests).toEqual([1, 2])
})

async function cliError(
  args: string[],
  input?: string,
  env?: Record<string, string>
): Promise<{ error: Record<string, unknown>; exitCode: number }> {
  try {
    await runCli(args, input, env)
  } catch (error) {
    const { stdout, stderr, code } = error as { stdout: string; stderr: string; code: number }
    expect(stdout).toBe('')
    const parsed = JSON.parse(stderr)
    expect(parsed.exitCode).toBe(code)
    return parsed
  }
  throw new Error('Expected the CLI to fail')
}

async function resourceAgents(
  handle: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  taskCapabilities: string[] = [],
  env?: Record<string, string>
): Promise<{
  profile: string
  cli: (name: string, args?: Record<string, unknown>) => Promise<{ result: unknown }>
  mcp: (name: string, args?: Record<string, unknown>) => ReturnType<Client['callTool']>
  cliError: (name: string, args: Record<string, unknown>) => ReturnType<typeof cliError>
}> {
  const profile = await mkdtemp(join(tmpdir(), 'osci-agent-resources-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const token = 'resource-fixture-token'
  const service = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/bootstrap') {
      response.end(JSON.stringify({ taskCapabilities }))
      return
    }
    void Promise.resolve(handle(request, response)).catch(() => response.writeHead(500).end())
  })
  service.listen(0, '127.0.0.1')
  await once(service, 'listening')
  cleanup.push(async () => {
    service.closeAllConnections()
    await new Promise<void>((done) => service.close(() => done()))
  })
  await writeFile(
    join(profile, 'web-service.json'),
    JSON.stringify({
      pid: process.pid,
      port: (service.address() as { port: number }).port,
      startedAt: new Date().toISOString()
    })
  )
  await writeFile(join(profile, 'web-token'), token)
  const client = await connectMcp(profile, env)
  const cliArgs = (name: string): string[] => [
    'tools',
    'call',
    name,
    '--profile',
    profile,
    '--json'
  ]
  return {
    profile,
    async cli(name: string, args: Record<string, unknown> = {}) {
      return JSON.parse((await runCli(cliArgs(name), JSON.stringify(args), env)).stdout) as {
        result: unknown
      }
    },
    mcp: (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }),
    cliError: (name: string, args: Record<string, unknown>) =>
      cliError(cliArgs(name), JSON.stringify(args), env)
  }
}

it('reports grouped package drift through the CLI discovery surface', async () => {
  const agent = await resourceAgents(() => undefined)
  const entry = await registerMcpGroup({
    configRoot: agent.profile,
    group: 'core',
    version: 'old-version',
    capabilityNames: ['old-capability'],
    processId: 'stale-cli-core',
    now: () => new Date().toISOString()
  })
  await entry?.setState('connected')
  const listed = await agent.cli('list_capabilities', { group: 'setup' })
  expect(listed).toMatchObject({
    result: { mcp: { groups: { core: { status: 'version_mismatch' } } } }
  })
  await entry?.close()
})

it('finds a Plan that needs review from CLI JSON and MCP stdio', async () => {
  const interaction = {
    id: 'plan:plan-version',
    kind: 'plan',
    state: 'pending',
    runId: 'run-1',
    projectId: 'p1',
    sessionId: 's1',
    revision: 3,
    owner: 'user',
    responseCapability: 'respond_plan',
    actions: ['approved', 'rejected', 'revise']
  }
  const plan = {
    artifactVersionId: 'plan-version',
    revision: 3,
    document: { task_summary: 'Compare irrigation groups.' }
  }
  const run = {
    id: interaction.runId,
    status: 'running',
    attention: { kind: 'interactions', interactions: [interaction] }
  }
  const agent = await resourceAgents(
    (request, response) => {
      const url = new URL(request.url!, 'http://localhost')
      if (url.pathname === '/api/v1/runs/run-1') {
        response.end(JSON.stringify({ data: run }))
      } else if (
        url.pathname === '/api/v1/interactions' &&
        url.searchParams.get('runId') === run.id
      ) {
        response.end(JSON.stringify({ data: [interaction] }))
      } else if (
        decodeURIComponent(url.pathname) === '/api/v1/interactions/plan:plan-version' &&
        url.searchParams.get('projectId') === 'p1' &&
        url.searchParams.get('sessionId') === 's1'
      ) {
        response.end(JSON.stringify({ data: { ...interaction, plan } }))
      } else {
        response.writeHead(404).end(JSON.stringify({ error: { code: 'not_found' } }))
      }
    },
    ['task-interactions']
  )

  const both = async (
    name: string,
    args: Record<string, unknown>,
    result: unknown
  ): Promise<void> => {
    expect(await agent.cli(name, args)).toEqual({ result })
    const mcp = await agent.mcp(name, args)
    expect(mcp.isError).not.toBe(true)
    expect(mcp.structuredContent).toEqual({ result })
  }
  await both('list_interactions', { runId: run.id }, [interaction])
  await both('wait_run', { runId: run.id, timeoutMs: 4_000 }, { run, timeoutMs: 4_000 })
  await both(
    'get_interaction',
    { projectId: 'p1', sessionId: 's1', interactionId: interaction.id },
    { ...interaction, plan }
  )
})

it.each(['permission', 'runtime', 'code', 'child'] as const)(
  'queries and relays the same %s decision through CLI JSON and MCP stdio',
  async (kind) => {
    const scope = { runId: kind === 'runtime' ? 'settlement-run' : 'task-1' }
    const originalRun =
      kind === 'runtime'
        ? {
            id: 'task-1',
            status: 'completed',
            execution: { status: 'unconfirmed' },
            continuations: [
              { runId: scope.runId, requestId: 'settlement-request', status: 'running' }
            ]
          }
        : undefined
    const notebookReview =
      kind === 'runtime' || kind === 'code' ? { kind, language: 'r' } : undefined
    const delegated =
      kind === 'child'
        ? {
            frameId: 'child-frame',
            attemptId: 'source-attempt',
            branchId: 'child-branch',
            attemptStatus: 'running'
          }
        : undefined
    const id = delegated
      ? 'child-permission:delegated:p1:s1:child-frame:source-attempt:review-1'
      : 'permission:review-1'
    const interaction = {
      id,
      kind: 'permission',
      state: 'pending',
      owner: 'user',
      ...scope,
      projectId: 'p1',
      sessionId: 's1',
      branchId: 'branch-1',
      revision: 0,
      interactionPolicy: { mode: 'relay', revision: 0 },
      actions: ['allow-once', 'reject-once'],
      responseCapability: 'respond_permission',
      ...(notebookReview ? { notebookReview } : {}),
      ...(delegated ? { delegated } : {})
    }
    const detail = {
      ...interaction,
      recovery: 'original_run',
      request: {
        title: notebookReview ? 'Review Notebook work' : 'Read study table',
        toolCallId: 'tool-1',
        tool: 'files/read',
        input:
          kind === 'runtime'
            ? { runtimeId: 'selected-r', label: 'Research R' }
            : kind === 'code'
              ? {
                  notebookRunId: 'cell-1',
                  riskCount: 1,
                  risks: [{ operation: 'overwrite', line: 1 }]
                }
              : { path: 'study.csv' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
      }
    }
    let released = false
    const agent = await resourceAgents(
      async (request, response) => {
        const url = new URL(request.url!, 'http://localhost')
        const json = (data: unknown): void => {
          response.end(JSON.stringify({ data }))
        }
        if (originalRun && url.pathname === `/api/v1/runs/${originalRun.id}`) {
          json(originalRun)
        } else if (originalRun && url.pathname === '/api/v1/run-submissions/settlement-request') {
          json({ requestId: 'settlement-request', runId: scope.runId, status: 'accepted' })
        } else if (url.pathname === `/api/v1/runs/${scope.runId}`) {
          json({
            id: scope.runId,
            ...(originalRun ? { continuedFromRunId: originalRun.id } : {}),
            status: released ? 'completed' : 'running',
            ...(!released
              ? {
                  attention: { kind: 'interactions', interactions: [interaction] },
                  ...(notebookReview
                    ? {
                        execution: {
                          status: 'waiting_for_user',
                          reasonCode: `notebook_${kind}_review_required`,
                          kernelDispatched: false,
                          next: { action: 'respond_permission' }
                        }
                      }
                    : {})
                }
              : {})
          })
        } else if (
          url.pathname === '/api/v1/interactions' &&
          url.searchParams.get('runId') === scope.runId
        ) {
          json(released ? [] : [interaction])
        } else if (
          url.pathname === `/api/v1/runs/${scope.runId}/interaction-mode` &&
          request.method === 'PUT'
        ) {
          let body = ''
          for await (const chunk of request) body += chunk
          expect(JSON.parse(body)).toEqual({ interactionMode: 'delegate', expectedRevision: 0 })
          json({ mode: 'delegate', revision: 1 })
        } else if (
          url.searchParams.get('runId') === scope.runId &&
          decodeURIComponent(url.pathname) === `/api/v1/interactions/${id}`
        ) {
          json(detail)
        } else if (
          url.searchParams.get('runId') === scope.runId &&
          decodeURIComponent(url.pathname) === `/api/v1/interactions/${id}/permission` &&
          request.method === 'POST'
        ) {
          let body = ''
          for await (const chunk of request) body += chunk
          expect(JSON.parse(body)).toEqual({
            optionId: 'allow-once',
            source: 'user_relay',
            expectedBranchId: 'branch-1',
            expectedRevision: 0,
            ...(notebookReview ? { expectedLanguage: 'r' } : {})
          })
          json({
            changed: !released,
            interaction: {
              ...interaction,
              state: 'responded',
              actions: [],
              response: { source: 'user_relay', optionId: 'allow-once', status: 'released' }
            }
          })
          released = true
        } else {
          response.writeHead(404).end()
        }
      },
      ['task-interactions', 'task-permissions', 'task-delegation', 'durable-submissions']
    )

    if (originalRun) {
      const readOriginal = { runId: originalRun.id }
      const mcpRun = (await agent.mcp('get_run', readOriginal)).structuredContent
      expect(mcpRun).toEqual({ result: originalRun })
      expect(await agent.cli('get_run', readOriginal)).toEqual(mcpRun)
      const [{ requestId }] = originalRun.continuations
      const mcpSubmission = (await agent.mcp('get_submission', { requestId })).structuredContent
      expect(mcpSubmission).toMatchObject({ result: { runId: scope.runId, status: 'accepted' } })
      expect(await agent.cli('get_submission', { requestId })).toEqual(mcpSubmission)
    }

    for (const [name, input] of [
      ['get_run', scope],
      ['wait_run', { ...scope, timeoutMs: 1000 }],
      ['list_interactions', scope],
      ['get_interaction', { ...scope, interactionId: interaction.id }],
      ['set_run_interaction_mode', { ...scope, interactionMode: 'delegate', expectedRevision: 0 }]
    ] as const) {
      expect((await agent.mcp(name, input)).structuredContent).toEqual(await agent.cli(name, input))
    }
    const reviewed = {
      ...scope,
      interactionId: interaction.id,
      optionId: 'allow-once',
      expectedRevision: 0,
      expectedBranchId: 'branch-1',
      ...(notebookReview ? { expectedLanguage: 'r' } : {})
    }
    const invalid = { ...reviewed, source: 'delegated_agent' }
    const rejected = await agent.mcp('respond_permission', invalid)
    expect(rejected.structuredContent).toEqual({
      error: (await agent.cliError('respond_permission', invalid)).error
    })
    expect(rejected.structuredContent).toMatchObject({ error: { code: 'invalid_request' } })
    const response = { ...reviewed, source: 'user_relay' }
    const first = await agent.cli('respond_permission', response)
    expect(first).toMatchObject({
      result: { changed: true, interaction: { response: { status: 'released' } } }
    })
    const retry = await agent.mcp('respond_permission', response)
    expect(retry.structuredContent).toEqual({
      result: { ...(first.result as object), changed: false }
    })
    expect(await agent.cli('list_interactions', scope)).toEqual({ result: [] })
    expect(await agent.cli('get_run', scope)).toMatchObject({
      result: { id: scope.runId, status: 'completed' }
    })
  }
)

it.each(['question:question-1', 'child-question:question-1'])(
  'answers %s through CLI JSON and MCP stdio',
  async (interactionId) => {
    const scope = { runId: 'run-1' }
    const delegated = interactionId.startsWith('child-')
      ? {
          frameId: 'child-frame',
          attemptId: 'source-attempt',
          branchId: 'child-branch',
          attemptStatus: 'completed',
          continuation: { attemptId: 'continuation-attempt', status: 'running' }
        }
      : undefined
    const settled = { id: interactionId, state: 'responded', ...(delegated ? { delegated } : {}) }
    const response = {
      expectedRevision: 2,
      expectedBranchId: 'branch-1',
      action: 'accept',
      source: 'known_context',
      answers: [
        { fieldId: 'groups', value: ['Control', 'Treatment'] },
        { fieldId: 'units_custom', value: 'millimeters', status: 'answered' }
      ]
    }
    let changed = true
    const agent = await resourceAgents(
      async (request, reply) => {
        const url = new URL(request.url!, 'http://localhost')
        expect(decodeURIComponent(url.pathname)).toBe(
          `/api/v1/interactions/${interactionId}/answer`
        )
        expect(request.method).toBe('POST')
        expect(url.searchParams.get('runId')).toBe(scope.runId)
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk)
        expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(response)
        reply.end(
          JSON.stringify({
            data: { changed, interaction: settled }
          })
        )
        changed = false
      },
      ['task-questions']
    )

    const input = { ...scope, interactionId, ...response }
    expect(await agent.cli('answer_question', input)).toEqual({
      result: { changed: true, interaction: settled }
    })
    const mcp = await agent.mcp('answer_question', input)
    expect(mcp.isError).not.toBe(true)
    expect(mcp.structuredContent).toEqual({
      result: { changed: false, interaction: settled }
    })
  }
)

it('discovers, registers and explicitly enables an existing Notebook interpreter through CLI and MCP', async () => {
  const runtime = {
    runtimeId: '/workspace/existing-r/bin/R',
    interpreterPath: '/workspace/existing-r/bin/R',
    language: 'r',
    source: 'external',
    provenance: 'user-own',
    label: 'Existing R',
    version: '4.5.1',
    runnable: true,
    enabled: false
  }
  let registered = false
  const agent = await resourceAgents(
    async (request, response) => {
      const path = '/api/v1/notebook-runtimes'
      if (request.url === `${path}?language=r` && request.method === 'GET') {
        response.end(JSON.stringify({ data: registered ? [runtime] : [] }))
        return
      }
      expect(request.url).toBe(path)
      expect(request.method).toBe('POST')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (input.action === 'register') {
        expect(input).toEqual({ action: 'register', language: 'r', path: runtime.interpreterPath })
        registered = true
      } else {
        expect(input).toEqual({ action: 'enable', language: 'r', runtimeId: runtime.runtimeId })
        expect(registered).toBe(true)
        runtime.enabled = true
      }
      response.end(JSON.stringify({ data: runtime }))
    },
    ['notebook-runtime-selection']
  )

  expect(await agent.cli('list_notebook_runtimes', { language: 'r' })).toEqual({ result: [] })
  expect(
    (
      await agent.mcp('register_notebook_interpreter', {
        language: 'r',
        path: runtime.interpreterPath
      })
    ).structuredContent
  ).toMatchObject({ result: { enabled: false, runnable: true } })
  expect((await agent.mcp('list_notebook_runtimes', { language: 'r' })).structuredContent).toEqual(
    await agent.cli('list_notebook_runtimes', { language: 'r' })
  )
  expect(
    await agent.cli('enable_notebook_runtime', { language: 'r', runtimeId: runtime.runtimeId })
  ).toMatchObject({ result: { enabled: true } })
  expect((await agent.mcp('list_notebook_runtimes', { language: 'r' })).structuredContent).toEqual({
    result: [runtime]
  })
  const withoutRuntimeId = {
    requestId: 'incomplete-runtime-selection',
    projectId: 'project-1',
    prompt: 'Research',
    notebookLanguage: 'r'
  }
  const invalid = await agent.cliError('start_run', withoutRuntimeId)
  expect(invalid.error).toMatchObject({
    code: 'invalid_request',
    message: 'Supply notebookLanguage and notebookRuntimeId together.'
  })
  const rejected = await agent.mcp('start_run', withoutRuntimeId)
  expect(rejected.isError).toBe(true)
  expect(rejected.structuredContent).toEqual({ error: invalid.error })
})

it('resumes the same managed Notebook installation through CLI and MCP after a bounded wait', async () => {
  const target = { language: 'r', operationId: 'prepare-r' }
  const path = `/api/v1/notebook-environment/operations/${target.operationId}`
  let accepted = false
  let finished = false
  let starts = 0
  const agent = await resourceAgents(
    (request, response) => {
      if (request.url === path && request.method === 'PUT') {
        accepted = true
        starts++
      } else if (request.url !== `${path}?language=r` || request.method !== 'GET') {
        response.writeHead(404).end()
        return
      }
      expect(accepted).toBe(true)
      response.end(
        JSON.stringify({
          data: {
            ...target,
            action: 'prepare',
            status: finished ? 'completed' : 'preparing',
            progress: { phase: finished ? 'done' : 'fetch-r', fraction: finished ? 1 : 0.25 }
          }
        })
      )
    },
    ['notebook-setup-operations']
  )

  expect(
    await agent.cli('prepare_notebook_environment', { ...target, timeoutMs: 1 })
  ).toMatchObject({
    result: {
      operation: { ...target, status: 'preparing', progress: { phase: 'fetch-r', fraction: 0.25 } },
      timedOut: true,
      next: [{ action: 'get_notebook_environment_operation', arguments: target }]
    }
  })
  finished = true
  const result = await agent.mcp('get_notebook_environment_operation', target)
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toMatchObject({
    result: {
      operation: { ...target, status: 'completed' },
      next: [{ action: 'get_setup_status', arguments: { language: 'r' } }]
    }
  })
  expect(result.structuredContent).toEqual(
    await agent.cli('get_notebook_environment_operation', target)
  )
  expect(starts).toBe(1)
})

it('recovers a lost setup response and uses the same cancel and repair contract through CLI and MCP', async () => {
  const rTarget = { language: 'r', operationId: 'r-lost-response' }
  const pyTarget = { language: 'python', operationId: 'python-repair' }
  let rStatus = 'unconfirmed'
  const agent = await resourceAgents(
    async (request, response) => {
      const url = new URL(request.url!, 'http://localhost')
      const operationId = url.pathname.split('/').at(-1)
      const reply = (data: unknown): void => {
        response.end(JSON.stringify({ data }))
      }
      if (operationId === rTarget.operationId) {
        if (request.method === 'PUT') {
          rStatus = 'preparing'
          response.destroy()
          return
        }
        if (request.method === 'DELETE') rStatus = 'cancelled'
        return reply({ ...rTarget, status: rStatus })
      }
      if (operationId === pyTarget.operationId && request.method === 'PUT') {
        let payload = ''
        for await (const chunk of request) payload += chunk
        if (JSON.parse(payload).action === 'repair')
          return reply({
            ...pyTarget,
            action: 'repair',
            status: 'failed',
            reason: 'notebook_environment_recovery_required'
          })
      }
      response.writeHead(404).end()
    },
    ['notebook-setup-operations']
  )

  const lost = await agent.mcp('prepare_notebook_environment', rTarget)
  expect(lost.isError).toBe(true)
  expect(lost.structuredContent).toMatchObject({
    error: {
      operationId: rTarget.operationId,
      completionStatus: 'unconfirmed',
      next: [{ action: 'get_notebook_environment_operation', arguments: rTarget }]
    }
  })
  const reconnected = await connectMcp(agent.profile)
  expect(
    (await reconnected.callTool({ name: 'get_notebook_environment_operation', arguments: rTarget }))
      .structuredContent
  ).toMatchObject({
    result: { operation: { ...rTarget, status: 'preparing' } }
  })
  for (const [name, target, status] of [
    ['cancel_notebook_environment_operation', rTarget, 'cancelled'],
    ['repair_notebook_environment', pyTarget, 'failed']
  ] as const) {
    const mcp = await agent.mcp(name, target)
    expect(mcp.isError).not.toBe(true)
    expect(mcp.structuredContent).toEqual(await agent.cli(name, target))
    expect(mcp.structuredContent).toMatchObject({ result: { operation: { ...target, status } } })
  }
})

it('recovers the original study after the initial submission response is lost', async () => {
  const args = {
    requestId: 'study-request',
    projectId: 'p1',
    prompt: 'Review these results.',
    permissionProfile: 'auto'
  }
  const receipt = { requestId: args.requestId, status: 'accepted', runId: 'run-1', createdAt: 1 }
  let accepted = false
  let writes = 0
  const agent = await resourceAgents(
    async (request, response) => {
      if (request.url === '/api/v1/run-submissions/study-request') {
        if (request.method === 'PUT') {
          let body = ''
          for await (const chunk of request) body += chunk
          const input = JSON.parse(body)
          if (
            input.project === 'p1' &&
            input.prompt === args.prompt &&
            input.permissionProfile === 'auto' &&
            input.sessionId === undefined
          ) {
            accepted = true
            writes += 1
            response.destroy()
            return
          }
        } else if (request.method === 'GET' && accepted) {
          response.end(JSON.stringify({ data: receipt }))
          return
        }
      }
      response.writeHead(404).end(JSON.stringify({ error: { code: 'submission_not_found' } }))
    },
    ['durable-submissions']
  )

  for (const invalid of [
    { projectId: 'p1', prompt: 'Missing request' },
    { ...args, requestId: '../invalid' },
    { requestId: 'no-project', prompt: 'Missing Project' },
    { ...args, permissionProfile: 'unknown' }
  ]) {
    const rejected = await agent.mcp('start_run', invalid)
    expect(rejected.isError).toBe(true)
    expect(rejected.structuredContent).toMatchObject({ error: { code: 'invalid_request' } })
    expect(rejected.structuredContent).toEqual({
      error: (await agent.cliError('start_run', invalid)).error
    })
  }
  const lost = await agent.mcp('start_run', args)
  expect(lost.isError).toBe(true)
  expect(lost.structuredContent).toMatchObject({
    error: {
      requestId: args.requestId,
      completionStatus: 'submission-unconfirmed',
      retryable: false,
      next: [{ action: 'get_submission', requestId: args.requestId }]
    }
  })
  const key = { requestId: args.requestId }
  expect(await agent.cli('get_submission', key)).toEqual({ result: receipt })
  const reconnected = await connectMcp(agent.profile)
  expect(
    (await reconnected.callTool({ name: 'get_submission', arguments: key })).structuredContent
  ).toEqual({ result: receipt })
  expect(writes).toBe(1)
})

it('recovers the same provider authentication handoff through CLI and MCP', async () => {
  const receipt = {
    requestId: 'needs-login',
    status: 'failed',
    createdAt: 1,
    error: { code: 'provider_auth_required', message: 'private provider detail' }
  }
  const agent = await resourceAgents(
    (request, response) => {
      if (request.url === `/api/v1/run-submissions/${receipt.requestId}`) {
        response.end(JSON.stringify({ data: receipt }))
      } else {
        response.writeHead(404).end()
      }
    },
    ['durable-submissions']
  )
  const key = { requestId: receipt.requestId }
  const handoff = {
    ...key,
    status: 'failed',
    error: {
      code: 'provider_auth_required',
      owner: 'user',
      requiresUser: true,
      retryable: false,
      next: [
        expect.objectContaining({
          action: 'list_providers',
          verify: { capability: 'get_setup_status', profile: agent.profile }
        })
      ]
    }
  }
  for (const [name, args] of [
    ['start_run', { ...key, projectId: 'p1', prompt: 'Read these results.' }],
    ['get_submission', key],
    ['wait_submission', key]
  ] as const) {
    const observed = await agent.mcp(name, args)
    expect(observed.isError).not.toBe(true)
    expect(observed.structuredContent).toEqual(await agent.cli(name, args))
    expect(observed.structuredContent).toMatchObject({
      result: name === 'wait_submission' ? { timeoutMs: 10000, receipt: handoff } : handoff
    })
    expect(JSON.stringify(observed)).not.toContain('open_setup')
    expect(JSON.stringify(observed)).not.toContain('private provider detail')
  }
})

it('tells both transports how to observe a pending submission before a Run exists', async () => {
  const args = { requestId: 'pending-study', projectId: 'p1', prompt: 'Review these results.' }
  const receipt = { requestId: args.requestId, status: 'pending', createdAt: 1 }
  const agent = await resourceAgents(
    (request, response) => {
      if (request.url === `/api/v1/run-submissions/${args.requestId}`) {
        response.end(JSON.stringify({ data: receipt }))
      } else response.writeHead(404).end()
    },
    ['durable-submissions']
  )
  const expected = {
    result: { ...receipt, next: [{ action: 'wait_submission', requestId: args.requestId }] }
  }
  for (const [capability, input] of [
    ['start_run', args],
    ['get_submission', { requestId: args.requestId }]
  ] as const) {
    const mcp = await agent.mcp(capability, input)
    expect(mcp.isError).not.toBe(true)
    expect(mcp.structuredContent).toEqual(expected)
    expect(await agent.cli(capability, input)).toEqual(expected)
  }
})

it('bounds receipt and Run waiting without cancelling or issuing another submission', async () => {
  const receipt: { requestId: string; status: string; createdAt: number; runId?: string } = {
    requestId: 'wait-request',
    status: 'pending',
    createdAt: 1
  }
  const run = { id: 'run-1', projectId: 'p1', sessionId: 's1', status: 'running' }
  const writes: string[] = []
  const agent = await resourceAgents(
    (request, response) => {
      if (request.method !== 'GET') writes.push(request.url!)
      if (request.url === '/api/v1/run-submissions/wait-request') {
        response.end(JSON.stringify({ data: receipt }))
      } else if (request.url === '/api/v1/runs/run-1') {
        response.end(JSON.stringify({ data: run }))
      } else if (request.url === '/api/v1/runs/run-1/cancel' && request.method === 'POST') {
        run.status = 'cancelled'
        response.end(JSON.stringify({ data: run }))
      } else {
        response.writeHead(404).end()
      }
    },
    ['durable-submissions']
  )
  const described = await agent.cli('describe_capability', { name: 'wait_run' })
  expect(described.result).toMatchObject({
    inputSchema: { properties: { timeoutMs: { default: 10000, maximum: 30000 } } }
  })
  for (const [name, reference, action] of [
    ['wait_submission', { requestId: receipt.requestId }, 'get_submission'],
    ['wait_run', { runId: run.id }, 'get_run']
  ] as const) {
    const args = { ...reference, timeoutMs: 120 }
    const result = await agent.mcp(name, args)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: { code: 'timeout', ...args, next: [{ action, ...reference }] }
    })
    expect(result.structuredContent).toEqual({ error: (await agent.cliError(name, args)).error })
  }
  receipt.status = 'accepted'
  receipt.runId = run.id
  expect(await agent.cli('wait_submission', { requestId: receipt.requestId })).toEqual({
    result: { timeoutMs: 10000, receipt }
  })
  expect(writes).toEqual([])
  expect(await agent.cli('cancel_run', { runId: run.id })).toEqual({
    result: { ...run, status: 'cancelled' }
  })
  expect((await agent.mcp('wait_run', { runId: run.id })).structuredContent).toEqual({
    result: { timeoutMs: 10000, run }
  })
  expect(writes).toEqual(['/api/v1/runs/run-1/cancel'])
})

it('returns the stopped Notebook and user action without waiting for the outer Run to finish', async () => {
  const run = {
    id: 'run-stopped',
    projectId: 'p1',
    sessionId: 's1',
    status: 'running',
    execution: {
      status: 'waiting_for_user',
      projectId: 'p1',
      sessionId: 's1',
      reasonCode: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION',
      refusalId: 'refusal-1',
      messageBranchId: 'branch-1',
      requiresUser: true,
      retryable: false,
      next: { action: 'continue_notebook_in_app', message: 'Choose Continue Notebook work.' }
    }
  }
  const agent = await resourceAgents((request, response) => {
    if (request.method === 'GET' && request.url === `/api/v1/runs/${run.id}`) {
      response.end(JSON.stringify({ data: run }))
    } else response.writeHead(404).end()
  })
  const args = { runId: run.id, timeoutMs: 250 }
  const expected = { result: { timeoutMs: args.timeoutMs, run } }
  const result = await agent.mcp('wait_run', args)
  expect(result.isError).not.toBe(true)
  expect(result.structuredContent).toEqual(expected)
  expect(await agent.cli('wait_run', args)).toEqual(expected)
  const listed = (await agent.mcp('list_capabilities', { group: 'research' }))
    .structuredContent as {
    result: { groups: { research: { name: string }[] } }
  }
  expect(listed.result.groups.research.map(({ name }) => name)).not.toContain(
    'continue_notebook_execution'
  )
})

it('recovers the same Notebook continuation receipt after losing the first response', async () => {
  const input = {
    requestId: 'continue-1',
    runId: 'original-run',
    branchId: 'original-branch',
    refusalId: 'original-refusal',
    source: 'user_relay',
    prompt: 'Continue the stopped Notebook analysis.'
  }
  const continuation = {
    runId: input.runId,
    branchId: input.branchId,
    refusalId: input.refusalId,
    source: 'user_relay'
  }
  const receipt = {
    requestId: input.requestId,
    status: 'accepted',
    createdAt: 900,
    runId: 'continuation-run',
    notebookContinuation: continuation
  }
  let writes = 0
  const agent = await resourceAgents(
    async (request, response) => {
      if (request.method === 'PUT' && request.url === '/api/v1/notebook-continuations/continue-1') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk)
        const { requestId: _requestId, ...body } = input
        void _requestId
        expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(body)
        if (++writes === 1) request.socket.destroy()
        else response.end(JSON.stringify({ data: receipt }))
      } else if (request.method === 'GET' && request.url === '/api/v1/run-submissions/continue-1') {
        response.end(JSON.stringify({ data: receipt }))
      } else response.writeHead(404).end()
    },
    ['durable-submissions', 'notebook-continuation']
  )

  const wrongSource = { ...input, source: 'delegated_agent' }
  expect((await agent.mcp('continue_notebook', wrongSource)).structuredContent).toMatchObject({
    error: { code: 'invalid_request' }
  })
  expect(await agent.cliError('continue_notebook', wrongSource)).toMatchObject({
    error: { code: 'invalid_request' }
  })
  expect(writes).toBe(0)
  expect((await agent.mcp('continue_notebook', input)).structuredContent).toMatchObject({
    error: {
      completionStatus: 'submission-unconfirmed',
      requestId: input.requestId,
      next: [{ action: 'get_submission', requestId: input.requestId }]
    }
  })
  const expected = { result: receipt }
  const identity = { requestId: input.requestId }
  expect(await agent.cli('get_submission', identity)).toEqual(expected)
  expect((await agent.mcp('get_submission', identity)).structuredContent).toEqual(expected)
  expect(await agent.cli('continue_notebook', input)).toEqual(expected)
})

it.each(['code', 'runtime'] as const)(
  'returns the live Notebook %s review handoff on both external surfaces',
  async (kind) => {
    const action = `review_notebook_${kind}_in_app`
    let pending = true
    const run = {
      id: 'run-review',
      projectId: 'p1',
      sessionId: 's1',
      status: 'running',
      execution: {
        status: 'waiting_for_user',
        reasonCode: `notebook_${kind}_review_required`,
        projectId: 'p1',
        sessionId: 's1',
        ...(kind === 'code' ? { notebookRunId: 'notebook-1' } : {}),
        promptMessageId: 'prompt-1',
        messageBranchId: 'branch-1',
        kernelDispatched: false,
        owner: 'user',
        requiresUser: true,
        retryable: false,
        next: { action, message: 'Decide the review in Open-Science.' }
      }
    }
    const agent = await resourceAgents((request, response) => {
      if (request.method === 'GET' && request.url === `/api/v1/runs/${run.id}`) {
        response.end(
          JSON.stringify({ data: pending ? run : { ...run, execution: { status: 'unconfirmed' } } })
        )
      } else response.writeHead(404).end()
    })
    const key = { runId: run.id }
    const args = { ...key, timeoutMs: 500 }
    expect((await agent.mcp('get_run', key)).structuredContent).toEqual({ result: run })
    const expected = { result: { timeoutMs: args.timeoutMs, run } }
    expect((await agent.mcp('wait_run', args)).structuredContent).toEqual(expected)
    expect(await agent.cli('wait_run', args)).toEqual(expected)
    const guide = await agent.cli('get_agent_guide')
    expect((await agent.mcp('get_agent_guide')).structuredContent).toEqual(guide)
    expect(guide.result).toContain(action)
    if (kind === 'runtime') {
      pending = false
      const bounded = { ...key, timeoutMs: 120 }
      const expired = await agent.mcp('wait_run', bounded)
      expect(expired.structuredContent).toMatchObject({
        error: { code: 'timeout', ...bounded, next: [{ action: 'get_run', ...key }] }
      })
      expect(expired.structuredContent).toEqual({
        error: (await agent.cliError('wait_run', bounded)).error
      })
    }
  }
)

it('persists a generated CLI request before it can be admitted and refuses to submit without the record', async () => {
  let requestId: string | undefined
  let recordAtAdmission: unknown
  let writes = 0
  const agent = await resourceAgents(
    async (request, response) => {
      if (request.url === '/api/v1/projects') {
        response.end(JSON.stringify({ data: [{ id: 'p1', name: 'Study' }] }))
      } else if (request.method === 'PUT' && request.url?.startsWith('/api/v1/run-submissions/')) {
        writes += 1
        requestId = request.url.split('/').at(-1)!
        recordAtAdmission = JSON.parse(
          await readFile(join(agent.profile, 'agent-run-requests', `${requestId}.json`), 'utf8')
        )
        response.destroy()
      } else if (request.url === `/api/v1/run-submissions/${requestId}`) {
        response.end(JSON.stringify({ data: { requestId, status: 'accepted', runId: 'run-1' } }))
      } else {
        response.writeHead(404).end()
      }
    },
    ['durable-submissions']
  )
  const records = join(agent.profile, 'agent-run-requests')
  const args = [
    'run',
    '--profile',
    agent.profile,
    '--project',
    'p1',
    '--prompt',
    'private study',
    '--json'
  ]
  const lost = await cliError(args)
  expect(lost.error).toMatchObject({ requestId, completionStatus: 'submission-unconfirmed' })
  expect(await readdir(records)).toEqual([`${requestId}.json`])
  expect(recordAtAdmission).toEqual({ requestId, projectId: 'p1', profile: agent.profile })
  expect(await agent.cli('get_submission', { requestId })).toMatchObject({
    result: { requestId, runId: 'run-1' }
  })

  await rm(records, { recursive: true })
  await writeFile(records, 'not a directory')
  const unwritable = await cliError(args)
  expect(unwritable.error).toMatchObject({ code: 'recovery_record_failed', retryable: false })
  expect(writes).toBe(1)
})

it('creates and discovers explicit Project IDs through both Agent entry points', async () => {
  const projects = [{ id: 'p1', name: 'Original', updatedAt: 1 }]
  const agent = await resourceAgents(async (request, response) => {
    if (request.url !== '/api/v1/projects') {
      response.writeHead(404).end()
      return
    }
    if (request.method === 'POST') {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      const number = projects.length + 1
      const data = { id: `p${number}`, name: input.name, updatedAt: number }
      projects.push(data)
      response.writeHead(201).end(JSON.stringify({ data }))
    } else {
      response.end(JSON.stringify({ data: projects }))
    }
  })
  expect(await agent.cli('create_project', { name: 'CLI Study' })).toEqual({
    result: { id: 'p2', name: 'CLI Study', updatedAt: 2 }
  })
  expect((await agent.mcp('create_project', { name: 'MCP Study' })).structuredContent).toEqual({
    result: { id: 'p3', name: 'MCP Study', updatedAt: 3 }
  })
  const listed = await agent.cli('list_projects')
  expect(listed.result).toEqual([
    { id: 'p1', name: 'Original', updatedAt: 1 },
    { id: 'p2', name: 'CLI Study', updatedAt: 2 },
    { id: 'p3', name: 'MCP Study', updatedAt: 3 }
  ])
  expect((await agent.mcp('list_projects')).structuredContent).toEqual(listed)
})

it('checks Session ownership and allows read-only inspection without changing imported history', async () => {
  const packageOrigin = {
    importId: 'import-1',
    sourceProjectId: 'source-p',
    sourceSessionId: 'source-s',
    importedAt: 20,
    manifestChecksum: 'a'.repeat(64)
  }
  const session = { id: 'imported', projectId: 'destination', readOnly: true, packageOrigin }
  const agent = await resourceAgents(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    const error = (status: number, code: string): void => {
      response.writeHead(status).end(JSON.stringify({ error: { code, message: 'private detail' } }))
    }
    if (url.pathname === '/api/v1/sessions' && url.searchParams.get('project') === 'destination') {
      response.end(JSON.stringify({ data: [session] }))
    } else if (url.pathname === '/api/v1/sessions/imported' && request.method === 'GET') {
      if (url.searchParams.get('project') !== 'destination') {
        error(409, 'session_project_mismatch')
        return
      }
      response.end(JSON.stringify({ data: session }))
    } else if (url.pathname === '/api/v1/sessions/imported/config' && request.method === 'PATCH') {
      let body = ''
      for await (const chunk of request) body += chunk
      if (JSON.parse(body).projectId !== 'destination') {
        error(409, 'session_project_mismatch')
        return
      }
      error(409, 'session_read_only')
    } else {
      error(404, 'session_not_found')
    }
  })
  const scope = { sessionId: 'imported', projectId: 'destination' }
  expect(await agent.cli('list_sessions', { projectId: scope.projectId })).toEqual({
    result: [session]
  })
  expect((await agent.mcp('get_session', scope)).structuredContent).toMatchObject({
    result: session
  })
  expect(await agent.cli('get_session', scope)).toEqual(
    (await agent.mcp('get_session', scope)).structuredContent
  )

  for (const [name, args, code] of [
    ['get_session', { ...scope, projectId: 'other' }, 'session_project_mismatch'],
    ['get_session', { ...scope, sessionId: 'missing' }, 'session_not_found'],
    [
      'update_session_configuration',
      { ...scope, expectedRevision: 0, memoryEnabled: false },
      'session_read_only'
    ]
  ] as const) {
    const result = await agent.mcp(name, args)
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({ error: (await agent.cliError(name, args)).error })
    expect(result.structuredContent).toMatchObject({
      error: {
        code,
        retryable: false,
        next: [expect.objectContaining({ action: expect.any(String) })]
      }
    })
    expect(JSON.stringify(result)).not.toContain('private detail')
  }
  expect(await agent.cli('get_session', scope)).toMatchObject({ result: session })
})

it('applies flat Project and Session settings using the configuration versions returned by the service', async () => {
  let project = { id: 'p1', name: 'Original', updatedAt: 10 }
  let defaults = { projectId: 'p1', updatedAt: 10, configured: { memoryEnabled: true } }
  let configuration = {
    projectId: 'p1',
    sessionId: 's1',
    revision: 4,
    persisted: {},
    effective: { permissionProfile: 'ask', memoryEnabled: true }
  }
  const agent = await resourceAgents(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    let body = ''
    for await (const chunk of request) body += chunk
    const input = body ? JSON.parse(body) : undefined
    const error = (status: number, code: string): void => {
      response.writeHead(status).end(JSON.stringify({ error: { code } }))
    }
    if (url.pathname === '/api/v1/projects/p1' && request.method === 'PATCH') {
      if (input.expectedUpdatedAt !== project.updatedAt) {
        error(409, 'project_conflict')
        return
      }
      project = { ...project, name: input.name, updatedAt: 11 }
      response.end(JSON.stringify({ data: project }))
    } else if (url.pathname === '/api/v1/projects/p1/session-defaults') {
      if (request.method === 'PATCH') {
        if (input.expectedUpdatedAt !== defaults.updatedAt) {
          error(409, 'project_conflict')
          return
        }
        defaults = {
          ...defaults,
          updatedAt: 11,
          configured: { ...defaults.configured, ...input.patch }
        }
      }
      response.end(JSON.stringify({ data: defaults }))
    } else if (url.pathname === '/api/v1/sessions/s1/config') {
      if (request.method === 'PATCH') {
        if (input.expectedRevision !== configuration.revision) {
          error(409, 'session_revision_conflict')
          return
        }
        if (input.agentConfiguration?.providerId !== 'configured-provider') {
          error(400, 'invalid_configuration')
          return
        }
        const settings = {
          agentConfiguration: input.agentConfiguration,
          computeHosts: input.computeHosts
        }
        configuration = {
          ...configuration,
          revision: 5,
          persisted: settings,
          effective: { ...configuration.effective, ...settings }
        }
      }
      response.end(JSON.stringify({ data: configuration }))
    } else {
      error(404, 'not_found')
    }
  })
  expect(
    (await agent.mcp('update_project', { projectId: 'p1', expectedUpdatedAt: 10, name: 'Updated' }))
      .structuredContent
  ).toMatchObject({ result: { id: 'p1', name: 'Updated', updatedAt: 11 } })
  const previous = await agent.cli('get_project_session_defaults', { projectId: 'p1' })
  expect(previous).toMatchObject({ result: { configured: { memoryEnabled: true } } })
  const updated = await agent.cli('update_project_session_defaults', {
    projectId: 'p1',
    expectedUpdatedAt: 10,
    providerId: 'configured-provider',
    model: null
  })
  expect(updated).toMatchObject({
    result: {
      projectId: 'p1',
      updatedAt: 11,
      configured: { agentConfiguration: { providerId: 'configured-provider', model: null } }
    }
  })
  expect(
    (await agent.mcp('get_project_session_defaults', { projectId: 'p1' })).structuredContent
  ).toEqual(updated)
  const selection = { projectId: 'p1', sessionId: 's1' }
  const current = await agent.cli('get_session_configuration', selection)
  expect(current).toMatchObject({
    result: { ...selection, revision: 4, effective: { permissionProfile: 'ask' } }
  })
  const args = {
    ...selection,
    expectedRevision: 4,
    providerId: 'configured-provider',
    model: 'model-1',
    enabledComputeHostIds: ['host-1'],
    selectedComputeHostIds: ['host-1']
  }
  const invalid = { ...args, providerId: 'unknown-provider' }
  const rejected = await agent.mcp('update_session_configuration', invalid)
  expect(rejected.isError).toBe(true)
  expect(rejected.structuredContent).toMatchObject({ error: { code: 'invalid_configuration' } })
  expect(rejected.structuredContent).toEqual({
    error: (await agent.cliError('update_session_configuration', invalid)).error
  })
  const changed = await agent.mcp('update_session_configuration', args)
  expect(changed.structuredContent).toMatchObject({
    result: {
      ...selection,
      revision: 5,
      persisted: {
        agentConfiguration: { providerId: 'configured-provider', model: 'model-1' },
        computeHosts: { enabled: ['host-1'], selected: ['host-1'] }
      }
    }
  })
  expect(await agent.cli('get_session_configuration', selection)).toEqual(changed.structuredContent)
  const stale = await agent.mcp('update_session_configuration', args)
  expect(stale.structuredContent).toEqual({
    error: (await agent.cliError('update_session_configuration', args)).error
  })
  expect(stale.structuredContent).toMatchObject({ error: { code: 'session_revision_conflict' } })
})

it('shares Literature search defaults and reports unsupported services without falling back to other commands', async () => {
  const page = { entries: [{ id: 'item-atlas', item: { title: 'Sample Atlas' } }], nextOffset: 20 }
  let supported = true
  const agent = await resourceAgents(async (request, response) => {
    if (!supported || request.url !== '/rpc/literature%3Asearch') {
      response.writeHead(404).end(
        JSON.stringify({
          ok: false,
          error: { code: 'method_not_found', message: 'private command detail' }
        })
      )
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const [input] = JSON.parse(body).args
    response.end(
      JSON.stringify({
        ok: true,
        result: input.projectId === 'p1' && input.limit === 20 ? page : { entries: [] }
      })
    )
  })
  const described = await agent.cli('describe_capability', { name: 'search_literature' })
  expect(described).toMatchObject({
    result: {
      exposure: { cli: true, mcp: true },
      inputSchema: { properties: { limit: { default: 20 } } }
    }
  })
  const input = { projectId: 'p1' }
  expect(await agent.cli('search_literature', input)).toEqual({ result: page })
  expect((await agent.mcp('search_literature', input)).structuredContent).toEqual({ result: page })
  supported = false
  const failure = await agent.mcp('search_literature', input)
  expect(failure.isError).toBe(true)
  expect(failure.structuredContent).toEqual({
    error: (await agent.cliError('search_literature', input)).error
  })
  expect(failure.structuredContent).toMatchObject({
    error: { code: 'unsupported_capability', owner: 'deployment', retryable: false }
  })
  expect(JSON.stringify(failure)).not.toContain('private command detail')
})

it('discovers the same local guide and capability schemas without a running service', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-offline-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const unavailableInstallation = join(profile, 'blocked-installation-state')
  await writeFile(unavailableInstallation, '')
  const client = await connectMcp(profile, {
    OPEN_SCIENCE_INSTALLATION_STATE_ROOT: unavailableInstallation
  })

  const { stdout } = await runCli(['tools', 'list', 'setup', '--profile', profile, '--json'])
  const listed = await client.callTool({
    name: 'list_capabilities',
    arguments: { group: 'setup' }
  })
  expect(listed.structuredContent).toEqual(JSON.parse(stdout))
  expect(listed.structuredContent).toMatchObject({
    result: {
      groups: {
        setup: expect.arrayContaining([
          expect.objectContaining({
            name: 'doctor',
            exposure: { cli: true, mcp: true },
            serviceSupport: 'unknown'
          })
        ])
      }
    }
  })

  const { stdout: description } = await runCli([
    'tools',
    'describe',
    'list_capabilities',
    '--profile',
    profile,
    '--json'
  ])
  const { tools } = await client.listTools()
  const discover = tools.find((tool) => tool.name === 'list_capabilities')
  expect(JSON.parse(description)).toMatchObject({
    result: {
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { checkService: { type: 'boolean', default: false } }
      }
    }
  })
  expect(discover?.inputSchema).toEqual(JSON.parse(description).result.inputSchema)
  const setupBrowser = tools.find((tool) => tool.name === 'open_setup')
  expect(setupBrowser?.description).toMatch(/explicitly asks to open Web/)
  expect(setupBrowser?.description).toMatch(/provider.*requires a browser sign-in/i)

  const { resources } = await client.listResources()
  const guide = resources.find((resource) => resource.uri === 'openscience://agent/guide')
  expect(guide?.mimeType).toBe('text/markdown')
  const { contents } = await client.readResource({ uri: guide!.uri })
  const fallback = await client.callTool({ name: 'get_agent_guide' })
  expect(contents[0]).toHaveProperty('text', fallback.structuredContent?.result)
  expect(fallback.structuredContent?.result).toMatch(/same machine/)
  const { stdout: cliGuide } = await runCli([
    'tools',
    'call',
    'get_agent_guide',
    '--profile',
    profile,
    '--json'
  ])
  expect(JSON.parse(cliGuide)).toEqual(fallback.structuredContent)

  const discovery = await client.callTool({
    name: 'list_capabilities',
    arguments: { group: 'setup', checkService: true }
  })
  expect(discovery.structuredContent).toMatchObject({
    result: {
      groups: {
        setup: expect.arrayContaining([
          expect.objectContaining({ name: 'doctor', serviceSupport: 'unavailable' })
        ])
      },
      service: { status: 'unavailable' }
    }
  })
  const unavailable = await client.callTool({ name: 'doctor' })
  expect(unavailable.isError).toBe(true)
  const missing = await cliError(['doctor', '--profile', profile, '--json'])
  expect(missing.exitCode).toBe(3)
  expect(unavailable.structuredContent).toMatchObject({
    error: {
      code: 'startup_unconfirmed',
      next: [{ executable: 'open-science', argv: ['status', '--json', '--profile', profile] }]
    }
  })
  expect(JSON.stringify(unavailable)).not.toContain(unavailableInstallation)
  expect(missing.error).toMatchObject({
    code: 'daemon_unavailable',
    requiresUser: true,
    retryable: false,
    owner: 'deployment',
    next: [{ executable: 'open-science', argv: ['start', '--no-open', '--profile', profile] }]
  })
})

it('checks a fresh MCP profile after its own startup with another local service holding the configured port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'osci-mcp-fresh-profile-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const install = join(root, 'install')
  const backend = join(install, 'out/backend')
  const profile = join(root, 'profile')
  await mkdir(backend, { recursive: true })
  const sources = resolve('packages/open-science')
  await Promise.all(
    (await readdir(sources))
      .filter((file) => file.endsWith('.mjs') || file.endsWith('.cjs') || file === 'package.json')
      .map((file) => cp(join(sources, file), join(install, file)))
  )
  await symlink(
    dependencyRoot,
    join(install, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  let foreignRequests = 0
  const foreign = createServer((_request, response) => {
    foreignRequests++
    response.writeHead(418).end()
  })
  foreign.listen(0, '127.0.0.1')
  await once(foreign, 'listening')
  cleanup.push(async () => {
    foreign.closeAllConnections()
    await new Promise<void>((done) => foreign.close(() => done()))
  })
  await writeFile(
    join(backend, 'index.cjs'),
    `
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const profile = process.env.OPEN_SCIENCE_CONFIG_ROOT
const port = Number(process.argv.find((arg) => arg.startsWith('--serve=')).split('=')[1])
const token = 'fresh-profile-fixture-token'
fs.writeFileSync(path.join(profile, 'fixture.pid'), String(process.pid))
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + token) return res.writeHead(401).end()
  res.setHeader('content-type', 'application/json')
  if (req.url === '/api/bootstrap') return res.end(JSON.stringify({ taskCapabilities: ['doctor'] }))
  if (req.url === '/api/v1/doctor') {
    fs.appendFileSync(path.join(profile, 'doctor-requests'), '.')
    return res.end(JSON.stringify({ data: { ready: true, checks: {} } }))
  }
  return res.writeHead(404).end()
})
server.listen(port, '127.0.0.1', () => {
  const check = setInterval(() => {
    if (!fs.existsSync(path.join(profile, 'publish-fixture'))) return
    clearInterval(check)
    fs.writeFileSync(path.join(profile, 'web-token'), token)
    fs.writeFileSync(path.join(profile, 'web-service.json'), JSON.stringify({
      pid: process.pid, port: server.address().port, startedAt: new Date().toISOString()
    }))
  }, 20)
})
`
  )
  const occupiedPort = (foreign.address() as { port: number }).port
  const env = {
    OPEN_SCIENCE_INSTALLATION_STATE_ROOT: join(root, 'registration'),
    OPEN_SCIENCE_WEB_PORT: String(occupiedPort)
  }
  cleanup.push(async () => {
    try {
      process.kill(Number(await readFile(join(profile, 'fixture.pid'), 'utf8')))
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  })
  const entry = join(install, 'cli.mjs')
  const client = await connectMcp(profile, env, entry)
  await expect.poll(() => readFile(join(profile, 'fixture.pid'), 'utf8')).toMatch(/^\d+$/)

  const doctor = client.callTool({ name: 'doctor' })
  const setup = client.callTool({ name: 'get_setup_status', arguments: { language: 'r' } })
  const observation = new AbortController()
  const cancelled = expect(
    client.callTool({ name: 'doctor' }, undefined, { signal: observation.signal })
  ).rejects.toThrow()
  const discovery = await client.callTool({
    name: 'list_capabilities',
    arguments: { group: 'setup', checkService: true }
  })
  expect(discovery.structuredContent).toMatchObject({
    result: { service: { status: 'unavailable' } }
  })
  observation.abort()
  await cancelled
  await writeFile(join(profile, 'publish-fixture'), '')
  for (const result of await Promise.all([doctor, setup])) {
    expect(result.structuredContent).toMatchObject({
      result: { profile, readiness: { service: 'ready' } }
    })
  }
  const statePath = join(profile, 'web-service.json')
  const original = JSON.parse(await readFile(statePath, 'utf8'))
  expect(original.port).not.toBe(occupiedPort)
  expect(await readFile(join(profile, 'doctor-requests'), 'utf8')).toBe('..')
  expect(foreignRequests).toBe(0)

  const reconnected = await connectMcp(profile, env, entry)
  expect((await reconnected.callTool({ name: 'doctor' })).structuredContent).toEqual(
    (await doctor).structuredContent
  )
  expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(original)
  expect((await readdir(profile)).filter((file) => file.startsWith('cli-daemon-'))).toHaveLength(1)
}, 15_000)

it('uses the authenticated service for doctor and maps invalid or unsupported calls without exposing secrets', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-doctor-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const token = 'doctor-fixture-secret'
  let advertisesDoctor = true
  let agentReady = true
  let notebookEvidence: Record<string, unknown> | undefined
  let doctorStatus = 200
  let doctorRequests = 0
  const service = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/bootstrap') {
      res.end(JSON.stringify({ taskCapabilities: advertisesDoctor ? ['doctor'] : [] }))
      return
    }
    if (req.url === '/api/v1/doctor') {
      doctorRequests += 1
      res.setHeader('x-correlation-id', 'doctor-correlation-1')
      res.writeHead(doctorStatus).end(
        JSON.stringify(
          doctorStatus === 200
            ? {
                data: {
                  ready: agentReady,
                  checks: {
                    runtime: { status: 'ready', framework: 'codex' },
                    notebook: notebookEvidence,
                    provider: {
                      status: agentReady ? 'ready' : 'not_ready',
                      reason: agentReady ? undefined : 'credential_invalid',
                      credential: token
                    }
                  },
                  next: agentReady ? [] : [{ code: 'provider_not_ready' }]
                }
              }
            : { error: { code: token, message: `Authorization: Bearer ${token}` } }
        )
      )
      return
    }
    res.writeHead(404).end()
  })
  service.listen(0, '127.0.0.1')
  await once(service, 'listening')
  cleanup.push(async () => {
    service.closeAllConnections()
    await new Promise<void>((done) => service.close(() => done()))
  })
  await writeFile(
    join(profile, 'web-service.json'),
    JSON.stringify({
      pid: process.pid,
      port: (service.address() as { port: number }).port,
      startedAt: new Date().toISOString()
    })
  )
  await writeFile(join(profile, 'web-token'), token)
  const client = await connectMcp(profile)
  const doctorArgs = ['doctor', '--profile', profile, '--json']
  const expectSupport = async (serviceSupport: string): Promise<void> => {
    const listed = await client.callTool({
      name: 'list_capabilities',
      arguments: { group: 'setup', checkService: true }
    })
    expect(listed.structuredContent).toMatchObject({
      result: {
        service: { status: 'reachable' },
        groups: {
          setup: expect.arrayContaining([
            expect.objectContaining({ name: 'doctor', serviceSupport })
          ])
        }
      }
    })
  }
  await expectSupport('supported')
  const ready = await client.callTool({ name: 'doctor' })
  expect(ready.isError).not.toBe(true)
  expect(ready.structuredContent).toEqual(JSON.parse((await runCli(doctorArgs)).stdout))
  expect(ready.structuredContent).toMatchObject({
    result: { readiness: { service: 'ready', agent: 'ready', notebook: 'unconfirmed' } }
  })
  expect(ready.structuredContent?.result).not.toHaveProperty('execution')
  expect(ready.structuredContent?.result).not.toHaveProperty('delivery')
  expect(JSON.stringify(ready)).not.toContain(token)

  notebookEvidence = {
    platform: 'darwin',
    environment: { status: 'ready', pythonReady: true, rReady: false },
    dependencies: { status: 'ready' },
    sandbox: { status: 'ready' },
    memoryPolicy: {
      status: 'ready',
      source: 'darwin-sysctl-dispatch',
      executionScope: 'darwin:host',
      detail: token
    }
  }
  const notebookReady = await client.callTool({ name: 'get_setup_status' })
  expect(notebookReady.structuredContent).toEqual(JSON.parse((await runCli(doctorArgs)).stdout))
  const deliveryPath = join(profile, 'agent-delivery')
  expect(notebookReady.structuredContent).toMatchObject({
    result: {
      profile,
      readiness: { agent: 'ready', notebook: 'ready' },
      checks: {
        notebook: {
          environment: { status: 'ready', pythonReady: true, rReady: false },
          memoryPolicy: { source: 'darwin-sysctl-dispatch', executionScope: 'darwin:host' }
        },
        deliveryDirectory: { status: 'ready', path: deliveryPath, checkedDirectory: profile }
      }
    }
  })
  expect(JSON.stringify(notebookReady)).not.toContain(token)
  await expect(lstat(deliveryPath)).rejects.toMatchObject({ code: 'ENOENT' })

  for (const [check, evidence, reason, owner, requiresUser] of [
    [
      'environment',
      { status: 'checking', pythonReady: false, rReady: false },
      'notebook_environment_preparing',
      'service',
      false
    ],
    ['dependencies', { status: 'blocked' }, 'notebook_bubblewrap_missing', 'deployment', true],
    ['dependencies', { status: 'blocked' }, 'notebook_trust_bundle_invalid', 'deployment', true],
    [
      'sandbox',
      { status: 'unconfirmed' },
      'notebook_linux_isolation_unconfirmed',
      'deployment',
      true
    ],
    [
      'memoryPolicy',
      { status: 'blocked' },
      'notebook_linux_procfs_unavailable',
      'deployment',
      true
    ],
    [
      'memoryPolicy',
      { status: 'blocked' },
      'notebook_linux_cgroup_unavailable',
      'deployment',
      true
    ],
    [
      'memoryPolicy',
      { status: 'blocked' },
      'notebook_memory_policy_unavailable',
      'deployment',
      true
    ]
  ] as const) {
    const baseline = notebookEvidence
    notebookEvidence = {
      ...baseline,
      [check]: { ...evidence, reason, detail: token }
    }
    const status = await client.callTool({ name: 'get_setup_status' })
    expect(status.structuredContent).toEqual(JSON.parse((await runCli(doctorArgs)).stdout))
    expect(status.structuredContent).toMatchObject({
      result: {
        readiness: { agent: 'ready', notebook: evidence.status },
        checks: { notebook: { [check]: { status: evidence.status, reason } } },
        next: [
          expect.objectContaining({
            code: reason,
            owner,
            requiresUser,
            verify: { capability: 'get_setup_status', profile }
          })
        ]
      }
    })
    expect(JSON.stringify(status)).not.toContain(token)
    notebookEvidence = baseline
  }

  await writeFile(deliveryPath, 'existing file')
  const blockedDirectory = await client.callTool({ name: 'doctor' })
  expect(blockedDirectory.structuredContent).toEqual(JSON.parse((await runCli(doctorArgs)).stdout))
  expect(blockedDirectory.structuredContent).toMatchObject({
    result: {
      readiness: { notebook: 'ready' },
      checks: {
        deliveryDirectory: {
          status: 'blocked',
          path: deliveryPath,
          reason: 'delivery_directory_not_directory'
        }
      },
      next: [expect.objectContaining({ code: 'delivery_directory_not_directory', owner: 'user' })]
    }
  })
  await rm(deliveryPath)

  notebookEvidence = undefined
  advertisesDoctor = false
  await expectSupport('supported') // Older services may implement doctor without advertising it.
  agentReady = false
  const blocked = await client.callTool({ name: 'doctor' })
  expect(blocked.structuredContent).toEqual(JSON.parse((await runCli(doctorArgs)).stdout))
  expect(blocked.structuredContent).toMatchObject({
    result: {
      readiness: { service: 'ready', agent: 'blocked', notebook: 'unconfirmed' },
      checks: { provider: { status: 'not_ready', reason: 'credential_invalid' } },
      next: [{ code: 'provider_not_ready', action: 'list_providers' }]
    }
  })

  expect(JSON.stringify(blocked.structuredContent)).not.toContain('open_setup')
  const beforeInvalid = doctorRequests
  const invalid = await client.callTool({ name: 'doctor', arguments: { apiKey: token } })
  expect(invalid.isError).toBe(true)
  expect(invalid.structuredContent).toEqual({
    error: (await cliError(['tools', 'call', ...doctorArgs], JSON.stringify({ apiKey: token })))
      .error
  })
  expect(invalid.structuredContent).toMatchObject({
    error: { code: 'invalid_request', retryable: false, requiresUser: false, owner: 'agent' }
  })
  expect(JSON.stringify(invalid)).not.toContain(token)
  expect(doctorRequests).toBe(beforeInvalid)
  const denied = await client.callTool({
    name: 'call_rpc',
    arguments: { channel: 'private:write' }
  })
  expect(denied.isError).toBe(true)
  expect(denied.structuredContent).toMatchObject({ error: { code: 'capability_not_exposed' } })
  expect(
    (await cliError(['tools', 'call', 'unregistered_tool', '--profile', profile, '--json'])).error
  ).toMatchObject({
    code: 'capability_not_exposed'
  })

  doctorStatus = 404
  await expectSupport('unsupported')
  for (const [status, code, owner] of [
    [404, 'unsupported_capability', 'deployment'],
    [401, 'access_denied', 'deployment'],
    [500, 'request_failed', 'service']
  ] as const) {
    doctorStatus = status
    const received = await client.callTool({ name: 'doctor' })
    expect(received.isError).toBe(true)
    expect(received.structuredContent).toEqual({ error: (await cliError(doctorArgs)).error })
    expect(received.structuredContent).toMatchObject({
      error: { code, owner, correlationId: 'doctor-correlation-1', retryable: false }
    })
    expect(received.content).toEqual([
      { type: 'text', text: JSON.stringify(received.structuredContent) }
    ])
    expect(JSON.stringify(received)).not.toContain(token)
  }
})

it('discovers setup choices and prepares only the selected runtime, provider and language', async () => {
  const writes: unknown[] = []
  let selected: string | null = null
  let provider = 'missing'
  const installed = new Set<string>()
  const agent = await resourceAgents(
    async (req, res) => {
      let text = ''
      for await (const chunk of req) text += chunk
      const args = text ? JSON.parse(text) : undefined
      if (args) writes.push(args)
      const respond = (data: unknown): void => {
        res.end(JSON.stringify({ data }))
      }
      switch (req.url) {
        case '/api/v1/doctor':
          return respond({
            ready: provider === 'ready' && installed.has(selected ?? ''),
            checks: {
              runtime: {
                status: installed.has(selected ?? '') ? 'ready' : 'missing',
                framework: selected ?? 'codex',
                selectedFramework: selected
              },
              provider: { status: provider, keylessKiloAvailable: true },
              notebook: {
                platform: 'darwin',
                environment: {
                  status: 'blocked',
                  reason: 'notebook_python_missing',
                  python: {
                    status: installed.has('python') ? 'ready' : 'blocked',
                    reason: installed.has('python') ? undefined : 'notebook_environment_missing'
                  },
                  r: {
                    status: installed.has('r') ? 'ready' : 'blocked',
                    reason: installed.has('r') ? undefined : 'notebook_environment_missing'
                  }
                },
                dependencies: { status: 'ready' },
                sandbox: { status: 'ready' },
                memoryPolicy: { status: 'ready', source: 'darwin', executionScope: 'darwin:host' }
              }
            },
            next: [
              { code: 'runtime_missing' },
              ...(provider === 'missing'
                ? [{ code: 'provider_missing', argv: ['codex', 'login'] }]
                : [])
            ]
          })
        case '/api/v1/runtimes':
          return respond(
            ['open-science-agent', 'opencode', 'codex'].map((framework) => ({
              framework,
              status: installed.has(framework) ? 'ready' : 'missing'
            }))
          )
        case '/api/v1/bootstrap':
          if (args.action === 'agent-runtime') installed.add(args.framework)
          else if (args.action === 'kilo-free') provider = 'ready'
          return respond({ ok: true })
        case '/api/v1/settings/agent-routing':
          selected = args.framework
          return respond({ configured: { framework: selected } })
        case '/api/v1/notebook-environment/operations/prepare-r':
        case '/api/v1/notebook-environment/operations/prepare-python':
          installed.add(args.language)
          return respond({
            operationId: `prepare-${args.language}`,
            ...args,
            status: 'completed'
          })
        default:
          res.writeHead(404).end()
      }
    },
    ['doctor', 'agent-setup', 'notebook-setup-operations', 'list-runtimes']
  )
  const both = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const mcp = await agent.mcp(name, args)
    expect(mcp.isError).not.toBe(true)
    expect(mcp.structuredContent).toEqual(await agent.cli(name, args))
    return mcp.structuredContent?.result
  }
  const fresh = await both('get_setup_status')
  expect(fresh).toMatchObject({
    checks: {
      runtime: { selectedFramework: null },
      notebook: { environment: { python: { status: 'blocked' }, r: { status: 'blocked' } } }
    },
    next: expect.arrayContaining([
      expect.objectContaining({ action: 'choose_runtime' }),
      expect.objectContaining({ action: 'choose_notebook_language' })
    ])
  })
  expect(JSON.stringify(fresh)).not.toContain('provider_login')
  expect(JSON.stringify(fresh)).not.toContain('open_setup')
  expect(await both('list_runtimes')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ framework: 'opencode' }),
      expect.objectContaining({ framework: 'codex' })
    ])
  )
  expect(writes).toEqual([])
  for (const name of ['prepare_runtime', 'configure_provider', 'prepare_notebook_environment']) {
    const mcp = await agent.mcp(name, { apiKey: 'private-value' })
    expect(mcp.isError).toBe(true)
    expect(mcp.structuredContent).toEqual({
      error: (await agent.cliError(name, { apiKey: 'private-value' })).error
    })
    expect(JSON.stringify(mcp)).not.toContain('private-value')
  }
  expect(writes).toEqual([])
  const framework = 'opencode'
  const needsProvider = await both('select_runtime', { framework })
  expect(needsProvider).toMatchObject({
    next: expect.arrayContaining([expect.objectContaining({ action: 'choose_provider' })])
  })
  expect(JSON.stringify(needsProvider)).not.toContain('open_setup')
  await both('prepare_runtime', { framework })
  expect(await both('configure_provider', { provider: 'kilo-free', framework })).toMatchObject({
    readiness: { agent: 'ready' },
    checks: { runtime: { framework, selectedFramework: framework } }
  })
  expect(
    await both('prepare_notebook_environment', { language: 'r', operationId: 'prepare-r' })
  ).toMatchObject({
    operation: { language: 'r', status: 'completed' }
  })
  expect(await both('get_setup_status', { language: 'r' })).toMatchObject({
    readiness: { notebook: 'ready' },
    checks: { notebook: { environment: { python: { status: 'blocked' }, r: { status: 'ready' } } } }
  })
  const missingPython = await both('get_setup_status', { language: 'python' })
  expect(missingPython).toMatchObject({
    readiness: { notebook: 'blocked' },
    next: expect.arrayContaining([
      expect.objectContaining({
        action: 'prepare_notebook_environment',
        owner: 'agent',
        requiresUser: false,
        arguments: { language: 'python' },
        message: expect.stringContaining('Settings > Runtimes')
      })
    ])
  })
  expect(JSON.stringify(missingPython)).not.toContain('open_setup')
  installed.delete('r')
  expect(
    await both('prepare_notebook_environment', {
      language: 'python',
      operationId: 'prepare-python'
    })
  ).toMatchObject({
    operation: { language: 'python', status: 'completed' }
  })
  expect(await both('get_setup_status', { language: 'python' })).toMatchObject({
    readiness: { notebook: 'ready' },
    checks: { notebook: { environment: { python: { status: 'ready' }, r: { status: 'blocked' } } } }
  })
  expect(writes).toEqual([
    ...Array(2).fill({ framework }),
    ...Array(2).fill({ action: 'agent-runtime', framework }),
    ...Array(2).fill({ action: 'kilo-free', framework }),
    ...Array(2).fill({ language: 'r', action: 'prepare' }),
    ...Array(2).fill({ language: 'python', action: 'prepare' })
  ])
})

it.each(['messages', 'chat-completions', 'responses'])(
  'returns a headless credential command for the selected %s protocol',
  async (protocol) => {
    const framework = 'open-science-agent'
    const baseUrl = 'https://gateway.example/v1'
    const endpoint = `${baseUrl}/${protocol === 'chat-completions' ? 'chat/completions' : protocol}`
    const model = 'gateway-model'
    const args = { providerType: 'custom', framework, baseUrl, model, protocol }
    const agent = await resourceAgents(
      async (req, res) => {
        if (req.url !== '/api/v1/bootstrap') return void res.writeHead(404).end()
        let text = ''
        for await (const chunk of req) text += chunk
        const input = JSON.parse(text)
        expect(input.key).toBeUndefined()
        if (input.action === 'provider-save') {
          res.end(JSON.stringify({ data: { ok: false, code: 'provider_credential_missing' } }))
        } else if (input.action === 'provider-credential-target') {
          res.end(
            JSON.stringify({ data: { ok: true, providerCredentialTarget: { protocol, endpoint } } })
          )
        } else res.writeHead(404).end()
      },
      ['provider-setup', 'provider-terminal-setup']
    )
    const check = (error: Record<string, unknown>): void => {
      expect(error).toMatchObject({
        code: 'provider_credential_missing',
        owner: 'user',
        requiresUser: true,
        next: [
          {
            action: 'enter_provider_credential',
            owner: 'user',
            target: { profile: agent.profile, framework, model, protocol, baseUrl, endpoint },
            argv: expect.arrayContaining(['provider', 'setup', '--protocol', protocol]),
            verify: { action: 'list_providers', arguments: { framework } }
          }
        ]
      })
      const [next] = error.next as Array<{
        command: string
        target: { providerId: string }
        argv: string[]
      }>
      expect(next.command).toContain(protocol)
      expect(next.command).not.toContain('open_setup')
      expect(next.target.providerId).toMatch(/^[a-f0-9-]{36}$/)
    }
    const mcp = await agent.mcp('save_api_provider', args)
    expect(mcp.isError).toBe(true)
    check(mcp.structuredContent!.error as Record<string, unknown>)
    check((await agent.cliError('save_api_provider', args)).error)
    const [handoff] = mcp.structuredContent!.error.next as Array<{ argv: string[] }>
    const result = await cliError([...handoff.argv.slice(1), '--json'], 'not-a-terminal-key')
    expect(result.error.message).toContain('interactive terminal')
    expect(JSON.stringify(result)).not.toContain('not-a-terminal-key')
  }
)

it('publishes disjoint official and custom provider draft schemas', async () => {
  const agent = await resourceAgents(() => undefined, ['provider-setup'])
  const client = await connectMcp(agent.profile, undefined, cli, 'core')
  const { tools } = await client.listTools()
  const tool = tools.find(({ name }) => name === 'save_api_provider')
  const schema = tool?.inputSchema as {
    properties?: Record<string, { const?: string; description?: string }>
    oneOf?: Array<{
      required?: string[]
      properties?: Record<string, { const?: string; description?: string }>
    }>
  }
  expect(tool?.description).toMatch(/default is a terminal handoff/i)
  expect(schema.properties?.apiKeyEnv?.description).toMatch(/explicitly chosen/i)
  expect(schema.properties?.credentialRef?.description).toMatch(/explicitly chosen/i)
  expect(schema.properties?.providerType).toMatchObject({
    type: 'string',
    enum: ['official', 'custom']
  })
  expect(schema.properties?.providerType).not.toHaveProperty('const')
  const official = schema.oneOf?.find(
    (variant) => variant.properties?.providerType?.const === 'official'
  )
  const custom = schema.oneOf?.find(
    (variant) => variant.properties?.providerType?.const === 'custom'
  )
  expect(official).toBeDefined()
  expect(official?.required).toEqual(expect.arrayContaining(['vendorId']))
  expect(official?.properties).not.toHaveProperty('baseUrl')
  expect(official?.properties).not.toHaveProperty('protocol')
  expect(custom).toBeDefined()
  expect(custom?.required).toEqual(expect.arrayContaining(['baseUrl', 'protocol']))
  expect(custom?.properties).not.toHaveProperty('vendorId')
  expect(custom?.properties).not.toHaveProperty('region')
})

it('explains the official provider protocol constraint', async () => {
  const agent = await resourceAgents(() => undefined, ['provider-setup'])
  const response = await agent.mcp('save_api_provider', {
    providerType: 'official',
    framework: 'opencode',
    model: 'deepseek-v4-pro',
    vendorId: 'deepseek',
    protocol: 'chat-completions'
  })
  expect(response.structuredContent).toMatchObject({
    error: {
      code: 'invalid_request',
      message: expect.stringContaining('derive the protocol')
    }
  })
})

it('discovers, saves and explicitly activates an API provider through CLI and MCP', async () => {
  const key = 'synthetic-provider-secret'
  const framework = 'opencode'
  const model = 'gateway-model'
  const active = { providerId: null as string | null, model: null as string | null }
  const saved = { providerId: 'gateway', model, framework, saved: true, active: false }
  let savedProvider = false
  const profile = await resourceAgents(
    async (req, res) => {
      if (req.url !== '/api/v1/bootstrap') return void res.writeHead(404).end()
      let text = ''
      for await (const chunk of req) text += chunk
      const input = JSON.parse(text)
      const respond = (data: unknown): void => void res.end(JSON.stringify({ data }))
      switch (input.action) {
        case 'provider-options':
          return respond({
            ok: true,
            providerOptions: {
              framework,
              selectedFramework: framework,
              active,
              providers: savedProvider
                ? [{ id: saved.providerId, type: 'custom', models: [model] }]
                : [],
              official: [{ vendorId: 'openai', models: ['gpt-5.4'] }]
            }
          })
        case 'provider-save':
          if (input.key !== key && input.credentialRef !== 'fixture-ref')
            return respond({ ok: false, code: 'credential_invalid' })
          if (input.model === 'rejected-model')
            return respond({
              ok: false,
              code: 'provider_validation_failed',
              category: 'model-not-found',
              message: key
            })
          savedProvider = true
          return respond({ ok: true, providerSetup: { ...saved, validation: 'passed' } })
        case 'provider-activate':
          if (
            input.expectedActiveProviderId !== active.providerId ||
            input.expectedActiveModel !== active.model
          )
            return respond({ ok: false, code: 'configuration_conflict' })
          active.providerId = saved.providerId
          active.model = model
          return respond({
            ok: true,
            providerSetup: { ...saved, active: true, validation: 'passed' }
          })
        default:
          res.writeHead(404).end()
      }
    },
    ['provider-setup'],
    { OSCI_TEST_PROVIDER_KEY: key }
  )
  const draft = {
    providerType: 'custom',
    framework,
    baseUrl: 'https://gateway.example/v1',
    protocol: 'chat-completions',
    model,
    apiKeyEnv: 'OSCI_TEST_PROVIDER_KEY'
  }
  const success = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const mcp = await profile.mcp(name, args)
    expect(mcp.isError).not.toBe(true)
    expect(mcp.structuredContent).toEqual(await profile.cli(name, args))
    expect(JSON.stringify(mcp)).not.toContain(key)
    return mcp.structuredContent?.result
  }
  const failure = async (
    name: string,
    args: Record<string, unknown>,
    code: string
  ): Promise<void> => {
    const mcp = await profile.mcp(name, args)
    expect(mcp.isError).toBe(true)
    const { error } = await profile.cliError(name, args)
    expect(error.code).toBe(code)
    expect(mcp.structuredContent).toEqual({ error })
    expect(JSON.stringify(mcp)).not.toContain(key)
  }

  expect(await success('list_providers')).toMatchObject({
    framework,
    active: { providerId: null, model: null },
    providers: [],
    official: [{ vendorId: 'openai', models: ['gpt-5.4'] }]
  })
  await failure(
    'save_api_provider',
    { ...draft, apiKeyEnv: 'OSCI_TEST_PROVIDER_KEY_MISSING' },
    'provider_credential_missing'
  )
  await failure('save_api_provider', { ...draft, apiKey: key }, 'invalid_request')
  await failure(
    'save_api_provider',
    { ...draft, model: 'rejected-model' },
    'provider_validation_failed'
  )
  expect(await success('save_api_provider', draft)).toEqual({ ...saved, validation: 'passed' })
  expect(
    await success('save_api_provider', {
      ...draft,
      apiKeyEnv: undefined,
      credentialRef: 'fixture-ref'
    })
  ).toEqual({ ...saved, validation: 'passed' })
  expect(await success('list_providers')).toMatchObject({
    active: { providerId: null, model: null },
    providers: [{ id: saved.providerId, models: [model] }]
  })
  const selection = {
    providerId: saved.providerId,
    framework,
    model,
    expectedActiveProviderId: null,
    expectedActiveModel: null
  }
  const mcp = await profile.mcp('activate_provider', selection)
  expect(mcp.structuredContent?.result).toEqual({ ...saved, active: true, validation: 'passed' })
  await failure('activate_provider', selection, 'configuration_conflict')
  expect(
    await success('activate_provider', {
      ...selection,
      expectedActiveProviderId: saved.providerId,
      expectedActiveModel: model
    })
  ).toEqual({ ...saved, active: true, validation: 'passed' })
})

it('leaves the configured Codex provider login to the user in the same profile', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-setup-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const token = 'setup-fixture-secret'
  let runtime = 'missing'
  let provider = 'missing'
  let installationFails = false
  const installs: unknown[] = []
  const service = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end()
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/bootstrap') {
      return res.end(JSON.stringify({ taskCapabilities: ['doctor', 'agent-setup'] }))
    }
    if (req.url === '/api/v1/bootstrap' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      installs.push(JSON.parse(body))
      if (installationFails) {
        return res
          .writeHead(503)
          .end(JSON.stringify({ error: { code: 'runtime_unavailable', message: token } }))
      }
      runtime = 'ready'
      return res.end(JSON.stringify({ data: { ok: true } }))
    }
    if (req.url === '/api/v1/doctor') {
      return res.end(
        JSON.stringify({
          data: {
            ready: runtime === 'ready' && provider === 'ready',
            checks: {
              runtime: { status: runtime, framework: 'codex', selectedFramework: 'codex' },
              provider: { status: provider }
            },
            next:
              provider === 'missing'
                ? [{ code: 'provider_missing', argv: ['codex', 'login', '--force'] }]
                : []
          }
        })
      )
    }
    return res.writeHead(404).end()
  })
  service.listen(0, '127.0.0.1')
  await once(service, 'listening')
  cleanup.push(async () => {
    service.closeAllConnections()
    await new Promise<void>((done) => service.close(() => done()))
  })
  await writeFile(
    join(profile, 'web-service.json'),
    JSON.stringify({
      pid: process.pid,
      port: (service.address() as { port: number }).port,
      startedAt: new Date().toISOString()
    })
  )
  await writeFile(join(profile, 'web-token'), token)
  const client = await connectMcp(profile)
  const cliArgs = (name: string): string[] => [
    'tools',
    'call',
    name,
    '--profile',
    profile,
    '--json'
  ]
  const both = async (name: string, args: object = {}): Promise<unknown> => {
    const mcp = await client.callTool({ name, arguments: args })
    expect(mcp.isError).not.toBe(true)
    expect(mcp.structuredContent).toEqual(
      JSON.parse((await runCli(cliArgs(name), JSON.stringify(args))).stdout)
    )
    return mcp.structuredContent?.result
  }
  expect(await both('get_setup_status')).toMatchObject({
    profile,
    readiness: { service: 'ready', agent: 'blocked' },
    checks: { runtime: { status: 'missing' }, provider: { status: 'missing' } }
  })
  expect(installs).toEqual([])
  const rejected = await client.callTool({ name: 'prepare_runtime', arguments: { apiKey: token } })
  expect(rejected.isError).toBe(true)
  expect(rejected.structuredContent).toMatchObject({ error: { code: 'invalid_request' } })
  expect(installs).toEqual([])

  installationFails = true
  const runtimeArgs = { framework: 'codex' }
  const failed = await client.callTool({ name: 'prepare_runtime', arguments: runtimeArgs })
  expect(failed.isError).toBe(true)
  expect(failed.structuredContent).toEqual({
    error: (await cliError(cliArgs('prepare_runtime'), JSON.stringify(runtimeArgs))).error
  })
  expect(failed.structuredContent).toMatchObject({
    error: { code: 'runtime_unavailable', owner: 'deployment', retryable: false }
  })
  expect(JSON.stringify(failed)).not.toContain(token)

  installationFails = false
  const prepared = await both('prepare_runtime', runtimeArgs)
  expect(prepared).toMatchObject({
    profile,
    checks: { runtime: { status: 'ready' }, provider: { status: 'missing' } },
    next: [
      expect.objectContaining({
        code: 'provider_missing',
        owner: 'user',
        executable: process.execPath,
        argv: [cli, 'codex', 'login', '--force', '--profile', profile],
        web: { capability: 'open_setup' },
        requiresUser: true,
        retryable: false,
        verify: { capability: 'get_setup_status', profile }
      })
    ]
  })
  const { stdout } = await runCli(['runtime', 'install', 'codex', '--profile', profile, '--json'])
  expect(JSON.parse(stdout)).toEqual({ ok: true })
  expect(installs).toEqual([
    ...Array(4).fill({ action: 'agent-runtime', framework: 'codex' }),
    { action: 'runtime' }
  ])
  provider = 'ready' // The product's login owns this change, outside the external Agent API.
  expect(await both('get_setup_status')).toMatchObject({
    profile,
    readiness: { agent: 'ready' },
    next: []
  })
})

it('serves a real stdio run/poll/artifact workflow through authenticated HTTP and keeps runs after close', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const requests: Array<{ url: string; method: string; body: unknown }> = []
  const startupRequested = Promise.withResolvers<void>()
  const allowStartup = Promise.withResolvers<void>()
  const token = 'mcp-fixture-secret'
  const run = { id: 'r1', sessionId: 's1', projectId: 'p1', status: 'running' }
  const receipt = { requestId: 'study-001', runId: run.id, status: 'accepted', createdAt: 1 }
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ url: req.url!, method: req.method!, body: body ? JSON.parse(body) : undefined })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/bootstrap') {
      startupRequested.resolve()
      await allowStartup.promise
      res.end(JSON.stringify({ taskCapabilities: ['durable-submissions'] }))
      return
    }
    const data =
      req.url === '/api/v1/sessions/s1/artifacts'
        ? [{ id: 'a1', name: 'report.md' }]
        : req.url === '/api/v1/run-submissions/study-001'
          ? receipt
          : run
    res.end(JSON.stringify({ data }))
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  cleanup.push(async () => {
    http.closeAllConnections()
    await new Promise<void>((done) => http.close(() => done()))
  })
  const address = http.address() as { port: number }
  await writeFile(
    join(profile, 'web-service.json'),
    JSON.stringify({ pid: process.pid, port: address.port, startedAt: new Date().toISOString() })
  )
  await writeFile(join(profile, 'web-token'), token)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('packages/open-science/cli.mjs'), 'mcp', '--profile', profile],
    stderr: 'pipe'
  })
  const client = new Client({ name: 'external-agent', version: '1.0.0' })
  cleanup.push(() => client.close())
  cleanup.push(async () => allowStartup.resolve())
  let stderr = ''
  transport.stderr?.on('data', (data) => {
    stderr += data.toString()
  })
  await client.connect(transport)
  // Initialization starts the service before any tool call; discovery stays usable meanwhile.
  await startupRequested.promise
  expect((await client.listTools()).tools).toEqual(
    expect.arrayContaining(
      ['start_run', 'get_run', 'list_artifacts'].map((name) => expect.objectContaining({ name }))
    )
  )
  const ownerPath = join(profile, 'runtime-owner.json')
  await writeFile(ownerPath, '{}')
  allowStartup.resolve()
  const blocked = await client.callTool({
    name: 'start_run',
    arguments: { requestId: receipt.requestId, projectId: 'p1', prompt: 'Research' }
  })
  expect(blocked.isError).toBe(true)
  expect(blocked.content).toEqual([
    { type: 'text', text: expect.stringContaining('startup_unconfirmed') }
  ])
  expect(requests.every((request) => request.method === 'GET')).toBe(true)
  await rm(ownerPath)
  const started = await client.callTool({
    name: 'start_run',
    arguments: {
      requestId: receipt.requestId,
      projectId: 'p1',
      sessionId: 's1',
      prompt: 'Continue',
      model: null,
      turnIntent: 'plan-first'
    }
  })
  expect(started.structuredContent).toEqual({ result: receipt })
  expect(requests.find((request) => request.method === 'PUT')).toEqual({
    url: '/api/v1/run-submissions/study-001',
    method: 'PUT',
    body: {
      project: 'p1',
      sessionId: 's1',
      prompt: 'Continue',
      agentConfiguration: { model: null },
      turnIntent: 'plan-first'
    }
  })
  run.status = 'completed'
  expect(
    (await client.callTool({ name: 'get_run', arguments: { runId: 'r1' } })).structuredContent
  ).toEqual({ result: run })
  expect(
    (await client.callTool({ name: 'list_artifacts', arguments: { sessionId: 's1' } }))
      .structuredContent
  ).toEqual({ result: [{ downloadId: 'a1', name: 'report.md' }] })
  await client.close()
  expect(requests.some((request) => request.url.includes('cancel'))).toBe(false)
  expect(stderr).not.toContain(token)
  expect(http.listening).toBe(true)
}, 15000)

it('delivers a pinned Artifact through either entry point without overwriting local files', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-artifact-delivery-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const token = 'artifact-fixture-secret'
  const report = {
    id: 'report-version',
    artifactId: 'report-lineage',
    versionId: 'report-version',
    producerRunId: 'notebook-run',
    name: 'report.md',
    kind: 'managed-file',
    mimeType: 'text/markdown',
    size: 3,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  }
  const table = { ...report, id: 'table-version', versionId: 'table-version', name: 'results.csv' }
  const unrelated = { ...table, id: 'old-version', versionId: 'old-version', name: 'other.csv' }
  const run = { id: 'r1', sessionId: 's1', status: 'completed', artifacts: [report, table] }
  let content = 'abc'
  const service = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end()
    if (req.url?.endsWith('/content')) {
      return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(content)
    }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/bootstrap') return res.end('{}')
    if (req.url === '/api/v1/sessions/s1/artifacts') {
      return res.end(JSON.stringify({ data: [report, table, unrelated] }))
    }
    if (req.url === '/api/v1/runs/r1') return res.end(JSON.stringify({ data: run }))
    return res.writeHead(404).end()
  })
  service.listen(0, '127.0.0.1')
  await once(service, 'listening')
  cleanup.push(async () => {
    service.closeAllConnections()
    await new Promise<void>((done) => service.close(() => done()))
  })
  await writeFile(
    join(profile, 'web-service.json'),
    JSON.stringify({
      pid: process.pid,
      port: (service.address() as { port: number }).port,
      startedAt: new Date().toISOString()
    })
  )
  await writeFile(join(profile, 'web-token'), token)
  const mcp = await connectMcp(profile, undefined, cli, 'core')
  const tools = await mcp.listTools()
  expect(tools.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      'list_artifacts',
      'download_artifact',
      'get_delivery_status',
      'get_package_operation'
    ])
  )
  expect(tools.tools.map((tool) => tool.name)).not.toContain('start_run')
  const cliArgs = (name: string): string[] => [
    'tools',
    'call',
    name,
    '--profile',
    profile,
    '--json'
  ]
  const call = (name: string, args: Record<string, unknown>): ReturnType<Client['callTool']> =>
    mcp.callTool({ name, arguments: args })
  const both = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const remote = await call(name, args)
    expect(remote.isError, JSON.stringify(remote.structuredContent)).not.toBe(true)
    expect(remote.structuredContent).toEqual(
      JSON.parse((await runCli(cliArgs(name), JSON.stringify(args))).stdout)
    )
    return (remote.structuredContent as { result: unknown }).result
  }
  const bothFail = async (args: Record<string, unknown>, code: string): Promise<void> => {
    const remote = await call('download_artifact', args)
    expect(remote.isError).toBe(true)
    const cli = await cliError(cliArgs('download_artifact'), JSON.stringify(args))
    expect(remote.structuredContent).toEqual({ error: cli.error })
    expect(cli.error).toMatchObject({ code })
  }
  const listed = await both('list_artifacts', { sessionId: 's1', runId: 'r1' })
  expect(listed).toEqual([
    expect.objectContaining({
      downloadId: 'report-version',
      artifactId: 'report-lineage',
      versionId: 'report-version',
      producerRunId: 'notebook-run',
      runId: 'r1',
      name: 'report.md',
      bytes: 3,
      sha256: report.sha256
    }),
    expect.objectContaining({ downloadId: 'table-version' })
  ])
  const expected = { runId: 'r1', reportName: 'report.md', tableName: 'results.csv' }
  expect(await both('get_delivery_status', { ...expected, tableName: 'other.csv' })).toMatchObject({
    delivery: { status: 'partial', verified: false }
  })
  expect(await both('get_delivery_status', expected)).toMatchObject({
    delivery: { status: 'available', verified: false }
  })

  const reportPath = join(profile, 'agent-delivery', 'report-version', 'report.md')
  const request = { sessionId: 's1', downloadId: 'report-version' }
  expect((await call('download_artifact', request)).structuredContent).toMatchObject({
    result: { path: reportPath, bytes: 3, sha256: report.sha256, verified: true, timeoutMs: 300000 }
  })
  expect(await readFile(reportPath, 'utf8')).toBe('abc')
  const tablePath = join(profile, 'results.csv')
  const tableRequest = { sessionId: 's1', downloadId: 'table-version', outputPath: tablePath }
  expect(
    JSON.parse((await runCli(cliArgs('download_artifact'), JSON.stringify(tableRequest))).stdout)
  ).toMatchObject({
    result: { path: tablePath, bytes: 3, sha256: report.sha256, verified: true }
  })
  expect(await readFile(tablePath, 'utf8')).toBe('abc')
  expect(await both('get_delivery_status', { ...expected, tablePath })).toMatchObject({
    handoffStatus: 'incomplete',
    execution: { status: 'unconfirmed' },
    delivery: { status: 'verified', verified: true }
  })
  Object.assign(run, { execution: { status: 'failed', sessionId: 's1', kernelDispatched: true } })
  expect(await both('get_delivery_status', { ...expected, tablePath })).toMatchObject({
    handoffStatus: 'incomplete',
    execution: { status: 'failed', kernelDispatched: true }
  })
  Object.assign(run, {
    execution: { status: 'completed', sessionId: 's1', kernelDispatched: true }
  })
  expect(await both('get_delivery_status', expected)).toMatchObject({
    handoffStatus: 'incomplete',
    delivery: {
      status: 'available',
      outputs: [
        { role: 'report', path: reportPath, status: 'verified' },
        { role: 'table', status: 'available' }
      ]
    },
    next: [
      {
        action: 'get_delivery_status',
        ...expected,
        message: expect.stringContaining('tablePath from the download receipt')
      }
    ]
  })
  expect(await both('get_delivery_status', { ...expected, tablePath })).toMatchObject({
    handoffStatus: 'complete',
    delivery: { status: 'verified', verified: true }
  })
  const shortcutPath = join(profile, 'shortcut.csv')
  const shortcut = [
    'artifacts',
    'download',
    'table-version',
    '--session',
    's1',
    '--output',
    shortcutPath,
    '--profile',
    profile,
    '--json'
  ]
  expect(JSON.parse((await runCli(shortcut)).stdout)).toMatchObject({
    sessionId: 's1',
    downloadId: 'table-version',
    path: shortcutPath,
    bytes: 3,
    sha256: report.sha256,
    verified: true
  })
  expect((await cliError(shortcut)).error).toMatchObject({
    code: 'delivery_target_exists',
    sessionId: 's1'
  })

  await bothFail(request, 'delivery_target_exists')
  await bothFail({ ...request, downloadId: 'report-lineage' }, 'artifact_not_found')
  const directory = join(profile, 'directory')
  await mkdir(directory)
  await bothFail({ ...request, outputPath: directory }, 'delivery_target_exists')
  if (process.platform !== 'win32') {
    const link = join(profile, 'link')
    await symlink(reportPath, link)
    await bothFail({ ...request, outputPath: link }, 'delivery_target_exists')
    expect(await readlink(link)).toBe(reportPath)
  }
  expect(await readFile(reportPath, 'utf8')).toBe('abc')

  const badPath = join(directory, 'bad.md')
  for (const changed of ['ab', 'xyz']) {
    content = changed
    await bothFail({ ...request, outputPath: badPath }, 'delivery_integrity_mismatch')
    expect(await readdir(directory)).toEqual([])
  }
  delete (report as Partial<typeof report>).sha256
  const unverified = await call('download_artifact', { ...request, outputPath: badPath })
  expect(unverified.structuredContent).toMatchObject({
    result: { path: badPath, bytes: 3, verified: false }
  })
  expect(await readFile(badPath, 'utf8')).toBe('xyz')

  const collisionPath = join(profile, 'collision.md')
  const concurrent = await Promise.all(
    [1, 2].map(() => call('download_artifact', { ...request, outputPath: collisionPath }))
  )
  expect(concurrent.map((result) => result.structuredContent)).toEqual(
    expect.arrayContaining([
      { result: expect.objectContaining({ path: collisionPath }) },
      { error: expect.objectContaining({ code: 'delivery_target_exists' }) }
    ])
  )
  expect(await readFile(collisionPath, 'utf8')).toBe('xyz')
}, 20000)

it('runs Core package export, import, query and Fork operations through grouped MCP', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-core-package-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const sourcePath = join(profile, 'source.science')
  const exportPath = join(profile, 'exported.science')
  await writeFile(sourcePath, 'source package')
  let latest: Record<string, unknown> | undefined
  const agent = await resourceAgents(
    async (request, response) => {
      if (request.url !== '/rpc/sessions%3Apackage-operation') {
        response.writeHead(404).end(JSON.stringify({ error: { code: 'not_found' } }))
        return
      }
      let body = ''
      for await (const chunk of request) body += chunk
      const [input] = JSON.parse(body).args
      if (input.action === 'agent-export') {
        await writeFile(input.destinationPath, 'science')
        latest = {
          id: '11111111-1111-4111-8111-111111111111',
          kind: 'export',
          state: 'succeeded',
          agent: { correlationId: input.correlationId, destinationPath: input.destinationPath },
          session: { projectId: 'p1', sessionId: 's1' },
          result: {
            filePath: input.destinationPath,
            fileDigest: {
              sizeBytes: 7,
              checksum: '790fad4744a9da8d301e23c83b386f1baabd229611dbe5265df62a97b5357393'
            }
          }
        }
      } else if (input.action === 'agent-import') {
        latest = {
          id: '22222222-2222-4222-8222-222222222222',
          kind: 'import',
          state: 'succeeded',
          agent: { correlationId: input.correlationId, sourcePath: input.sourcePath },
          importTarget: { projectId: 'p2' },
          result: { imported: { projectId: 'p2', sessionId: 's2' }, packageSummary: { files: 1 } }
        }
      } else if (input.action === 'agent-fork') {
        latest = {
          id: '33333333-3333-4333-8333-333333333333',
          kind: 'fork',
          state: 'succeeded',
          agent: { correlationId: input.correlationId },
          session: { projectId: 'p2', sessionId: 's2' },
          result: { imported: { projectId: 'p2', sessionId: 's3' } }
        }
      } else if (input.action !== 'snapshot') {
        response.writeHead(400).end(JSON.stringify({ error: { code: 'invalid_request' } }))
        return
      }
      response.end(JSON.stringify({ ok: true, result: latest }))
    },
    ['agent-package-operations', 'agent-package-import', 'agent-package-fork']
  )
  const core = await connectMcp(agent.profile, undefined, cli, 'core')
  const exported = await core.callTool({
    name: 'export_session',
    arguments: { projectId: 'p1', sessionId: 's1', destinationPath: exportPath, waitMs: 1000 }
  })
  expect(exported.structuredContent).toMatchObject({
    result: { completionStatus: 'completed', delivery: { status: 'verified' } }
  })
  const imported = await core.callTool({
    name: 'import_session',
    arguments: { sourcePath, targetProjectId: 'p2', waitMs: 1000 }
  })
  expect(imported.structuredContent).toMatchObject({
    result: {
      completionStatus: 'completed',
      session: { projectId: 'p2', sessionId: 's2', readOnly: true }
    }
  })
  const forked = await core.callTool({
    name: 'fork_session',
    arguments: { projectId: 'p2', sessionId: 's2', waitMs: 1000 }
  })
  expect(forked.structuredContent).toMatchObject({
    result: {
      completionStatus: 'completed',
      session: { projectId: 'p2', sessionId: 's3', readOnly: false }
    }
  })
  const operation = await core.callTool({
    name: 'get_package_operation',
    arguments: { operationId: '33333333-3333-4333-8333-333333333333' }
  })
  expect(operation.structuredContent).toMatchObject({
    result: {
      completionStatus: 'completed',
      session: { projectId: 'p2', sessionId: 's3', readOnly: false }
    }
  })
})

it.each(['EOF', 'SIGTERM', 'SIGINT'] as const)(
  'terminates on %s without writing non-protocol stdout',
  async (event) => {
    const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-exit-'))
    cleanup.push(() => rm(profile, { recursive: true, force: true }))
    const probing = Promise.withResolvers<void>()
    const owner = createServer(() => probing.resolve()) // Hold the owner probe open until disconnect.
    owner.listen(0, '127.0.0.1')
    await once(owner, 'listening')
    cleanup.push(async () => {
      owner.closeAllConnections()
      await new Promise<void>((done) => owner.close(() => done()))
    })
    await writeFile(join(profile, 'web-token'), 'test')
    await writeFile(
      join(profile, 'runtime-owner.json'),
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        port: (owner.address() as { port: number }).port,
        host: 'node',
        generation: 'mcp-exit'
      })
    )
    const child = spawn(
      process.execPath,
      [resolve('packages/open-science/cli.mjs'), 'mcp', '--profile', profile],
      { stdio: 'pipe' }
    )
    cleanup.push(async () => {
      if (child.exitCode === null) child.kill()
    })
    let output = ''
    child.stdout.on('data', (data) => {
      output += data.toString()
    })
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' }
        }
      }) + '\n'
    )
    await once(child.stdout, 'data')
    expect(JSON.parse(output).result.serverInfo.name).toBe('open-science')
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
    await probing.promise
    // The owner probe normally waits five seconds. Closing the adapter must interrupt it.
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(3000) })
    if (event === 'EOF') child.stdin.end()
    else child.kill(event)
    const [code, signal] = await exited
    // Windows kill() forcibly terminates the process without invoking signal handlers.
    const forced = process.platform === 'win32' && event !== 'EOF'
    expect(code).toBe(forced ? null : 0)
    expect(signal).toBe(forced ? event : null)
    expect(
      output
        .trim()
        .split('\n')
        .every((line) => JSON.parse(line).jsonrpc === '2.0')
    ).toBe(true)
  },
  10000
)
