import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'

import type { CodexSubscriptionTransport } from '../../shared/settings'
import { codexSubscriptionStorageDir } from '../agent-framework/codex'
import { terminateProcessTree } from '../process-tree'
import { augmentedPathEnv } from './shell-path'
import { clearSystemProxyEnvironment, type SystemProxyEnvironment } from './system-proxy'

export type CodexAuthMode = 'shared' | 'isolated'

export type CodexAuthStatus = {
  mode: CodexAuthMode
  supported: boolean
  authenticated: boolean
  message?: string
}

type CodexAuthenticationStatus = {
  type?: 'unauthenticated' | 'api-key' | 'chat-gpt' | 'gateway'
  email?: string
  name?: string
}

export type CodexAuthSession = {
  initialize: () => Promise<{ authMethods?: { id: string }[] }>
  status: () => Promise<CodexAuthenticationStatus>
  authenticateChatGpt: () => Promise<void>
  logout: () => Promise<void>
  close: () => Promise<void>
}

export type CodexAuthLaunch = {
  adapterPath: string
  nativePath?: string
  mode: CodexAuthMode
  storageRoot: string
  transport?: CodexSubscriptionTransport
  proxyEnv?: SystemProxyEnvironment
}

type CodexAuthControllerOptions = {
  openSession: (mode: CodexAuthMode) => Promise<CodexAuthSession>
  loginTimeoutMs?: number
  // Bounds the read-only status check (open + initialize + status). Unlike the browser login this
  // never waits on a human, so a much shorter deadline keeps a stalled adapter from hanging save/test
  // indefinitely.
  statusTimeoutMs?: number
}

const CODEX_ENV_KEYS = [
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_CONFIG',
  'CODEX_HOME',
  'CODEX_PATH',
  'MODEL_PROVIDER',
  'DEFAULT_AUTH_REQUEST',
  'NO_BROWSER'
] as const

type ImportedCodexProviderRoute = {
  id: string
  name: string
  baseUrl: string
  supportsWebsockets?: boolean
}

type TomlScalar = string | boolean

const parseTomlString = (literal: string): string | undefined => {
  const trimmed = literal.trim()

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return typeof parsed === 'string' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1)
  return undefined
}

const parseTomlKey = (literal: string): string | undefined =>
  /^[A-Za-z0-9_-]+$/.test(literal) ? literal : parseTomlString(literal)

const parseTomlAssignmentKey = (line: string): string | undefined => {
  const match = line.match(/^\s*("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.|\s*=)/)
  return match ? parseTomlKey(match[1]) : undefined
}

const parseTomlScalarAssignment = (
  line: string
): { key: string; value: TomlScalar } | undefined => {
  const stringMatch = line.match(
    /^\s*("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/
  )
  if (stringMatch) {
    const key = parseTomlKey(stringMatch[1])
    const value = parseTomlString(stringMatch[2])
    return key === undefined || value === undefined ? undefined : { key, value }
  }

  const booleanMatch = line.match(
    /^\s*("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(true|false)\s*(?:#.*)?$/
  )
  if (!booleanMatch) return undefined

  const key = parseTomlKey(booleanMatch[1])
  return key === undefined ? undefined : { key, value: booleanMatch[2] === 'true' }
}

const parseModelProviderTableId = (line: string): string | undefined => {
  const match = line.match(
    /^\s*\[\s*(?:model_providers|"model_providers"|'model_providers')\s*\.\s*("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)\s*\]\s*(?:#.*)?$/
  )
  if (!match) return undefined

  const key = match[1]
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : parseTomlString(key)
}

const parseModelProviderTableRootId = (line: string): string | undefined => {
  const match = line.match(
    /^\s*\[\s*(?:model_providers|"model_providers"|'model_providers')\s*\.\s*("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.|\s*\])/
  )
  if (!match) return undefined

  const key = match[1]
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : parseTomlString(key)
}

const isModelProviderAssignment = (line: string): boolean =>
  /^\s*(?:model_provider|"model_provider"|'model_provider')\s*=/.test(line)

const isLoopbackHostname = (hostname: string): boolean => {
  const unwrappedHostname =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (unwrappedHostname === 'localhost') return true

  const ipVersion = isIP(unwrappedHostname)
  return ipVersion === 4
    ? unwrappedHostname.startsWith('127.')
    : ipVersion === 6 && unwrappedHostname === '::1'
}

// These provider fields can carry credentials or make the route depend on values that the isolated
// profile deliberately does not copy. Reject the whole route instead of persisting a sanitized but
// unusable endpoint. Scalar retry/timing options remain safe to omit.
const UNSAFE_IMPORTED_ROUTE_KEYS = new Set([
  'env_key',
  'experimental_bearer_token',
  'http_headers',
  'env_http_headers',
  'query_params'
])

// Import only the active provider's non-secret route. This preserves a working local Codex network
// path (for example a loopback proxy endpoint) without copying models, MCP servers, hooks,
// headers, bearer tokens, or any other user configuration into the app-owned profile.
const extractCodexProviderRoute = (configToml: string): ImportedCodexProviderRoute | undefined => {
  const lines = configToml.split(/\r?\n/)
  let activeProviderId: string | undefined

  for (const line of lines) {
    if (/^\s*\[/.test(line)) break
    const assignment = parseTomlScalarAssignment(line)
    if (assignment?.key === 'model_provider' && typeof assignment.value === 'string') {
      activeProviderId = assignment.value
      break
    }
  }

  if (!activeProviderId || activeProviderId.length > 128) return undefined

  let inActiveProviderTable = false
  let name: string | undefined
  let baseUrl: string | undefined
  let wireApi: string | undefined
  let requiresOpenAiAuth: boolean | undefined
  let supportsWebsockets: boolean | undefined

  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      const providerTableId = parseModelProviderTableId(line)
      const providerTableRootId = parseModelProviderTableRootId(line)
      // Nested provider tables are not serialized into the app-owned profile and commonly carry
      // headers/query parameters. Treat any nested dependency on the active route as incompatible.
      if (providerTableRootId === activeProviderId && providerTableId !== activeProviderId) {
        return undefined
      }
      inActiveProviderTable = providerTableId === activeProviderId
      continue
    }
    if (!inActiveProviderTable) continue

    const assignmentKey = parseTomlAssignmentKey(line)
    if (assignmentKey && UNSAFE_IMPORTED_ROUTE_KEYS.has(assignmentKey)) return undefined

    const assignment = parseTomlScalarAssignment(line)
    if (!assignment) continue

    if (assignment.key === 'name' && typeof assignment.value === 'string') {
      name = assignment.value
    } else if (assignment.key === 'base_url' && typeof assignment.value === 'string') {
      baseUrl = assignment.value
    } else if (assignment.key === 'wire_api' && typeof assignment.value === 'string') {
      wireApi = assignment.value
    } else if (assignment.key === 'requires_openai_auth' && typeof assignment.value === 'boolean') {
      requiresOpenAiAuth = assignment.value
    } else if (assignment.key === 'supports_websockets' && typeof assignment.value === 'boolean') {
      supportsWebsockets = assignment.value
    }
  }

  if (!baseUrl || wireApi !== 'responses' || requiresOpenAiAuth !== true) return undefined

  // WHATWG URL normalizes an empty trailing query or fragment away, so inspect the raw value as
  // well. Imported routes never need either delimiter, even when no query/hash content follows it.
  if (baseUrl.includes('?') || baseUrl.includes('#')) return undefined

  try {
    const url = new URL(baseUrl)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !isLoopbackHostname(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return undefined
    }
  } catch {
    return undefined
  }

  return {
    id: activeProviderId,
    name: name?.trim() || activeProviderId,
    baseUrl,
    ...(supportsWebsockets === undefined ? {} : { supportsWebsockets })
  }
}

const serializeLegacyCodexProviderRoute = (route: ImportedCodexProviderRoute): string =>
  [
    `model_provider = ${JSON.stringify(route.id)}`,
    '',
    `[model_providers.${JSON.stringify(route.id)}]`,
    `name = ${JSON.stringify(route.name)}`,
    `base_url = ${JSON.stringify(route.baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    ...(route.supportsWebsockets === undefined
      ? []
      : [`supports_websockets = ${String(route.supportsWebsockets)}`]),
    ''
  ].join('\n')

export const projectSafeCodexProviderRoute = (configToml: string): string | undefined => {
  const route = extractCodexProviderRoute(configToml)
  return route ? serializeLegacyCodexProviderRoute(route) : undefined
}

const IMPORTED_ROUTE_SELECTION_BEGIN = '# Open Science: begin imported Codex route selection'
const IMPORTED_ROUTE_SELECTION_END = '# Open Science: end imported Codex route selection'
const IMPORTED_ROUTE_PROVIDER_BEGIN = '# Open Science: begin imported Codex provider'
const IMPORTED_ROUTE_PROVIDER_END = '# Open Science: end imported Codex provider'
const IMPORTED_ROUTE_PRESERVED_LINE = '# Open Science: preserved Codex config '
const CODEX_FILE_CREDENTIAL_STORE = 'cli_auth_credentials_store = "file"'
const TRANSPORT_ROUTE_SELECTION_BEGIN = '# Open Science: begin Codex transport route selection'
const TRANSPORT_ROUTE_SELECTION_END = '# Open Science: end Codex transport route selection'
const TRANSPORT_ROUTE_PROVIDER_BEGIN = '# Open Science: begin Codex transport provider'
const TRANSPORT_ROUTE_PROVIDER_END = '# Open Science: end Codex transport provider'
const CODEX_TRANSPORT_PROVIDER_IDS = [
  'open-science-chatgpt-https',
  'open-science-chatgpt-websocket'
] as const

export const resolveEffectiveCodexSubscriptionTransport = (provider: {
  codexTransport?: CodexSubscriptionTransport
  codexAutoUseHttps?: boolean
}): CodexSubscriptionTransport => {
  const preference = provider.codexTransport ?? 'auto'
  return preference === 'auto' && provider.codexAutoUseHttps === true ? 'https' : preference
}

const isCodexCredentialStoreAssignment = (line: string): boolean =>
  /^\s*(?:cli_auth_credentials_store|"cli_auth_credentials_store"|'cli_auth_credentials_store')\s*=/.test(
    line
  )

// CODEX_HOME isolates file-backed auth.json, but the default/auto store can still select the
// process-wide OS keyring. Pin subscription profiles to file storage so status, login, and logout
// cannot observe or mutate the user's global Codex CLI credential.
const serializeCodexFileCredentialStore = (existingConfigToml: string): string => {
  const lines = existingConfigToml.split(/\r?\n/)
  const result: string[] = []
  let inTopLevel = true

  for (const line of lines) {
    if (/^\s*\[/.test(line)) inTopLevel = false
    if (inTopLevel && isCodexCredentialStoreAssignment(line)) continue
    result.push(line)
  }

  while (result.at(-1) === '') result.pop()
  const firstOwnedMarkerIndex = result.findIndex(
    (line) =>
      line === IMPORTED_ROUTE_SELECTION_BEGIN ||
      line === IMPORTED_ROUTE_PROVIDER_BEGIN ||
      line === TRANSPORT_ROUTE_SELECTION_BEGIN ||
      line === TRANSPORT_ROUTE_PROVIDER_BEGIN
  )
  const firstTableIndex = result.findIndex((line) => /^\s*\[/.test(line))
  const insertionCandidates = [firstOwnedMarkerIndex, firstTableIndex].filter((index) => index >= 0)
  const insertionIndex =
    insertionCandidates.length > 0 ? Math.min(...insertionCandidates) : result.length
  result.splice(insertionIndex, 0, CODEX_FILE_CREDENTIAL_STORE)
  result.push('')

  return result.join('\n')
}

const restoreCompleteMarkedBlock = (lines: string[], begin: string, end: string): string[] => {
  const result = [...lines]
  let beginIndex = result.indexOf(begin)

  while (beginIndex >= 0) {
    const relativeEndIndex = result.slice(beginIndex + 1).indexOf(end)
    if (relativeEndIndex < 0) break

    const endIndex = beginIndex + relativeEndIndex + 1
    const preservedLines = result.slice(beginIndex + 1, endIndex).flatMap((line) => {
      if (!line.startsWith(IMPORTED_ROUTE_PRESERVED_LINE)) return []
      try {
        const preservedLine = JSON.parse(
          line.slice(IMPORTED_ROUTE_PRESERVED_LINE.length)
        ) as unknown
        return typeof preservedLine === 'string' ? [preservedLine] : []
      } catch {
        return []
      }
    })
    result.splice(beginIndex, relativeEndIndex + 2, ...preservedLines)
    beginIndex = result.indexOf(begin)
  }

  return result
}

const hasCompleteMarkedBlock = (lines: string[], begin: string, end: string): boolean => {
  const beginIndex = lines.indexOf(begin)
  return beginIndex >= 0 && lines.slice(beginIndex + 1).includes(end)
}

const isOwnedTransportProviderId = (value: unknown): boolean =>
  typeof value === 'string' &&
  CODEX_TRANSPORT_PROVIDER_IDS.includes(value as (typeof CODEX_TRANSPORT_PROVIDER_IDS)[number])

// Builds before the transport selector used an unmarked HTTPS provider. Its reserved app-owned id
// makes that exact selection/table safe to migrate without touching user-authored provider routes.
const removeLegacyCodexTransportRoute = (lines: string[]): string[] => {
  const result: string[] = []
  let inTopLevel = true
  let inOwnedProviderTable = false

  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inTopLevel = false
      inOwnedProviderTable = isOwnedTransportProviderId(parseModelProviderTableRootId(line))
      if (inOwnedProviderTable) continue
    } else if (inOwnedProviderTable) {
      continue
    }

    const assignment = inTopLevel ? parseTomlScalarAssignment(line) : undefined
    if (assignment?.key === 'model_provider' && isOwnedTransportProviderId(assignment.value)) {
      continue
    }
    result.push(line)
  }
  return result
}

const removeCodexTransportRoute = (configToml: string): string =>
  removeLegacyCodexTransportRoute(
    restoreCompleteMarkedBlock(
      restoreCompleteMarkedBlock(
        configToml.split(/\r?\n/),
        TRANSPORT_ROUTE_SELECTION_BEGIN,
        TRANSPORT_ROUTE_SELECTION_END
      ),
      TRANSPORT_ROUTE_PROVIDER_BEGIN,
      TRANSPORT_ROUTE_PROVIDER_END
    )
  ).join('\n')

// Imported routes are explicit user configuration and may describe a loopback gateway. They always
// take precedence over this ChatGPT transport preference.
const serializeCodexSubscriptionTransport = (
  existingConfigToml: string,
  transport: CodexSubscriptionTransport
): string => {
  const withoutOwnedRoute = removeCodexTransportRoute(existingConfigToml)
  if (transport === 'auto') return withoutOwnedRoute

  const lines = withoutOwnedRoute.split(/\r?\n/)
  if (
    hasCompleteMarkedBlock(lines, IMPORTED_ROUTE_SELECTION_BEGIN, IMPORTED_ROUTE_SELECTION_END) ||
    hasCompleteMarkedBlock(lines, IMPORTED_ROUTE_PROVIDER_BEGIN, IMPORTED_ROUTE_PROVIDER_END)
  ) {
    return withoutOwnedRoute
  }

  const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line))
  const topLevelEnd = firstTableIndex < 0 ? lines.length : firstTableIndex
  if (
    lines.slice(0, topLevelEnd).some((line) => parseTomlAssignmentKey(line) === 'model_provider')
  ) {
    return withoutOwnedRoute
  }

  while (lines.at(-1) === '') lines.pop()
  const providerId = `open-science-chatgpt-${transport}`
  const selectionIndex = lines.findIndex((line) => /^\s*\[/.test(line))
  lines.splice(
    selectionIndex < 0 ? lines.length : selectionIndex,
    0,
    TRANSPORT_ROUTE_SELECTION_BEGIN,
    `model_provider = ${JSON.stringify(providerId)}`,
    TRANSPORT_ROUTE_SELECTION_END,
    ''
  )
  while (lines.at(-1) === '') lines.pop()
  if (lines.length > 0) lines.push('')
  lines.push(
    TRANSPORT_ROUTE_PROVIDER_BEGIN,
    `[model_providers.${JSON.stringify(providerId)}]`,
    `name = ${JSON.stringify(transport === 'https' ? 'OpenAI HTTPS' : 'OpenAI WebSocket')}`,
    'base_url = "https://chatgpt.com/backend-api/codex"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    `supports_websockets = ${String(transport === 'websocket')}`,
    TRANSPORT_ROUTE_PROVIDER_END,
    ''
  )
  return lines.join('\n')
}

const removeImportedCodexProviderRoute = (configToml: string): string => {
  const lines = configToml.split(/\r?\n/)
  const hasMarkedRoute =
    hasCompleteMarkedBlock(lines, IMPORTED_ROUTE_SELECTION_BEGIN, IMPORTED_ROUTE_SELECTION_END) ||
    hasCompleteMarkedBlock(lines, IMPORTED_ROUTE_PROVIDER_BEGIN, IMPORTED_ROUTE_PROVIDER_END)
  const withoutMarkedBlocks = restoreCompleteMarkedBlock(
    restoreCompleteMarkedBlock(lines, IMPORTED_ROUTE_SELECTION_BEGIN, IMPORTED_ROUTE_SELECTION_END),
    IMPORTED_ROUTE_PROVIDER_BEGIN,
    IMPORTED_ROUTE_PROVIDER_END
  ).join('\n')

  // Builds produced before route markers wrote only the sanitized route. Recognize that exact shape
  // so switching modes can clean it up without ever treating a mixed, user-authored config as ours.
  const legacyRoute = hasMarkedRoute ? undefined : extractCodexProviderRoute(withoutMarkedBlocks)
  if (
    legacyRoute &&
    withoutMarkedBlocks.trim() === serializeLegacyCodexProviderRoute(legacyRoute).trim()
  ) {
    return ''
  }

  return withoutMarkedBlocks
}

const removeConflictingCodexProviderRoute = (
  lines: string[],
  providerId: string
): { lines: string[]; selection: string[]; provider: string[] } => {
  const result: string[] = []
  const selection: string[] = []
  const provider: string[] = []
  let inTopLevel = true
  let inConflictingProviderTable = false

  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inTopLevel = false
      inConflictingProviderTable = parseModelProviderTableRootId(line) === providerId
      if (inConflictingProviderTable) {
        provider.push(line)
        continue
      }
    } else if (inConflictingProviderTable) {
      provider.push(line)
      continue
    }

    if (inTopLevel && isModelProviderAssignment(line)) {
      selection.push(line)
      continue
    }
    result.push(line)
  }

  return { lines: result, selection, provider }
}

const serializePreservedConfigLines = (lines: string[]): string[] =>
  lines.map((line) => `${IMPORTED_ROUTE_PRESERVED_LINE}${JSON.stringify(line)}`)

const serializeImportedCodexProviderRoute = (
  route: ImportedCodexProviderRoute,
  existingConfigToml: string
): string => {
  const conflictingRoute = removeConflictingCodexProviderRoute(
    removeImportedCodexProviderRoute(existingConfigToml).split(/\r?\n/),
    route.id
  )
  const baseLines = conflictingRoute.lines
  while (baseLines.at(-1) === '') baseLines.pop()

  const firstTableIndex = baseLines.findIndex((line) => /^\s*\[/.test(line))
  const selectionIndex = firstTableIndex < 0 ? baseLines.length : firstTableIndex
  baseLines.splice(
    selectionIndex,
    0,
    IMPORTED_ROUTE_SELECTION_BEGIN,
    ...serializePreservedConfigLines(conflictingRoute.selection),
    `model_provider = ${JSON.stringify(route.id)}`,
    IMPORTED_ROUTE_SELECTION_END
  )
  baseLines.push(
    IMPORTED_ROUTE_PROVIDER_BEGIN,
    ...serializePreservedConfigLines(conflictingRoute.provider),
    `[model_providers.${JSON.stringify(route.id)}]`,
    `name = ${JSON.stringify(route.name)}`,
    `base_url = ${JSON.stringify(route.baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    ...(route.supportsWebsockets === undefined
      ? []
      : [`supports_websockets = ${String(route.supportsWebsockets)}`]),
    IMPORTED_ROUTE_PROVIDER_END,
    ''
  )

  return baseLines.join('\n')
}

const writePrivateFileAtomically = async (
  destinationPath: string,
  content: string
): Promise<void> => {
  const temporaryPath = `${destinationPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, destinationPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

const ensureCodexAuthConfigHome = async (
  codexHome: string,
  transport: CodexSubscriptionTransport
): Promise<void> => {
  const configPath = join(codexHome, 'config.toml')
  await mkdir(codexHome, { recursive: true })

  let existingConfigToml = ''
  try {
    existingConfigToml = await readFile(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const nextConfigToml = serializeCodexFileCredentialStore(
    serializeCodexSubscriptionTransport(existingConfigToml, transport)
  )
  if (nextConfigToml !== existingConfigToml) {
    await writePrivateFileAtomically(configPath, nextConfigToml)
  }
}

export const createCodexAuthEnvironment = (
  _mode: CodexAuthMode,
  storageRoot: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  proxyEnv?: SystemProxyEnvironment
): NodeJS.ProcessEnv => {
  const env = augmentedPathEnv(sourceEnv)
  for (const key of CODEX_ENV_KEYS) delete env[key]
  if (proxyEnv !== undefined) clearSystemProxyEnvironment(env)

  return {
    ...env,
    ...(proxyEnv ?? {}),
    CODEX_HOME: codexSubscriptionStorageDir(storageRoot)
  }
}

// Provider setup imports an existing login plus the safe, non-secret subset of its active provider
// route. Global model defaults, MCP servers, Skills, sessions, memories, hooks, and tokens embedded in
// provider config remain outside Open Science.
export const importCodexAuthentication = async (
  sourceHome: string,
  destinationHome: string
): Promise<void> => {
  const sourcePath = join(sourceHome, 'auth.json')
  const destinationPath = join(destinationHome, 'auth.json')
  const sourceConfigPath = join(sourceHome, 'config.toml')
  const destinationConfigPath = join(destinationHome, 'config.toml')
  let content: string

  try {
    content = await readFile(sourcePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
  } catch {
    throw new Error('The selected Codex profile does not contain importable authentication.')
  }

  let providerRoute: ImportedCodexProviderRoute | undefined
  try {
    providerRoute = extractCodexProviderRoute(await readFile(sourceConfigPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  await mkdir(destinationHome, { recursive: true })
  await writePrivateFileAtomically(destinationPath, content)
  if (providerRoute) {
    let existingConfigToml = ''
    try {
      existingConfigToml = await readFile(destinationConfigPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writePrivateFileAtomically(
      destinationConfigPath,
      serializeImportedCodexProviderRoute(providerRoute, existingConfigToml)
    )
  } else {
    await clearImportedCodexProviderRoute(destinationHome)
  }
  await ensureCodexAuthConfigHome(destinationHome, 'auto')
}

export const clearImportedCodexProviderRoute = async (destinationHome: string): Promise<void> => {
  const destinationConfigPath = join(destinationHome, 'config.toml')
  let existingConfigToml: string

  try {
    existingConfigToml = await readFile(destinationConfigPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  const cleanedConfigToml = removeImportedCodexProviderRoute(existingConfigToml)
  if (cleanedConfigToml === existingConfigToml) return

  if (cleanedConfigToml.trim()) {
    await writePrivateFileAtomically(destinationConfigPath, cleanedConfigToml)
  } else {
    await rm(destinationConfigPath, { force: true })
  }
}

// Switching away from an imported profile must discard the copied credential without invoking
// Codex logout. Logging out a copied token can revoke the same session still used by the user's
// global CLI profile; unlinking only the app-owned copy preserves that external login.
export const clearAppOwnedCodexAuthentication = async (destinationHome: string): Promise<void> => {
  await rm(join(destinationHome, 'auth.json'), { force: true })
}

const abortError = (message: string): Error => {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

const waitForAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError(String(signal.reason ?? 'cancelled')))
      return
    }
    signal.addEventListener(
      'abort',
      () => reject(abortError(String(signal.reason ?? 'cancelled'))),
      { once: true }
    )
  })

const waitForOperation = <Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> =>
  Promise.race([operation, waitForAbort(signal)])

const capabilityFailure = (mode: CodexAuthMode): CodexAuthStatus => ({
  mode,
  supported: false,
  authenticated: false,
  message: 'The installed codex-acp does not advertise ChatGPT authentication.'
})

// Any stored credential counts as authenticated, not just a ChatGPT login: a profile holding an
// API key (or gateway auth) runs fine at runtime, so reporting it as signed out would be a false
// negative that blocks an otherwise working provider.
const isAuthenticated = (status: CodexAuthenticationStatus): boolean =>
  status.type === 'chat-gpt' || status.type === 'api-key' || status.type === 'gateway'

const toPublicStatus = (
  mode: CodexAuthMode,
  supported: boolean,
  status: CodexAuthenticationStatus
): CodexAuthStatus =>
  supported
    ? {
        mode,
        supported: true,
        authenticated: isAuthenticated(status)
      }
    : capabilityFailure(mode)

export class CodexAuthController {
  private readonly openSession: (mode: CodexAuthMode) => Promise<CodexAuthSession>
  private readonly loginTimeoutMs: number
  private readonly statusTimeoutMs: number
  private activeLogin: { abort: AbortController; completion: Promise<void> } | undefined

  constructor(options: CodexAuthControllerOptions) {
    this.openSession = options.openSession
    this.loginTimeoutMs = options.loginTimeoutMs ?? 5 * 60_000
    this.statusTimeoutMs = options.statusTimeoutMs ?? 30_000
  }

  // Runs an adapter interaction against a freshly opened session under a hard deadline, so every
  // status/login/logout round-trip fails closed rather than hanging on a stalled codex-acp. Owns the
  // full lifecycle: open (racing the deadline), late-close of a session that only arrives after the
  // abort, timeout, and teardown. The caller supplies the AbortController so it can register it
  // synchronously before any await (loginIsolated stores it in activeLogin, before this async helper
  // is even entered, so its re-entrancy guard cannot race); `onAborted` maps a timeout/cancel into a
  // result.
  private async withBoundedSession(
    mode: CodexAuthMode,
    timeoutMs: number,
    run: (session: CodexAuthSession, signal: AbortSignal) => Promise<CodexAuthStatus>,
    onAborted: (reason: unknown) => CodexAuthStatus,
    abort: AbortController = new AbortController()
  ): Promise<CodexAuthStatus> {
    const timeout = setTimeout(() => abort.abort('timeout'), timeoutMs)
    let authSession: CodexAuthSession | undefined

    try {
      const sessionPromise = this.openSession(mode)
      void sessionPromise
        .then(async (session) => {
          if (abort.signal.aborted && authSession !== session) await session.close()
        })
        .catch(() => undefined)
      authSession = await waitForOperation(sessionPromise, abort.signal)
      return await run(authSession, abort.signal)
    } catch (error) {
      if (abort.signal.aborted) return onAborted(abort.signal.reason)
      throw error
    } finally {
      clearTimeout(timeout)
      await authSession?.close()
    }
  }

  async getStatus(mode: CodexAuthMode): Promise<CodexAuthStatus> {
    return this.withBoundedSession(
      mode,
      this.statusTimeoutMs,
      async (session, signal) => {
        const initialized = await waitForOperation(session.initialize(), signal)
        const supported =
          initialized.authMethods?.some((method) => method.id === 'chat-gpt') ?? false

        // Read the live status regardless of the advertised methods: an adapter can hold a usable
        // api-key/gateway credential without offering ChatGPT login, and that profile is
        // authenticated. Only when the profile is signed out AND ChatGPT login is unavailable is there
        // nothing to do — that is the genuine capability failure.
        const status = await waitForOperation(session.status(), signal)
        if (isAuthenticated(status)) return toPublicStatus(mode, true, status)
        if (!supported) return capabilityFailure(mode)

        return toPublicStatus(mode, true, status)
      },
      () => ({
        mode,
        supported: true,
        authenticated: false,
        message: 'Codex status check timed out.'
      })
    )
  }

  async loginIsolated(): Promise<CodexAuthStatus> {
    if (this.activeLogin) {
      return {
        mode: 'isolated',
        supported: true,
        authenticated: false,
        message: 'A Codex sign-in is already in progress.'
      }
    }

    // Claim the in-progress slot synchronously, in the same tick as the guard above and before the
    // async helper is entered, so two rapid calls cannot both pass the guard and open two browser
    // sign-ins. cancelLogin aborts this same controller and waits for the session teardown below.
    const abort = new AbortController()
    let finishCompletion!: () => void
    const activeLogin = {
      abort,
      completion: new Promise<void>((resolve) => {
        finishCompletion = resolve
      })
    }
    this.activeLogin = activeLogin

    return this.withBoundedSession(
      'isolated',
      this.loginTimeoutMs,
      async (session, signal) => {
        const initialized = await waitForOperation(session.initialize(), signal)
        const supported =
          initialized.authMethods?.some((method) => method.id === 'chat-gpt') ?? false

        // Read credential status before the capability gate, mirroring getStatus. An api-key/gateway
        // credential already in the app-managed isolated home is exactly what the runtime would use,
        // so any usable credential short-circuits the browser flow — even on a build that never
        // advertises chat-gpt. Only a signed-out profile on such a build has nothing to do.
        const current = await waitForOperation(session.status(), signal)
        if (!isAuthenticated(current)) {
          if (!supported) return capabilityFailure('isolated')
          await waitForOperation(session.authenticateChatGpt(), signal)
        }

        return toPublicStatus('isolated', true, await waitForOperation(session.status(), signal))
      },
      (reason) => ({
        mode: 'isolated',
        supported: true,
        authenticated: false,
        message:
          reason === 'timeout'
            ? 'Codex sign-in timed out after five minutes.'
            : 'Codex sign-in was cancelled.'
      }),
      abort
    ).finally(() => {
      if (this.activeLogin === activeLogin) this.activeLogin = undefined
      finishCompletion()
    })
  }

  async cancelLogin(): Promise<void> {
    const activeLogin = this.activeLogin
    if (!activeLogin) return

    activeLogin.abort.abort('cancelled')
    await activeLogin.completion
  }

  async logoutIsolated(): Promise<CodexAuthStatus> {
    // Bounded like the reads: logout is user-triggered from Settings and now issues its own status
    // round-trip, so a stalled adapter must fail closed here too rather than freeze sign-out.
    return this.withBoundedSession(
      'isolated',
      this.statusTimeoutMs,
      async (session, signal) => {
        const initialized = await waitForOperation(session.initialize(), signal)
        const supported =
          initialized.authMethods?.some((method) => method.id === 'chat-gpt') ?? false

        // Clear whatever credential the isolated home holds, mirroring getStatus/loginIsolated: an
        // api-key/gateway login must be sign-out-able even on a build that never advertises chat-gpt.
        // Only a signed-out profile on such a build has nothing to clear — the capability failure.
        const current = await waitForOperation(session.status(), signal)
        if (!isAuthenticated(current) && !supported) return capabilityFailure('isolated')

        await waitForOperation(session.logout(), signal)
        return { mode: 'isolated', supported: true, authenticated: false }
      },
      () => ({
        mode: 'isolated',
        supported: true,
        authenticated: false,
        message: 'Codex sign-out timed out.'
      })
    )
  }
}

export type CodexAuthControllerPort = Pick<
  CodexAuthController,
  'getStatus' | 'loginIsolated' | 'cancelLogin' | 'logoutIsolated'
>

// Every auth session uses the app-owned subscription home. `shared` is a legacy setup discriminator,
// not permission to read the user's global Codex profile at runtime.
export const ensureCodexAuthHome = async (
  _mode: CodexAuthMode,
  storageRoot: string,
  transport: CodexSubscriptionTransport = 'auto'
): Promise<void> => {
  await ensureCodexAuthConfigHome(codexSubscriptionStorageDir(storageRoot), transport)
}

export const openCodexAuthSession = async ({
  adapterPath,
  nativePath,
  mode,
  storageRoot,
  transport = 'auto',
  proxyEnv
}: CodexAuthLaunch): Promise<CodexAuthSession> => {
  await ensureCodexAuthHome(mode, storageRoot, transport)

  const isJavaScript = /\.[cm]?js$/i.test(adapterPath)
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(adapterPath)
  const command = isJavaScript ? process.execPath : needsShell ? `"${adapterPath}"` : adapterPath
  const args = isJavaScript ? [adapterPath] : []
  const env = createCodexAuthEnvironment(mode, storageRoot, process.env, proxyEnv)
  if (isJavaScript) env.ELECTRON_RUN_AS_NODE = '1'
  if (nativePath) env.CODEX_PATH = nativePath

  const child = spawn(command, args, {
    env,
    shell: needsShell,
    stdio: 'pipe',
    windowsHide: true
  })
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  )
  const connection = acp.client({ name: 'open-science-auth' }).connect(stream)

  return {
    initialize: () =>
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'open-science-auth', version: '0.0.0' },
        clientCapabilities: {}
      }),
    status: () => connection.agent.request<CodexAuthenticationStatus>('authentication/status', {}),
    authenticateChatGpt: () =>
      connection.agent
        .request(acp.methods.agent.authenticate, { methodId: 'chat-gpt' })
        .then(() => undefined),
    logout: () =>
      connection.agent
        .request<Record<string, never>>('authentication/logout', {})
        .then(() => undefined),
    close: async () => {
      connection.close()
      child.stdin.end()
      await terminateProcessTree(child)
    }
  }
}
