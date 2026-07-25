import type { AcpPermissionRequest } from '../../../../shared/acp'

import {
  matchNotebookControlTool,
  resolveNotebookLanguage,
  resolveNotebookRunToolName
} from './notebook-tool-names'

type NotebookRuntime = 'python' | 'r' | 'js' | 'bash'

type PermissionPresentation = {
  actionTitle: string
  categoryLabel: string
  description: string
  actionDetail?: string
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

// Keeps an otherwise-opaque MCP request distinguishable without surfacing its protocol spelling.
// The request title is preferred because providers can reduce providerToolName to a bare leaf.
const humanizeMcpAction = (request: AcpPermissionRequest): string | undefined => {
  const name = request.title.trim() || providerToolName(request)
  if (!name) return undefined

  const normalized = name.replace(/^mcp(?:__|\.)/u, '')
  const segments = normalized
    .split(/__|\./u)
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

const isNetworkTool = (request: AcpPermissionRequest): boolean => {
  const name = providerToolName(request)?.toLowerCase()
  return request.toolKind === 'fetch' || name === 'webfetch' || name === 'websearch'
}

const withMcpActionDetail = (
  request: AcpPermissionRequest,
  presentation: PermissionPresentation
): PermissionPresentation =>
  request.isMcp ? { ...presentation, actionDetail: humanizeMcpAction(request) } : presentation

const describePermissionRequest = (request: AcpPermissionRequest): PermissionPresentation => {
  const notebookToolName = resolveNotebookRunToolName(request.providerToolName, request.title)
  if (notebookToolName) {
    const input = getRequestInput(request)
    const language = resolveNotebookLanguage(notebookToolName, input, getCode(input))
    return notebookExecutionPresentation(toNotebookRuntime(language))
  }

  const controlTool = [request.providerToolName, request.title]
    .map(matchNotebookControlTool)
    .find((tool): tool is string => tool !== undefined)
  if (controlTool) return notebookControlPresentation(controlTool)

  if (isNetworkTool(request)) {
    return withMcpActionDetail(request, {
      actionTitle: 'Access network resource?',
      categoryLabel: 'Network access',
      description: 'Sends a request to an external network resource.'
    })
  }

  switch (request.toolKind) {
    case 'read':
    case 'search':
      return withMcpActionDetail(request, {
        actionTitle: 'Read files?',
        categoryLabel: 'File access',
        description: 'Reads or searches the listed files.'
      })
    case 'edit':
      return withMcpActionDetail(request, {
        actionTitle: 'Edit files?',
        categoryLabel: 'File access',
        description: 'Changes the listed files.'
      })
    case 'delete':
      return withMcpActionDetail(request, {
        actionTitle: 'Delete files?',
        categoryLabel: 'File access',
        description: 'Deletes the listed files.'
      })
    case 'move':
      return withMcpActionDetail(request, {
        actionTitle: 'Move files?',
        categoryLabel: 'File access',
        description: 'Moves the listed files.'
      })
    default:
      break
  }

  if (request.isMcp) {
    return withMcpActionDetail(request, {
      actionTitle: 'Use external service?',
      categoryLabel: 'External service',
      description: 'Uses an MCP service configured for this conversation.'
    })
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

export { describePermissionRequest }
export type { NotebookRuntime, PermissionPresentation }
