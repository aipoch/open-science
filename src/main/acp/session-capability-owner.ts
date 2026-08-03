import type { McpServer } from '@agentclientprotocol/sdk'

import type { AgentFramework } from '../agent-framework'
import {
  canonicalAppMcpServerName,
  modelFacingAppMcpServerName
} from '../agent-framework/app-mcp-names'
import {
  ARTIFACT_MCP_SERVER_NAME,
  createArtifactMcpServerConfig,
  type ArtifactMcpEnvironment
} from '../artifacts/mcp-server'
import { getArtifactCurrentRunFilePath } from '../artifacts/repository'
import { createLogger, diagnosticErrorFields } from '../logger'
import {
  NOTEBOOK_MCP_SERVER_NAME,
  createNotebookMcpServerConfig,
  type NotebookMcpEnvironment,
  type NotebookRpcConnection
} from '../notebook/mcp-server'
import {
  SKILL_IMPORT_MCP_SERVER_NAME,
  createSkillImportMcpServerConfig,
  type SkillImportMcpEnvironment,
  type SkillImportRpcConnection
} from '../skills/mcp-server'
import type { AgentMcpHttpHost } from './mcp-http-host'

const log = createLogger('acp')

const CURRENT_PRIMARY_CAPABILITIES = [
  'artifacts',
  'notebook',
  'skill-import',
  'host-agents'
] as const
const NOTEBOOK_CONTROL_RPC_METHODS = ['mcpCall', 'computeCall', 'agentsCall'] as const

export type SessionCapabilityName = (typeof CURRENT_PRIMARY_CAPABILITIES)[number]

export type SessionCapabilityPolicy = Readonly<{
  role: 'primary' | 'reviewer'
  // Delegation is deliberately explicit and denied for every currently shipped Session. Issue #458
  // can extend this input later without making prompts, identity text, or provider metadata authoritative.
  delegation: 'denied'
}>

export const CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY: SessionCapabilityPolicy = Object.freeze({
  role: 'primary',
  delegation: 'denied'
})

export const REVIEWER_SESSION_CAPABILITY_POLICY: SessionCapabilityPolicy = Object.freeze({
  role: 'reviewer',
  delegation: 'denied'
})

export const policyAllowsSessionCapability = (
  policy: SessionCapabilityPolicy,
  capability: string
): capability is SessionCapabilityName =>
  policy.role === 'primary' &&
  policy.delegation === 'denied' &&
  (CURRENT_PRIMARY_CAPABILITIES as readonly string[]).includes(capability)

export type EffectiveSessionCapabilityDescriptor = Readonly<{
  role: SessionCapabilityPolicy['role']
  delegation: SessionCapabilityPolicy['delegation']
  transport: 'stdio' | 'http' | 'none'
  capabilities: readonly SessionCapabilityName[]
  canonicalMcpServerNames: readonly string[]
  modelFacingMcpServerNames: readonly string[]
  controlRpcMethods: readonly string[]
}>

export type SessionCapabilityRoutingIds = Readonly<{
  artifact: string
  notebook: string
  skillImport: string
}>

export type SessionCapabilityArtifactOptions = {
  dataRoot: string
  projectName: string
  mcpEntryPath: string
  mcpCommand?: string
  getRpcConnection?: () => Promise<NotebookRpcConnection>
}

export type SessionCapabilityNotebookOptions = {
  projectName: string
  mcpEntryPath: string
  mcpCommand?: string
  getRpcConnection?: (binding: {
    sessionId: string
    projectId: string
  }) => Promise<NotebookRpcConnection>
  registerSessionAlias?: (aliasSessionId: string, sessionId: string) => void
  releaseSessionCapabilities?: (sessionId: string) => void
}

export type SessionCapabilitySkillImportOptions = {
  mcpEntryPath: string
  mcpCommand?: string
  isEnabled?: () => Promise<boolean>
  getRpcConnection: (binding: { sessionId: string }) => Promise<SkillImportRpcConnection>
  registerSessionAlias?: (aliasSessionId: string, sessionId: string) => void
  releaseSessionCapabilities?: (sessionId: string) => void
}

export type BuildSessionCapabilitiesRequest = {
  framework: Pick<AgentFramework, 'id' | 'acceptsStdioMcp'>
  nativeMcpEnabled: boolean
  bridgeMcpAliasesEnabled: boolean
  policy: SessionCapabilityPolicy
  routingIds: SessionCapabilityRoutingIds
  sessionCwd: string
  projectName: string
  onNotebookConnection?: (connection: NotebookRpcConnection) => void
  onSkillImportConnection?: (connection: SkillImportRpcConnection) => void
}

export type BuiltSessionCapabilities = Readonly<{
  mcpServers: McpServer[]
  descriptor: EffectiveSessionCapabilityDescriptor
}>

type CommitSessionCapabilitiesRequest = {
  appSessionId: string
  routingIds: SessionCapabilityRoutingIds
  descriptor: EffectiveSessionCapabilityDescriptor
  notebookRelease?: () => void
  skillImportRelease?: () => void
}

type RevokeProvisionalSessionCapabilitiesRequest = {
  routingIds: readonly (string | undefined)[]
  usedHttpTransport: boolean
  notebookSessionId?: string
  notebookRelease?: () => void
  skillImportRelease?: () => void
  ownsStableIdentity: boolean
}

type SessionCapabilityOwnerOptions = {
  artifacts?: SessionCapabilityArtifactOptions
  notebook?: SessionCapabilityNotebookOptions
  skillImport?: SessionCapabilitySkillImportOptions
  mcpHttpHost?: AgentMcpHttpHost
}

const freezeDescriptor = (
  descriptor: Omit<
    EffectiveSessionCapabilityDescriptor,
    'capabilities' | 'canonicalMcpServerNames' | 'modelFacingMcpServerNames' | 'controlRpcMethods'
  > & {
    capabilities: SessionCapabilityName[]
    canonicalMcpServerNames: string[]
    modelFacingMcpServerNames: string[]
    controlRpcMethods: string[]
  }
): EffectiveSessionCapabilityDescriptor =>
  Object.freeze({
    ...descriptor,
    capabilities: Object.freeze([...descriptor.capabilities]),
    canonicalMcpServerNames: Object.freeze([...descriptor.canonicalMcpServerNames]),
    modelFacingMcpServerNames: Object.freeze([...descriptor.modelFacingMcpServerNames]),
    controlRpcMethods: Object.freeze([...descriptor.controlRpcMethods])
  })

const safeLogError = (message: string, fields: Record<string, unknown>): void => {
  try {
    log.error(message, fields)
  } catch {
    /* cleanup must not be interrupted by diagnostics */
  }
}

export class AcpSessionCapabilityOwner {
  private readonly artifactRoutingIds = new Map<string, string>()
  private readonly notebookRoutingIds = new Map<string, string>()
  private readonly notebookCapabilityReleases = new Map<string, () => void>()
  private readonly skillImportRoutingIds = new Map<string, string>()
  private readonly skillImportCapabilityReleases = new Map<string, () => void>()
  private readonly descriptors = new Map<string, EffectiveSessionCapabilityDescriptor>()
  private readonly committedSessionIds = new Set<string>()
  private artifactSessionSequence = 0
  private notebookSessionSequence = 0
  private skillImportSessionSequence = 0
  private skillImportEnabled = true

  constructor(private readonly options: SessionCapabilityOwnerOptions) {}

  createRoutingIds(stableAppSessionId?: string): SessionCapabilityRoutingIds {
    if (stableAppSessionId) {
      return Object.freeze({
        artifact: this.options.artifacts ? stableAppSessionId : '',
        notebook: this.options.notebook ? stableAppSessionId : '',
        skillImport: this.options.skillImport ? stableAppSessionId : ''
      })
    }

    const timestamp = Date.now()
    if (this.options.artifacts) this.artifactSessionSequence += 1
    if (this.options.notebook) this.notebookSessionSequence += 1
    if (this.options.skillImport) this.skillImportSessionSequence += 1

    return Object.freeze({
      artifact: this.options.artifacts
        ? `artifact-session-${timestamp}-${this.artifactSessionSequence}`
        : '',
      notebook: this.options.notebook
        ? `notebook-session-${timestamp}-${this.notebookSessionSequence}`
        : '',
      skillImport: this.options.skillImport
        ? `skill-import-session-${timestamp}-${this.skillImportSessionSequence}`
        : ''
    })
  }

  async build(request: BuildSessionCapabilitiesRequest): Promise<BuiltSessionCapabilities> {
    const transport = request.framework.acceptsStdioMcp
      ? 'stdio'
      : this.options.mcpHttpHost
        ? 'http'
        : 'none'
    const artifactsAllowed =
      policyAllowsSessionCapability(request.policy, 'artifacts') &&
      (request.nativeMcpEnabled || request.bridgeMcpAliasesEnabled)
    const notebookAllowed = policyAllowsSessionCapability(request.policy, 'notebook')
    const skillImportAllowed = policyAllowsSessionCapability(request.policy, 'skill-import')

    const servers =
      transport === 'stdio'
        ? await this.buildStdioServers(request, {
            artifacts: artifactsAllowed,
            notebook: notebookAllowed,
            skillImport: skillImportAllowed
          })
        : transport === 'http'
          ? await this.buildHttpServers(request, {
              artifacts: artifactsAllowed,
              notebook: notebookAllowed,
              skillImport: skillImportAllowed
            })
          : []
    const modelFacingServers = servers.map((server) => {
      const name = (server as { name?: unknown }).name
      if (typeof name !== 'string') return server

      const modelFacingName = modelFacingAppMcpServerName(request.framework.id, name)
      return modelFacingName === name ? server : { ...server, name: modelFacingName }
    })
    const modelFacingMcpServerNames = modelFacingServers
      .map((server) => (server as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string')
    const canonicalMcpServerNames = modelFacingMcpServerNames.map(canonicalAppMcpServerName)
    const capabilities: SessionCapabilityName[] = []
    if (canonicalMcpServerNames.includes(ARTIFACT_MCP_SERVER_NAME)) capabilities.push('artifacts')
    if (canonicalMcpServerNames.includes(NOTEBOOK_MCP_SERVER_NAME)) capabilities.push('notebook')
    if (canonicalMcpServerNames.includes(SKILL_IMPORT_MCP_SERVER_NAME)) {
      capabilities.push('skill-import')
    }
    if (
      capabilities.includes('notebook') &&
      policyAllowsSessionCapability(request.policy, 'host-agents')
    ) {
      capabilities.push('host-agents')
    }

    const descriptor = freezeDescriptor({
      role: request.policy.role,
      delegation: request.policy.delegation,
      transport: modelFacingServers.length > 0 ? transport : 'none',
      capabilities,
      canonicalMcpServerNames,
      modelFacingMcpServerNames,
      controlRpcMethods: capabilities.includes('host-agents')
        ? [...NOTEBOOK_CONTROL_RPC_METHODS]
        : []
    })

    log.info('session capabilities built', {
      framework: request.framework.id,
      role: request.policy.role,
      transport: descriptor.transport,
      count: modelFacingServers.length
    })

    return Object.freeze({ mcpServers: modelFacingServers, descriptor })
  }

  commit(request: CommitSessionCapabilitiesRequest): void {
    const { appSessionId, routingIds, descriptor } = request
    if (routingIds.artifact) this.artifactRoutingIds.set(appSessionId, routingIds.artifact)
    if (routingIds.notebook) {
      this.notebookRoutingIds.set(appSessionId, routingIds.notebook)
      this.registerAlias(
        'notebook',
        routingIds.notebook,
        appSessionId,
        this.options.notebook?.registerSessionAlias
      )
    }
    if (routingIds.skillImport && this.skillImportEnabled) {
      this.skillImportRoutingIds.set(appSessionId, routingIds.skillImport)
      this.registerAlias(
        'skill import',
        routingIds.skillImport,
        appSessionId,
        this.options.skillImport?.registerSessionAlias
      )
    }
    this.descriptors.set(appSessionId, descriptor)
    this.committedSessionIds.add(appSessionId)
    this.commitNotebookRelease(appSessionId, request.notebookRelease)
    this.commitSkillImportRelease(appSessionId, request.skillImportRelease)
  }

  revokeProvisional(request: RevokeProvisionalSessionCapabilitiesRequest): void {
    if (request.usedHttpTransport && this.options.mcpHttpHost) {
      for (const routingId of new Set(request.routingIds)) {
        if (!routingId) continue
        try {
          this.options.mcpHttpHost.unregister(routingId)
        } catch (error) {
          safeLogError('provisional http MCP route cleanup failed', {
            ...diagnosticErrorFields(error),
            routingId
          })
        }
      }
    }

    if (request.notebookRelease) {
      try {
        request.notebookRelease()
      } catch (error) {
        safeLogError('provisional notebook capability cleanup failed', {
          ...diagnosticErrorFields(error),
          sessionId: request.notebookSessionId
        })
      }
    }
    if (request.skillImportRelease) {
      try {
        request.skillImportRelease()
      } catch (error) {
        safeLogError('provisional Skill import capability cleanup failed', {
          ...diagnosticErrorFields(error)
        })
      }
    }
    if (request.notebookSessionId && request.ownsStableIdentity) {
      this.releaseSessionCapabilities(request.notebookSessionId)
    }
  }

  revokeSession(appSessionId: string): void {
    if (!this.committedSessionIds.has(appSessionId)) return

    if (this.options.mcpHttpHost) {
      const routingIds = [
        this.artifactRoutingIds.get(appSessionId),
        this.notebookRoutingIds.get(appSessionId),
        this.skillImportRoutingIds.get(appSessionId)
      ]
      for (const routingId of routingIds) {
        if (!routingId) continue
        try {
          this.options.mcpHttpHost.unregister(routingId)
        } catch (error) {
          safeLogError('committed http MCP route cleanup failed', {
            ...diagnosticErrorFields(error),
            routingId,
            sessionId: appSessionId
          })
        }
      }
    }

    this.artifactRoutingIds.delete(appSessionId)
    this.notebookRoutingIds.delete(appSessionId)
    this.skillImportRoutingIds.delete(appSessionId)
    this.descriptors.delete(appSessionId)
    this.committedSessionIds.delete(appSessionId)
    this.releaseCommittedNotebookCapability(appSessionId)
    this.releaseCommittedSkillImportCapability(appSessionId)
    this.releaseSessionCapabilities(appSessionId)
  }

  dispose(sessionIds: Iterable<string> = []): void {
    const ownedSessionIds = new Set([
      ...sessionIds,
      ...this.artifactRoutingIds.keys(),
      ...this.notebookRoutingIds.keys(),
      ...this.skillImportRoutingIds.keys(),
      ...this.notebookCapabilityReleases.keys(),
      ...this.skillImportCapabilityReleases.keys(),
      ...this.descriptors.keys(),
      ...this.committedSessionIds
    ])
    for (const sessionId of ownedSessionIds) {
      this.releaseCommittedNotebookCapability(sessionId)
      this.releaseCommittedSkillImportCapability(sessionId)
      this.releaseSessionCapabilities(sessionId)
    }
    this.artifactRoutingIds.clear()
    this.notebookRoutingIds.clear()
    this.skillImportRoutingIds.clear()
    this.notebookCapabilityReleases.clear()
    this.skillImportCapabilityReleases.clear()
    this.descriptors.clear()
    this.committedSessionIds.clear()
  }

  clearHttpRoutes(): void {
    this.options.mcpHttpHost?.clear()
  }

  artifactRoutingIdFor(appSessionId: string): string | undefined {
    return this.artifactRoutingIds.get(appSessionId)
  }

  mcpServerNamesFor(appSessionId: string): readonly string[] {
    return this.descriptors.get(appSessionId)?.canonicalMcpServerNames ?? []
  }

  isSkillImportEnabled(): boolean {
    return this.skillImportEnabled
  }

  // Skill-import enablement is preference-backed and may change between connections. Refresh it
  // before projecting tooling guidance into backend-native instructions, which happens before the
  // concrete session capability set is built.
  async refreshDynamicAvailability(): Promise<void> {
    if (!this.options.skillImport) return
    this.skillImportEnabled = (await this.options.skillImport.isEnabled?.()) ?? true
  }

  toolingAvailability(input: {
    framework: Pick<AgentFramework, 'acceptsStdioMcp'>
    nativeMcpEnabled: boolean
    bridgeMcpAliasesEnabled: boolean
    policy: SessionCapabilityPolicy
  }): Readonly<{
    artifacts: boolean
    notebook: boolean
    skillImport: boolean
    hostAgents: boolean
  }> {
    const transportAvailable = input.framework.acceptsStdioMcp || Boolean(this.options.mcpHttpHost)
    const notebook =
      transportAvailable &&
      Boolean(this.options.notebook) &&
      policyAllowsSessionCapability(input.policy, 'notebook')
    return Object.freeze({
      artifacts:
        transportAvailable &&
        Boolean(this.options.artifacts) &&
        (input.nativeMcpEnabled || input.bridgeMcpAliasesEnabled) &&
        policyAllowsSessionCapability(input.policy, 'artifacts'),
      notebook,
      skillImport:
        transportAvailable &&
        this.skillImportEnabled &&
        Boolean(this.options.skillImport) &&
        policyAllowsSessionCapability(input.policy, 'skill-import'),
      hostAgents: notebook && policyAllowsSessionCapability(input.policy, 'host-agents')
    })
  }

  private async buildArtifactEnvironment(
    routingId: string,
    sessionCwd: string,
    projectName: string
  ): Promise<ArtifactMcpEnvironment | undefined> {
    if (!this.options.artifacts || !routingId) return undefined
    const connection = await this.options.artifacts.getRpcConnection?.()
    return {
      storageRoot: this.options.artifacts.dataRoot,
      projectName,
      sessionId: routingId,
      currentRunFile: getArtifactCurrentRunFilePath(
        this.options.artifacts.dataRoot,
        projectName,
        routingId
      ),
      allowedImportRoots: [sessionCwd],
      rpcEndpoint: connection?.endpoint
    }
  }

  private async buildNotebookEnvironment(
    routingId: string,
    sessionCwd: string,
    projectName: string,
    onConnection?: (connection: NotebookRpcConnection) => void
  ): Promise<NotebookMcpEnvironment | undefined> {
    if (!this.options.notebook || !routingId) return undefined
    if (!this.options.notebook.getRpcConnection) {
      throw new Error('Notebook runtime RPC connection is not configured.')
    }
    const connection = await this.options.notebook.getRpcConnection({
      sessionId: routingId,
      projectId: projectName
    })
    onConnection?.(connection)
    return {
      endpoint: connection.endpoint,
      token: connection.token,
      projectName,
      sessionId: routingId,
      workspaceCwd: sessionCwd
    }
  }

  private async buildSkillImportEnvironment(
    routingId: string,
    onConnection?: (connection: SkillImportRpcConnection) => void
  ): Promise<SkillImportMcpEnvironment | undefined> {
    if (!this.options.skillImport || !routingId) return undefined
    await this.refreshDynamicAvailability()
    if (!this.skillImportEnabled) return undefined
    const connection = await this.options.skillImport.getRpcConnection({ sessionId: routingId })
    onConnection?.(connection)
    return { ...connection, sessionId: routingId }
  }

  private async buildStdioServers(
    request: BuildSessionCapabilitiesRequest,
    enabled: { artifacts: boolean; notebook: boolean; skillImport: boolean }
  ): Promise<McpServer[]> {
    const servers: McpServer[] = []
    if (enabled.artifacts) {
      const environment = await this.buildArtifactEnvironment(
        request.routingIds.artifact,
        request.sessionCwd,
        request.projectName
      )
      if (environment && this.options.artifacts) {
        servers.push(
          createArtifactMcpServerConfig({
            command: this.options.artifacts.mcpCommand ?? process.execPath,
            entryPath: this.options.artifacts.mcpEntryPath,
            ...environment
          })
        )
      }
    }
    if (enabled.notebook) {
      const environment = await this.buildNotebookEnvironment(
        request.routingIds.notebook,
        request.sessionCwd,
        request.projectName,
        request.onNotebookConnection
      )
      if (environment && this.options.notebook) {
        servers.push(
          createNotebookMcpServerConfig({
            command: this.options.notebook.mcpCommand ?? process.execPath,
            entryPath: this.options.notebook.mcpEntryPath,
            ...environment
          })
        )
      }
    }
    if (enabled.skillImport) {
      const environment = await this.buildSkillImportEnvironment(
        request.routingIds.skillImport,
        request.onSkillImportConnection
      )
      if (environment && this.options.skillImport) {
        servers.push(
          createSkillImportMcpServerConfig({
            command: this.options.skillImport.mcpCommand ?? process.execPath,
            entryPath: this.options.skillImport.mcpEntryPath,
            ...environment
          })
        )
      }
    }
    return servers
  }

  private async buildHttpServers(
    request: BuildSessionCapabilitiesRequest,
    enabled: { artifacts: boolean; notebook: boolean; skillImport: boolean }
  ): Promise<McpServer[]> {
    const host = this.options.mcpHttpHost
    if (!host) return []
    const { token } = await host.ensureStarted()
    const authHeader = { name: 'authorization', value: `Bearer ${token}` }
    const servers: McpServer[] = []

    if (enabled.artifacts) {
      const environment = await this.buildArtifactEnvironment(
        request.routingIds.artifact,
        request.sessionCwd,
        request.projectName
      )
      if (environment) {
        host.registerArtifact(request.routingIds.artifact, environment)
        servers.push({
          type: 'http',
          name: ARTIFACT_MCP_SERVER_NAME,
          url: host.urlFor('artifact', request.routingIds.artifact),
          headers: [authHeader]
        })
      }
    }
    if (enabled.notebook) {
      const environment = await this.buildNotebookEnvironment(
        request.routingIds.notebook,
        request.sessionCwd,
        request.projectName,
        request.onNotebookConnection
      )
      if (environment) {
        host.registerNotebook(request.routingIds.notebook, environment)
        servers.push({
          type: 'http',
          name: NOTEBOOK_MCP_SERVER_NAME,
          url: host.urlFor('notebook', request.routingIds.notebook),
          headers: [authHeader]
        })
      }
    }
    if (enabled.skillImport) {
      const environment = await this.buildSkillImportEnvironment(
        request.routingIds.skillImport,
        request.onSkillImportConnection
      )
      if (environment) {
        host.registerSkillImport(request.routingIds.skillImport, environment)
        servers.push({
          type: 'http',
          name: SKILL_IMPORT_MCP_SERVER_NAME,
          url: host.urlFor('skill-import', request.routingIds.skillImport),
          headers: [authHeader]
        })
      }
    }
    return servers
  }

  private registerAlias(
    kind: string,
    aliasSessionId: string,
    appSessionId: string,
    register: ((aliasSessionId: string, sessionId: string) => void) | undefined
  ): void {
    if (!register || aliasSessionId === appSessionId) return
    try {
      register(aliasSessionId, appSessionId)
    } catch (error) {
      safeLogError(`register ${kind} session alias failed`, {
        ...diagnosticErrorFields(error),
        aliasSessionId,
        sessionId: appSessionId
      })
    }
  }

  private commitNotebookRelease(sessionId: string, release: (() => void) | undefined): void {
    const previousRelease = this.notebookCapabilityReleases.get(sessionId)
    if (previousRelease === release) return
    if (release) this.notebookCapabilityReleases.set(sessionId, release)
    else this.notebookCapabilityReleases.delete(sessionId)
    if (!previousRelease) return
    try {
      previousRelease()
    } catch (error) {
      safeLogError('replaced notebook capability cleanup failed', {
        ...diagnosticErrorFields(error),
        sessionId
      })
    }
  }

  private releaseCommittedNotebookCapability(sessionId: string): void {
    const release = this.notebookCapabilityReleases.get(sessionId)
    this.notebookCapabilityReleases.delete(sessionId)
    if (!release) return
    try {
      release()
    } catch (error) {
      safeLogError('committed notebook capability cleanup failed', {
        ...diagnosticErrorFields(error),
        sessionId
      })
    }
  }

  private commitSkillImportRelease(sessionId: string, release: (() => void) | undefined): void {
    const previousRelease = this.skillImportCapabilityReleases.get(sessionId)
    if (previousRelease === release) return
    if (release) this.skillImportCapabilityReleases.set(sessionId, release)
    else this.skillImportCapabilityReleases.delete(sessionId)
    if (!previousRelease) return
    try {
      previousRelease()
    } catch (error) {
      safeLogError('replaced Skill import capability cleanup failed', {
        ...diagnosticErrorFields(error),
        sessionId
      })
    }
  }

  private releaseCommittedSkillImportCapability(sessionId: string): void {
    const release = this.skillImportCapabilityReleases.get(sessionId)
    this.skillImportCapabilityReleases.delete(sessionId)
    if (!release) return
    try {
      release()
    } catch (error) {
      safeLogError('committed Skill import capability cleanup failed', {
        ...diagnosticErrorFields(error),
        sessionId
      })
    }
  }

  private releaseSessionCapabilities(sessionId: string): void {
    try {
      const release =
        this.options.notebook?.releaseSessionCapabilities ??
        this.options.skillImport?.releaseSessionCapabilities
      release?.(sessionId)
    } catch (error) {
      safeLogError('release session capabilities failed', {
        ...diagnosticErrorFields(error),
        sessionId
      })
    }
  }
}
