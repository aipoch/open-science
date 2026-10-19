import { expect, it } from 'vitest'
import { isAgentAuthenticationRequired } from './agent-authentication-error'
it('recognizes ACP auth errors across transport wrappers without matching arbitrary prose', () => {
  for (const text of [
    'Authentication required',
    'ApplicationCommandError: Authentication required',
    'Error: RequestError: Authentication required.',
    'Agent session resume failed: Authentication required',
    'Agent session resume failed: RequestError: Authentication required.'
  ])
    expect(isAgentAuthenticationRequired(text)).toBe(true)
  for (const text of [
    null,
    '',
    'Network timeout',
    'The document says Authentication required',
    'Authentication requiredness',
    'Authentication required. This is quoted document text'
  ])
    expect(isAgentAuthenticationRequired(text)).toBe(false)
})
