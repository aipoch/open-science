const WEB_CALLER_LOCATIONS = ['local', 'remote'] as const
type WebCallerLocation = (typeof WEB_CALLER_LOCATIONS)[number]

const WEB_CALLER_LOCATION_ATTRIBUTE = 'data-open-science-web-caller-location'

export { WEB_CALLER_LOCATION_ATTRIBUTE, WEB_CALLER_LOCATIONS }
export type { WebCallerLocation }
