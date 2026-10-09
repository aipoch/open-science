import { expect, it, vi } from 'vitest'
import { ResearchExecutionConfigurationBroker } from './configuration-broker'
import type { ResearchExecutionPreflight } from '../../shared/research-execution-profile'

const scope = {
  projectId: 'project',
  sessionId: 'discussion',
  sourceSessionId: 'research',
  sourceIdentity: 'closure',
  descriptorVersionId: 'descriptor',
  planKey: 'original'
}
const blocked: ResearchExecutionPreflight = {
  status: 'blocked',
  binding: { ...scope, descriptorSha256: 'a'.repeat(64) },
  issues: [{ code: 'credential-required', key: 'provider' }],
  compatibleRuntimeIds: ['b'.repeat(64)],
  profiles: [],
  remoteServicesVerified: false,
  slots: [
    {
      key: 'provider',
      description: 'API key',
      environmentVariable: 'API_KEY',
      required: true,
      status: 'missing'
    }
  ]
}
it('hands verified scope to desktop, is idempotent, and only resolves after profile verification', async () => {
  const preflight = vi.fn(async () => structuredClone(blocked))
  const broker = new ResearchExecutionConfigurationBroker({ preflight })
  const request = { ...scope, requestId: 'configuration-one' }
  const [first, second] = await Promise.all([broker.request(request), broker.request(request)])
  expect(first.configurationId).toBe(second.configurationId)
  expect(preflight).toHaveBeenCalledTimes(1)
  expect(broker.listPending()).toHaveLength(1)
  await expect(
    broker.get({
      projectId: 'another',
      sessionId: scope.sessionId,
      configurationId: first.configurationId
    })
  ).rejects.toThrow('not found')
  await expect(
    broker.resolve({
      configurationId: first.configurationId,
      outcome: 'configured',
      profileId: 'other-profile'
    })
  ).rejects.toThrow('not configured')
  preflight.mockResolvedValue({
    ...blocked,
    status: 'ready',
    issues: [],
    selectedProfileId: 'local-profile',
    slots: blocked.slots.map((slot) => ({ ...slot, status: 'configured' }))
  })
  expect(
    await broker.resolve({
      configurationId: first.configurationId,
      outcome: 'configured',
      profileId: 'local-profile'
    })
  ).toMatchObject({ status: 'configured', profileId: 'local-profile' })
  expect(broker.listPending()).toEqual([])
  expect(
    await broker.get({
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      configurationId: first.configurationId
    })
  ).toMatchObject({ status: 'configured' })
  await expect(broker.request({ ...request, planKey: 'different' })).rejects.toThrow('conflicts')
})
it('dismisses or expires without launching and keeps prior admission stable on retries', async () => {
  let now = 1
  const broker = new ResearchExecutionConfigurationBroker({
    now: () => now,
    preflight: async () => structuredClone(blocked)
  })
  const first = await broker.request({ ...scope, requestId: 'one' })
  await broker.resolve({ configurationId: first.configurationId, outcome: 'dismissed' })
  expect(await broker.request({ ...scope, requestId: 'one' })).toMatchObject({
    status: 'dismissed'
  })
  const second = await broker.request({ ...scope, requestId: 'two' })
  now = second.expiresAt
  expect(broker.listPending()).toEqual([])
  expect(
    await broker.get({
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      configurationId: second.configurationId
    })
  ).toMatchObject({ status: 'expired' })
})
it('cannot request a forged source, accept secrets in public payloads, or override a dismissal during async resolution', async () => {
  const refused = new ResearchExecutionConfigurationBroker({
    preflight: async () => {
      throw new Error('Source is unavailable')
    }
  })
  await expect(refused.request({ ...scope, requestId: 'one' })).rejects.toThrow('unavailable')
  expect(refused.listPending()).toEqual([])
  await expect(
    refused.request({ ...scope, requestId: 'one', credentials: { key: 'secret' } })
  ).rejects.toThrow()
  let complete!: (result: ResearchExecutionPreflight) => void
  const preflight = vi.fn(async () => structuredClone(blocked))
  const broker = new ResearchExecutionConfigurationBroker({ preflight })
  const first = await broker.request({ ...scope, requestId: 'one' })
  preflight.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const resolution = broker.resolve({
    configurationId: first.configurationId,
    outcome: 'configured',
    profileId: 'local'
  })
  await broker.resolve({ configurationId: first.configurationId, outcome: 'dismissed' })
  complete({
    ...blocked,
    selectedProfileId: 'local',
    slots: blocked.slots.map((slot) => ({ ...slot, status: 'configured' }))
  })
  expect(await resolution).toMatchObject({ status: 'dismissed' })
})
