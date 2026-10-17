import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { patchCodexAcpAuthenticationStatusSource } from './managed-codex'

const source = `class Client {
  async getAuthenticationStatus() {
    const modelProvider = await this.getCurrentModelProvider();
    if (modelProvider) {
      return {
        type: "gateway",
        name: modelProvider
      };
    }
    const account = (await this.getAccount()).account;
    return { type: account === null ? "unauthenticated" : account.type };
  }
}; Client`
describe('Codex authentication status patch', () => {
  it.each([
    ['open-science-chatgpt-https', true, null, 'unauthenticated'],
    ['open-science-chatgpt-https', true, { type: 'chat-gpt' }, 'chat-gpt'],
    ['custom', false, null, 'gateway'],
    [null, true, null, 'unauthenticated'],
    [null, true, { type: 'api-key' }, 'api-key']
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
