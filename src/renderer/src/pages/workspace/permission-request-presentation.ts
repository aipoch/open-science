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

const isNetworkTool = (request: AcpPermissionRequest): boolean => {
  const name = providerToolName(request)?.toLowerCase()
  return request.toolKind === 'fetch' || name === 'webfetch' || name === 'websearch'
}

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

  if (request.isMcp) {
    return {
      actionTitle: 'Use external service?',
      categoryLabel: 'External service',
      description: 'Uses an MCP service configured for this conversation.'
    }
  }

  if (request.providerToolName === 'Bash' || request.toolKind === 'execute') {
    return {
      actionTitle: 'Run command?',
      categoryLabel: 'Command execution',
      description: 'Runs a command on this computer.'
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
        categoryLabel: 'File access',
        description: 'Changes the listed files.'
      }
    case 'delete':
      return {
        actionTitle: 'Delete files?',
        categoryLabel: 'File access',
        description: 'Deletes the listed files.'
      }
    case 'move':
      return {
        actionTitle: 'Move files?',
        categoryLabel: 'File access',
        description: 'Moves the listed files.'
      }
    default:
      return {
        actionTitle: 'Allow tool access?',
        categoryLabel: 'Tool access',
        description: 'Allows this tool to run with the details shown below.'
      }
  }
}

export { describePermissionRequest }
export type { NotebookRuntime, PermissionPresentation }
