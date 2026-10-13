import { create } from 'zustand'
import { errorDetail } from '@/lib/error-detail'

// Keep structured RPC fields in the local disclosure; message normalization is separate.
const capturedErrorDetail = (raw: unknown): string => {
  if (raw instanceof Error) return raw.stack ?? raw.message
  if (raw !== null && typeof raw === 'object') {
    try {
      return JSON.stringify(raw, null, 2) ?? String(raw)
    } catch {
      // Follow the existing diagnostic display fallback for non-serializable values.
    }
  }
  return errorDetail(raw) ?? String(raw)
}

type OperationDiagnostic = { operation: 'resume'; detail: string; message: string }

// Operation failures belong to the initiating surface, never to the durable Session projection.
// Keep the Session identity so an asynchronous rejection cannot appear in another conversation.
const useWorkspaceOperationErrors = create<{
  errors: Record<string, string>
  diagnostics: Record<string, OperationDiagnostic>
}>(() => ({ errors: {}, diagnostics: {} }))

const reportWorkspaceOperationError = (
  sessionId: string,
  error: string,
  diagnostic?: { operation: 'resume'; rawError: unknown }
): void => {
  useWorkspaceOperationErrors.setState(({ errors, diagnostics }) => {
    const next = { ...diagnostics }
    if (diagnostic) {
      const raw = diagnostic.rawError
      next[sessionId] = {
        operation: diagnostic.operation,
        message: error,
        detail: capturedErrorDetail(raw)
      }
    } else delete next[sessionId]
    return { errors: { ...errors, [sessionId]: error }, diagnostics: next }
  })
}

const clearWorkspaceOperationError = (sessionId: string): void => {
  useWorkspaceOperationErrors.setState(({ errors, diagnostics }) => {
    if (!Object.hasOwn(errors, sessionId)) return { errors }
    const next = { ...errors }
    delete next[sessionId]
    const nextDiagnostics = { ...diagnostics }
    delete nextDiagnostics[sessionId]
    return { errors: next, diagnostics: nextDiagnostics }
  })
}

export { useWorkspaceOperationErrors, reportWorkspaceOperationError, clearWorkspaceOperationError }
