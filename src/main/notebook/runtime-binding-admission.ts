import type { TaskNotebookRuntimeSelection } from '../../shared/task-api'

// Host-only per-request prompt policy. Symbols cannot arrive over RPC JSON; the enumerable marker
// survives internal request spreads without adding a wire field or persisted Session preference.
const TRUSTED_BINDING_PERMISSION_PROMPTS = Symbol('trusted-notebook-binding-permission-prompts')
type TrustedBindingRequest = { [TRUSTED_BINDING_PERMISSION_PROMPTS]?: 'none' }
const TASK_RUNTIME_SELECTION = Symbol('trusted-task-notebook-runtime-selection')
type TaskRuntimeRequest = { [TASK_RUNTIME_SELECTION]?: TaskNotebookRuntimeSelection }

export function markTaskNotebookRuntime<T extends object>(
  request: T,
  selection: TaskNotebookRuntimeSelection | undefined
): T {
  if (selection) Object.assign(request, { [TASK_RUNTIME_SELECTION]: selection })
  return request
}

export function taskNotebookRuntimeSelection(
  request: object
): TaskNotebookRuntimeSelection | undefined {
  return (request as TaskRuntimeRequest)[TASK_RUNTIME_SELECTION]
}

export function markTrustedNotebookBindingPermissionPrompts<T extends object>(
  request: T,
  permissionPrompts: 'none' | undefined
): T {
  if (permissionPrompts === 'none') {
    Object.assign(request, { [TRUSTED_BINDING_PERMISSION_PROMPTS]: permissionPrompts })
  }
  return request
}

export function readTrustedNotebookBindingPermissionPrompts(request: object): 'none' | undefined {
  return (request as TrustedBindingRequest)[TRUSTED_BINDING_PERMISSION_PROMPTS]
}
