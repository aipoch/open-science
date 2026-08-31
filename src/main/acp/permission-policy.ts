import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { isAbsolute, relative, resolve } from 'node:path'

import type {
  PermissionAutoReviewStrategy,
  PermissionProfileId
} from '../../shared/permission-profiles'
import type { AgentFrameworkId } from '../../shared/settings'
import type { CommandShellDialect } from '../agent-framework/types'
import {
  ACTIVITY_GROUP_MCP_SERVER_NAME,
  isActivityGroupToolEvent
} from '../../shared/activity-groups'
import { extractProviderToolName } from './runtime-events'
import {
  appMcpServerAliases,
  canonicalAppMcpServerName,
  resolveCanonicalMcpToolIdentity
} from '../agent-framework/app-mcp-names'

type PermissionPolicyContext = {
  profile: PermissionProfileId
  projectId?: string
  // Delegated runtimes have a provider-local Session id, while durable grants belong to the parent
  // app Session. Keep that owner identity separate from the request routing identity.
  permissionGrantSessionId?: string
  frameworkId?: AgentFrameworkId
  shellDialect?: CommandShellDialect
  autoReviewStrategy?: PermissionAutoReviewStrategy
  cwd?: string
  // Canonical MCP server names, so framework-visible tools can resolve to stable policy identities.
  mcpServerNames?: readonly string[]
  // Main-owned identity of the user Message whose provider turn is parked on this request.
  promptMessageId?: string
}

const TRUSTED_MCP_TOOL_IDENTITY = Symbol('trusted-mcp-tool-identity')
const TRUSTED_NATIVE_TOOL_IDENTITY = Symbol('trusted-native-tool-identity')
type TrustedMcpPermissionRequest = RequestPermissionRequest & {
  [TRUSTED_MCP_TOOL_IDENTITY]?: string
}
type TrustedNativePermissionRequest = RequestPermissionRequest & {
  [TRUSTED_NATIVE_TOOL_IDENTITY]?: string
}

// Carries a runtime-verified MCP identity across the broker without serializing it back to ACP. A
// symbol key cannot be supplied by provider JSON, while its enumerable value survives the broker's
// options projection spread before automatic policy resolution.
const withTrustedMcpToolIdentity = (
  params: RequestPermissionRequest,
  identity: string
): RequestPermissionRequest => Object.assign({}, params, { [TRUSTED_MCP_TOOL_IDENTITY]: identity })

const trustedMcpToolIdentity = (params: RequestPermissionRequest): string | undefined =>
  (params as TrustedMcpPermissionRequest)[TRUSTED_MCP_TOOL_IDENTITY]

// Marks a provider-native tool only after the runtime binds its preceding tool_call to the later
// request_permission by session and call id. ACP JSON cannot forge this process-local Symbol.
const withTrustedNativeToolIdentity = (
  params: RequestPermissionRequest,
  identity: string
): RequestPermissionRequest =>
  Object.assign({}, params, { [TRUSTED_NATIVE_TOOL_IDENTITY]: identity })

const trustedNativeToolIdentity = (params: RequestPermissionRequest): string | undefined =>
  (params as TrustedNativePermissionRequest)[TRUSTED_NATIVE_TOOL_IDENTITY]

// MCP tool naming differs per framework: Claude Code namespaces them mcp__<server>__<tool>, Codex
// reports mcp.<server>.<tool>, and opencode joins them <server>_<tool>. Claude's distinctive prefix is
// self-identifying; the shorter Codex/opencode forms are checked against known session servers.
const MCP_TOOL_PREFIX = 'mcp__'
const CODEX_MCP_TOOL_PREFIX = 'mcp.'
const MCP_PROVIDER_LEAF_ALIASES: Record<string, Readonly<Record<string, string>>> = {
  'open-science-notebook': { execute: 'notebook_execute' },
  'open-science-artifacts': { write: 'write_artifact_file' },
  'open-science-activity': { begin_activity_group: 'begin_activity_group' }
}

// Resolves provider leaf aliases only when the configured server set identifies exactly one app-owned
// MCP tool. Ambiguous leaf names remain MCP for conservative policy, but are not stable enough to grant.
const resolveMcpProviderLeafIdentity = (
  name: string | null | undefined,
  mcpServerNames: readonly string[]
): string | undefined => {
  if (!name) return undefined

  const identities = new Set(
    mcpServerNames.flatMap((server) => {
      const canonicalServer = canonicalAppMcpServerName(server)
      const tool = MCP_PROVIDER_LEAF_ALIASES[canonicalServer]?.[name]
      return tool ? [`${canonicalServer}/${tool}`] : []
    })
  )

  return identities.size === 1 ? identities.values().next().value : undefined
}

// Recognizes an MCP-originated tool name across frameworks (see MCP_TOOL_PREFIX): Claude's mcp__ prefix,
// or a known MCP server name used as the tool's own prefix (opencode's <server>_<tool>).
const isMcpToolName = (
  name: string | null | undefined,
  mcpServerNames: readonly string[]
): boolean =>
  name != null &&
  (name.startsWith(MCP_TOOL_PREFIX) ||
    resolveCanonicalMcpToolIdentity(name, mcpServerNames) != null ||
    mcpServerNames.some((server) => {
      const canonicalServer = canonicalAppMcpServerName(server)
      return (
        appMcpServerAliases(canonicalServer).includes(name) ||
        name.startsWith(`${CODEX_MCP_TOOL_PREFIX}${canonicalServer}.`) ||
        MCP_PROVIDER_LEAF_ALIASES[canonicalServer]?.[name] != null
      )
    }))

// Tests whether a tool-reported path stays within the workspace after resolving relative paths.
const isWithinWorkspace = (path: string, cwd: string): boolean => {
  const workspace = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(workspace, path)
  const relation = relative(workspace, target)

  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

// MCP tools can report a benign kind (read/edit) while performing arbitrary side effects, so the
// conservative fallback treats any MCP-originated call as out of scope regardless of its kind.
const isMcpTool = (
  params: RequestPermissionRequest,
  mcpServerNames: readonly string[]
): boolean => {
  const { toolCall } = params
  const providerToolName = extractProviderToolName(toolCall)

  return (
    isMcpToolName(toolCall.title, mcpServerNames) || isMcpToolName(providerToolName, mcpServerNames)
  )
}

// Conservative cross-model fallback used only when the Agent does not advertise native auto review.
// It never interprets model prose or shell source. Only explicitly located, workspace-contained
// read/search/edit operations and side-effect-free thinking can pass without user review.
const canConservativelyAutoApprove = (
  params: RequestPermissionRequest,
  cwd: string | undefined,
  mcpServerNames: readonly string[] = []
): boolean => {
  const { kind, locations } = params.toolCall

  if (isMcpTool(params, mcpServerNames)) return false
  if (kind === 'think') return true
  if (!cwd || !locations || locations.length === 0) return false
  if (kind !== 'read' && kind !== 'search' && kind !== 'edit') return false

  return locations.every((location) => isWithinWorkspace(location.path, cwd))
}

// The fallback grants a single-use approval only. It never selects allow_always, so an automatic
// decision can never silently escalate a category to session-persistent access inside the Agent.
const resolveAllowOptionId = (params: RequestPermissionRequest): string | undefined =>
  params.options.find((option) => option.kind.toLowerCase() === 'allow_once')?.optionId

// OpenCode's native Skill tool only reads an app-provisioned skill definition into the model's
// context. It is framework plumbing rather than a user-authorizable side effect. Older OpenCode
// sessions can still emit request_permission, so the runtime binds that request to a preceding native
// tool_call and attaches the process-local identity below. Presentation text alone is never trusted.
const isOpenCodeNativeSkillPermission = (
  params: RequestPermissionRequest,
  context: PermissionPolicyContext | undefined
): boolean => {
  if (context?.frameworkId !== 'opencode' || params.toolCall.kind !== 'other') return false
  if (trustedNativeToolIdentity(params) !== 'opencode/skill') return false

  const title = params.toolCall.title?.trim().toLowerCase()
  const providerToolName = extractProviderToolName(params.toolCall)?.trim().toLowerCase()

  return title === 'skill' && (providerToolName == null || providerToolName === 'skill')
}

const isArtifactSaveTool = (
  params: RequestPermissionRequest,
  mcpServerNames: readonly string[]
): boolean => {
  if (!mcpServerNames.map(canonicalAppMcpServerName).includes('open-science-artifacts'))
    return false

  // title is presentation text controlled by the Agent and cannot prove which provider capability
  // ACP is asking to execute. Only framework metadata supplied with the tool call may claim the
  // no-prompt Artifact save exception.
  const providerToolName = extractProviderToolName(params.toolCall)
  if (!providerToolName) return false

  const trustedMcpIdentity = trustedMcpToolIdentity(params)

  return (
    trustedMcpIdentity === 'open-science-artifacts/write_artifact_file' ||
    resolveCanonicalMcpToolIdentity(providerToolName, mcpServerNames) ===
      'open-science-artifacts/write_artifact_file' ||
    resolveMcpProviderLeafIdentity(providerToolName, mcpServerNames) ===
      'open-science-artifacts/write_artifact_file'
  )
}

const APP_INTERACTION_TOOLS = new Set([
  'open-science-notebook/ask_user_question',
  'open-science-notebook/request_network_access'
])

const isAppInteractionTool = (
  params: RequestPermissionRequest,
  context: PermissionPolicyContext | undefined
): boolean => {
  const mcpServerNames = context?.mcpServerNames
  if (!mcpServerNames) return false
  if (!mcpServerNames.map(canonicalAppMcpServerName).includes('open-science-notebook')) return false

  if (APP_INTERACTION_TOOLS.has(trustedMcpToolIdentity(params) ?? '')) return true
  if (context.frameworkId === 'codex') return false

  const providerToolName = extractProviderToolName(params.toolCall)
  if (!providerToolName) return false

  return APP_INTERACTION_TOOLS.has(
    resolveCanonicalMcpToolIdentity(providerToolName, mcpServerNames) ?? ''
  )
}

// Returns an option only when the application can make a provider-neutral decision. Full access is the
// user's explicit, dialog-confirmed choice, so it auto-approves everything (for frameworks that delegate
// permissions rather than bypassing natively — a native-bypass agent sends no requests here at all).
// Otherwise, only native-less 'auto' conservatively approves workspace-contained low-risk operations.
const resolveAutomaticPermission = (
  params: RequestPermissionRequest,
  context: PermissionPolicyContext | undefined
): string | undefined => {
  if (context?.profile === 'full') {
    return resolveAllowOptionId(params)
  }

  if (isOpenCodeNativeSkillPermission(params, context)) {
    return resolveAllowOptionId(params)
  }

  // Asking the user is itself the authorization boundary: the call cannot execute code or mutate
  // external state, and it remains blocked until the renderer answers or cancels it. Do not insert a
  // redundant permission card before the actual choice card.
  if (isAppInteractionTool(params, context)) {
    return resolveAllowOptionId(params)
  }

  // Saving an already-existing/inline result into the exact app-owned Artifact capability is part
  // of normal turn finalization. It cannot execute code or choose Project/Session ownership, so it
  // receives one call-scoped allow decision under every profile without showing an approval card.
  if (context?.mcpServerNames && isArtifactSaveTool(params, context.mcpServerNames)) {
    return resolveAllowOptionId(params)
  }

  // The declaration exception must be bound to a server-qualified tool identity. rawInput is
  // agent-controlled arguments and cannot prove which tool the permission request will execute.
  if (
    context?.mcpServerNames?.includes(ACTIVITY_GROUP_MCP_SERVER_NAME) &&
    isActivityGroupToolEvent({
      title: params.toolCall.title ?? undefined,
      providerToolName: extractProviderToolName(params.toolCall)
    })
  ) {
    return resolveAllowOptionId(params)
  }

  if (
    context?.profile !== 'auto' ||
    context.autoReviewStrategy !== 'conservative' ||
    !canConservativelyAutoApprove(params, context.cwd, context.mcpServerNames)
  ) {
    return undefined
  }

  return resolveAllowOptionId(params)
}

export {
  canConservativelyAutoApprove,
  isMcpToolName,
  isArtifactSaveTool,
  isWithinWorkspace,
  resolveMcpProviderLeafIdentity,
  resolveAutomaticPermission,
  resolveAllowOptionId,
  trustedMcpToolIdentity,
  withTrustedNativeToolIdentity,
  withTrustedMcpToolIdentity
}
export type { PermissionPolicyContext }
