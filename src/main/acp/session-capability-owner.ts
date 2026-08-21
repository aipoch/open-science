import type { McpServer } from '@agentclientprotocol/sdk'

import type { SideChatSendMessageRequest, SideChatSendMessageResult } from '../../shared/side-chat'
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
import {
  PLAN_MCP_SERVER_NAME,
  createPlanMcpServerConfig,
  type PlanMcpEnvironment
} from '../session-plan/plan-mcp-server'
import { HOST_MESSAGE_MCP_SERVER_NAME } from '../side-chat/host-message-mcp-server'
import type { AgentMcpHttpHost } from './mcp-http-host'

const log = createLogger('acp')

const CURRENT_PRIMARY_CAPABILITIES = [
  'artifacts',
  'notebook',
  'skill-import',
  'plan',
  'host-agents',
  'host-skills',
  'host-frames',
  'host-sessions',
  'host-llm',
  'host-message'
] as const
const NOTEBOOK_CONTROL_RPC_METHODS = [
  'capabilitiesCall',
  'lineageCall',
  'mcpCall',
  'computeCall',
  'agentsCall',
  'skillsCall',
  'framesCall',
  'sessionsCall',
  'currentModelCall',
  'listModelsCall',
  'llmCall',
  'viewImageCall'
] as const

export type SessionCapabilityName = (typeof CURRENT_PRIMARY_CAPABILITIES)[number]

export type SessionCapabilityPolicy = Readonly<{
  role: 'primary' | 'reviewer' | 'side-chat'
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

export const SIDE_CHAT_SESSION_CAPABILITY_POLICY: SessionCapabilityPolicy = Object.freeze({
  role: 'side-chat',
  delegation: 'denied'
})

export const policyAllowsSessionCapability = (
  policy: SessionCapabilityPolicy,
  capability: string
): capability is SessionCapabilityName =>
  policy.delegation === 'denied' &&
  ((policy.role === 'primary' &&
    capability !== 'host-message' &&
    (CURRENT_PRIMARY_CAPABILITIES as readonly string[]).includes(capability)) ||
    (policy.role === 'side-chat' && capability === 'host-message'))

export type EffectiveSessionCapabilityDescriptor = Readonly<{
  role: SessionCapabilityPolicy['role']
  delegation: SessionCapabilityPolicy['delegation']
  transport: 'stdio' | 'http' | 'none'
  capabilities: readonly SessionCapabilityName[]
  canonicalMcpServerNames: readonly string[]
  modelFacingMcpServerNames: readonly string[]
  controlRpcMethods: readonly string[]
}>

type SessionCapabilityRoutingIds = Readonly<{
  artifact: string
  notebook: string
  skillImport: string
  plan: string
  sideChat: string
}>

export type SessionCapabilityArtifactOptions = {
  dataRoot: string
  projectId: string
  mcpEntryPath: string
  mcpCommand?: string
  getRpcConnection?: () => Promise<NotebookRpcConnection>
  // A delegated Attempt owns this handoff path. Its runtime may use Artifact tools, but must not
  // create or replace the turn owned by DurableDelegatedWork.
  currentRunFile?: string
}

export type SessionCapabilityNotebookOptions = {
  projectId: string
  mcpEntryPath: string
  mcpCommand?: string
  memoryTools?: boolean
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

export type SessionCapabilityPlanOptions = {
  mcpEntryPath: string
  mcpCommand?: string
  getRpcConnection: (binding: {
    sessionId: string
    projectId: string
  }) => Promise<NotebookRpcConnection>
  registerSessionAlias?: (aliasSessionId: string, sessionId: string) => void
}

type BuildSessionCapabilitiesRequest = {
  framework: Pick<AgentFramework, 'id' | 'acceptsStdioMcp'>
  nativeMcpEnabled: boolean
  bridgeMcpAliasesEnabled: boolean
  policy: SessionCapabilityPolicy
  routingIds: SessionCapabilityRoutingIds
  routingOwner: object
  provisionGeneration: number
  sessionCwd: string
  projectId: string
  onNotebookConnection?: (connection: NotebookRpcConnection) => void
  onSkillImportConnection?: (connection: SkillImportRpcConnection) => void
  onPlanConnection?: (connection: NotebookRpcConnection) => void
}

type BuiltSessionCapabilities = Readonly<{
  mcpServers: McpServer[]
  descriptor: EffectiveSessionCapabilityDescriptor
}>

export type ProvisionSessionCapabilitiesRequest = Omit<
  BuildSessionCapabilitiesRequest,
  | 'routingIds'
  | 'routingOwner'
  | 'provisionGeneration'
  | 'onNotebookConnection'
  | 'onSkillImportConnection'
  | 'onPlanConnection'
> & {
  stableAppSessionId?: string
}

export type SessionCapabilityOwnershipFacts = Readonly<{
  ownsStableIdentity: boolean
}>

export type SessionCapabilityProvision = Readonly<{
  mcpServers: McpServer[]
  descriptor: EffectiveSessionCapabilityDescriptor
  commit: (appSessionId: string) => void
  release: (ownershipFacts: SessionCapabilityOwnershipFacts) => void
}>

type CommitSessionCapabilitiesRequest = {
  appSessionId: string
  routingIds: SessionCapabilityRoutingIds
  descriptor: EffectiveSessionCapabilityDescriptor
  notebookRelease?: () => void
  skillImportRelease?: () => void
  planRelease?: () => void
}

type RevokeProvisionalSessionCapabilitiesRequest = {
  routingIds: readonly (string | undefined)[]
  usedHttpTransport: boolean
  notebookSessionId?: string
  notebookRelease?: () => void
  skillImportRelease?: () => void
  planRelease?: () => void
  ownsStableIdentity: boolean
}

type SessionCapabilityOwnerOptions = {
  artifacts?: SessionCapabilityArtifactOptions
  notebook?: SessionCapabilityNotebookOptions
  skillImport?: SessionCapabilitySkillImportOptions
  plan?: SessionCapabilityPlanOptions
  sideChat?: Readonly<{
    sendMessage: (
      routingId: string,
      request: SideChatSendMessageRequest
    ) => Promise<SideChatSendMessageResult>
  }>
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
  private readonly planRoutingIds = new Map<string, string>()
  private readonly planCapabilityReleases = new Map<string, () => void>()
  private readonly sideChatRoutingIds = new Map<string, string>()
  private readonly descriptors = new Map<string, EffectiveSessionCapabilityDescriptor>()
  private readonly committedSessionIds = new Set<string>()
  private readonly provisionalRoutingOwners = new Map<string, object>()
  private provisionalGeneration = 0
  private artifactSessionSequence = 0
  private notebookSessionSequence = 0
  private skillImportSessionSequence = 0
  private planSessionSequence = 0
  private sideChatSessionSequence = 0
  private skillImportEnabled = true

  constructor(private readonly options: SessionCapabilityOwnerOptions) {}

  async provision(
    request: ProvisionSessionCapabilitiesRequest
  ): Promise<SessionCapabilityProvision> {
    const routingIds = this.createRoutingIds(request.stableAppSessionId)
    const routingOwner = this.trackProvisionalRoutingOwner(routingIds)
    const provisionGeneration = this.provisionalGeneration
    let notebookRelease: (() => void) | undefined
    let skillImportRelease: (() => void) | undefined
    let planRelease: (() => void) | undefined
    let built: BuiltSessionCapabilities
    try {
      built = await this.build({
        framework: request.framework,
        nativeMcpEnabled: request.nativeMcpEnabled,
        bridgeMcpAliasesEnabled: request.bridgeMcpAliasesEnabled,
        policy: request.policy,
        routingIds,
        routingOwner,
        provisionGeneration,
        sessionCwd: request.sessionCwd,
        projectId: request.projectId,
        onNotebookConnection: (connection) => {
          notebookRelease = connection.release
        },
        onSkillImportConnection: (connection) => {
          skillImportRelease = connection.release
        },
        onPlanConnection: (connection) => {
          planRelease = connection.release
        }
      })
    } catch (error) {
      const ownsStableIdentity = this.ownsProvisionalRoutingIds(routingIds, routingOwner)
      this.revokeProvisional({
        routingIds: [
          routingIds.artifact,
          routingIds.notebook,
          routingIds.skillImport,
          routingIds.plan,
          routingIds.sideChat
        ],
        usedHttpTransport:
          ownsStableIdentity &&
          (request.policy.role === 'side-chat' || !request.framework.acceptsStdioMcp),
        notebookSessionId: routingIds.notebook || undefined,
        notebookRelease,
        skillImportRelease,
        planRelease,
        ownsStableIdentity
      })
      this.finishProvisionalRoutingOwner(routingIds, routingOwner)
      throw error
    }
    let terminal = false

    return Object.freeze({
      ...built,
      commit: (appSessionId: string): void => {
        if (terminal) return
        terminal = true
        const ownsRoutingIds = this.ownsProvisionalRoutingIds(routingIds, routingOwner)
        if (provisionGeneration !== this.provisionalGeneration) {
          this.revokeProvisional({
            routingIds: [
              routingIds.artifact,
              routingIds.notebook,
              routingIds.skillImport,
              routingIds.plan,
              routingIds.sideChat
            ],
            usedHttpTransport:
              ownsRoutingIds &&
              (request.policy.role === 'side-chat' || !request.framework.acceptsStdioMcp),
            notebookSessionId: routingIds.notebook || undefined,
            notebookRelease,
            skillImportRelease,
            planRelease,
            ownsStableIdentity: ownsRoutingIds
          })
          this.finishProvisionalRoutingOwner(routingIds, routingOwner)
          throw new Error('ACP session capability provision was superseded.')
        }
        if (!ownsRoutingIds) {
          this.revokeProvisional({
            routingIds: [],
            usedHttpTransport: false,
            notebookSessionId: routingIds.notebook || undefined,
            notebookRelease,
            skillImportRelease,
            planRelease,
            ownsStableIdentity: false
          })
          this.finishProvisionalRoutingOwner(routingIds, routingOwner)
          throw new Error('ACP session capability provision was superseded.')
        }
        this.commit({
          appSessionId,
          routingIds,
          descriptor: built.descriptor,
          notebookRelease,
          skillImportRelease,
          planRelease
        })
        this.finishProvisionalRoutingOwner(routingIds, routingOwner)
      },
      release: (ownershipFacts: SessionCapabilityOwnershipFacts): void => {
        if (terminal) return
        terminal = true
        const ownsStableIdentity =
          ownershipFacts.ownsStableIdentity &&
          this.ownsProvisionalRoutingIds(routingIds, routingOwner)
        this.revokeProvisional({
          routingIds: [
            routingIds.artifact,
            routingIds.notebook,
            routingIds.skillImport,
            routingIds.plan,
            routingIds.sideChat
          ],
          usedHttpTransport:
            ownsStableIdentity &&
            (request.policy.role === 'side-chat' || !request.framework.acceptsStdioMcp),
          notebookSessionId: routingIds.notebook || undefined,
          notebookRelease,
          skillImportRelease,
          planRelease,
          ownsStableIdentity
        })
        this.finishProvisionalRoutingOwner(routingIds, routingOwner)
      }
    })
  }

  private createRoutingIds(stableAppSessionId?: string): SessionCapabilityRoutingIds {
    if (stableAppSessionId) {
      return Object.freeze({
        artifact: this.options.artifacts ? stableAppSessionId : '',
        notebook: this.options.notebook ? stableAppSessionId : '',
        skillImport: this.options.skillImport ? stableAppSessionId : '',
        plan: this.options.plan ? stableAppSessionId : '',
        sideChat: this.options.sideChat ? stableAppSessionId : ''
      })
    }

    const timestamp = Date.now()
    if (this.options.artifacts) this.artifactSessionSequence += 1
    if (this.options.notebook) this.notebookSessionSequence += 1
    if (this.options.skillImport) this.skillImportSessionSequence += 1
    if (this.options.plan) this.planSessionSequence += 1
    if (this.options.sideChat) this.sideChatSessionSequence += 1

    return Object.freeze({
      artifact: this.options.artifacts
        ? `artifact-session-${timestamp}-${this.artifactSessionSequence}`
        : '',
      notebook: this.options.notebook
        ? `notebook-session-${timestamp}-${this.notebookSessionSequence}`
        : '',
      skillImport: this.options.skillImport
        ? `skill-import-session-${timestamp}-${this.skillImportSessionSequence}`
        : '',
      plan: this.options.plan ? `plan-session-${timestamp}-${this.planSessionSequence}` : '',
      sideChat: this.options.sideChat
        ? `side-chat-session-${timestamp}-${this.sideChatSessionSequence}`
        : ''
    })
  }

  private async build(request: BuildSessionCapabilitiesRequest): Promise<BuiltSessionCapabilities> {
    const transport =
      request.policy.role === 'side-chat'
        ? this.options.mcpHttpHost
          ? 'http'
          : 'none'
        : request.framework.acceptsStdioMcp
          ? 'stdio'
          : this.options.mcpHttpHost
            ? 'http'
            : 'none'
    const artifactsAllowed =
      policyAllowsSessionCapability(request.policy, 'artifacts') &&
      (request.nativeMcpEnabled || request.bridgeMcpAliasesEnabled)
    const notebookAllowed = policyAllowsSessionCapability(request.policy, 'notebook')
    const skillImportAllowed = policyAllowsSessionCapability(request.policy, 'skill-import')
    const planAllowed = policyAllowsSessionCapability(request.policy, 'plan')
    const hostMessageAllowed = policyAllowsSessionCapability(request.policy, 'host-message')

    const servers =
      transport === 'stdio'
        ? await this.buildStdioServers(request, {
            artifacts: artifactsAllowed,
            notebook: notebookAllowed,
            skillImport: skillImportAllowed,
            plan: planAllowed,
            hostMessage: hostMessageAllowed
          })
        : transport === 'http'
          ? await this.buildHttpServers(request, {
              artifacts: artifactsAllowed,
              notebook: notebookAllowed,
              skillImport: skillImportAllowed,
              plan: planAllowed,
              hostMessage: hostMessageAllowed
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
    if (canonicalMcpServerNames.includes(PLAN_MCP_SERVER_NAME)) capabilities.push('plan')
    if (canonicalMcpServerNames.includes(HOST_MESSAGE_MCP_SERVER_NAME)) {
      capabilities.push('host-message')
    }
    if (
      capabilities.includes('notebook') &&
      policyAllowsSessionCapability(request.policy, 'host-agents')
    ) {
      capabilities.push('host-agents')
    }
    if (
      capabilities.includes('notebook') &&
      policyAllowsSessionCapability(request.policy, 'host-skills')
    ) {
      capabilities.push('host-skills')
    }
    if (
      capabilities.includes('notebook') &&
      policyAllowsSessionCapability(request.policy, 'host-frames')
    ) {
      capabilities.push('host-frames')
    }
    if (
      capabilities.includes('notebook') &&
      policyAllowsSessionCapability(request.policy, 'host-sessions')
    ) {
      capabilities.push('host-sessions')
    }
    if (
      capabilities.includes('notebook') &&
      policyAllowsSessionCapability(request.policy, 'host-llm')
    ) {
      capabilities.push('host-llm')
    }

    const descriptor = freezeDescriptor({
      role: request.policy.role,
      delegation: request.policy.delegation,
      transport: modelFacingServers.length > 0 ? transport : 'none',
      capabilities,
      canonicalMcpServerNames,
      modelFacingMcpServerNames,
      controlRpcMethods:
        capabilities.includes('host-agents') ||
        capabilities.includes('host-skills') ||
        capabilities.includes('host-frames') ||
        capabilities.includes('host-sessions') ||
        capabilities.includes('host-llm')
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

  private commit(request: CommitSessionCapabilitiesRequest): void {
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
    if (routingIds.plan) {
      this.planRoutingIds.set(appSessionId, routingIds.plan)
      this.registerAlias(
        'plan',
        routingIds.plan,
        appSessionId,
        this.options.plan?.registerSessionAlias
      )
    }
    if (routingIds.sideChat) this.sideChatRoutingIds.set(appSessionId, routingIds.sideChat)
    this.descriptors.set(appSessionId, descriptor)
    this.committedSessionIds.add(appSessionId)
    this.commitNotebookRelease(appSessionId, request.notebookRelease)
    this.commitSkillImportRelease(appSessionId, request.skillImportRelease)
    this.commitPlanRelease(appSessionId, request.planRelease)
  }

  private revokeProvisional(request: RevokeProvisionalSessionCapabilitiesRequest): void {
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
    if (request.planRelease) {
      try {
        request.planRelease()
      } catch (error) {
        safeLogError('provisional Plan capability cleanup failed', {
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
        this.skillImportRoutingIds.get(appSessionId),
        this.planRoutingIds.get(appSessionId),
        this.sideChatRoutingIds.get(appSessionId)
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
    this.planRoutingIds.delete(appSessionId)
    this.sideChatRoutingIds.delete(appSessionId)
    this.descriptors.delete(appSessionId)
    this.committedSessionIds.delete(appSessionId)
    this.releaseCommittedNotebookCapability(appSessionId)
    this.releaseCommittedSkillImportCapability(appSessionId)
    this.releaseCommittedPlanCapability(appSessionId)
    this.releaseSessionCapabilities(appSessionId)
  }

  dispose(sessionIds: Iterable<string> = []): void {
    this.provisionalGeneration += 1
    const ownedSessionIds = new Set([
      ...sessionIds,
      ...this.artifactRoutingIds.keys(),
      ...this.notebookRoutingIds.keys(),
      ...this.skillImportRoutingIds.keys(),
      ...this.planRoutingIds.keys(),
      ...this.sideChatRoutingIds.keys(),
      ...this.notebookCapabilityReleases.keys(),
      ...this.skillImportCapabilityReleases.keys(),
      ...this.planCapabilityReleases.keys(),
      ...this.descriptors.keys(),
      ...this.committedSessionIds
    ])
    for (const sessionId of ownedSessionIds) {
      this.releaseCommittedNotebookCapability(sessionId)
      this.releaseCommittedSkillImportCapability(sessionId)
      this.releaseCommittedPlanCapability(sessionId)
      this.releaseSessionCapabilities(sessionId)
    }
    this.artifactRoutingIds.clear()
    this.notebookRoutingIds.clear()
    this.skillImportRoutingIds.clear()
    this.planRoutingIds.clear()
    this.sideChatRoutingIds.clear()
    this.notebookCapabilityReleases.clear()
    this.skillImportCapabilityReleases.clear()
    this.planCapabilityReleases.clear()
    this.descriptors.clear()
    this.committedSessionIds.clear()
    // In-flight provisions retain terminal cleanup ownership across teardown. A same-id successor
    // supersedes that ownership when it starts provisioning.
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
    plan: boolean
    hostAgents: boolean
    hostSkills: boolean
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
      plan:
        transportAvailable &&
        Boolean(this.options.plan) &&
        policyAllowsSessionCapability(input.policy, 'plan'),
      hostAgents: notebook && policyAllowsSessionCapability(input.policy, 'host-agents'),
      hostSkills: notebook && policyAllowsSessionCapability(input.policy, 'host-skills')
    })
  }

  private async buildArtifactEnvironment(
    routingId: string,
    sessionCwd: string,
    projectId: string
  ): Promise<ArtifactMcpEnvironment | undefined> {
    if (!this.options.artifacts || !routingId) return undefined
    const connection = await this.options.artifacts.getRpcConnection?.()
    return {
      storageRoot: this.options.artifacts.dataRoot,
      projectId: projectId,
      sessionId: routingId,
      currentRunFile:
        this.options.artifacts.currentRunFile ??
        getArtifactCurrentRunFilePath(this.options.artifacts.dataRoot, projectId, routingId),
      allowedImportRoots: [sessionCwd],
      rpcEndpoint: connection?.endpoint,
      rpcSocketPath: connection?.socketPath
    }
  }

  private async buildNotebookEnvironment(
    routingId: string,
    sessionCwd: string,
    projectId: string,
    onConnection?: (connection: NotebookRpcConnection) => void
  ): Promise<NotebookMcpEnvironment | undefined> {
    if (!this.options.notebook || !routingId) return undefined
    if (!this.options.notebook.getRpcConnection) {
      throw new Error('Notebook runtime RPC connection is not configured.')
    }
    const connection = await this.options.notebook.getRpcConnection({
      sessionId: routingId,
      projectId: projectId
    })
    onConnection?.(connection)
    return {
      endpoint: connection.endpoint,
      socketPath: connection.socketPath,
      token: connection.token,
      projectId: projectId,
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

  private async buildPlanEnvironment(
    routingId: string,
    projectId: string,
    onConnection?: (connection: NotebookRpcConnection) => void
  ): Promise<PlanMcpEnvironment | undefined> {
    if (!this.options.plan || !routingId) return undefined
    const connection = await this.options.plan.getRpcConnection({ sessionId: routingId, projectId })
    onConnection?.(connection)
    return { ...connection, projectId, sessionId: routingId }
  }

  private async buildStdioServers(
    request: BuildSessionCapabilitiesRequest,
    enabled: {
      artifacts: boolean
      notebook: boolean
      skillImport: boolean
      plan: boolean
      hostMessage: boolean
    }
  ): Promise<McpServer[]> {
    const servers: McpServer[] = []
    if (enabled.artifacts) {
      const environment = await this.buildArtifactEnvironment(
        request.routingIds.artifact,
        request.sessionCwd,
        request.projectId
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
        request.projectId,
        request.onNotebookConnection
      )
      if (environment && this.options.notebook) {
        servers.push(
          createNotebookMcpServerConfig({
            command: this.options.notebook.mcpCommand ?? process.execPath,
            entryPath: this.options.notebook.mcpEntryPath,
            memoryTools: this.options.notebook.memoryTools ?? true,
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
    if (enabled.plan) {
      const environment = await this.buildPlanEnvironment(
        request.routingIds.plan,
        request.projectId,
        request.onPlanConnection
      )
      if (environment && this.options.plan) {
        servers.push(
          createPlanMcpServerConfig({
            command: this.options.plan.mcpCommand ?? process.execPath,
            entryPath: this.options.plan.mcpEntryPath,
            ...environment
          })
        )
      }
    }
    return servers
  }

  private async buildHttpServers(
    request: BuildSessionCapabilitiesRequest,
    enabled: {
      artifacts: boolean
      notebook: boolean
      skillImport: boolean
      plan: boolean
      hostMessage: boolean
    }
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
        request.projectId
      )
      if (environment && this.canPublishHttpRoute(request)) {
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
        request.projectId,
        request.onNotebookConnection
      )
      if (environment && this.options.notebook && this.canPublishHttpRoute(request)) {
        host.registerNotebook(request.routingIds.notebook, {
          ...environment,
          memoryTools: this.options.notebook.memoryTools ?? true
        })
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
      if (environment && this.canPublishHttpRoute(request)) {
        host.registerSkillImport(request.routingIds.skillImport, environment)
        servers.push({
          type: 'http',
          name: SKILL_IMPORT_MCP_SERVER_NAME,
          url: host.urlFor('skill-import', request.routingIds.skillImport),
          headers: [authHeader]
        })
      }
    }
    if (enabled.plan) {
      const environment = await this.buildPlanEnvironment(
        request.routingIds.plan,
        request.projectId,
        request.onPlanConnection
      )
      if (environment && this.canPublishHttpRoute(request)) {
        host.registerPlan(request.routingIds.plan, environment)
        servers.push({
          type: 'http',
          name: PLAN_MCP_SERVER_NAME,
          url: host.urlFor('plan', request.routingIds.plan),
          headers: [authHeader]
        })
      }
    }
    if (enabled.hostMessage && this.options.sideChat && this.canPublishHttpRoute(request)) {
      const routingId = request.routingIds.sideChat
      host.registerHostMessage(routingId, {
        sendMessage: (input) => this.options.sideChat!.sendMessage(routingId, input)
      })
      servers.push({
        type: 'http',
        name: HOST_MESSAGE_MCP_SERVER_NAME,
        url: host.urlFor('host-message', routingId),
        headers: [authHeader]
      })
    }
    return servers
  }

  private canPublishHttpRoute(request: BuildSessionCapabilitiesRequest): boolean {
    return (
      request.provisionGeneration === this.provisionalGeneration &&
      this.ownsProvisionalRoutingIds(request.routingIds, request.routingOwner)
    )
  }

  private trackProvisionalRoutingOwner(routingIds: SessionCapabilityRoutingIds): object {
    const owner = {}
    for (const routingId of new Set(Object.values(routingIds))) {
      if (routingId) this.provisionalRoutingOwners.set(routingId, owner)
    }
    return owner
  }

  private ownsProvisionalRoutingIds(
    routingIds: SessionCapabilityRoutingIds,
    owner: object
  ): boolean {
    for (const routingId of new Set(Object.values(routingIds))) {
      if (routingId && this.provisionalRoutingOwners.get(routingId) !== owner) return false
    }
    return true
  }

  private finishProvisionalRoutingOwner(
    routingIds: SessionCapabilityRoutingIds,
    owner: object
  ): void {
    for (const routingId of new Set(Object.values(routingIds))) {
      if (routingId && this.provisionalRoutingOwners.get(routingId) === owner) {
        this.provisionalRoutingOwners.delete(routingId)
      }
    }
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

  private commitPlanRelease(sessionId: string, release: (() => void) | undefined): void {
    const previousRelease = this.planCapabilityReleases.get(sessionId)
    if (previousRelease === release) return
    if (release) this.planCapabilityReleases.set(sessionId, release)
    else this.planCapabilityReleases.delete(sessionId)
    try {
      previousRelease?.()
    } catch (error) {
      safeLogError('replaced Plan capability cleanup failed', {
        ...diagnosticErrorFields(error),
        sessionId
      })
    }
  }

  private releaseCommittedPlanCapability(sessionId: string): void {
    const release = this.planCapabilityReleases.get(sessionId)
    this.planCapabilityReleases.delete(sessionId)
    try {
      release?.()
    } catch (error) {
      safeLogError('committed Plan capability cleanup failed', {
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
