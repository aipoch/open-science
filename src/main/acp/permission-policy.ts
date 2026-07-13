import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { isAbsolute, relative, resolve } from 'node:path'

import type {
  PermissionAutoReviewStrategy,
  PermissionProfileId
} from '../../shared/permission-profiles'

type PermissionPolicyContext = {
  profile: PermissionProfileId
  autoReviewStrategy?: PermissionAutoReviewStrategy
  cwd?: string
}

const ALLOW_OPTION_KINDS = new Set(['allow_once', 'allow_always'])

// Tests whether a tool-reported path stays within the workspace after resolving relative paths.
const isWithinWorkspace = (path: string, cwd: string): boolean => {
  const workspace = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(workspace, path)
  const relation = relative(workspace, target)

  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

// Conservative cross-model fallback used only when the Agent does not advertise native auto review.
// It never interprets model prose or shell source. Only explicitly located, workspace-contained
// read/search/edit operations and side-effect-free thinking can pass without user review.
const canConservativelyAutoApprove = (
  params: RequestPermissionRequest,
  cwd: string | undefined
): boolean => {
  const { kind, locations } = params.toolCall

  if (kind === 'think') return true
  if (!cwd || !locations || locations.length === 0) return false
  if (kind !== 'read' && kind !== 'search' && kind !== 'edit') return false

  return locations.every((location) => isWithinWorkspace(location.path, cwd))
}

const resolveAllowOptionId = (params: RequestPermissionRequest): string | undefined =>
  params.options.find((option) => ALLOW_OPTION_KINDS.has(option.kind.toLowerCase()))?.optionId

// Returns an option only when the application can make a provider-neutral, fail-closed decision.
// Native auto mode reviews inside the Agent; any request it escalates still belongs in the UI.
const resolveAutomaticPermission = (
  params: RequestPermissionRequest,
  context: PermissionPolicyContext | undefined
): string | undefined => {
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
