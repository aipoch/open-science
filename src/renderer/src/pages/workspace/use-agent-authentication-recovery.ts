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
  actionError: string | null
): AgentAuthenticationRecovery => {
  const providers = useSettingsStore((state) => state.providers)
  const provider = providers.find(({ id }) => id === configuration?.providerId)
  const sessionFailure = sessionAuthenticationFailure(session)
  const liveError = [actionError, composerError].find(isAgentAuthenticationRequired)
  const error = liveError ?? sessionFailure?.message
  const graph = session?.conversationGraph
  const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
  const key = JSON.stringify([
    session?.id ?? draftKey,
    frame?.id,
    frame?.activeBranchId,
    sessionFailure?.at,
    error
  ])
  const validCredential = isProviderAuthenticationRestored(provider, 0, configuration?.model)
  type Observation = {
    validatedAt?: number
    credentialRequired: boolean
    armed: boolean
    resolvedAt?: number
  }
  const initialObservation: Observation = {
    validatedAt: provider?.lastValidatedAt,
    credentialRequired: provider?.needsKey === true,
    armed: false,
    resolvedAt:
      !liveError &&
      sessionFailure &&
      validCredential &&
      provider!.lastValidatedAt! > sessionFailure.at
        ? provider!.lastValidatedAt
        : undefined
  }
  const selectedId = configuration?.providerId ?? ''
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
    // Returning from Settings must not apply a completion armed for a previous selection.
    current = {
      ...current,
      selectedId,
      observations: {
        ...current.observations,
        [current.selectedId]: { ...current.observations[current.selectedId], armed: false },
        [selectedId]: current.observations[selectedId] ?? initialObservation
      }
    }
  }
  let observed = current.observations[selectedId]
  if (provider?.needsKey && !observed.credentialRequired)
    observed = { ...observed, credentialRequired: true }
  if (
    observed.resolvedAt !== undefined &&
    (!validCredential || (provider?.lastValidatedAt ?? 0) < observed.resolvedAt)
  ) {
    observed = { ...observed, resolvedAt: undefined, armed: false }
  } else if (
    observed.armed &&
    validCredential &&
    provider!.lastValidatedAt! > Math.max(observed.validatedAt ?? 0, sessionFailure?.at ?? 0)
  ) {
    observed = { ...observed, resolvedAt: provider!.lastValidatedAt, armed: false }
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
      setState({
        ...current,
        observations: {
          ...current.observations,
          [selectedId]: { ...observed, validatedAt: provider?.lastValidatedAt, armed: true }
        }
      })
      if (provider) useSettingsStore.getState().openSettingsToProvider(provider.id)
      else useSettingsStore.getState().openSettingsToPanel('model')
    }
  }
}
