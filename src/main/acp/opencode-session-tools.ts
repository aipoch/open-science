import type { McpServer } from '@agentclientprotocol/sdk'
import { createLogger } from '@aipoch/diagnostics/node'
import { sep } from 'node:path'
import { isRecord } from '../value-guards'
import type { AcpOpenCodeUsageApi } from './backend-generation-owner'

const log = createLogger('acp')

type SessionToolsInput = {
  api: AcpOpenCodeUsageApi
  providerSessionId: string
  cwd: string
  servers: readonly McpServer[]
  notebookDirectory: string
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

/** 在下一轮使用当前专家的 MCP 配置，并为本会话原稿启用逐次目录检查。 */
export const prepareOpenCodeSessionTools = async (input: SessionToolsInput): Promise<boolean> => {
  const request = async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    const url = new URL(path, input.api.baseUrl)
    url.searchParams.set('directory', input.cwd)
    const timeout = AbortSignal.timeout(35_000)
    const response = await fetch(url, {
      method,
      headers: { authorization: input.api.authorization, 'content-type': 'application/json' },
      redirect: 'error',
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!response.ok)
      throw new Error(`OpenCode session configuration failed (HTTP ${response.status}).`)
    return response.json()
  }

  const directoryConfigured = await configureNotebookDirectory(
    request,
    input.providerSessionId,
    input.notebookDirectory
  ).then(
    () => true,
    () => {
      input.signal?.throwIfAborted()
      // 部分旧运行时不支持会话级规则，仍可使用 Notebook 完成工作。
      log.warn('OpenCode Notebook directory permission unavailable', {
        sessionId: input.providerSessionId
      })
      return false
    }
  )

  // 1.x 的 ACP resume 可能沿用已缓存的注册记录。用本次会话的配置重新注册，
  // 由正在执行的 OpenCode 进程实际完成 tools/list，再检查该服务的结果。
  const refreshed = await Promise.allSettled(
    input.servers.map(async (server) => {
      if ('type' in server && server.type === 'acp') return true
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
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await request('/mcp', 'POST', { name: server.name, config })
        const status = isRecord(result) ? result[server.name] : undefined
        if (!isRecord(status) || typeof status.status !== 'string') {
          throw new Error(`Invalid OpenCode MCP status for ${server.name}.`)
        }
        if (status.status === 'connected') return true
        if (status.status !== 'failed') break
      }
      return false
    })
  )

  input.signal?.throwIfAborted()
  // 已确认的发现失败只禁用相应服务。原生文件工具仍可继续工作，下轮会再校验。
  const unavailable: string[] = []
  for (const [index, result] of refreshed.entries()) {
    if (result.status === 'rejected') throw result.reason
    if (!result.value) unavailable.push(input.servers[index].name)
  }
  if (unavailable.length) {
    log.warn('OpenCode MCP discovery failed', {
      sessionId: input.providerSessionId,
      servers: unavailable
    })
  }
  return directoryConfigured && unavailable.length === 0
}
