import { classifyFailure } from '../../../../shared/failure/classify'
import type { ClassifiedFailure } from '../../../../shared/failure/contract'
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

type OperationDiagnostic = {
  occurredAt: number
  operation: 'resume'
  detail: string
  message: string
}

// Operation failures belong to the initiating surface, never to the durable Session projection.
// Keep the Session identity so an asynchronous rejection cannot appear in another conversation.
const useWorkspaceOperationErrors = create<{
  contextResets: Record<string, boolean>
  failures: Record<string, ClassifiedFailure>
  errors: Record<string, string>
  providerValidations: Record<string, ProviderValidationSnapshot>
  providerTargets: Record<string, ProviderTarget | undefined>
  diagnostics: Record<string, OperationDiagnostic>
}>(() => ({
  contextResets: {},
  errors: {},
  failures: {},
  providerValidations: {},
  providerTargets: {},
  diagnostics: {}
}))

const reportWorkspaceOperationError = (
  sessionId: string,
  error: string,
  context?: { providerTarget?: ProviderTarget } & (
    { operation: 'resume'; rawError: unknown } | { operation?: undefined }
  )
): void => {
  useWorkspaceOperationErrors.setState(
    ({ errors, failures, providerValidations, providerTargets, diagnostics }) => {
      const next = { ...diagnostics }
      if (context?.operation) {
        const raw = context.rawError
        next[sessionId] = {
          occurredAt: Date.now(),
          operation: context.operation,
          message: error,
          detail: capturedErrorDetail(raw)
        }
      } else delete next[sessionId]
      return {
        errors: { ...errors, [sessionId]: error },
        failures: {
          ...failures,
          [sessionId]: classifyFailure({
            origin: 'operation',
            code: context?.operation === 'resume' ? 'resume-operation' : undefined,
            text:
              context?.operation === 'resume' ? (errorDetail(context.rawError) ?? error) : error,
            model: context?.providerTarget?.model
          })
        },
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
    ({ errors, failures, providerValidations, providerTargets, diagnostics }) => {
      if (!Object.hasOwn(errors, sessionId)) return { errors }
      const next = { ...errors }
      const nextFailures = { ...failures }
      delete nextFailures[sessionId]
      delete next[sessionId]
      const nextDiagnostics = { ...diagnostics }
      delete nextDiagnostics[sessionId]
      const nextProviderValidations = { ...providerValidations }
      delete nextProviderValidations[sessionId]
      const nextProviderTargets = { ...providerTargets }
      delete nextProviderTargets[sessionId]
      return {
        errors: next,
        failures: nextFailures,
        providerValidations: nextProviderValidations,
        providerTargets: nextProviderTargets,
        diagnostics: nextDiagnostics
      }
    }
  )
}

export { useWorkspaceOperationErrors, reportWorkspaceOperationError, clearWorkspaceOperationError }
