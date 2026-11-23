import type { LabConnectionState, LabErrorCode } from '../../../../shared/lab'

// Renderer-side presentation helpers for the Lab panel. Kept outside the component so the panel file
// only exports React components (react-refresh) and so these mappings can be reused by tests.

const LAB_STATUS_LABEL_KEYS: Record<LabConnectionState, string> = {
  unconfigured: 'Not configured',
  signedOut: 'Not signed in',
  signingIn: 'Waiting for browser confirmation…',
  authenticated: 'Signed in',
  expired: 'Session expired — sign in again',
  unreachable: 'Lab server unreachable',
  blocked: 'Lab access blocked'
}

export const labStatusLabelKey = (state: LabConnectionState): string => LAB_STATUS_LABEL_KEYS[state]

const LAB_ERROR_COPY_KEYS: Record<LabErrorCode, string> = {
  'server-url-missing': 'Enter a Lab server address.',
  'server-url-invalid': 'Lab server address must be a valid HTTP or HTTPS URL.',
  'server-url-insecure': 'Use HTTPS for a Lab server that is not on this computer.',
  'server-url-credentials': 'Remove credentials from the Lab server address.',
  'server-url-query': 'Lab server address must not include query parameters or fragments.',
  cancelled: 'Lab sign-in was cancelled.',
  expired: 'The sign-in request expired. Start sign-in again.',
  unauthorized: 'Lab sign-in failed. Try again.',
  'license-inactive': "Your organization's Lab license is inactive.",
  'seat-required': 'A Lab seat is required for this account.',
  'org-inactive': 'Your organization is inactive.',
  'account-disabled': 'This account is disabled.',
  'device-limit':
    'This account already uses the maximum number of Lab devices. Choose a device to replace in the browser, then retry.',
  'rate-limited': 'Too many Lab requests. Try again in a moment.',
  timeout: 'The Lab server did not respond in time.',
  'server-error': 'Lab server unreachable',
  network: 'Lab server unreachable',
  'invalid-response': 'The Lab server returned an invalid response.',
  unknown: 'The Lab server rejected the request.'
}

export const labErrorCopyKey = (code: LabErrorCode | undefined): string | undefined =>
  code === undefined ? undefined : LAB_ERROR_COPY_KEYS[code]

const LAB_PROTOCOL_LABELS: Record<string, string> = {
  'chat-completions': 'Chat Completions',
  openai: 'Chat Completions',
  responses: 'Responses',
  'openai-response': 'Responses'
}

// Protocol labels are technical identifiers and intentionally stay in English in every locale; the
// panel still routes the returned string through t() so the copy boundary stays uniform.
export const labModelProtocolLabel = (protocols: readonly string[]): string => {
  const labels = protocols
    .map((protocol) => LAB_PROTOCOL_LABELS[protocol.toLowerCase()])
    .filter((label): label is string => label !== undefined)
  const unique = [...new Set(labels)]
  return unique.length > 0 ? unique.join(' · ') : 'Chat Completions'
}
