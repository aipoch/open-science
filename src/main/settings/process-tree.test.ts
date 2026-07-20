import { describe, expect, it } from 'vitest'

import { stripCodexCredentialEnv } from './process-tree'

describe('stripCodexCredentialEnv', () => {
  it('removes every Codex credential/config var, including DEFAULT_AUTH_REQUEST', () => {
    const out = stripCodexCredentialEnv({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-secret',
      CODEX_API_KEY: 'ck',
      CODEX_CONFIG: '{}',
      DEFAULT_AUTH_REQUEST: 'apikey',
      HOME: '/home/u'
    })

    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/home/u' })
    // Explicit per-key guard so a regression that drops one key from the strip list is caught.
    expect(out.OPENAI_API_KEY).toBeUndefined()
    expect(out.CODEX_API_KEY).toBeUndefined()
    expect(out.CODEX_CONFIG).toBeUndefined()
    expect(out.DEFAULT_AUTH_REQUEST).toBeUndefined()
  })

  it('does not mutate the input env', () => {
    const input = { OPENAI_API_KEY: 'x', PATH: '/bin' }
    stripCodexCredentialEnv(input)

    expect(input.OPENAI_API_KEY).toBe('x')
  })

  it('leaves an env with no credential vars unchanged', () => {
    expect(stripCodexCredentialEnv({ PATH: '/bin', CODEX_HOME: '/tmp/home' })).toEqual({
      PATH: '/bin',
      CODEX_HOME: '/tmp/home'
    })
  })
})
