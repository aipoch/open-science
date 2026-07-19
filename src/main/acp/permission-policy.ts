import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { isAbsolute, relative, resolve } from 'node:path'

import type {
  PermissionAutoReviewStrategy,
  PermissionProfileId
} from '../../shared/permission-profiles'
import { extractProviderToolName } from './runtime-events'

type PermissionPolicyContext = {
  profile: PermissionProfileId
  autoReviewStrategy?: PermissionAutoReviewStrategy
  cwd?: string
  // Agent-visible MCP server names, so MCP tools can be recognized across frameworks (see isMcpToolName).
  mcpServerNames?: readonly string[]
}

// MCP tool naming differs per framework: Claude Code namespaces them mcp__<server>__<tool>, while
// opencode joins them <server>_<tool>. The mcp__ prefix identifies Claude's regardless of server;
// opencode's are recognized against the session's known MCP server names.
const MCP_TOOL_PREFIX = 'mcp__'
const MCP_PROVIDER_LEAF_NAMES: Record<string, readonly string[]> = {
  'open-science-notebook': ['execute'],
  'open-science-artifacts': ['write']
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
        name.startsWith(`${server}_`) ||
        MCP_PROVIDER_LEAF_NAMES[server]?.includes(name)
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

// Full access approves anything the agent asks. Prefer a one-shot allow so the app keeps deciding each
// call; fall back to allow_always only when the agent offers no one-shot option, so a run never stalls.
const resolveFullAccessAllowOptionId = (params: RequestPermissionRequest): string | undefined =>
  resolveAllowOptionId(params) ??
  params.options.find((option) => option.kind.toLowerCase() === 'allow_always')?.optionId

// Returns an option only when the application can make a provider-neutral decision. Full access is the
// user's explicit, dialog-confirmed choice, so it auto-approves everything (for frameworks that delegate
// permissions rather than bypassing natively — a native-bypass agent sends no requests here at all).
// Otherwise, only native-less 'auto' conservatively approves workspace-contained low-risk operations.
const resolveAutomaticPermission = (
  params: RequestPermissionRequest,
  context: PermissionPolicyContext | undefined
): string | undefined => {
  if (context?.profile === 'full') {
    return resolveFullAccessAllowOptionId(params)
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
  resolveAutomaticPermission,
  resolveAllowOptionId
}
export type { PermissionPolicyContext }
