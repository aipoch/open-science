const WEB_EVENT_CONSUMERS_READY_EVENT = 'open-science:web-event-consumers-ready'
const WEB_EVENT_CONNECTION_STATE_EVENT = 'open-science:web-event-connection-state'
const WEB_EVENTS_OPEN_EVENT = 'open-science:web-events-open'
const WEB_EVENT_SURFACE_ATTRIBUTE = 'data-open-science-web-events'

const WEB_EVENT_CONNECTION_PHASES = [
  'connecting',
  'reconnecting',
  'replaying',
  'live',
  'reload-required'
] as const

type WebEventConnectionPhase = (typeof WEB_EVENT_CONNECTION_PHASES)[number]
type WebEventConnectionState = Readonly<{
  phase: WebEventConnectionPhase
}>

export {
  WEB_EVENT_CONNECTION_PHASES,
  WEB_EVENT_CONNECTION_STATE_EVENT,
  WEB_EVENT_CONSUMERS_READY_EVENT,
  WEB_EVENT_SURFACE_ATTRIBUTE,
  WEB_EVENTS_OPEN_EVENT
}
export type { WebEventConnectionPhase, WebEventConnectionState }
