import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { isAbsolute, relative, resolve } from 'node:path'

import type {
  PermissionAutoReviewStrategy,
  PermissionProfileId
} from '../../shared/permission-profiles'
import type { AgentFrameworkId } from '../../shared/settings'
import {
  ACTIVITY_GROUP_MCP_SERVER_NAME,
  isActivityGroupToolEvent
} from '../../shared/activity-groups'
import { extractProviderToolName } from './runtime-events'

type PermissionPolicyContext = {
  profile: PermissionProfileId
  frameworkId?: AgentFrameworkId
  autoReviewStrategy?: PermissionAutoReviewStrategy
  cwd?: string
  // Agent-visible MCP server names, so MCP tools can be recognized across frameworks (see isMcpToolName).
  mcpServerNames?: readonly string[]
}

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
      const tool = MCP_PROVIDER_LEAF_ALIASES[server]?.[name]
      return tool ? [`${server}/${tool}`] : []
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
    mcpServerNames.some(
      (server) =>
        name === server ||
        name.startsWith(`${CODEX_MCP_TOOL_PREFIX}${server}.`) ||
        name.startsWith(`${server}_`) ||
        MCP_PROVIDER_LEAF_ALIASES[server]?.[name] != null
    ))

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
  isWithinWorkspace,
  resolveMcpProviderLeafIdentity,
  resolveAutomaticPermission,
  resolveAllowOptionId
}
export type { PermissionPolicyContext }
