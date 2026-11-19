import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it('serves a real stdio run/poll/artifact workflow through authenticated HTTP and keeps runs after close', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'osci-mcp-'))
  cleanup.push(() => rm(profile, { recursive: true, force: true }))
  const requests: Array<{ url: string; method: string; body: unknown }> = []
  const startupRequested = Promise.withResolvers<void>()
  const allowStartup = Promise.withResolvers<void>()
  const token = 'mcp-fixture-secret'
  const run = { id: 'r1', sessionId: 's1', projectId: 'p1', status: 'running' }
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
      res.end('{}')
      return
    }
    const data =
      req.url === '/api/v1/sessions/s1/artifacts' ? [{ id: 'a1', name: 'report.md' }] : run
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
  expect((await client.listTools()).tools).toHaveLength(27)
  const ownerPath = join(profile, 'runtime-owner.json')
  await writeFile(ownerPath, '{}')
  allowStartup.resolve()
  const blocked = await client.callTool({
    name: 'start_run',
    arguments: { projectId: 'p1', prompt: 'Research' }
  })
  expect(blocked.isError).toBe(true)
  expect(blocked.content).toEqual([
    { type: 'text', text: expect.stringContaining('startup_unconfirmed') }
  ])
  expect(requests.some((request) => request.method === 'POST')).toBe(false)
  await rm(ownerPath)
  const started = await client.callTool({
    name: 'start_run',
    arguments: { projectId: 'p1', prompt: 'Research' }
  })
  expect(started.structuredContent).toEqual({ result: run })
  expect(requests.find((request) => request.method === 'POST')).toEqual({
    url: '/api/v1/runs',
    method: 'POST',
    body: { project: 'p1', prompt: 'Research' }
  })
  run.status = 'completed'
  expect(
    (await client.callTool({ name: 'get_run', arguments: { runId: 'r1' } })).structuredContent
  ).toEqual({ result: run })
  expect(
    (await client.callTool({ name: 'list_artifacts', arguments: { sessionId: 's1' } }))
      .structuredContent
  ).toEqual({ result: [{ id: 'a1', name: 'report.md' }] })
  await client.close()
  expect(requests.some((request) => request.url.includes('cancel'))).toBe(false)
  expect(stderr).not.toContain(token)
  expect(http.listening).toBe(true)
}, 15000)

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
