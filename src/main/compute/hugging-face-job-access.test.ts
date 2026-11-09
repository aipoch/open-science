import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAccounts } from './compute-account-service'
import { getHuggingFaceJobAccess, resolveHuggingFaceJobIdentity } from './hugging-face-job-access'

import { resolveConfigRoot } from '../storage-root'
vi.mock('../storage-root', () => ({ resolveConfigRoot: vi.fn() }))
let configRoot: string
beforeEach(async () => {
  configRoot = await mkdtemp(join(tmpdir(), 'hf-account-config-'))
  vi.mocked(resolveConfigRoot).mockReturnValue(configRoot)
})
afterEach(async () => {
  await rm(configRoot, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
it('binds the local identity and private payer bucket before quoting a hosted job', async () => {
  vi.stubEnv('HF_ENDPOINT', 'https://huggingface.co')
  vi.stubEnv('HF_TOKEN', 'fixture-token')
  let privateBucket = true
  const fetch = vi.fn(async (input: string, init: RequestInit) => {
    const { pathname, origin } = new URL(input)
    expect(origin).toBe('https://huggingface.co')
    expect(init.redirect).toBe('error')
    expect(new Headers(init.headers).get('authorization')).toBe(
      pathname === '/api/jobs/hardware' ? null : 'Bearer fixture-token'
    )
    if (pathname === '/api/whoami-v2')
      return Response.json({ name: 'alice', id: 'user-1', orgs: [{ name: 'lab', id: 'org-1' }] })
    if (pathname === '/api/buckets/lab/private')
      return Response.json({ id: 'lab/private', private: privateBucket })
    expect(pathname).toBe('/api/jobs/hardware')
    return Response.json([{ name: 'cpu-basic', unitLabel: 'minute', unitCostMicroUSD: 167 }])
  })
  vi.stubGlobal('fetch', fetch)
  const target = { namespace: 'lab', bucket: 'lab/private', flavor: 'cpu-basic' }
  expect(await getHuggingFaceJobAccess(target)).toEqual({
    account: '["user-1","org-1"]',
    token: 'fixture-token',
    rateMicroUsdPerMinute: 167
  })
  privateBucket = false
  await expect(getHuggingFaceJobAccess(target)).rejects.toThrow('private Hugging Face Bucket')
  await expect(
    getHuggingFaceJobAccess({ ...target, namespace: 'another', bucket: 'another/private' })
  ).rejects.toThrow('namespace')
})

it('reads the active CLI token from HF_HOME and stops a read-only identity before upload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hf-cli-identity-'))
  try {
    await writeFile(join(root, 'token'), 'hf_fixture\n', { mode: 0o600 })
    vi.stubEnv('HF_HOME', root)
    vi.stubEnv('HF_ENDPOINT', 'https://huggingface.co')
    vi.stubEnv('HF_TOKEN_PATH', undefined)
    vi.stubEnv('HF_TOKEN', undefined)
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(new URL(url).pathname).toBe('/api/whoami-v2')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer hf_fixture')
      return Response.json({ id: 'user', name: 'alice', auth: { accessToken: { role: 'read' } } })
    })
    vi.stubGlobal('fetch', fetch)
    await expect(
      getHuggingFaceJobAccess({ namespace: 'alice', bucket: 'alice/private', flavor: 'cpu-basic' })
    ).rejects.toThrow('read-only')
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps managed identity checks on the official Hub when the local CLI uses a mirror', async () => {
  vi.stubEnv('HF_ENDPOINT', 'https://mirror.example')
  vi.stubEnv('HF_TOKEN', 'local-example')
  const fetch = vi.fn(async (url: string) => {
    expect(new URL(url).origin).toBe('https://huggingface.co')
    return Response.json({ id: 'user', name: 'alice' })
  })
  vi.stubGlobal('fetch', fetch)
  await expect(resolveHuggingFaceJobIdentity('alice')).rejects.toMatchObject({
    reason: 'authorization'
  })
  vi.stubEnv('HF_ENDPOINT', 'https://huggingface.co')
  vi.stubEnv('HUGGINGFACE_CO_STAGING', '1')
  await expect(resolveHuggingFaceJobIdentity('alice')).rejects.toMatchObject({
    reason: 'authorization'
  })
  expect(fetch).not.toHaveBeenCalled()
  vi.stubEnv('HF_ENDPOINT', 'https://mirror.example')
  const managed = vi.spyOn(computeAccounts, 'hfToken').mockResolvedValue('managed-example')
  try {
    expect(await resolveHuggingFaceJobIdentity('alice')).toMatchObject({ token: 'managed-example' })
  } finally {
    managed.mockRestore()
  }
})
