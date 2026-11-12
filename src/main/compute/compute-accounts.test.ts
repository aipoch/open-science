import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PROTECTED_STRING_PREFIX } from '../secure-storage'
import { ComputeAccounts } from './compute-accounts'
import {
  AccountAuthError,
  type AccountMaterial,
  type ComputeAccountAdapter
} from './compute-account-adapter'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
type Options = Required<ConstructorParameters<typeof ComputeAccounts>[0]>
const fixture = async (): Promise<{
  root: string
  options: Options
  adapter: ComputeAccountAdapter
  owner: ComputeAccounts
  finish: (m: AccountMaterial) => void
}> => {
  const root = await mkdtemp(join(tmpdir(), 'compute-accounts-'))
  roots.push(root)
  const protection = {
    isAvailable: vi.fn(() => true),
    protect: (s: string) => PROTECTED_STRING_PREFIX + Buffer.from(s).toString('base64'),
    reveal: (s: string) => Buffer.from(s.slice(PROTECTED_STRING_PREFIX.length), 'base64').toString()
  }
  let finish!: (m: AccountMaterial) => void
  const adapter: ComputeAccountAdapter = {
    authorize: vi.fn(async (challenge) => {
      await challenge('https://huggingface.co/oauth/device', 'ABCD-EFGH', Date.now() + 300000)
      return await new Promise<AccountMaterial>((resolve) => {
        finish = resolve
      })
    }),
    probe: vi.fn(async (m) => (m ? 'managed-user' : 'cli-user'))
  }
  const options = {
    configRoot: () => root,
    openExternal: vi.fn(async () => {}),
    protection,
    adapters: { 'hugging-face': adapter, modal: adapter },
    refreshHf: vi.fn(async () => ({
      accessToken: 'rotated',
      refreshToken: 'rotated-refresh',
      expiresAt: Date.now() + 3600000
    }))
  }
  return {
    root,
    options,
    adapter,
    owner: new ComputeAccounts(options),
    finish: (m: AccountMaterial) => finish(m)
  }
}
it('restores protected credentials, rotates them once and disconnects without falling back to a CLI identity', async () => {
  const { root, owner, options, finish } = await fixture()
  const provider = 'hugging-face'
  expect(await owner.status(provider)).toMatchObject({
    source: 'local',
    state: 'connected',
    identity: 'cli-user'
  })
  expect(await owner.connect(provider)).toMatchObject({ source: 'managed', state: 'pending' })
  expect(await owner.connect(provider)).toMatchObject({ userCode: 'ABCD-EFGH' })
  expect(options.openExternal).toHaveBeenCalledOnce()
  finish({ accessToken: 'managed-secret', refreshToken: 'refresh-secret', expiresAt: Date.now() })
  await vi.waitFor(async () =>
    expect(await owner.status(provider)).toMatchObject({
      source: 'managed',
      identity: 'managed-user'
    })
  )
  const disk = await readFile(join(root, 'compute-hugging-face-account.json'), 'utf8')
  expect(disk).toContain(PROTECTED_STRING_PREFIX)
  expect(disk).not.toContain('managed-secret')
  expect(disk).not.toContain('refresh-secret')
  const restarted = new ComputeAccounts(options)
  const job = new AbortController()
  vi.mocked(options.refreshHf).mockImplementationOnce(async (_material, signal) => {
    job.abort()
    signal.throwIfAborted()
    return {
      accessToken: 'rotated',
      refreshToken: 'rotated-refresh',
      expiresAt: Date.now() + 3600000
    }
  })
  await Promise.all([
    expect(restarted.hfToken(job.signal)).rejects.toMatchObject({ name: 'AbortError' }),
    expect(restarted.hfToken()).resolves.toBe('rotated')
  ])
  expect(options.refreshHf).toHaveBeenCalledOnce()
  vi.mocked(options.adapters[provider].probe).mockRejectedValueOnce(new AccountAuthError('missing'))
  expect(await restarted.useLocal(provider)).toMatchObject({
    state: 'connected',
    source: 'managed',
    identity: 'managed-user',
    reason: 'missing'
  })
  expect(await restarted.hfToken()).toBe('rotated')
  expect(await restarted.disconnect(provider)).toMatchObject({ state: 'disconnected' })
  vi.stubEnv('HF_TOKEN', 'existing-local')
  await expect(new ComputeAccounts(options).hfToken()).rejects.toMatchObject({ reason: 'missing' })
  expect(await restarted.useLocal(provider)).toMatchObject({
    identity: 'cli-user',
    source: 'local'
  })
  expect(await restarted.hfToken()).toBe('existing-local')
})
it('rejects a late authorization result after cancel and reports discovery and encryption failures accurately', async () => {
  const { owner, finish, adapter, options } = await fixture()
  await owner.connect('modal')
  await owner.cancel('modal')
  finish({ tokenId: 'late', tokenSecret: 'unused-secret' })
  await Promise.resolve()
  expect(await owner.modalIdentity()).toBeUndefined()
  vi.mocked(adapter.probe)
    .mockRejectedValueOnce(new AccountAuthError('network'))
    .mockRejectedValueOnce(new AccountAuthError('authorization'))
  expect(await owner.status('modal', true)).toMatchObject({
    state: 'unavailable',
    reason: 'network'
  })
  expect(await owner.status('modal', true)).toMatchObject({
    state: 'expired',
    reason: 'authorization'
  })
  vi.mocked(options.protection.isAvailable).mockReturnValue(false)
  expect(await owner.connect('modal')).toMatchObject({
    state: 'connected',
    source: 'local',
    identity: 'cli-user',
    reason: 'storage'
  })
  expect(adapter.authorize).toHaveBeenCalledOnce()
})

it.each(['new', 'managed'] as const)(
  'keeps the %s account record intact when a cancelled local probe succeeds late',
  async (initial) => {
    const { root, owner, adapter, finish } = await fixture()
    const provider = 'modal'
    const file = join(root, 'compute-modal-account.json')
    if (initial === 'managed') {
      await owner.connect(provider)
      finish({ tokenId: 'existing-id', tokenSecret: 'existing-secret' })
      await vi.waitFor(async () =>
        expect(await owner.status(provider)).toMatchObject({
          state: 'connected',
          source: 'managed'
        })
      )
    }
    const original = initial === 'managed' ? await readFile(file, 'utf8') : undefined
    const reply = Promise.withResolvers<string>()
    const started = Promise.withResolvers<AbortSignal>()
    vi.mocked(adapter.probe).mockImplementationOnce(async (_material, signal) => {
      started.resolve(signal)
      return reply.promise
    })
    const selection = owner.useLocal(provider)
    const signal = await started.promise
    expect(await owner.status(provider)).toMatchObject({ state: 'pending', source: 'local' })
    const restored = await owner.cancel(provider)
    expect(signal.aborted).toBe(true)
    reply.resolve('late-local-identity')
    expect(await selection).toEqual({ ...restored, reason: 'cancelled' })
    if (initial === 'managed') {
      expect(restored).toMatchObject({ state: 'connected', source: 'managed' })
      expect(await readFile(file, 'utf8')).toEqual(original)
    } else {
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }
)

it('binds authorize and post-authorization probe to one runtime, rejecting an old queued connection after source commit', async () => {
  const f = await fixture()
  const controller = new AbortController()
  let current = true
  const fingerprint: string[] = []
  let finish!: (material: AccountMaterial) => void
  const bound: ComputeAccountAdapter = {
    authorize: async () => {
      fingerprint.push('python-a:authorize')
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    probe: async () => {
      fingerprint.push('python-a:probe')
      return 'runtime-a'
    }
  }
  const context = {
    adapter: bound,
    signal: controller.signal,
    operationId: 'a',
    revision: 0,
    assertCurrent: () => {
      if (!current) throw new Error('stale runtime')
    }
  }
  expect(await f.owner.connect('modal', context)).toMatchObject({
    state: 'pending',
    runtimeRevision: 0
  })
  finish({ tokenId: 'id', tokenSecret: 'secret' })
  await vi.waitFor(async () =>
    expect(await f.owner.status('modal')).toMatchObject({
      state: 'connected',
      identity: 'runtime-a',
      runtimeRevision: 0
    })
  )
  expect(fingerprint).toEqual(['python-a:authorize', 'python-a:probe'])
  await f.owner.commitRuntimeSelection('modal', async () => {
    current = false
  })
  await expect(f.owner.connect('modal', context)).rejects.toThrow('stale runtime')
  expect(fingerprint).toHaveLength(2)
})
it('invalidates old authorization and cache under the source commit queue without probing or deleting credentials', async () => {
  const f = await fixture()
  let finish!: (material: AccountMaterial) => void
  const probe = vi.fn(async () => 'old')
  const context = {
    adapter: {
      authorize: async () =>
        new Promise<AccountMaterial>((resolve) => {
          finish = resolve
        }),
      probe
    },
    signal: new AbortController().signal,
    operationId: 'old',
    revision: 0,
    assertCurrent: () => {}
  }
  await f.owner.connect('modal', context)
  await f.owner.commitRuntimeSelection('modal', async () => {})
  finish({ tokenId: 'old-id', tokenSecret: 'old-secret' })
  await Promise.resolve()
  await Promise.resolve()
  expect(probe).not.toHaveBeenCalled()
  expect(f.adapter.probe).not.toHaveBeenCalled()
  expect(await f.owner.modalIdentity()).toBeUndefined()
  expect(await f.owner.cancelOperation('modal', 'old')).toEqual({
    provider: 'modal',
    state: 'disconnected'
  })
  expect(f.adapter.probe).not.toHaveBeenCalled()
})

it('does not start a fallback account probe when a runtime operation is cancelled before source commit', async () => {
  const f = await fixture()
  const controller = new AbortController()
  let finish!: (material: AccountMaterial) => void
  await f.owner.connect('modal', {
    signal: controller.signal,
    operationId: 'cancel-before-commit',
    revision: 0,
    assertCurrent: () => {},
    adapter: {
      authorize: async () =>
        new Promise<AccountMaterial>((resolve) => {
          finish = resolve
        }),
      probe: vi.fn()
    }
  })
  controller.abort()
  finish({ tokenId: 'id', tokenSecret: 'secret' })
  await vi.waitFor(async () =>
    expect(await f.owner.status('modal')).toMatchObject({
      state: 'disconnected',
      reason: 'cancelled'
    })
  )
  expect(f.adapter.probe).not.toHaveBeenCalled()
})

it.each(['modal', 'hugging-face'] as const)(
  'reports a missing %s local identity without claiming browser authorization was rejected',
  async (provider) => {
    const f = await fixture()
    vi.mocked(f.adapter.probe).mockRejectedValue(new AccountAuthError('missing'))
    expect(await f.owner.useLocal(provider)).toMatchObject({
      provider,
      state: 'disconnected',
      localAvailable: false,
      reason: 'missing'
    })
    expect(f.options.openExternal).not.toHaveBeenCalled()
    expect(await f.owner.modalIdentity()).toBeUndefined()
  }
)

it.each([
  ['modal', 'managed'],
  ['modal', 'local'],
  ['hugging-face', 'managed'],
  ['hugging-face', 'local']
] as const)(
  'preserves a completed %s %s connection when its dialog cleanup cancels the old operation',
  async (provider, source) => {
    const f = await fixture()
    const controller = new AbortController()
    const probe = vi.fn(async () => 'connected-workspace')
    const context = {
      adapter: {
        probe,
        authorize: async (): Promise<AccountMaterial> =>
          provider === 'modal'
            ? { tokenId: 'id', tokenSecret: 'secret' }
            : { accessToken: 'hf_token' }
      },
      signal: controller.signal,
      operationId: 'completed',
      revision: 3,
      assertCurrent: () => {}
    }
    if (source === 'local') await f.owner.useLocal(provider, context)
    else {
      await f.owner.connect(provider, context)
      await vi.waitFor(async () =>
        expect(await f.owner.status(provider)).toMatchObject({ state: 'connected' })
      )
    }
    const connected = await f.owner.status(provider)
    const record = await readFile(join(f.root, `compute-${provider}-account.json`), 'utf8')
    probe.mockClear()
    controller.abort()
    expect(await f.owner.cancelOperation(provider, context.operationId)).toEqual(connected)
    expect(await f.owner.status(provider)).toEqual(connected)
    expect(probe).not.toHaveBeenCalled()
    expect(f.adapter.probe).not.toHaveBeenCalled()
    expect(await readFile(join(f.root, `compute-${provider}-account.json`), 'utf8')).toBe(record)
  }
)

it.each(['modal', 'hugging-face'] as const)(
  'preserves a newer %s flow when cancellation names an older operation',
  async (provider) => {
    const f = await fixture()
    await f.owner.connect(provider, {
      adapter: {
        authorize: async () => new Promise<AccountMaterial>(() => {}),
        probe: vi.fn()
      },
      signal: new AbortController().signal,
      operationId: 'newer',
      revision: 1,
      assertCurrent: () => {}
    })
    const pending = await f.owner.status(provider)
    expect(await f.owner.cancelOperation(provider, 'older')).toEqual(pending)
    expect(await f.owner.status(provider)).toEqual(pending)
    await f.owner.cancelOperation(provider, 'newer')
  }
)
