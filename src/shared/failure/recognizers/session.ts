import type { Recognizer } from '../contract'

export const recognizeSession: Recognizer = ({ origin, code, text = '' }) => {
  if (
    origin === 'session' ||
    (origin === 'agent-runtime' && code === -32002) ||
    [
      'Session was interrupted before the app closed.',
      'This turn was interrupted. Resume to continue.',
      'Agent session resume timed out; click Resume to try again.',
      'Could not reconnect to the agent; check it is installed, then click Resume to retry.'
    ].includes(text)
  )
    return { category: 'session', reason: 'session/interrupted', diagnostics: {} }
  return undefined
}
