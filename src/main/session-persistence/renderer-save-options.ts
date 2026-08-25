import type {
  SaveSessionOptions,
  SessionConflictRebaseField
} from '../../shared/session-persistence'

const RENDERER_SESSION_CONFLICT_REBASE_FIELDS = new Set<SessionConflictRebaseField>([
  'title',
  'permissionProfile',
  'autoReviewEnabled',
  'memoryEnabled',
  'agentConfiguration',
  'enabledComputeHosts',
  'selectedComputeHosts',
  'pinned'
])

// Electron IPC arguments are runtime values even when the preload contract is typed. Project only
// renderer-owned rebase authority before the request reaches Main's Session persistence owner.
export const sanitizeRendererSaveSessionOptions = (
  options: unknown
): SaveSessionOptions | undefined => {
  if (typeof options !== 'object' || options === null) return undefined
  const candidate = Reflect.get(options, 'conflictRebaseFields')
  if (!Array.isArray(candidate)) return undefined
  const conflictRebaseFields = [
    ...new Set(
      candidate.filter(
        (field): field is SessionConflictRebaseField =>
          typeof field === 'string' &&
          RENDERER_SESSION_CONFLICT_REBASE_FIELDS.has(field as SessionConflictRebaseField)
      )
    )
  ]
  return conflictRebaseFields.length > 0 ? { conflictRebaseFields } : undefined
}
