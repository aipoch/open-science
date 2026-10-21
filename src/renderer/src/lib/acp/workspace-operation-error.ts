import { create } from 'zustand'
import {
  captureProviderValidationSnapshot,
  type ProviderValidationSnapshot
} from '@/lib/provider-validation-snapshot'
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

type ProviderTarget = { providerId: string; model?: string }

type OperationDiagnostic = { operation: 'resume'; detail: string; message: string }

// Operation failures belong to the initiating surface, never to the durable Session projection.
// Keep the Session identity so an asynchronous rejection cannot appear in another conversation.
const useWorkspaceOperationErrors = create<{
  errors: Record<string, string>
  providerValidations: Record<string, ProviderValidationSnapshot>
  providerTargets: Record<string, ProviderTarget | undefined>
  diagnostics: Record<string, OperationDiagnostic>
}>(() => ({ errors: {}, providerValidations: {}, providerTargets: {}, diagnostics: {} }))

const reportWorkspaceOperationError = (
  sessionId: string,
  error: string,
  context?: { providerTarget?: ProviderTarget } & (
    { operation: 'resume'; rawError: unknown } | { operation?: undefined }
  )
): void => {
  useWorkspaceOperationErrors.setState(
    ({ errors, providerValidations, providerTargets, diagnostics }) => {
      const next = { ...diagnostics }
      if (context?.operation) {
        const raw = context.rawError
        next[sessionId] = {
          operation: context.operation,
          message: error,
          detail: capturedErrorDetail(raw)
        }
      } else delete next[sessionId]
      return {
        errors: { ...errors, [sessionId]: error },
        providerValidations: {
          ...providerValidations,
          [sessionId]: captureProviderValidationSnapshot()
        },
        providerTargets: {
          ...providerTargets,
          [sessionId]: context?.providerTarget
            ? { providerId: context.providerTarget.providerId, model: context.providerTarget.model }
            : undefined
        },
        diagnostics: next
      }
    }
  )
}

const clearWorkspaceOperationError = (sessionId: string): void => {
  useWorkspaceOperationErrors.setState(
    ({ errors, providerValidations, providerTargets, diagnostics }) => {
      if (!Object.hasOwn(errors, sessionId)) return { errors }
      const next = { ...errors }
      delete next[sessionId]
      const nextDiagnostics = { ...diagnostics }
      delete nextDiagnostics[sessionId]
      const nextProviderValidations = { ...providerValidations }
      delete nextProviderValidations[sessionId]
      const nextProviderTargets = { ...providerTargets }
      delete nextProviderTargets[sessionId]
      return {
        errors: next,
        providerValidations: nextProviderValidations,
        providerTargets: nextProviderTargets,
        diagnostics: nextDiagnostics
      }
    }
  )
}

export { useWorkspaceOperationErrors, reportWorkspaceOperationError, clearWorkspaceOperationError }
