import type {
  ActiveSession,
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse
} from '@agentclientprotocol/sdk'
import { createLogger } from '@aipoch/diagnostics/node'
import { isAbsolute, resolve, sep } from 'node:path'
import { canonicalAppMcpServerName } from '../agent-framework/app-mcp-names'
import { NOTEBOOK_MCP_SERVER_NAME } from '../notebook/mcp-server'
import { isRecord } from '../value-guards'
import type { AcpOpenCodeUsageApi } from './backend-generation-owner'
import { isNotebookDraftFile, type NotebookDraftWrite } from './filesystem'
import type { AcpNotebookConnectionVerifier } from './provider-session-resumer'
import type {
  AcpSessionInteractionScope,
  AcpPromptSessionInteractionScope
} from './session-interaction-owner'
import { isPathInsideWorkspace } from './workspace-path'

const log = createLogger('acp')
const NOTEBOOK_PREPARATION_TIMEOUT_MS = 10_000

type SessionToolsInput = {
  api: AcpOpenCodeUsageApi
  providerSessionId: string
  cwd: string
  notebook: McpServer
  notebookDirectory: string
  checkDirectory: boolean
  checkTools: boolean
  providerRefreshed: boolean
  signal?: AbortSignal
}

const configureNotebookDirectory = async (
  request: (path: string, method?: string, body?: unknown) => Promise<unknown>,
  providerSessionId: string,
  notebookDirectory: string
): Promise<void> => {
  // OpenCode 的路径规则支持通配符。无法精确表示的目录仍通过 Notebook 工具访问。
  const directory = notebookDirectory.split(sep).join('/')
  if (/[\\*?]/u.test(directory)) return
  const path = '/session/' + encodeURIComponent(providerSessionId)
  const session = await request(path)
  if (
    !isRecord(session) ||
    session.id !== providerSessionId ||
    (session.permission !== undefined && !Array.isArray(session.permission))
  ) {
    throw new Error('OpenCode returned an invalid session permission list.')
  }
  const rules: unknown[] = session.permission ?? []
  const rule = { permission: 'external_directory', pattern: directory + '/*', action: 'ask' }
  const matches = (item: unknown): boolean =>
    isRecord(item) &&
    item.permission === rule.permission &&
    item.pattern === rule.pattern &&
    item.action === rule.action
  if (!rules.some(matches)) {
    const updated = await request(path, 'PATCH', { permission: [...rules, rule] })
    if (
      !isRecord(updated) ||
      !Array.isArray(updated.permission) ||
      !updated.permission.some(matches)
    ) {
      throw new Error('OpenCode could not apply the Notebook directory permission.')
    }
  }
}

type OpenCodeNotebookReadiness = { directoryReady: boolean; toolsReady: boolean }

/** 核对 OpenCode 1.x 的 Notebook 工具，并为本会话原稿启用逐次目录检查。 */
const prepareOpenCodeSessionTools = async (
  input: SessionToolsInput
): Promise<OpenCodeNotebookReadiness> => {
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

  let directoryReady = true
  if (input.checkDirectory) {
    try {
      await configureNotebookDirectory(request, input.providerSessionId, input.notebookDirectory)
    } catch {
      input.signal?.throwIfAborted()
      directoryReady = false
      log.warn('OpenCode Notebook directory permission unavailable', {
        sessionId: input.providerSessionId
      })
    }
  }

  const server = input.notebook
  if (!input.checkTools || ('type' in server && server.type === 'acp'))
    return { directoryReady, toolsReady: true }

  const statusFor = (result: unknown): string | undefined => {
    if (isRecord(result)) {
      const status = result[server.name]
      if (status === undefined) return
      if (isRecord(status) && typeof status.status === 'string') return status.status
    }
    throw new Error('OpenCode returned an invalid Notebook MCP status.')
  }

  // 上游已刷新 Notebook 时，复用这次工具发现。未刷新时主动验证，避免复用旧工具列表。
  let status: string | undefined
  if (input.providerRefreshed) {
    try {
      status = statusFor(await request('/mcp'))
    } catch {
      signal.throwIfAborted()
      // 查询失败时，只有重新注册本轮配置才能确认提供方实际使用的连接。
      log.warn('OpenCode Notebook MCP status unavailable', { sessionId: input.providerSessionId })
    }
  }
  if (status === 'connected') return { directoryReady, toolsReady: true }
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
    if (registered === 'connected') return { directoryReady, toolsReady: true }
    if (registered === undefined)
      throw new Error('OpenCode did not report a status for the registered Notebook MCP server.')
    if (registered !== 'failed') break
  }

  // 发现失败时本轮仍可使用原生文件工具，下轮会重新核对 Notebook。
  log.warn('OpenCode Notebook MCP discovery failed', { sessionId: input.providerSessionId })
  return { directoryReady, toolsReady: false }
}

export type OpenCodeNotebookScope = {
  api: AcpOpenCodeUsageApi
  directory: string
  session: ActiveSession
  revision: number
  servers: readonly McpServer[]
  interaction?: AcpSessionInteractionScope
}

type ReadinessCheck = { revision: number; readiness?: OpenCodeNotebookReadiness }

export class AcpOpenCodeNotebook {
  private readonly checks = new WeakMap<ActiveSession, ReadinessCheck>()
  private readonly approvedWrites = new WeakMap<
    AcpPromptSessionInteractionScope,
    Map<string, OpenCodeNotebookScope>
  >()

  constructor(
    private readonly resolveScope: (providerSessionId: string) => OpenCodeNotebookScope | undefined
  ) {}

  invalidate(session: ActiveSession): void {
    this.checks.delete(session)
  }

  readonly verify: AcpNotebookConnectionVerifier = async (input) => {
    const scope = this.resolveScope(input.providerSessionId)
    if (!scope) return
    const cached = this.checks.get(scope.session)
    const previous = cached?.revision === scope.revision ? cached.readiness : undefined
    const checkDirectory = !previous?.directoryReady
    const checkTools = input.providerRefreshed || !previous?.toolsReady
    if (!checkDirectory && !checkTools) return
    const notebook = (input.mcpServers ?? scope.servers).find(
      ({ name }) => canonicalAppMcpServerName(name) === NOTEBOOK_MCP_SERVER_NAME
    )
    if (!notebook) return
    const check: ReadinessCheck = { revision: scope.revision }
    this.checks.set(scope.session, check)
    const readiness = await prepareOpenCodeSessionTools({
      api: scope.api,
      cwd: input.cwd,
      providerSessionId: input.providerSessionId,
      notebook,
      notebookDirectory: scope.directory,
      checkDirectory,
      checkTools,
      providerRefreshed: input.providerRefreshed,
      signal: input.signal ?? scope.interaction?.signal
    })
    input.signal?.throwIfAborted()
    if (this.checks.get(scope.session) !== check || !this.isCurrent(input.providerSessionId, scope))
      throw new Error('OpenCode session changed during tool discovery.')
    check.readiness = readiness
  }

  async requestPermission(
    params: RequestPermissionRequest,
    request: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>
  ): Promise<RequestPermissionResponse> {
    const { rawInput, kind } = params.toolCall
    if (!isRecord(rawInput) || typeof rawInput.filepath !== 'string') return request(params)

    // OpenCode 1.x 依次请求外部目录访问和实际编辑授权。目录授权本身不能批准写入。
    const directoryAccess = kind === 'other' && typeof rawInput.parentDir === 'string'
    const edit = kind === 'edit' && typeof rawInput.diff === 'string'
    if (!directoryAccess && !edit) return request(params)

    const scope = this.resolveScope(params.sessionId)
    const filePath = rawInput.filepath
    if (edit && (!scope || !isPathInsideWorkspace(scope.directory, filePath)))
      return request(params)
    const cancelled = { outcome: { outcome: 'cancelled' as const } }
    if (!scope || !isAbsolute(filePath)) return cancelled
    const canAccess = async (): Promise<boolean> =>
      (await isNotebookDraftFile(scope.directory, filePath)) &&
      this.isCurrent(params.sessionId, scope)
    if (!(await canAccess())) return cancelled
    const options = params.options.filter((option) => option.kind !== 'allow_always')
    const decision = await request({ ...params, options })
    if (decision.outcome.outcome !== 'selected') return decision
    const optionId = decision.outcome.optionId
    if (!options.some((option) => option.optionId === optionId && option.kind === 'allow_once'))
      return decision
    if (!(await canAccess())) return cancelled
    if (edit) {
      const turn = scope.interaction
      if (turn?.kind !== 'prompt' || turn.signal.aborted) return cancelled
      const paths = this.approvedWrites.get(turn) ?? new Map<string, OpenCodeNotebookScope>()
      paths.set(resolve(filePath), scope)
      this.approvedWrites.set(turn, paths)
    }
    return decision
  }

  /** 只兑现本轮对目标原稿的一次编辑授权。 */
  consumeDraftWrite(providerSessionId: string, path: string): NotebookDraftWrite | undefined {
    if (!isAbsolute(path)) return
    const scope = this.resolveScope(providerSessionId)
    const turn = scope?.interaction
    if (!scope || turn?.kind !== 'prompt' || turn.signal.aborted) return
    const paths = this.approvedWrites.get(turn)
    const key = resolve(path)
    const grant = paths?.get(key)
    if (!grant) return
    paths?.delete(key)
    if (!this.isCurrent(providerSessionId, grant)) return undefined
    return { root: grant.directory, signal: turn.signal }
  }

  private isCurrent(providerSessionId: string, scope: OpenCodeNotebookScope): boolean {
    const current = this.resolveScope(providerSessionId)
    return (
      current?.session === scope.session &&
      current.api === scope.api &&
      current.revision === scope.revision &&
      current.directory === scope.directory &&
      current.interaction === scope.interaction &&
      !scope.interaction?.signal.aborted
    )
  }
}
