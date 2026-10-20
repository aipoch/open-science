import { spawn } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { expect, it, onTestFinished } from 'vitest'

import { createCodexFramework } from '../agent-framework/codex'
import { terminateProcessTree } from '../process-tree'
import { ensureManagedCodexContextUsage } from './managed-codex'
import { NativeResponsesCompatibilityProxy } from './native-responses-compatibility'
import { clearSystemProxyEnvironment } from './system-proxy'

const adapter = process.env.CODEX_ACP_PATH
const native = process.env.CODEX_NATIVE_PATH
const requiredTools = ['read_turn', 'query_execution_log', 'read_artifact', 'submit_findings']

// This installed-runtime check follows the existing codex-skill-loading test convention.
// Only model responses and MCP startup timing are controlled; native tool discovery is real.
it.runIf(Boolean(adapter && native)).each(['delayed', 'failed', 'timed-out'] as const)(
  'requires Reviewer tools before model requests when MCP tools/list is %s',
  async (startup) => {
    const root = await mkdtemp(join(tmpdir(), 'reviewer-mcp-readiness-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const managedAdapter = join(root, 'adapter.mjs')
    await writeFile(managedAdapter, await readFile(adapter!, 'utf8'))
    await ensureManagedCodexContextUsage(managedAdapter)

    let released = false
    let gateResponse: ServerResponse | undefined
    let releaseTimer: ReturnType<typeof setTimeout> | undefined
    const release = (): void => {
      released = true
      if (releaseTimer) clearTimeout(releaseTimer)
      gateResponse?.end('ready')
    }
    const gate = createServer((_request, response) => {
      gateResponse = response
      // Exceed the native optional-server grace period, but stay below its startup timeout.
      // This delay is a fault injection in the test, never a production readiness heuristic.
      if (startup !== 'timed-out') releaseTimer = setTimeout(release, 4_000)
    })
    await new Promise<void>((resolve) => gate.listen(0, '127.0.0.1', resolve))
    const address = gate.address()
    if (!address || typeof address === 'string') throw new Error('Missing test gate address')
    const mcpEntry = join(root, 'delayed-mcp.mjs')
    await writeFile(
      mcpEntry,
      `import { createInterface } from 'node:readline';
const tools = ${JSON.stringify(requiredTools)}.map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'reviewer-test', version: '1' } };
  if (request.method === 'tools/list') {
    if (${JSON.stringify(startup)} === 'failed') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'reviewer tools/list failed' } }) + '\\n');
      return;
    }
    await fetch('http://127.0.0.1:${address.port}').then(response => response.text());
    result = { tools };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`
    )
    const requests: Array<{ released: boolean; tools: string }> = []
    const upstream: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown }
      const tools = JSON.stringify(body.tools)
      requests.push({ released, tools })
      const text = requiredTools.every((name) => tools.includes(name))
        ? 'REVIEW_TOOLS_READY'
        : 'REVIEW_TOOLS_UNAVAILABLE'
      const events = [
        { type: 'response.created', response: { id: `probe-${requests.length}` } },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            id: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }]
          }
        },
        {
          type: 'response.completed',
          response: {
            id: `probe-${requests.length}`,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
          }
        }
      ]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' }
      })
    }
    const proxy = new NativeResponsesCompatibilityProxy(
      { baseUrl: 'https://reviewer-test.invalid/v1', model: 'probe-native-model' },
      upstream
    )
    const bridge = await proxy.start()
    const framework = createCodexFramework()
    const config = framework.prepareModelConfig(
      {
        type: 'custom',
        apiEndpoints: ['responses'],
        baseUrl: 'https://reviewer-test.invalid/v1',
        model: 'probe-native-model',
        contextWindow: 128_000
      },
      {
        storageRoot: root,
        executablePath: managedAdapter,
        responsesConnection: bridge
      }
    )
    for (const file of config.configFiles ?? []) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.content)
    }
    const env = { ...process.env, ...config.env, CODEX_PATH: native! }
    clearSystemProxyEnvironment(env)
    Object.assign(env, { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' })
    const child = spawn(process.execPath, [managedAdapter], {
      cwd: workspace,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stderr: string[] = []
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
    onTestFinished(async () => {
      release()
      await terminateProcessTree(child)
      await proxy.close()
      gate.closeAllConnections()
      await new Promise<void>((resolve) => gate.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    })
    const run = acp
      .client({ name: 'reviewer-readiness-test' })
      .connectWith(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
        ),
        async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo: { name: 'reviewer-readiness-test', version: '1' },
            clientCapabilities: {}
          })
          await ctx.request(acp.methods.agent.providers.set, config.providerConfiguration!)
          await ctx
            .buildSession({
              cwd: workspace,
              mcpServers: [
                {
                  name: 'open-science-reviewer',
                  command: process.execPath,
                  args: [mcpEntry],
                  env: []
                }
              ]
            })
            .withSession(async (session) => {
              for (const text of [
                'Read the turn and submit findings.',
                'Your previous turn ended without calling submit_findings. Retry using the Reviewer tools.'
              ]) {
                const prompt = session.prompt({ type: 'text', text })
                void prompt.catch(() => undefined)
                while ((await session.nextUpdate()).kind !== 'stop') {
                  /* Drain notifications. */
                }
                await prompt
              }
            })
        }
      )
    if (startup !== 'delayed') {
      const failure = await run.then(
        () => null,
        (error: unknown) => error
      )
      expect(failure).toBeInstanceOf(Error)
      expect(JSON.stringify(failure)).toContain('open-science-reviewer')
      expect(JSON.stringify(failure)).toMatch(
        startup === 'failed' ? /reviewer tools\/list failed/ : /timed out|timeout/i
      )
      expect(requests).toHaveLength(0)
      return
    }
    await run
    expect(requests, stderr.join('')).toHaveLength(2)
    expect(
      requests.map((request) => ({
        startupReady: request.released,
        missingTools: requiredTools.filter((name) => !request.tools.includes(name))
      }))
    ).toEqual([
      { startupReady: true, missingTools: [] },
      { startupReady: true, missingTools: [] }
    ])
  },
  90_000
)
