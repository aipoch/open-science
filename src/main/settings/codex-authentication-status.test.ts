import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { patchCodexAcpAuthenticationStatusSource } from './codex-authentication-status'

const source = `class Client {${readFileSync(
  new URL('./fixtures/codex-acp-1.6.2-authentication-status.txt', import.meta.url),
  'utf8'
)}}; Client`

describe('Codex authentication status patch', () => {
  it.each([
    ['open-science-chatgpt-https', true, null, 'unauthenticated'],
    [
      'open-science-chatgpt-https',
      true,
      { type: 'chatgpt', email: 'researcher@example.test' },
      'chat-gpt'
    ],
    ['custom', false, null, 'gateway'],
    [null, true, null, 'unauthenticated'],
    [null, true, { type: 'apiKey' }, 'api-key']
  ])(
    'checks account requirements for %s',
    async (provider, requiresOpenaiAuth, account, expected) => {
      const Client = runInNewContext(patchCodexAcpAuthenticationStatusSource(source))
      const client = new Client()
      client.getCurrentModelProvider = async () => provider
      client.getAccount = async () => ({ account, requiresOpenaiAuth })
      expect((await client.getAuthenticationStatus()).type).toBe(expected)
    }
  )
  it('propagates account-read failures instead of reporting a gateway login', async () => {
    const Client = runInNewContext(patchCodexAcpAuthenticationStatusSource(source))
    const client = new Client()
    client.getCurrentModelProvider = async () => 'custom'
    client.getAccount = async () => {
      throw new Error('account unavailable')
    }
    await expect(client.getAuthenticationStatus()).rejects.toThrow('account unavailable')
  })

  it('is idempotent and refuses ambiguous or changed real adapters', () => {
    const patched = patchCodexAcpAuthenticationStatusSource(source)
    expect(patchCodexAcpAuthenticationStatusSource(patched)).toBe(patched)
    expect(() => patchCodexAcpAuthenticationStatusSource(source + source)).toThrow(
      'no longer matches'
    )
    expect(() =>
      patchCodexAcpAuthenticationStatusSource(source.replace('if (modelProvider)', 'if (true)'))
    ).toThrow('no longer matches')
  })
})
