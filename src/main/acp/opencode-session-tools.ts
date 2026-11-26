import {
  methods,
  type ActiveSession,
  type ClientConnection,
  type McpServer,
  type SessionNotification
} from '@agentclientprotocol/sdk'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import {
  NOTEBOOK_TOOLS_UNAVAILABLE_CODE,
  NOTEBOOK_TOOLS_UNAVAILABLE_MESSAGE
} from '../../shared/failure/messages'
import { canonicalAppMcpServerName } from '../agent-framework/app-mcp-names'
import { OPENCODE_NOTEBOOK_CHECK_COMMAND } from '../agent-framework/opencode'
import { NOTEBOOK_MCP_SERVER_NAME } from '../notebook/mcp-server'
import { isRecord } from '../value-guards'
import type { AcpOpenCodeUsageApi } from './backend-generation-owner'
import type { AcpNotebookConnectionVerifier } from './provider-session-resumer'
import type { AcpSessionInteractionScope } from './session-interaction-owner'

const log = createLogger('acp')
const NOTEBOOK_PREPARATION_TIMEOUT_MS = 10_000

type SessionToolsInput = {
  api: AcpOpenCodeUsageApi
  providerSessionId: string
  cwd: string
  notebook: McpServer
  providerRefreshed: boolean
  signal?: AbortSignal
}

const prepareOpenCodeSessionTools = async (input: SessionToolsInput): Promise<void> => {
  const timeout = AbortSignal.timeout(NOTEBOOK_PREPARATION_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  const request = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    const url = new URL(path, input.api.baseUrl)
    url.searchParams.set('directory', input.cwd)
    const response = await fetch(url, {
      method,
      headers: { authorization: input.api.authorization, 'content-type': 'application/json' },
      redirect: 'error',
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!response.ok)
      throw new Error(`OpenCode session configuration failed (HTTP ${response.status}).`)
    return response.json()
  }

  const server = input.notebook
  if ('type' in server && server.type === 'acp') return

  const statusFor = (result: unknown): string | undefined => {
    if (isRecord(result)) {
      const status = result[server.name]
      if (status === undefined) return
      if (isRecord(status) && typeof status.status === 'string') return status.status
    }
    throw new Error('OpenCode returned an invalid Notebook MCP status.')
  }

  // Reuse the discovery result when the provider has already refreshed the Notebook connection.
  let status: string | undefined
  if (input.providerRefreshed) {
    try {
      status = statusFor(await request('/mcp'))
    } catch {
      signal.throwIfAborted()
      // Register this turn's configuration to verify the connection when the status check fails.
      log.warn('OpenCode Notebook MCP status unavailable', { sessionId: input.providerSessionId })
    }
  }
  if (status === 'connected') return
  const config =
    'type' in server
      ? {
          type: 'remote',
          url: server.url,
          headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value]))
        }
      : {
          type: 'local',
          command: [server.command, ...server.args],
          environment: Object.fromEntries(server.env.map(({ name, value }) => [name, value]))
        }
  const attempts = status === 'failed' ? 1 : 2
  for (let attempt = 0; attempt < attempts; attempt++) {
    const registered = statusFor(await request('/mcp', 'POST', { name: server.name, config }))
    if (registered === 'connected') return
    if (registered === undefined)
      throw new Error('OpenCode did not report a status for the registered Notebook MCP server.')
    if (registered !== 'failed') break
  }

  throw new Error('OpenCode Notebook MCP discovery did not become ready.')
}

export type OpenCodeNotebookScope = {
  api: AcpOpenCodeUsageApi
  connection: ClientConnection
  session: ActiveSession
  revision: number
  servers: readonly McpServer[]
  interaction?: AcpSessionInteractionScope
}

type ReadinessCheck = { revision: number; ready: boolean }

export class AcpOpenCodeNotebook {
  private readonly checks = new WeakMap<ActiveSession, ReadinessCheck>()
  private readonly checkCommands = new WeakMap<ClientConnection, Set<string>>()

  constructor(
    private readonly resolveScope: (providerSessionId: string) => OpenCodeNotebookScope | undefined
  ) {}

  observeCommands(connection: ClientConnection, { sessionId, update }: SessionNotification): void {
    if (update.sessionUpdate !== 'available_commands_update') return
    const sessions = this.checkCommands.get(connection) ?? new Set<string>()
    if (update.availableCommands.some(({ name }) => name === OPENCODE_NOTEBOOK_CHECK_COMMAND))
      sessions.add(sessionId)
    else sessions.delete(sessionId)
    this.checkCommands.set(connection, sessions)
  }

  invalidate(session: ActiveSession): void {
    this.checks.delete(session)
  }

  readonly verify: AcpNotebookConnectionVerifier = async (input) => {
    const scope = this.resolveScope(input.providerSessionId)
    if (!scope) return
    const cached = this.checks.get(scope.session)
    if (!input.providerRefreshed && cached?.revision === scope.revision && cached.ready) return
    const notebook = (input.mcpServers ?? scope.servers).find(
      ({ name }) => canonicalAppMcpServerName(name) === NOTEBOOK_MCP_SERVER_NAME
    )
    const check: ReadinessCheck = { revision: scope.revision, ready: false }
    this.checks.set(scope.session, check)
    const signal = input.signal ?? scope.interaction?.signal
    try {
      if (!notebook) throw new Error('The OpenCode session configuration omits Notebook.')
      if (scope.api.version === 2) {
        // The usage API belongs to a separate server. Check the private ACP tool catalog
        // through its advertised plugin command, which never submits a model prompt.
        if (!this.checkCommands.get(scope.connection)?.has(input.providerSessionId))
          throw new Error('OpenCode did not advertise the Notebook check command.')
        const timeout = AbortSignal.timeout(NOTEBOOK_PREPARATION_TIMEOUT_MS)
        const response = await scope.connection.agent.request(
          methods.agent.session.prompt,
          {
            sessionId: input.providerSessionId,
            prompt: [{ type: 'text', text: '/' + OPENCODE_NOTEBOOK_CHECK_COMMAND }]
          },
          { cancellationSignal: signal ? AbortSignal.any([signal, timeout]) : timeout }
        )
        if (response.stopReason !== 'end_turn')
          throw new Error('OpenCode did not complete the Notebook check command.')
      } else {
        await prepareOpenCodeSessionTools({
          api: scope.api,
          cwd: input.cwd,
          providerSessionId: input.providerSessionId,
          notebook,
          providerRefreshed: input.providerRefreshed,
          signal
        })
      }
    } catch (error) {
      signal?.throwIfAborted()
      log.warn('OpenCode Notebook MCP preparation failed', {
        sessionId: input.providerSessionId,
        ...diagnosticErrorFields(error)
      })
      throw Object.assign(new Error(NOTEBOOK_TOOLS_UNAVAILABLE_MESSAGE, { cause: error }), {
        code: NOTEBOOK_TOOLS_UNAVAILABLE_CODE
      })
    }
    signal?.throwIfAborted()
    if (this.checks.get(scope.session) !== check || !this.isCurrent(input.providerSessionId, scope))
      throw new Error('OpenCode session changed during tool discovery.')
    check.ready = true
  }

  private isCurrent(providerSessionId: string, scope: OpenCodeNotebookScope): boolean {
    const current = this.resolveScope(providerSessionId)
    return (
      current?.session === scope.session &&
      current.api === scope.api &&
      current.connection === scope.connection &&
      current.revision === scope.revision &&
      current.interaction === scope.interaction &&
      !scope.interaction?.signal.aborted
    )
  }
}
