import type { AcpPermissionRequest } from '../../../../shared/acp'

import {
  matchNotebookControlTool,
  resolveNotebookLanguage,
  resolveNotebookRunToolName
} from './notebook-tool-names'
import {
  buildLiteratureToolSummary,
  isLiteratureReadDocumentTool
} from './literature-tool-presentation'

type NotebookRuntime = 'python' | 'r' | 'js' | 'bash'

type PermissionPresentation = {
  actionTitle: string
  actionTitleKey?: string
  actionTitleValues?: Record<string, string>
  categoryLabel: string
  description: string
  actionDetail?: string
  hideToolIdentity?: boolean
  notebookRuntime?: NotebookRuntime
}

type RequestInput = Record<string, unknown>

const getRequestInput = (request: AcpPermissionRequest): RequestInput | undefined => {
  const raw = request.rawInput
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined

  const record = raw as RequestInput
  const nested = record.arguments
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as RequestInput)
    : record
}

const getCode = (input: RequestInput | undefined): string | undefined => {
  for (const key of ['code', 'command', 'script']) {
    const value = input?.[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

const toNotebookRuntime = (language: string): NotebookRuntime => {
  if (language === 'r') return 'r'
  if (language === 'javascript') return 'js'
  if (language === 'bash') return 'bash'
  return 'python'
}

const notebookExecutionPresentation = (runtime: NotebookRuntime): PermissionPresentation => {
  switch (runtime) {
    case 'r':
      return {
        actionTitle: 'Run R code?',
        categoryLabel: 'R execution',
        description: 'Runs code in the current R notebook environment.',
        notebookRuntime: runtime
      }
    case 'js':
      return {
        actionTitle: 'Run JS code?',
        categoryLabel: 'JS REPL',
        description: 'Runs code in the current JavaScript REPL.',
        notebookRuntime: runtime
      }
    case 'bash':
      return {
        actionTitle: 'Run notebook command?',
        categoryLabel: 'Notebook shell',
        description: 'Runs a shell command in the current notebook session.',
        notebookRuntime: runtime
      }
    default:
      return {
        actionTitle: 'Run Python code?',
        categoryLabel: 'Python execution',
        description: 'Runs code in the current Python notebook environment.',
        notebookRuntime: runtime
      }
  }
}

const notebookControlPresentation = (tool: string): PermissionPresentation => {
  switch (tool) {
    case 'notebook_restart':
      return {
        actionTitle: 'Restart notebook?',
        categoryLabel: 'Notebook control',
        description:
          'Restarts the current notebook environment. Running processes and unsaved runtime state may be lost.'
      }
    case 'notebook_shutdown':
      return {
        actionTitle: 'Shut down notebook?',
        categoryLabel: 'Notebook control',
        description: 'Stops the current notebook environment and its running processes.'
      }
    case 'notebook_state':
      return {
        actionTitle: 'View notebook state?',
        categoryLabel: 'Notebook control',
        description: 'Reads the current notebook environment and runtime state.'
      }
    case 'list_notebook_runtimes':
      return {
        actionTitle: 'View notebook runtimes?',
        categoryLabel: 'Notebook control',
        description: 'Lists the notebook runtimes available to this conversation.'
      }
    case 'notebook_bind_runtime':
    case 'notebook_switch_runtime':
      return {
        actionTitle: 'Change notebook runtime?',
        categoryLabel: 'Notebook control',
        description: 'Changes the runtime used by the current notebook session.'
      }
    case 'inspect_packages':
      return {
        actionTitle: 'View notebook packages?',
        categoryLabel: 'Notebook control',
        description:
          'Reads installed package names and versions from the bound app-managed runtime without changing it.'
      }
    case 'manage_packages':
      return {
        actionTitle: 'Manage notebook packages?',
        categoryLabel: 'Notebook control',
        description: 'Changes packages available in the current notebook environment.'
      }
    case 'manage_environments':
      return {
        actionTitle: 'Manage notebook environments?',
        categoryLabel: 'Notebook control',
        description: 'Changes notebook environment configuration.'
      }
    default:
      return {
        actionTitle: 'Use notebook controls?',
        categoryLabel: 'Notebook control',
        description: 'Changes or reads the current notebook environment.'
      }
  }
}

const providerToolName = (request: AcpPermissionRequest): string | undefined =>
  request.providerToolName?.trim() || undefined

// MCP origin is broker-classified. Do not infer it from provider titles here: dotted and sanitized
// spellings are ambiguous without the configured-server context available to the broker.
const isMcpPermissionRequest = (request: AcpPermissionRequest): boolean => request.isMcp === true

// Specialist approvals are app-owned requests parked on the ACP permission broker. Their payload is
// already redacted in main; recognize it here so the standard permission card names the requested
// operation (switch / delete) rather than presenting it as an opaque tool call.
const specialistApprovalPayload = (
  request: AcpPermissionRequest
): Record<string, unknown> | undefined => {
  const input = getRequestInput(request)
  const approval = input?.specialistApproval
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) return undefined
  return approval as Record<string, unknown>
}

const specialistSwitchPayload = (
  request: AcpPermissionRequest
): Record<string, unknown> | undefined => {
  const payload = specialistApprovalPayload(request)
  if (!payload || payload.kind !== 'switch') return undefined
  return payload
}

// Shared with the approval card so the switch request renders its friendly specialist detail
// block (never the raw redacted payload) exactly when this presentation applies.
const isSpecialistSwitchRequest = (request: AcpPermissionRequest): boolean =>
  specialistSwitchPayload(request) !== undefined

const specialistDeletePayload = (
  request: AcpPermissionRequest
): Record<string, unknown> | undefined => {
  const payload = specialistApprovalPayload(request)
  if (!payload || payload.kind !== 'delete') return undefined
  return payload
}

// Shared with the approval card so the delete request renders its friendly specialist detail
// block (never the raw redacted payload) exactly when this presentation applies.
const isSpecialistDeleteRequest = (request: AcpPermissionRequest): boolean =>
  specialistDeletePayload(request) !== undefined

const specialistHandoffPresentation = (
  request: AcpPermissionRequest
): PermissionPresentation | undefined => {
  const payload = specialistSwitchPayload(request)
  if (!payload) return undefined
  const targetName = typeof payload.targetName === 'string' ? payload.targetName : undefined
  const isMain = payload.targetName === null
  return {
    actionTitle: isMain ? 'Switch to Main Agent?' : `Switch to ${targetName ?? 'Specialist'}?`,
    ...(!isMain
      ? {
          actionTitleKey: 'Switch to {{name}}?',
          actionTitleValues: { name: targetName ?? 'Specialist' }
        }
      : {}),
    categoryLabel: 'Specialist handoff',
    description: 'Approval changes the active Specialist after the current control tool completes.',
    hideToolIdentity: true
  }
}

const specialistDeletePresentation = (
  request: AcpPermissionRequest
): PermissionPresentation | undefined => {
  const payload = specialistDeletePayload(request)
  if (!payload) return undefined
  const name = typeof payload.name === 'string' ? payload.name : undefined
  return {
    actionTitle: `Delete ${name ?? 'Specialist'}?`,
    actionTitleKey: 'Delete {{name}}?',
    actionTitleValues: { name: name ?? 'Specialist' },
    categoryLabel: 'Specialist delete',
    description:
      'Permanently removes the Specialist. Conversations still bound to it become unavailable and are not switched to Main Agent automatically.',
    hideToolIdentity: true
  }
}

const ARTIFACT_SERVER_SEGMENT = 'open-science-artifacts'
const ARTIFACT_WRITE_TOOL = 'write_artifact_file'
const PLAN_GENERATE_IDENTITY = 'open-science-plan/generate_plan'
const PLAN_UPDATE_STEP_STATUS_IDENTITY = 'open-science-plan/update_step_status'

const isArtifactWriteToolName = (toolName: string | undefined): boolean => {
  const name = toolName?.trim().toLowerCase() ?? ''
  if (!name) return false

  const segments = name.split(/__|\.|\//u)
  if (segments.length >= 2) {
    const tool = segments[segments.length - 1]
    const server = segments[segments.length - 2].replace(/_/gu, '-')
    if (server === ARTIFACT_SERVER_SEGMENT && tool === ARTIFACT_WRITE_TOOL) return true
  }

  return (
    name === `${ARTIFACT_SERVER_SEGMENT}_${ARTIFACT_WRITE_TOOL}` ||
    name === `open_science_artifacts_${ARTIFACT_WRITE_TOOL}`
  )
}

const isArtifactWriteRequest = (request: AcpPermissionRequest): boolean =>
  isMcpPermissionRequest(request) && isArtifactWriteToolName(request.mcpIdentity)

const isLiteratureReadRequest = (request: AcpPermissionRequest): boolean =>
  isMcpPermissionRequest(request) && isLiteratureReadDocumentTool(request.mcpIdentity)

const planPermissionPresentation = (
  request: AcpPermissionRequest
): PermissionPresentation | undefined => {
  if (!isMcpPermissionRequest(request)) return undefined

  switch (request.mcpIdentity) {
    case PLAN_GENERATE_IDENTITY:
      return {
        actionTitle: 'Allow Plan creation and recording your decisions?',
        categoryLabel: 'Plan control',
        description:
          'Creates Plans and records decisions you make during review. This Permission Grant never approves a Plan; you must approve each Plan separately.',
        hideToolIdentity: true
      }
    case PLAN_UPDATE_STEP_STATUS_IDENTITY:
      return {
        actionTitle: 'Allow updates to approved Plan progress?',
        categoryLabel: 'Plan control',
        description: 'Updates progress for an approved Plan. This does not approve Plans.',
        hideToolIdentity: true
      }
    default:
      return undefined
  }
}

const humanizeMcpName = (name: string | undefined): string | undefined => {
  const normalized = name?.trim().replace(/^mcp(?:__|\.)/iu, '') ?? ''
  if (!normalized || /^(?:run )?(?:mcp )?(?:tool|tool request|tool call)$/iu.test(normalized)) {
    return undefined
  }

  const segments = normalized
    .split(/__|\.|\//u)
    .filter(Boolean)
    .map((segment) =>
      segment
        .split(/[-_]/u)
        .filter(Boolean)
        .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
        .join(' ')
    )
    .filter(Boolean)

  return segments.length > 0 ? segments.join(' / ') : undefined
}

// The broker resolves a stable `server/tool` identity before the request reaches the renderer.
// Keep it in the impact tip so a human-readable provider title cannot obscure the granted tool.
const humanizeMcpIdentity = (identity: string | undefined): string | undefined =>
  humanizeMcpName(identity)

// A broker-classified MCP request can lack a stable grant identity (for example, a server-only
// request). Keep that approval distinguishable without trusting the name for a privileged category.
const humanizeUnresolvedMcp = (request: AcpPermissionRequest): string | undefined =>
  humanizeMcpName(providerToolName(request) ?? request.title)

const isNetworkTool = (request: AcpPermissionRequest): boolean => {
  const name = providerToolName(request)?.toLowerCase()
  return request.toolKind === 'fetch' || name === 'webfetch' || name === 'websearch'
}

const describePermissionRequest = (request: AcpPermissionRequest): PermissionPresentation => {
  const deletePresentation = specialistDeletePresentation(request)
  if (deletePresentation) return deletePresentation
  const specialistPresentation = specialistHandoffPresentation(request)
  if (specialistPresentation) return specialistPresentation
  const isMcp = isMcpPermissionRequest(request)
  const notebookToolName = isMcp ? resolveNotebookRunToolName(request.mcpIdentity) : undefined
  if (notebookToolName) {
    const input = getRequestInput(request)
    const language = resolveNotebookLanguage(notebookToolName, input, getCode(input))
    return { ...notebookExecutionPresentation(toNotebookRuntime(language)), hideToolIdentity: true }
  }

  const controlTool = isMcp ? matchNotebookControlTool(request.mcpIdentity) : undefined
  if (controlTool) return { ...notebookControlPresentation(controlTool), hideToolIdentity: true }

  if (isArtifactWriteRequest(request)) {
    return {
      actionTitle: 'Save as artifact?',
      categoryLabel: 'Artifact save',
      description: 'Saves a file as an artifact for this conversation.'
    }
  }

  if (isLiteratureReadRequest(request)) {
    const summary = buildLiteratureToolSummary(request.rawInput)
    return {
      actionTitle: summary.action === 'search' ? 'Search linked PDFs?' : 'Read linked PDF?',
      categoryLabel: 'Reading',
      description:
        summary.action === 'search'
          ? 'Searches the PDFs linked to this conversation for relevant passages without modifying them.'
          : 'Reads the PDF linked to this conversation without modifying it.',
      hideToolIdentity: true
    }
  }

  const planPresentation = planPermissionPresentation(request)
  if (planPresentation) return planPresentation

  // MCP metadata describes the provider's tool, not a trusted local capability. Only the
  // explicitly modeled notebook tools above receive a more specific native classification.
  if (isMcpPermissionRequest(request)) {
    const actionDetail = humanizeMcpIdentity(request.mcpIdentity) ?? humanizeUnresolvedMcp(request)
    return {
      actionTitle: actionDetail ? `Use ${actionDetail}?` : 'Use external service?',
      ...(actionDetail
        ? {
            actionTitleKey: 'Use {{service}}?',
            actionTitleValues: { service: actionDetail }
          }
        : {}),
      categoryLabel: 'External service',
      description: 'Uses an MCP service configured for this conversation.',
      actionDetail
    }
  }

  if (isNetworkTool(request)) {
    return {
      actionTitle: 'Access network resource?',
      categoryLabel: 'Network access',
      description: 'Sends a request to an external network resource.'
    }
  }

  switch (request.toolKind) {
    case 'read':
    case 'search':
      return {
        actionTitle: 'Read files?',
        categoryLabel: 'File access',
        description: 'Reads or searches the listed files.'
      }
    case 'edit':
      return {
        actionTitle: 'Edit files?',
        categoryLabel: 'File change',
        description: 'Changes the listed files.'
      }
    case 'delete':
      return {
        actionTitle: 'Delete files?',
        categoryLabel: 'File change',
        description: 'Deletes the listed files.'
      }
    case 'move':
      return {
        actionTitle: 'Move files?',
        categoryLabel: 'File change',
        description: 'Moves the listed files.'
      }
    default:
      break
  }

  if (request.providerToolName === 'Bash' || request.toolKind === 'execute') {
    return {
      actionTitle: 'Run command?',
      categoryLabel: 'Command execution',
      description: 'Runs a command on this computer.'
    }
  }

  return {
    actionTitle: 'Allow tool access?',
    categoryLabel: 'Tool access',
    description: 'Allows this tool to run with the details shown below.'
  }
}

export {
  describePermissionRequest,
  isArtifactWriteRequest,
  isLiteratureReadRequest,
  isMcpPermissionRequest,
  isSpecialistDeleteRequest,
  isSpecialistSwitchRequest
}
export type { NotebookRuntime, PermissionPresentation }
