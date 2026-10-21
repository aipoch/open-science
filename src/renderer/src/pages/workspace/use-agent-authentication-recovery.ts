import type { ProviderValidationSnapshot } from '@/lib/provider-validation-snapshot'
import { useState } from 'react'
import { useSettingsStore } from '@/stores/settings-store'
import type { ChatSession } from '@/stores/session-store'
import type { ProviderView, SessionAgentConfiguration } from '../../../../shared/settings'
import {
  isAgentAuthenticationRequired,
  isProviderAuthenticationRestored,
  sessionAuthenticationFailure
} from './agent-authentication-error'

export type AgentAuthenticationRecovery = {
  required: boolean
  provider?: ProviderView
  openSettings: () => void
}

// Recovery is scoped to the branch and failed attempt, never persisted over the original error.
export const useAgentAuthenticationRecovery = (
  session: ChatSession | undefined,
  draftKey: string,
  configuration: SessionAgentConfiguration | undefined,
  composerError: string | null,
  actionError: string | null,
  errorValidations: {
    composer?: ProviderValidationSnapshot
    action?: ProviderValidationSnapshot
  } = {}
): AgentAuthenticationRecovery => {
  const providers = useSettingsStore((state) => state.providers)
  const provider = providers.find(({ id }) => id === configuration?.providerId)
  const sessionFailure = sessionAuthenticationFailure(session)
  const selectedId = configuration?.providerId ?? ''
  const liveFailures = [
    { message: actionError, validations: errorValidations.action },
    { message: composerError, validations: errorValidations.composer }
  ].filter(({ message }) => isAgentAuthenticationRequired(message))
  const liveError = liveFailures[0]?.message
  const validationAtFailure = liveFailures.some(({ validations }) => validations === undefined)
    ? undefined
    : Math.max(0, ...liveFailures.map(({ validations }) => validations![selectedId] ?? 0))
  const error = liveError ?? sessionFailure?.message
  const graph = session?.conversationGraph
  const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
  const key = JSON.stringify([
    session?.id ?? draftKey,
    frame?.id,
    frame?.activeBranchId,
    sessionFailure?.at,
    liveFailures.map(({ validations }) => validations),
    error
  ])
  const validCredential = isProviderAuthenticationRestored(provider, 0, configuration?.model)
  type Observation = {
    validatedAt?: number
    credentialRequired: boolean
    resolvedAt?: number
  }
  const initialObservation: Observation = {
    validatedAt: provider?.lastValidatedAt,
    credentialRequired: provider?.needsKey === true,
    resolvedAt:
      error &&
      validationAtFailure !== undefined &&
      validCredential &&
      provider!.lastValidatedAt! > Math.max(sessionFailure?.at ?? 0, validationAtFailure)
        ? provider!.lastValidatedAt
        : undefined
  }
  const initialState = {
    key,
    errorProviderId: liveError ? selectedId : (sessionFailure?.providerId ?? selectedId),
    selectedId,
    observations: { [selectedId]: initialObservation } as Record<string, Observation>
  }
  const [state, setState] = useState(initialState)
  let current = state
  if (current.key !== key) {
    current = initialState
  } else if (current.selectedId !== selectedId) {
    current = {
      ...current,
      selectedId,
      observations: {
        ...current.observations,
        [selectedId]: current.observations[selectedId] ?? initialObservation
      }
    }
  }
  let observed = current.observations[selectedId]
  if (
    provider?.needsKey &&
    (!observed.credentialRequired || observed.validatedAt !== provider.lastValidatedAt)
  )
    observed = { ...observed, credentialRequired: true, validatedAt: provider.lastValidatedAt }
  if (
    observed.resolvedAt !== undefined &&
    (!validCredential || (provider?.lastValidatedAt ?? 0) < observed.resolvedAt)
  ) {
    observed = { ...observed, resolvedAt: undefined }
  } else if (
    observed.resolvedAt !== provider?.lastValidatedAt &&
    validCredential &&
    provider!.lastValidatedAt! >
      Math.max(
        validationAtFailure ?? observed.validatedAt ?? 0,
        sessionFailure?.at ?? 0,
        observed.credentialRequired ? (observed.validatedAt ?? 0) : 0
      )
  ) {
    observed = { ...observed, resolvedAt: provider!.lastValidatedAt }
  }
  if (observed !== current.observations[selectedId])
    current = { ...current, observations: { ...current.observations, [selectedId]: observed } }
  if (current !== state) setState(current)
  return {
    required: Boolean(
      !session?.packageOrigin &&
      (observed.credentialRequired ||
        (error &&
          current.errorProviderId === selectedId &&
          (!sessionFailure?.providerId ||
            liveError ||
            sessionFailure.providerId === selectedId))) &&
      observed.resolvedAt === undefined
    ),
    provider,
    openSettings: () => {
      if (provider) useSettingsStore.getState().openSettingsToProvider(provider.id)
      else useSettingsStore.getState().openSettingsToPanel('model')
    }
  }
}
