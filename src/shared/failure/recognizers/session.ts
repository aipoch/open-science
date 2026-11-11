import type { Recognizer } from '../contract'

export const recognizeSession: Recognizer = ({ origin, code, text = '' }) => {
  if (origin === 'operation' && code === 'resume-operation') {
    if (text.includes('The previous execution is still using this conversation.'))
      return { category: 'session', reason: 'session/previous-execution-active', diagnostics: {} }
    if (/timed out/i.test(text))
      return { category: 'session', reason: 'session/resume-timeout', diagnostics: {} }
    if (/connection (failed|was superseded)|ACP connection/i.test(text))
      return { category: 'session', reason: 'session/reconnect-failed', diagnostics: {} }
  }
  if (
    origin === 'session' ||
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
