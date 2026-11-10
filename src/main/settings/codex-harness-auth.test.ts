import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectCodexHarnessAvailability, readCodexHarnessConnection } from './codex-harness-auth'
import { resolveCodexHarnessEndpoint } from './codex-auth'
import { codexSubscriptionStorageDir } from './codex-paths'

const jwt = (claims: Record<string, unknown>): string =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
type StoredCredential = {
  auth_mode: string
  tokens: { access_token: string; id_token: string; refresh_token: string; account_id: string }
  last_refresh: string
}
const credential = (
  account = 'account-one',
  expiry = Math.floor(Date.now() / 1000) + 3600
): StoredCredential => ({
  auth_mode: 'chatgpt',
  tokens: {
    access_token: jwt({
      exp: expiry,
      'https://api.openai.com/auth': { chatgpt_account_id: account }
    }),
    id_token: jwt({ sub: 'synthetic-user' }),
    refresh_token: 'synthetic-refresh-token',
    account_id: account
  },
  last_refresh: new Date().toISOString()
})
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const profile = async (
  auth: unknown = credential(),
  config = ''
): Promise<{ storageRoot: string; home: string }> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'codex-harness-auth-'))
  roots.push(storageRoot)
  const home = codexSubscriptionStorageDir(storageRoot)
  await mkdir(home)
  await writeFile(join(home, 'auth.json'), JSON.stringify(auth))
  await writeFile(join(home, 'config.toml'), config)
  return { storageRoot, home }
}
const signal = (): AbortSignal => new AbortController().signal
const loopbackRoute = (extra = ''): string =>
  [
    'model_provider = "imported"',
    '[model_providers.imported]',
    'base_url = "http://127.0.0.1:1234/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    extra
  ].join('\n')

describe('Codex harness authentication', () => {
  it('reads only the app-owned profile and avoids runtime/proxy resolution for a live token', async () => {
    const { storageRoot, home } = await profile()
    const before = await readFile(join(home, 'auth.json'), 'utf8')
    const resolveProxyEnvironment = vi.fn()
    const result = await readCodexHarnessConnection(
      { storageRoot, nativePath: '/does-not-exist', resolveProxyEnvironment },
      signal()
    )
    expect(result).toEqual({
      endpoint: 'https://chatgpt.com/backend-api/codex/responses',
      accessToken: JSON.parse(before).tokens.access_token,
      accountId: 'account-one'
    })
    expect(resolveProxyEnvironment).not.toHaveBeenCalled()
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(before)
  })

  it('accepts a valid token until its actual expiry without requiring the CLI', async () => {
    const auth = credential('account-one', Math.floor(Date.now() / 1000) + 2)
    const { storageRoot } = await profile(auth)
    await expect(readCodexHarnessConnection({ storageRoot }, signal())).resolves.toMatchObject({
      accessToken: auth.tokens.access_token
    })
  })

  it('fails closed when the app-owned credential is missing instead of reading global Codex', async () => {
    const { storageRoot, home } = await profile()
    await rm(join(home, 'auth.json'))
    await expect(readCodexHarnessConnection({ storageRoot }, signal())).rejects.toThrow(
      'Reconnect Codex'
    )
  })

  it.each([
    { auth_mode: 'apikey', OPENAI_API_KEY: 'private-api-key' },
    { auth_mode: 'personalAccessToken', personal_access_token: 'private-pat' },
    { ...credential(), auth_mode: undefined, OPENAI_API_KEY: 'private-api-key' },
    { ...credential(), auth_mode: undefined, personal_access_token: 'private-pat' },
    { ...credential(), auth_mode: undefined, bedrock_api_key: { api_key: 'private-bedrock-key' } },
    { ...credential(), tokens: { ...credential().tokens, account_id: 'different-account' } },
    { ...credential(), tokens: { ...credential().tokens, account_id: 'invalid\naccount' } },
    { ...credential(), tokens: { ...credential().tokens, access_token: 'invalid\ntoken' } }
  ])(
    'rejects unsupported or inconsistent credential material without exposing it (%#)',
    async (auth) => {
      const { storageRoot } = await profile(auth)
      await expect(readCodexHarnessConnection({ storageRoot }, signal())).rejects.toThrow(
        /Codex.*(?:unavailable|not supported)/
      )
    }
  )

  it('requires the runtime only when the token has expired', async () => {
    const { storageRoot } = await profile(credential('account-one', 1))
    await expect(readCodexHarnessConnection({ storageRoot }, signal())).rejects.toThrow(
      'could not be refreshed'
    )
  })

  it('cancels before reading or starting a runtime', async () => {
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    await expect(
      readCodexHarnessConnection({ storageRoot: '/missing' }, abort.signal)
    ).rejects.toThrow('cancelled')
  })

  it('finishes token rotation before honoring cancellation after refresh was sent', async () => {
    const { storageRoot, home } = await profile(credential('account-one', 1))
    const nativePath = join(storageRoot, 'rotation.cjs')
    const next = credential()
    await writeFile(
      nativePath,
      `const fs=require('node:fs');const path=require('node:path');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(request.id===1)process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
 if(request.id===2){
  fs.writeFileSync(path.join(process.env.CODEX_HOME,'refresh-started'),'yes');
  setTimeout(()=>{
   fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),${JSON.stringify(JSON.stringify(next))});
   process.stdout.write(JSON.stringify({id:2,result:{}})+'\\n');
  },100);
 }
});`
    )
    const abort = new AbortController()
    const request = readCodexHarnessConnection({ storageRoot, nativePath }, abort.signal)
    const rejected = expect(request).rejects.toThrow('cancelled')
    for (let attempt = 0; ; attempt++) {
      try {
        await readFile(join(home, 'refresh-started'))
        break
      } catch {
        if (attempt === 100) throw new Error('Synthetic refresh did not start')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    abort.abort(new Error('cancelled'))
    await rejected
    expect(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))).toEqual(next)
  })

  it('suppresses raw app-server errors and tears down its stalled process', async () => {
    const { storageRoot } = await profile(credential('account-one', 1))
    const nativePath = join(storageRoot, 'failed-refresh.cjs')
    await writeFile(
      nativePath,
      `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(request.id===1)process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
 if(request.id===2)process.stdout.write(JSON.stringify({id:2,error:{message:'private-refresh-token'}})+'\\n');
});`
    )
    await expect(readCodexHarnessConnection({ storageRoot, nativePath }, signal())).rejects.toThrow(
      'Codex subscription authentication could not be refreshed.'
    )
  })

  it.each([
    { refreshedAccount: 'account-one', lazy: false },
    { refreshedAccount: 'account-two', lazy: false },
    { refreshedAccount: 'account-one', lazy: true }
  ])(
    'lets Codex refresh its own file and checks the account ($refreshedAccount, lazy=$lazy)',
    async ({ refreshedAccount, lazy }) => {
      vi.stubEnv('OPENAI_API_KEY', 'host-private-key')
      vi.stubEnv('CODEX_ACCESS_TOKEN', 'host-private-token')
      vi.stubEnv('CODEX_REFRESH_TOKEN_URL_OVERRIDE', 'https://untrusted.example/token')
      const { storageRoot, home } = await profile(credential('account-one', 1))
      const nativePath = join(storageRoot, 'synthetic-codex.cjs')
      const next = credential(refreshedAccount)
      await writeFile(
        nativePath,
        `const fs=require('node:fs');const path=require('node:path');
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(request.id===1)process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');
 if(request.id===2){
  fs.writeFileSync(path.join(process.env.CODEX_HOME,'probe.json'),JSON.stringify({
   params:request.params,home:process.env.HOME,cwd:process.cwd(),
   envKey:process.env.OPENAI_API_KEY??null,config:process.env.CODEX_CONFIG??null,
   accessOverride:process.env.CODEX_ACCESS_TOKEN??null,
   refreshOverride:process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE??null
  }));
  fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),${JSON.stringify(JSON.stringify(next))});
  process.stdout.write(JSON.stringify({id:2,result:{authMethod:'chatgpt'}})+'\\n');
 }
});`
      )
      const resolveProxyEnvironment = vi.fn(async () => ({}))
      const resolveNativePath = lazy ? vi.fn(async () => nativePath) : undefined
      const options = {
        storageRoot,
        nativePath: lazy ? undefined : nativePath,
        resolveNativePath,
        resolveProxyEnvironment
      }
      expect(await inspectCodexHarnessAvailability(options)).toBe(true)
      if (resolveNativePath) expect(resolveNativePath).not.toHaveBeenCalled()
      const request = readCodexHarnessConnection(options, signal())
      if (refreshedAccount === 'account-one') {
        await expect(request).resolves.toMatchObject({
          accessToken: next.tokens.access_token,
          accountId: refreshedAccount
        })
      } else await expect(request).rejects.toThrow('could not be refreshed')
      if (resolveNativePath) expect(resolveNativePath).toHaveBeenCalledOnce()
      expect(resolveProxyEnvironment).toHaveBeenCalledOnce()
      const { cwd, ...probe } = JSON.parse(await readFile(join(home, 'probe.json'), 'utf8'))
      // Windows may retain an 8.3 path in process.cwd(); compare directory identity on both sides.
      expect(await realpath(cwd)).toBe(await realpath(home))
      expect(probe).toEqual({
        params: { includeToken: false, refreshToken: true },
        home,
        envKey: null,
        config: null,
        accessOverride: null,
        refreshOverride: null
      })
    }
  )
})

describe('Codex harness routing', () => {
  it.each(['auto', 'https'] as const)('uses the fixed backend for %s', (transport) => {
    expect(resolveCodexHarnessEndpoint('', transport)).toBe(
      'https://chatgpt.com/backend-api/codex/responses'
    )
  })
  it('rejects an explicit WebSocket preference without an imported route', () => {
    expect(() => resolveCodexHarnessEndpoint('', 'websocket')).toThrow('Auto or HTTPS')
  })
  it('preserves imported loopback routing ahead of the transport preference', () => {
    expect(
      resolveCodexHarnessEndpoint(loopbackRoute('supports_websockets = true'), 'websocket')
    ).toBe('http://127.0.0.1:1234/v1/responses')
  })
  it.each([
    loopbackRoute('env_key = "PRIVATE_TOKEN"'),
    loopbackRoute().replace('127.0.0.1:1234', 'remote.example'),
    loopbackRoute().replace('/v1"', '/v1?"'),
    loopbackRoute() + '\n[model_providers.imported.http_headers]\nAuthorization = "secret"'
  ])('rejects remote or secret-dependent profile routes (%#)', (config) => {
    expect(() => resolveCodexHarnessEndpoint(config)).toThrow('route is not supported')
  })
})

describe('Codex harness availability', () => {
  it.each([
    [credential(), '', 'auto', true],
    [{ auth_mode: 'apikey', OPENAI_API_KEY: 'private-key' }, '', 'auto', false],
    [credential(), loopbackRoute('env_key = "PRIVATE_TOKEN"'), 'auto', false],
    [credential(), '', 'websocket', false],
    [credential(), loopbackRoute(), 'websocket', true],
    [credential('account-one', 1), '', 'auto', false]
  ] as const)(
    'projects the same credential and route requirements as a request (%#)',
    async (auth, config, transport, available) => {
      const { storageRoot } = await profile(auth, config)
      const options = { storageRoot, transport }
      expect(await inspectCodexHarnessAvailability(options)).toBe(available)
      if (available)
        await expect(readCodexHarnessConnection(options, signal())).resolves.toHaveProperty(
          'endpoint'
        )
      else await expect(readCodexHarnessConnection(options, signal())).rejects.toThrow()
    }
  )
})

it('does not advertise an expired token with a missing refresh executable', async () => {
  const { storageRoot } = await profile(credential('account-one', 1))
  expect(
    await inspectCodexHarnessAvailability({ storageRoot, nativePath: join(storageRoot, 'missing') })
  ).toBe(false)
})
