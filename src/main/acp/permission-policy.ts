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
}

// Claude Code namespaces MCP tools as mcp__<server>__<tool>; the prefix surfaces in both the
// permission title and the provider tool name, so either is enough to identify an MCP origin.
const MCP_TOOL_PREFIX = 'mcp__'

// Tests whether a tool-reported path stays within the workspace after resolving relative paths.
const isWithinWorkspace = (path: string, cwd: string): boolean => {
  const workspace = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(workspace, path)
  const relation = relative(workspace, target)

  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

// MCP tools can report a benign kind (read/edit) while performing arbitrary side effects, so the
// conservative fallback treats any MCP-originated call as out of scope regardless of its kind.
const isMcpTool = (params: RequestPermissionRequest): boolean => {
  const { toolCall } = params
  const providerToolName = extractProviderToolName(toolCall)

  return (
    toolCall.title?.startsWith(MCP_TOOL_PREFIX) === true ||
    providerToolName?.startsWith(MCP_TOOL_PREFIX) === true
  )
}

// Conservative cross-model fallback used only when the Agent does not advertise native auto review.
// It never interprets model prose or shell source. Only explicitly located, workspace-contained
// read/search/edit operations and side-effect-free thinking can pass without user review.
const canConservativelyAutoApprove = (
  params: RequestPermissionRequest,
  cwd: string | undefined
): boolean => {
  const { kind, locations } = params.toolCall

  if (isMcpTool(params)) return false
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
    !canConservativelyAutoApprove(params, context.cwd)
  ) {
    return undefined
  }

  return resolveAllowOptionId(params)
}

export {
  canConservativelyAutoApprove,
  isWithinWorkspace,
  resolveAutomaticPermission,
  resolveAllowOptionId
}
export type { PermissionPolicyContext }
