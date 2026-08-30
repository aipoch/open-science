import { describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import { AgentComputeService, type RawComputeService } from './agent-compute-service'

type AgentComputeHarness = Readonly<{
  raw: { [Method in keyof RawComputeService]: ReturnType<typeof vi.fn> }
  registry: {
    getEnabled: ReturnType<typeof vi.fn>
    getSelected: ReturnType<typeof vi.fn>
  }
  service: AgentComputeService
}>

const host = (providerId: string, overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: providerId,
  providerId,
  displayName: providerId,
  shape: 'direct_ssh',
  sshAlias: providerId.slice(4),
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const createHarness = (
  access = { enabled: ['ssh:available', 'ssh:selected'], selected: ['ssh:selected'] }
): AgentComputeHarness => {
  const raw = {
    list: vi.fn(async () => [host('ssh:available'), host('ssh:selected'), host('ssh:hidden')]),
    getDetails: vi.fn(async () => ({ doc: '', isSkeleton: false })),
    appendDetails: vi.fn(async () => undefined),
    replaceDetails: vi.fn(async () => undefined),
    callCommand: vi.fn(async () => ({ exit_code: 0, stdout: '', stderr: '', truncated: false })),
    download: vi.fn(async () => ({ path: 'result', name: 'result', size: 1 })),
    submitJob: vi.fn(async () => ({
      job_id: 'job-1',
      provider_id: 'ssh:selected',
      status: 'submitted' as const,
      remote_workdir: '/tmp/job-1'
    })),
    getJobStatus: vi.fn(async () => ({})),
    getJobResult: vi.fn(async () => ({})),
    setSessionConcurrencyLimit: vi.fn(async () => undefined),
    getSessionConcurrencyStatus: vi.fn(async () => ({
      session_limit: null,
      active_count: 0,
      queued_count: 0,
      provider_ceilings: {}
    }))
  }
  const registry = {
    getEnabled: vi.fn(() => access.enabled),
    getSelected: vi.fn(() => access.selected)
  }
  return { raw, registry, service: new AgentComputeService(raw as never, registry) }
}

describe('AgentComputeService', () => {
  it('returns only enabled hosts and projects selected or available roles', async () => {
    const { service } = createHarness()

    await expect(service.listHosts('session-1')).resolves.toEqual([
      expect.objectContaining({ provider_id: 'ssh:available', role: 'available' }),
      expect.objectContaining({ provider_id: 'ssh:selected', role: 'selected' })
    ])
    await expect(service.list('session-1')).resolves.toEqual([
      expect.objectContaining({ providerId: 'ssh:available' }),
      expect.objectContaining({ providerId: 'ssh:selected' })
    ])
  })

  it('reports a successful Probe as historical evidence rather than a live connection', async () => {
    const { raw, service } = createHarness({
      enabled: ['ssh:selected'],
      selected: ['ssh:selected']
    })
    raw.list.mockResolvedValueOnce([
      host('ssh:selected', {
        probeResult: {
          ok: true,
          probedAt: '2020-01-01T00:00:00.000Z',
          exitCode: 0,
          errorTail: null
        }
      })
    ])

    await expect(service.listHosts('session-1')).resolves.toEqual([
      expect.objectContaining({ status: 'last_probe_ok' })
    ])
  })

  it('defensively excludes selected hosts that are not enabled', async () => {
    const { service } = createHarness({ enabled: ['ssh:available'], selected: ['ssh:hidden'] })

    await expect(service.listPreferred('session-1')).resolves.toEqual([])
    await expect(service.listHosts('session-1')).resolves.toEqual([
      expect.objectContaining({ provider_id: 'ssh:available', role: 'available' })
    ])
  })

  it('preserves compatibility discovery methods without exposing disabled hosts', async () => {
    const { service } = createHarness()

    expect(service.listCompute('session-1')).toEqual(['ssh:available', 'ssh:selected'])
    await expect(service.listRegistered('session-1')).resolves.toEqual(
      await service.listHosts('session-1')
    )
    await expect(service.listPreferred('session-1')).resolves.toEqual([
      expect.objectContaining({ provider_id: 'ssh:selected', role: 'selected' })
    ])
  })

  it.each(['ssh:hidden', 'ssh:missing'])(
    'rejects unavailable %s before provider side effects',
    async (providerId) => {
      const { raw, service } = createHarness()
      const context = { sessionId: 'session-1', projectId: 'project-1' }

      await expect(service.callCommand(context, providerId, 'true', 'test')).rejects.toMatchObject({
        code: 'host_unavailable'
      })
      await expect(service.getDetails('session-1', providerId)).rejects.toMatchObject({
        code: 'host_unavailable'
      })
      await expect(
        service.download(context, providerId, '/tmp/a', { kind: 'session-cache' })
      ).rejects.toMatchObject({
        code: 'host_unavailable'
      })
      await expect(
        service.submitJob(context, providerId, 'test', 'true', {})
      ).rejects.toMatchObject({
        code: 'host_unavailable'
      })

      expect(raw.callCommand).not.toHaveBeenCalled()
      expect(raw.getDetails).not.toHaveBeenCalled()
      expect(raw.download).not.toHaveBeenCalled()
      expect(raw.submitJob).not.toHaveBeenCalled()
    }
  )

  it('delegates enabled provider calls with trusted context', async () => {
    const { raw, service } = createHarness()
    const context = { sessionId: 'session-1', projectId: 'project-1' }
    const signal = new AbortController().signal

    await service.callCommand(context, 'ssh:available', 'true', 'test', false, 5, signal)

    expect(raw.callCommand).toHaveBeenCalledWith(
      'ssh:available',
      'true',
      'test',
      false,
      5,
      context,
      signal
    )
  })

  it('scopes job reads to the trusted Session and an enabled provider', async () => {
    const { raw, service } = createHarness()
    const context = { sessionId: 'session-1', projectId: 'project-1' }

    await service.getJobStatus(context, 'ssh:available', 'job-1')
    await service.getJobResult(context, 'ssh:selected', 'job-2')

    expect(raw.getJobStatus).toHaveBeenCalledWith('job-1', {
      ...context,
      providerId: 'ssh:available'
    })
    expect(raw.getJobResult).toHaveBeenCalledWith('job-2', {
      ...context,
      providerId: 'ssh:selected'
    })

    await expect(service.getJobStatus(context, 'ssh:hidden', 'job-hidden')).rejects.toMatchObject({
      code: 'host_unavailable'
    })
    await expect(service.getJobResult(context, 'ssh:hidden', 'job-hidden')).rejects.toMatchObject({
      code: 'host_unavailable'
    })
    expect(raw.getJobStatus).toHaveBeenCalledTimes(1)
    expect(raw.getJobResult).toHaveBeenCalledTimes(1)
  })
})
