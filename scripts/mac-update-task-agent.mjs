/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Deterministic provider boundary for signed update acceptance. Notebook, REPL, Shell, sandbox,
// permissions and lifecycle remain the packaged application's real ACP -> MCP implementation.
import * as acp from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'

export const TASK_MARKER = 'MAC_UPDATE_TASK_V1:'
export function taskCode({ kind, active, witness, nonce }) {
  const record = JSON.stringify({ kind, nonce })
  if (kind === 'python')
    return `import json, os, time\nwith open(${JSON.stringify(witness)}, 'w') as output:\n    json.dump(dict(${record.replaceAll('"', "'")}, pid=os.getpid()), output)\n${active ? 'time.sleep(300)' : "print('update-python-witness')"}`
  if (kind === 'repl')
    return `require('node:fs').writeFileSync(${JSON.stringify(witness)}, JSON.stringify({...${record},pid:process.pid})); ${active ? 'await new Promise(resolve => setTimeout(resolve, 300000));' : ''} return {pid:process.pid,nonce:${JSON.stringify(nonce)}};`
  if (kind === 'bash') {
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
    // Builtins produce the witness before a real long-running shell job. No unrelated process is
    // used as a stand-in for the app's sandbox host or REPL.
    return `printf '%s\\n' '${record.slice(0, -1)},"pid":'"$$"'}' > ${quote(witness)}${active ? '; sleep 300' : '; printf update-shell-witness'}`
  }
  throw new Error('Unknown task kind')
}

export function decodeTaskPrompt(text) {
  const matches = [...text.matchAll(/MAC_UPDATE_TASK_V1:([A-Za-z0-9+/=]+)/g)]
  if (!matches.length) throw new Error('No acceptance task request')
  const value = JSON.parse(Buffer.from(matches.at(-1)[1], 'base64').toString('utf8'))
  if (
    !['python', 'repl', 'bash'].includes(value.kind) ||
    typeof value.active !== 'boolean' ||
    typeof value.witness !== 'string' ||
    !value.witness.startsWith('/') ||
    !/^[a-f0-9-]{36}$/.test(value.nonce)
  )
    throw new Error('Invalid acceptance task request')
  return value
}

function resultValue(name, result) {
  const text = result.content
    ?.filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  if (result.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text)
}

export async function executeTask(client, request) {
  const kind = request.kind
  if (kind === 'python') {
    const runtimes = resultValue(
      'list_notebook_runtimes',
      await client.callTool({
        name: 'list_notebook_runtimes',
        arguments: { language: 'python' }
      })
    )
    const runtime = runtimes.runtimes?.find(
      (entry) => entry.language === 'python' && entry.runnable
    )
    if (!runtime)
      throw new Error('No enabled runnable Python; acceptance must configure a real interpreter')
    resultValue(
      'notebook_bind_runtime',
      await client.callTool({
        name: 'notebook_bind_runtime',
        arguments: { language: 'python', runtimeId: runtime.runtimeId }
      })
    )
  }
  const method = { python: 'notebook_execute', repl: 'repl_execute', bash: 'bash_execute' }[kind]
  const source = taskCode(request)
  const result = resultValue(
    method,
    await client.callTool(
      {
        name: method,
        arguments: {
          ...(kind === 'bash' ? { command: source } : { code: source }),
          ...(kind === 'python' ? { language: 'python' } : {}),
          background: request.active,
          timeoutMs: 360000
        }
      },
      undefined,
      { timeout: 420000 }
    )
  )
  if (!result.runId || (!request.active && result.status !== 'completed'))
    throw new Error(`Real task did not reach expected admission: ${JSON.stringify(result)}`)
  return {
    kind,
    active: request.active,
    runId: result.runId,
    status: result.status,
    nonce: request.nonce
  }
}

async function serve() {
  if (process.argv.includes('--version')) {
    process.stdout.write('1.0.0\n')
    return
  }
  const sessions = new Map()
  const app = acp
    .agent({ name: 'mac-update-real-task-driver' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.authenticate, () => ({}))
    .onRequest(acp.methods.agent.session.new, ({ params }) => {
      const sessionId = `mac-update-${randomUUID()}`
      sessions.set(sessionId, params)
      return { sessionId }
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client: host }) => {
      const request = decodeTaskPrompt(
        params.prompt
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
      )
      const fixtureRoot = process.env.OPEN_SCIENCE_MAC_ACCEPTANCE_ROOT
      if (
        !fixtureRoot ||
        [request.witness, request.agentWitness].some((path) => {
          if (typeof path !== 'string') return true
          const offset = relative(fixtureRoot, path)
          return !offset || isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`)
        })
      )
        throw new Error('Task evidence must remain in the explicit disposable acceptance root')
      if (request.agentWitness) {
        if (!request.agentWitness.startsWith('/')) throw new Error('Invalid provider witness path')
        await writeFile(
          request.agentWitness,
          JSON.stringify({ kind: 'provider', nonce: request.nonce, pid: process.pid })
        )
      }
      const route = sessions.get(params.sessionId)
      const server = route?.mcpServers?.find((entry) =>
        ['open-science-notebook', 'open_science_notebook'].includes(entry.name)
      )
      if (!server) throw new Error('The application did not grant its Notebook MCP capability')
      const transport =
        server.type === 'http'
          ? new StreamableHTTPClientTransport(new URL(server.url), {
              requestInit: {
                headers: Object.fromEntries(
                  (server.headers ?? []).map(({ name, value }) => [name, value])
                )
              }
            })
          : new StdioClientTransport({
              command: server.command,
              args: server.args ?? [],
              cwd: route.cwd,
              env: {
                ...process.env,
                ...Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value]))
              }
            })
      const notebook = new Client({ name: 'mac-update-real-task-driver', version: '1.0.0' })
      await notebook.connect(transport)
      try {
        const result = await executeTask(notebook, request)
        await host.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: randomUUID(),
            content: { type: 'text', text: `MAC_UPDATE_TASK_READY:${JSON.stringify(result)}` }
          }
        })
        return { stopReason: 'end_turn' }
      } finally {
        await notebook.close()
      }
    })
    .onNotification(acp.methods.agent.session.cancel, () => {})
    .onRequest(acp.methods.agent.session.close, () => ({}))
  const connection = app.connect(
    acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
  )
  await connection.closed
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await serve()
