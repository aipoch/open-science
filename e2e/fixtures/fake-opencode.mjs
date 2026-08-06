/* eslint-disable @typescript-eslint/explicit-function-return-type */

import * as acp from '@agentclientprotocol/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Readable, Writable } from 'node:stream'

const VERSION = '1.0.0'
const PERMISSION_PROMPT = 'Request fixture permission.'
const PROVIDER_BRIDGE_PROMPT = 'Verify the provider bridge.'
const NOTEBOOK_LIFECYCLE_PROMPT = 'Verify the notebook lifecycle.'
const ARTIFACT_PROVENANCE_PROMPT = 'Create a provenance artifact.'

const sessionRoutes = new Map()

const stringEnvironment = (overrides = []) => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined)
  )
  for (const entry of overrides) environment[entry.name] = entry.value
  return environment
}

const toolResult = (name, result) => {
  const text = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  if (result.isError) throw new Error(`${name} failed: ${text}`)
  return JSON.parse(text)
}

const frameworkServerName = (name) => name.replaceAll('-', '_')

const withMcpClient = async (sessionId, serverName, operation) => {
  const route = sessionRoutes.get(sessionId)
  const server = route?.mcpServers?.find(
    (candidate) =>
      candidate.name === serverName || candidate.name === frameworkServerName(serverName)
  )
  if (!route || !server?.command) {
    const routed = route?.mcpServers?.map((candidate) => candidate.name).join(', ') || 'none'
    throw new Error(`${serverName} was not routed to ${sessionId}; routed servers: ${routed}.`)
  }

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    cwd: route.cwd,
    env: stringEnvironment(server.env)
  })
  const client = new Client({ name: 'open-science-e2e-agent', version: VERSION })
  await client.connect(transport)
  try {
    return await operation(client)
  } finally {
    await client.close()
  }
}

const verifyProviderBridge = () => {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}')
  const providers = Object.values(config.provider ?? {})
  const route = providers.find((provider) => provider?.models?.['e2e-model'])
  const credentialName = route?.options?.apiKey?.match(/^\{env:([^}]+)\}$/)?.[1]
  const credential = credentialName ? process.env[credentialName] : undefined
  if (!route?.options?.baseURL || !credential)
    throw new Error('The persisted provider route did not reach the Agent process.')
  const direct = route.options.baseURL === 'http://127.0.0.1:9/v1' && credential === 'e2e-key'
  const url = new URL(route.options.baseURL)
  const bridged = url.hostname === '127.0.0.1' && url.pathname === '/v1' && url.port !== '9'
  if (!direct && !bridged)
    throw new Error(
      `The persisted provider route did not reach the Agent process ` +
        `(base URL: ${route.options.baseURL}, credential: present).`
    )
  return 'Provider bridge verified through the Agent process.'
}

const verifyNotebookLifecycle = async (sessionId) =>
  withMcpClient(sessionId, 'open-science-notebook', async (client) => {
    const initial = toolResult(
      'notebook_state',
      await client.callTool({ name: 'notebook_state', arguments: {} })
    )
    const execution = toolResult(
      'bash_execute',
      await client.callTool({
        name: 'bash_execute',
        arguments: { command: 'node -e "console.log(\'notebook-lifecycle-e2e\')"' }
      })
    )
    const after = toolResult(
      'notebook_state',
      await client.callTool({ name: 'notebook_state', arguments: {} })
    )
    const shutdown = toolResult(
      'notebook_shutdown',
      await client.callTool({ name: 'notebook_shutdown', arguments: {} })
    )
    if (
      initial.sessionId !== after.sessionId ||
      !execution.stdout?.includes('notebook-lifecycle-e2e') ||
      shutdown.status !== 'shutdown'
    ) {
      throw new Error('The Notebook lifecycle did not preserve its session and output.')
    }
    return `Notebook lifecycle verified for ${initial.sessionId}.`
  })

const createProvenanceArtifact = async (sessionId) => {
  const execution = await withMcpClient(sessionId, 'open-science-notebook', async (client) =>
    toolResult(
      'notebook_execute',
      await client.callTool({
        name: 'notebook_execute',
        arguments: { code: "print('artifact-provenance-e2e')", language: 'python' }
      })
    )
  )
  const stored = await withMcpClient(sessionId, 'open-science-artifacts', async (client) =>
    toolResult(
      'write_artifact_file',
      await client.callTool({
        name: 'write_artifact_file',
        arguments: {
          filename: 'provenance-evidence.txt',
          mimeType: 'text/plain',
          content: 'artifact provenance e2e',
          encoding: 'utf8',
          producerRunId: execution.runId
        }
      })
    )
  )
  if (!stored.artifact?.version_id || stored.artifact.producer_run_id !== execution.runId) {
    throw new Error('The artifact Version did not retain its Notebook producer run.')
  }
  return `Artifact provenance verified for session ${sessionId}, artifact ${stored.artifact.artifact_id}, version ${stored.artifact.version_id}.`
}

if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`)
} else {
  let nextMessageId = 1
  let nextSessionId = 1

  const app = acp
    .agent({ name: 'open-science-e2e-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {}, resume: {} }
      },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.authenticate, () => ({}))
    .onRequest(acp.methods.agent.session.new, (context) => {
      const sessionId = `e2e-session-${nextSessionId++}`
      sessionRoutes.set(sessionId, {
        cwd: context.params.cwd,
        mcpServers: context.params.mcpServers ?? []
      })
      return { sessionId }
    })
    .onRequest(acp.methods.agent.session.resume, (context) => {
      sessionRoutes.set(context.params.sessionId, {
        cwd: context.params.cwd,
        mcpServers: context.params.mcpServers ?? []
      })
      return {}
    })
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
      const prompt = context.params.prompt
        .map((content) => (content.type === 'text' ? content.text : ''))
        .join('')

      let reply = 'Deterministic reply: Summarize the deterministic fixture.'
      try {
        if (prompt.includes(PROVIDER_BRIDGE_PROMPT)) {
          reply = verifyProviderBridge()
        } else if (prompt.includes(NOTEBOOK_LIFECYCLE_PROMPT)) {
          reply = await verifyNotebookLifecycle(context.params.sessionId)
        } else if (prompt.includes(ARTIFACT_PROVENANCE_PROMPT)) {
          reply = await createProvenanceArtifact(context.params.sessionId)
        } else if (prompt.includes(PERMISSION_PROMPT)) {
          const permission = await context.client.request(
            acp.methods.client.session.requestPermission,
            {
              sessionId: context.params.sessionId,
              toolCall: {
                toolCallId: 'e2e-permission-tool',
                title: 'Write fixture output'
              },
              options: [
                { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
                { kind: 'reject_once', name: 'Deny', optionId: 'deny-once' }
              ]
            }
          )
          reply =
            permission.outcome.outcome === 'selected' &&
            permission.outcome.optionId === 'allow-once'
              ? 'Fixture permission allowed.'
              : 'Fixture permission denied.'
        }
      } catch (error) {
        reply = `E2E fixture failure: ${error instanceof Error ? error.message : String(error)}`
      }

      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `e2e-message-${nextMessageId++}`,
          content: { type: 'text', text: reply }
        }
      })

      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, () => undefined)
    .onRequest(acp.methods.agent.session.close, () => ({}))

  const connection = app.connect(
    acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
  )
  await connection.closed
}
