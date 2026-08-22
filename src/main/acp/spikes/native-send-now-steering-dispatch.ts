import {
  ACP_STEERING_METHOD,
  buildSteerRequest,
  parseSteerOutcome,
  readSteeringAdvertisement,
  type SteerOutcome
} from './native-send-now-capability'

// Spike: host-side `_session/steering` as a side-band on the live prompt.
//
// Production initialize keeps only close / delete / resume and drops `_meta`.
// Steering must not open a second prompt interaction. `startedNewTurn` is a
// detached adapter turn the host does not own, so Send now refuses it.
// Nothing here is wired into the composer queue.

export const STEERING_IDLE_BEHAVIOR = 'promptRequired' as const

export type HostInitializeCapabilities = Readonly<{
  close: boolean
  delete: boolean
  resume: boolean
  steering: boolean
}>

export type SteeringDispatchAdmission =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false
      reason: 'not-advertised' | 'no-live-turn'
    }>

export type SteeringDispatchResult =
  | Readonly<{ kind: 'injected' }>
  | Readonly<{ kind: 'prompt-required'; reason: string }>
  | Readonly<{
      kind: 'refused'
      reason:
        | 'not-advertised'
        | 'no-live-turn'
        | 'started-new-turn'
        | 'unrecognized-success'
        | 'missing-outcome'
        | 'unknown-outcome'
    }>

export type SteeringDispatchRequest = Readonly<{
  sessionId: string
  prompt: unknown[]
  _meta: Readonly<{
    steering: Readonly<{ idleBehavior: typeof STEERING_IDLE_BEHAVIOR }>
  }>
}>

const capabilityFlag = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const retainInitializeCapabilities = (initialize: unknown): HostInitializeCapabilities => {
  const record =
    initialize !== null && typeof initialize === 'object' && !Array.isArray(initialize)
      ? (initialize as Record<string, unknown>)
      : undefined
  const sessionCapabilities = capabilityFlag(record?.agentCapabilities)
    ? ((record?.agentCapabilities as Record<string, unknown>).sessionCapabilities as
        Record<string, unknown> | undefined)
    : undefined
  return Object.freeze({
    close: capabilityFlag(sessionCapabilities?.close),
    delete: capabilityFlag(sessionCapabilities?.delete),
    resume: capabilityFlag(sessionCapabilities?.resume),
    steering: readSteeringAdvertisement(initialize).supported
  })
}

// Production-shaped keep-list. Steering is dropped here today.
export const retainProductionInitializeCapabilities = (
  initialize: unknown
): Pick<HostInitializeCapabilities, 'close' | 'delete' | 'resume'> => {
  const retained = retainInitializeCapabilities(initialize)
  return Object.freeze({
    close: retained.close,
    delete: retained.delete,
    resume: retained.resume
  })
}

export const admitSteeringDispatch = (input: {
  advertised: boolean
  hasLivePrompt: boolean
}): SteeringDispatchAdmission => {
  if (!input.advertised) {
    return Object.freeze({ allowed: false, reason: 'not-advertised' })
  }
  if (!input.hasLivePrompt) {
    return Object.freeze({ allowed: false, reason: 'no-live-turn' })
  }
  return Object.freeze({ allowed: true })
}

export const buildSteeringDispatchRequest = (
  sessionId: string,
  prompt: unknown[]
): SteeringDispatchRequest =>
  Object.freeze({
    ...buildSteerRequest(sessionId, prompt),
    _meta: Object.freeze({
      steering: Object.freeze({ idleBehavior: STEERING_IDLE_BEHAVIOR })
    })
  })

export const interpretSteeringDispatch = (outcome: SteerOutcome): SteeringDispatchResult => {
  if (outcome.kind === 'injected') return Object.freeze({ kind: 'injected' })
  if (outcome.kind === 'prompt-required') {
    return Object.freeze({ kind: 'prompt-required', reason: outcome.reason })
  }
  if (outcome.kind === 'started-new-turn') {
    return Object.freeze({ kind: 'refused', reason: 'started-new-turn' })
  }
  return Object.freeze({ kind: 'refused', reason: outcome.reason })
}

export const dispatchSteering = async (input: {
  advertised: boolean
  hasLivePrompt: boolean
  request: (method: typeof ACP_STEERING_METHOD, params: SteeringDispatchRequest) => Promise<unknown>
  sessionId: string
  prompt: unknown[]
}): Promise<SteeringDispatchResult> => {
  const admission = admitSteeringDispatch(input)
  if (!admission.allowed) {
    return Object.freeze({ kind: 'refused', reason: admission.reason })
  }
  const result = await input.request(
    ACP_STEERING_METHOD,
    buildSteeringDispatchRequest(input.sessionId, input.prompt)
  )
  return interpretSteeringDispatch(parseSteerOutcome(result))
}

export { ACP_STEERING_METHOD }
