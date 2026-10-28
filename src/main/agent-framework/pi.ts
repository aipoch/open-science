import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'

import type {
  AgentFramework,
  AgentModelConfig,
  AgentSpawnInput,
  ModelConfigContext,
  ResolvedAgentBackend
} from './types'
import { isProductionDelegatedWorkFramework } from '../delegation/production-readiness'
import type { ResolvedProvider } from '../settings/provider-env'

const PI_PROVIDER = 'open-science'
const PLACEHOLDER_KEY = 'open-science-bridge-awaiting-authentication'
export const piSessionModel = (model: string): string => `${PI_PROVIDER}/${model}`

type PiSkillRuntimeConfig = Readonly<{
  command: string
  entryPath: string
  root: string
  skillsDirectory?: string
  allowedNames?: readonly string[]
}>

// The host admits only an app-managed ACP adapter that delegates tool execution to its permission
// broker and keeps ACP-authenticated bridge credentials in memory. This interface does not itself
// certify an adapter, authorize MCP calls, or expose Pi in Settings.
export type PiFrameworkHost = Readonly<{
  assertApprovedAdapter: (executablePath: string) => void
  mapPermissionProfile: AgentFramework<'pi'>['mapPermissionProfile']
  skillRuntime?: Readonly<{
    sessionOptionKey: string
    createServer: (config: PiSkillRuntimeConfig) => McpServer
  }>
  execPath?: string
}>

// Each wire maps to the Pi model API that speaks it and the path prefix that API appends to.
const PI_MODEL_API = {
  'chat-completions': { api: 'openai-completions', path: '/v1' },
  responses: { api: 'openai-responses', path: '/v1' },
  messages: { api: 'anthropic-messages', path: '' }
} as const
export type PiModelWire = keyof typeof PI_MODEL_API

// The suffix keeps one model name distinct across providers. The bridge rewrites the request model
// to the provider's real model name.
export const piModelId = (providerId: string, model: string): string =>
  `${model}@${createHash('sha256')
    .update(JSON.stringify([providerId, model]))
    .digest('hex')
    .slice(0, 8)}`

const loopbackBaseUrl = (provider: ResolvedProvider): { baseUrl: string; wire: PiModelWire } => {
  const wire = provider.apiEndpoints?.[0]
  if (!wire || !(wire in PI_MODEL_API) || provider.apiEndpoints?.length !== 1) {
    throw new Error('Pi model entries require exactly one bridged API.')
  }
  const url = new URL(provider.baseUrl ?? '')
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Pi model bridge must use a credential-free loopback address.')
  return {
    baseUrl: `${url.origin}${PI_MODEL_API[wire as PiModelWire].path}`,
    wire: wire as PiModelWire
  }
}

const piModelEntry = (provider: ResolvedProvider, reasoning: boolean): Record<string, unknown> => {
  const model = provider.model?.trim()
  if (!model || !provider.agentProviderId) throw new Error('Pi model entries require a model id.')
  const { baseUrl, wire } = loopbackBaseUrl(provider)
  return {
    id: provider.agentProviderId,
    name: model,
    api: PI_MODEL_API[wire].api,
    baseUrl,
    ...(reasoning ? { reasoning: true } : {}),
    // MiniMax chat completions inline reasoning as <think> in content unless split out; Pi then
    // stores it as answer text. Split mode streams reasoning_content, which Pi keeps as thinking.
    ...(wire === 'chat-completions' && /(?:^|\/)minimax-/i.test(model)
      ? { samplingParams: { reasoning_split: true } }
      : {}),
    ...(provider.contextWindow ? { contextWindow: provider.contextWindow } : {}),
    ...(provider.maxOutputTokens ? { maxTokens: provider.maxOutputTokens } : {}),
    ...(provider.supportsImageInput ? { input: ['text', 'image'] } : {})
  }
}

const preparePiModelConfig = (
  provider: ResolvedProvider,
  ctx: ModelConfigContext
): AgentModelConfig => {
  if (!isAbsolute(ctx.storageRoot)) throw new Error('Pi storage root must be absolute.')
  const token = ctx.piModelBridge?.token
  if (!token) throw new Error('Pi requires an app-owned model bridge.')
  const activeId = provider.agentProviderId
  if (!activeId) throw new Error('Pi requires a selected model.')
  const catalog = ctx.providerModelCatalog?.length
    ? ctx.providerModelCatalog
    : [{ provider, reasoningEfforts: ctx.reasoningEfforts }]
  const models = catalog.map((entry) =>
    piModelEntry(entry.provider, Boolean(entry.reasoningEfforts?.length))
  )
  if (!models.some((entry) => entry.id === activeId)) {
    throw new Error('The active Pi model is missing from its catalog.')
  }
  // Bridges belong to one backend generation. Give its model catalog a separate home so another
  // generation cannot overwrite it while sessions are active; session files remain recoverable.
  const generationId = createHash('sha256')
    .update(JSON.stringify(models))
    .digest('hex')
    .slice(0, 24)
  const profile = join(ctx.storageRoot, 'pi', 'generations', generationId)
  const home = join(profile, 'home')
  const agent = join(profile, 'agent')
  const sessions = join(ctx.storageRoot, 'pi', 'sessions')
  const content = `${JSON.stringify(
    { providers: { [PI_PROVIDER]: { apiKey: PLACEHOLDER_KEY, models } } },
    null,
    2
  )}\n`
  const model = activeId

  return {
    env: {
      HOME: home,
      PI_CODING_AGENT_DIR: agent,
      PI_ACP_SESSION_DIR: sessions
    },
    args: [
      '--agent-dir',
      agent,
      '--session-dir',
      sessions,
      '--model',
      piSessionModel(model),
      '--quiet-startup',
      '--no-delegation'
    ],
    configFiles: [{ path: join(agent, 'models.json'), content, mode: 0o600 }],
    authentication: {
      methodId: `api-key:${PI_PROVIDER}`,
      _meta: { 'api-key': { provider: PI_PROVIDER, apiKey: token } }
    },
    sessionModel: piSessionModel(model)
  }
}

const spawnPi = (input: AgentSpawnInput, host: PiFrameworkHost): ChildProcessWithoutNullStreams => {
  if (!isAbsolute(input.executablePath)) throw new Error('Pi ACP executable path must be absolute.')
  host.assertApprovedAdapter(input.executablePath)
  const home = input.env.HOME
  const agent = input.env.PI_CODING_AGENT_DIR
  const sessions = input.env.PI_ACP_SESSION_DIR
  if (!home || !agent || !sessions || ![home, agent, sessions].every(isAbsolute)) {
    throw new Error('Pi requires app-owned runtime directories.')
  }
  if (
    dirname(home) !== dirname(agent) ||
    join(dirname(home), 'home') !== home ||
    join(dirname(home), 'agent') !== agent ||
    join(dirname(sessions), 'sessions') !== sessions
  ) {
    throw new Error('Pi runtime directories do not match the app-owned profile.')
  }
  const args = input.args
  if (
    args.length !== 8 ||
    args[0] !== '--agent-dir' ||
    args[1] !== agent ||
    args[2] !== '--session-dir' ||
    args[3] !== sessions ||
    args[4] !== '--model' ||
    !args[5]?.startsWith(`${PI_PROVIDER}/`) ||
    args[6] !== '--quiet-startup' ||
    args[7] !== '--no-delegation'
  )
    throw new Error('Pi ACP launch configuration is invalid.')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(sessions, { recursive: true, mode: 0o700 })
  return (input.spawnProcess ?? spawn)(
    host.execPath ?? process.execPath,
    [input.executablePath, ...args],
    {
      stdio: 'pipe',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        PI_CODING_AGENT_DIR: agent,
        PI_ACP_SESSION_DIR: sessions,
        PI_OFFLINE: '1',
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {})
      }
    }
  )
}

// A delegated Attempt gets its own Pi home, agent directory, and session store under the Attempt
// runtime home. It reuses the generation's model catalog; the bridge key still arrives over ACP.
const preparePiDelegatedSpawn = async (
  backend: ResolvedAgentBackend,
  runtimeHome: string
): Promise<AgentSpawnInput> => {
  const args = backend.args ?? []
  const sourceAgent = args[1]
  if (args[0] !== '--agent-dir' || !sourceAgent || !isAbsolute(runtimeHome)) {
    throw new Error('Pi delegated launch configuration is invalid.')
  }
  const profile = join(runtimeHome, 'pi')
  const home = join(profile, 'home')
  const agent = join(profile, 'agent')
  const sessions = join(profile, 'sessions')
  await mkdir(agent, { recursive: true, mode: 0o700 })
  await copyFile(join(sourceAgent, 'models.json'), join(agent, 'models.json'))
  const delegatedArgs = [...args]
  delegatedArgs[1] = agent
  delegatedArgs[3] = sessions
  return {
    executablePath: backend.executablePath,
    args: delegatedArgs,
    env: {
      ...backend.env,
      HOME: home,
      PI_CODING_AGENT_DIR: agent,
      PI_ACP_SESSION_DIR: sessions
    },
    proxyEnvironmentMode: backend.proxyEnvironmentMode
  }
}

export const createPiFramework = (host: PiFrameworkHost): AgentFramework<'pi'> => ({
  id: 'pi',
  displayName: 'Pi',
  commandShellDialect: 'posix',
  contextCompaction: { kind: 'framework-managed' },
  supportsSkills: host.skillRuntime !== undefined,
  supportsDelegatedWork: isProductionDelegatedWorkFramework('pi'),
  prepareDelegatedSpawn: preparePiDelegatedSpawn,
  acceptsStdioMcp: true,
  supportsLiveEffortChange: false,
  supportedApiTypes: ['responses', 'chat-completions', 'messages'],
  spawn: (input) => spawnPi(input, host),
  prepareModelConfig: preparePiModelConfig,
  buildSessionSetup(ctx) {
    const runtime =
      host.skillRuntime &&
      (ctx.sessionOptions?.[host.skillRuntime.sessionOptionKey] as
        | { command?: string; entryPath?: string; root?: string; skillsDirectory?: string }
        | undefined)
    const available = Boolean(
      host.skillRuntime &&
      ctx.skillRuntimeScope !== undefined &&
      (ctx.skillRuntimeScope === 'all' || ctx.skillRuntimeScope.length > 0) &&
      runtime?.command &&
      runtime.entryPath &&
      runtime.root
    )
    const promptPrefix = [...ctx.systemPromptAppends, ...(ctx.turnPromptReminders ?? [])]
      .filter(Boolean)
      .join('\n\n')
    return {
      ...(available && host.skillRuntime && runtime?.command && runtime.entryPath && runtime.root
        ? {
            mcpServers: [
              host.skillRuntime.createServer({
                command: runtime.command,
                entryPath: runtime.entryPath,
                root: runtime.root,
                ...(runtime.skillsDirectory ? { skillsDirectory: runtime.skillsDirectory } : {}),
                ...(ctx.skillRuntimeScope !== 'all' ? { allowedNames: ctx.skillRuntimeScope } : {})
              })
            ]
          }
        : {}),
      ...(promptPrefix ? { promptPrefix } : {})
    }
  },
  mapPermissionProfile: host.mapPermissionProfile
})
