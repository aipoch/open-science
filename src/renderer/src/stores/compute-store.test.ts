import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeApprovalRequest, ComputeHost, ProbeResult } from '../../../shared/compute'
import {
  consumeComputeHostsPreload,
  createInitialComputeState,
  preloadComputeHosts,
  useComputeStore
} from './compute-store'

const createHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
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

const setComputeApi = (api: Partial<Window['api']['compute']>): void => {
  ;(globalThis as unknown as { window: { api: { compute: unknown } } }).window = {
    api: { compute: api }
  } as never
}

beforeEach(() => {
  useComputeStore.setState(createInitialComputeState())
})

describe('compute store', () => {
  it('loads hosts newest-first', async () => {
    setComputeApi({
      list: vi
        .fn()
        .mockResolvedValue([
          createHost({ providerId: 'ssh:old', createdAt: 10 }),
          createHost({ providerId: 'ssh:new', createdAt: 99 })
        ])
    })

    await useComputeStore.getState().loadHosts()

    expect(useComputeStore.getState().isLoaded).toBe(true)
    expect(useComputeStore.getState().loadError).toBeUndefined()
    expect(useComputeStore.getState().hosts.map((h) => h.providerId)).toEqual([
      'ssh:new',
      'ssh:old'
    ])
  })

  it('deduplicates only overlapping host loads and refreshes after they settle', async () => {
    let finishFirst!: (hosts: ComputeHost[]) => void
    const list = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<ComputeHost[]>((resolve) => (finishFirst = resolve))
      )
      .mockResolvedValueOnce([createHost({ providerId: 'ssh:refreshed' })])
    setComputeApi({ list })

    const first = useComputeStore.getState().loadHosts()
    const overlapping = useComputeStore.getState().loadHosts()
    expect(list).toHaveBeenCalledOnce()

    finishFirst([createHost()])
    await Promise.all([first, overlapping])
    await useComputeStore.getState().loadHosts()

    expect(list).toHaveBeenCalledTimes(2)
    expect(useComputeStore.getState().hosts[0]?.providerId).toBe('ssh:refreshed')
  })

  it('marks a lazy-boundary preload for exactly one panel mount', async () => {
    const list = vi.fn().mockResolvedValue([createHost()])
    setComputeApi({ list })

    await preloadComputeHosts()

    expect(list).toHaveBeenCalledOnce()
    expect(consumeComputeHostsPreload()).toBe(true)
    expect(consumeComputeHostsPreload()).toBe(false)
  })

  it('records a load error instead of throwing', async () => {
    setComputeApi({ list: vi.fn().mockRejectedValue(new Error('db down')) })

    await useComputeStore.getState().loadHosts()

    expect(useComputeStore.getState().isLoaded).toBe(true)
    expect(useComputeStore.getState().loadError).toBe('db down')
  })

  it('loads ssh aliases and degrades to empty on failure', async () => {
    setComputeApi({ sshConfigAliases: vi.fn().mockResolvedValue(['biowulf', 'lab-gpu']) })
    await useComputeStore.getState().loadSshAliases()
    expect(useComputeStore.getState().sshAliases).toEqual(['biowulf', 'lab-gpu'])

    setComputeApi({ sshConfigAliases: vi.fn().mockRejectedValue(new Error('no file')) })
    await useComputeStore.getState().loadSshAliases()
    expect(useComputeStore.getState().sshAliases).toEqual([])
  })

  it('creates a host and merges it into the cache', async () => {
    const created = createHost({ providerId: 'ssh:lab-gpu', createdAt: 50 })
    setComputeApi({ create: vi.fn().mockResolvedValue(created) })
    useComputeStore.setState({ hosts: [createHost({ providerId: 'ssh:old', createdAt: 10 })] })

    const result = await useComputeStore.getState().createHost({ sshAlias: 'lab-gpu' })

    expect(result.providerId).toBe('ssh:lab-gpu')
    expect(useComputeStore.getState().hosts.map((h) => h.providerId)).toEqual([
      'ssh:lab-gpu',
      'ssh:old'
    ])
  })

  it('propagates a create rejection (e.g. duplicate alias)', async () => {
    setComputeApi({
      create: vi
        .fn()
        .mockRejectedValue(new Error('A host with alias "biowulf" is already registered.'))
    })

    await expect(useComputeStore.getState().createHost({ sshAlias: 'biowulf' })).rejects.toThrow(
      /already registered/i
    )
  })

  it('unwraps the dedicated password-create API result without caching credential material', async () => {
    const created = createHost({
      providerId: 'ssh:password-host',
      authentication: {
        mode: 'password',
        credentialStatus: 'configured',
        revision: 1,
        lastVerifiedAt: 100
      }
    })
    const createPassword = vi.fn().mockResolvedValue({ ok: true, host: created })
    setComputeApi({ createPassword })
    const request = {
      sshAlias: 'password-host',
      authenticationMode: 'password' as const,
      username: 'researcher',
      port: 22,
      password: 'not cached',
      operationId: 'operation-1'
    }

    await expect(useComputeStore.getState().createPasswordHost(request)).resolves.toBe(created)

    expect(createPassword).toHaveBeenCalledWith(request)
    expect(JSON.stringify(useComputeStore.getState().hosts)).not.toContain(request.password)
  })

  it('turns a password-create failure envelope into a code-only renderer error', async () => {
    setComputeApi({
      createPassword: vi.fn().mockResolvedValue({
        ok: false,
        errorCode: 'authentication_failed'
      })
    })

    await expect(
      useComputeStore.getState().createPasswordHost({
        sshAlias: 'password-host',
        authenticationMode: 'password',
        username: 'researcher',
        port: 22,
        password: 'wrong',
        operationId: 'operation-1'
      })
    ).rejects.toMatchObject({ code: 'authentication_failed', message: 'authentication_failed' })
  })

  it('replaces only the public Host projection after a successful password reset', async () => {
    const current = createHost({
      authentication: {
        mode: 'password',
        credentialStatus: 'configured',
        revision: 1,
        lastVerifiedAt: undefined
      }
    })
    const updated = {
      ...current,
      authentication: { ...current.authentication!, revision: 2 }
    }
    const resetPassword = vi.fn().mockResolvedValue({ ok: true, host: updated })
    // The store re-probes in the background after a committed reset; keep that chain resolved.
    setComputeApi({
      resetPassword,
      probe: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(updated)
    })
    useComputeStore.setState({ hosts: [current] })
    const request = {
      providerId: current.providerId,
      password: 'new secret',
      operationId: 'reset-operation-1',
      expectedAuthenticationRevision: 1
    }

    await expect(useComputeStore.getState().resetPassword(request)).resolves.toEqual(updated)
    expect(resetPassword).toHaveBeenCalledWith(request)
    expect(useComputeStore.getState().hosts).toEqual([updated])
    expect(JSON.stringify(useComputeStore.getState())).not.toContain('new secret')
  })

  it('replaces only the changed Host projection after an authentication identity change', async () => {
    const existing = createHost({
      authentication: {
        mode: 'ssh_config',
        credentialStatus: 'missing',
        revision: 1,
        lastVerifiedAt: undefined
      }
    })
    const changed = createHost({
      sshOverrides: { user: 'new-user', port: 22 },
      authentication: {
        mode: 'password',
        credentialStatus: 'configured',
        revision: 2,
        lastVerifiedAt: 200
      }
    })
    const changeAuthentication = vi.fn().mockResolvedValue({ ok: true, host: changed })
    // The store re-probes in the background after a committed change; keep that chain resolved.
    setComputeApi({
      changeAuthentication,
      probe: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(changed)
    })
    useComputeStore.setState({ hosts: [existing, createHost({ providerId: 'ssh:other' })] })
    const request = {
      providerId: existing.providerId,
      expectedRevision: 1,
      operationId: 'change-1',
      authenticationMode: 'password' as const,
      username: 'new-user',
      port: 22,
      password: 'transient secret'
    }

    await useComputeStore.getState().changeAuthentication(request)

    expect(changeAuthentication).toHaveBeenCalledWith(request)
    expect(useComputeStore.getState().hosts[0]).toEqual(changed)
    expect(JSON.stringify(useComputeStore.getState().hosts)).not.toContain(request.password)
  })

  it('re-probes automatically after an authentication change commits', async () => {
    const changed = createHost({
      sshOverrides: { user: 'new-user', port: 22 },
      authentication: {
        mode: 'password',
        credentialStatus: 'configured',
        revision: 2,
        lastVerifiedAt: 200
      }
    })
    const probeResult: ProbeResult = {
      ok: true,
      probedAt: '2026-08-18T00:00:00.000Z',
      exitCode: 0,
      errorTail: null
    }
    const probed = { ...changed, probeResult }
    const probe = vi.fn().mockResolvedValue(probeResult)
    const get = vi.fn().mockResolvedValue(probed)
    setComputeApi({
      changeAuthentication: vi.fn().mockResolvedValue({ ok: true, host: changed }),
      probe,
      get
    })
    useComputeStore.setState({ hosts: [createHost()] })

    await useComputeStore.getState().changeAuthentication({
      providerId: 'ssh:biowulf',
      expectedRevision: 1,
      operationId: 'change-1',
      authenticationMode: 'password',
      username: 'new-user',
      port: 22,
      password: 'transient secret'
    })

    expect(probe).toHaveBeenCalledWith('ssh:biowulf')
    // The background probe replaces the cleared snapshot with the fresh result.
    await vi.waitFor(() => {
      expect(useComputeStore.getState().hosts[0]).toEqual(probed)
    })
    expect(useComputeStore.getState().probingIds.has('ssh:biowulf')).toBe(false)
  })

  it('re-probes automatically after a password reset commits', async () => {
    const updated = createHost({
      authentication: {
        mode: 'password',
        credentialStatus: 'configured',
        revision: 2,
        lastVerifiedAt: undefined
      }
    })
    const probeResult: ProbeResult = {
      ok: true,
      probedAt: '2026-08-18T00:00:00.000Z',
      exitCode: 0,
      errorTail: null
    }
    const probed = { ...updated, probeResult }
    const probe = vi.fn().mockResolvedValue(probeResult)
    const get = vi.fn().mockResolvedValue(probed)
    setComputeApi({
      resetPassword: vi.fn().mockResolvedValue({ ok: true, host: updated }),
      probe,
      get
    })
    useComputeStore.setState({ hosts: [createHost()] })

    await useComputeStore.getState().resetPassword({
      providerId: 'ssh:biowulf',
      password: 'new secret',
      operationId: 'reset-operation-1',
      expectedAuthenticationRevision: 1
    })

    expect(probe).toHaveBeenCalledWith('ssh:biowulf')
    await vi.waitFor(() => {
      expect(useComputeStore.getState().hosts[0]).toEqual(probed)
    })
    expect(useComputeStore.getState().probingIds.has('ssh:biowulf')).toBe(false)
  })

  it('keeps the committed authentication change when the automatic re-probe fails', async () => {
    const changed = createHost({
      sshOverrides: { user: 'new-user', port: 22 },
      authentication: {
        mode: 'ssh_config',
        credentialStatus: 'missing',
        revision: 2,
        lastVerifiedAt: 200
      }
    })
    setComputeApi({
      changeAuthentication: vi.fn().mockResolvedValue({ ok: true, host: changed }),
      probe: vi.fn().mockRejectedValue(new Error('probe IPC failed'))
    })
    useComputeStore.setState({ hosts: [createHost()] })

    await useComputeStore.getState().changeAuthentication({
      providerId: 'ssh:biowulf',
      expectedRevision: 1,
      operationId: 'change-1',
      authenticationMode: 'ssh_config',
      username: 'new-user',
      port: 22
    })

    // The rejected background probe is swallowed (no unhandled rejection) and clears probing state.
    await vi.waitFor(() => {
      expect(useComputeStore.getState().probingIds.size).toBe(0)
    })
    expect(useComputeStore.getState().hosts[0]).toEqual(changed)
  })

  it('deletes a host and drops it from the cache', async () => {
    const del = vi.fn().mockResolvedValue(undefined)
    setComputeApi({ delete: del })
    useComputeStore.setState({
      hosts: [createHost({ providerId: 'ssh:a' }), createHost({ providerId: 'ssh:b' })]
    })

    await useComputeStore.getState().deleteHost('ssh:a')

    expect(del).toHaveBeenCalledWith({ providerId: 'ssh:a' })
    expect(useComputeStore.getState().hosts.map((h) => h.providerId)).toEqual(['ssh:b'])
  })

  it('drops a durably deleted host when post-delete IPC cleanup reports an error', async () => {
    const del = vi.fn().mockRejectedValue(new Error('Grant cleanup failed'))
    const get = vi.fn().mockResolvedValue(null)
    setComputeApi({ delete: del, get })
    useComputeStore.setState({ hosts: [createHost({ providerId: 'ssh:a' })] })

    await expect(useComputeStore.getState().deleteHost('ssh:a')).resolves.toBeUndefined()

    expect(get).toHaveBeenCalledWith('ssh:a')
    expect(useComputeStore.getState().hosts).toEqual([])
  })

  it('keeps a host and reports deletion failure when the durable Host still exists', async () => {
    const host = createHost({ providerId: 'ssh:a' })
    const failure = new Error('database busy')
    setComputeApi({
      delete: vi.fn().mockRejectedValue(failure),
      get: vi.fn().mockResolvedValue(host)
    })
    useComputeStore.setState({ hosts: [host] })

    await expect(useComputeStore.getState().deleteHost('ssh:a')).rejects.toBe(failure)

    expect(useComputeStore.getState().hosts).toEqual([host])
  })
})

describe('compute store — details', () => {
  it('saveDetails calls detailsSave and re-fetches the host', async () => {
    const updatedHost = createHost({ detailsDoc: 'new content', detailsUpdatedBy: 'user' })
    const detailsSave = vi.fn().mockResolvedValue(undefined)
    const get = vi.fn().mockResolvedValue(updatedHost)
    setComputeApi({ detailsSave, get })
    useComputeStore.setState({ hosts: [createHost()] })

    await useComputeStore.getState().saveDetails('ssh:biowulf', 'new content', '')

    expect(detailsSave).toHaveBeenCalledWith('ssh:biowulf', 'new content', '', 'user')
    expect(useComputeStore.getState().hosts[0].detailsDoc).toBe('new content')
  })

  it('saveDetails propagates errors', async () => {
    setComputeApi({
      detailsSave: vi.fn().mockRejectedValue(new Error('old_text mismatch'))
    })

    await expect(
      useComputeStore.getState().saveDetails('ssh:biowulf', 'new', 'wrong old')
    ).rejects.toThrow(/old_text|mismatch/i)
  })
})

describe('compute store — scratch root', () => {
  it('setScratch calls scratchSet and re-fetches the host', async () => {
    const pinnedHost = createHost({ scratchRoot: '/my/scratch', scratchPinned: true })
    const scratchSet = vi.fn().mockResolvedValue(undefined)
    const get = vi.fn().mockResolvedValue(pinnedHost)
    setComputeApi({ scratchSet, get })
    useComputeStore.setState({ hosts: [createHost()] })

    await useComputeStore.getState().setScratch('ssh:biowulf', '/my/scratch')

    expect(scratchSet).toHaveBeenCalledWith('ssh:biowulf', '/my/scratch')
    expect(useComputeStore.getState().hosts[0].scratchPinned).toBe(true)
  })

  it('clearScratch calls scratchClear and re-fetches the unpinned host', async () => {
    const unpinnedHost = createHost({ scratchRoot: undefined, scratchPinned: false })
    const scratchClear = vi.fn().mockResolvedValue(undefined)
    const get = vi.fn().mockResolvedValue(unpinnedHost)
    setComputeApi({ scratchClear, get })
    useComputeStore.setState({
      hosts: [createHost({ scratchRoot: '', scratchPinned: true })]
    })

    await useComputeStore.getState().clearScratch('ssh:biowulf')

    expect(scratchClear).toHaveBeenCalledWith('ssh:biowulf')
    expect(useComputeStore.getState().hosts[0].scratchPinned).toBe(false)
  })
})

describe('compute store — concurrency limit', () => {
  it('setConcurrency calls concurrencySet and re-fetches the host', async () => {
    const updatedHost = createHost({ concurrencyLimit: 20 })
    const concurrencySet = vi.fn().mockResolvedValue(undefined)
    const get = vi.fn().mockResolvedValue(updatedHost)
    setComputeApi({ concurrencySet, get })
    useComputeStore.setState({ hosts: [createHost()] })

    await useComputeStore.getState().setConcurrency('ssh:biowulf', 20)

    expect(concurrencySet).toHaveBeenCalledWith('ssh:biowulf', 20)
    expect(useComputeStore.getState().hosts[0].concurrencyLimit).toBe(20)
  })
})

describe('compute store - approval replay', () => {
  it('deduplicates a replayed approval request by its stable id', () => {
    const request: ComputeApprovalRequest = {
      id: 'approval-1',
      operation: 'call_command',
      session_id: 'session-1',
      provider_id: 'ssh:lab',
      provider_name: 'Lab',
      shape: 'direct_ssh',
      intent: 'Run analysis',
      command_preview: 'run-analysis',
      command_full: 'run-analysis'
    }

    useComputeStore.getState().enqueueApproval(request)
    useComputeStore.getState().enqueueApproval(request)

    expect(useComputeStore.getState().pendingApprovals).toEqual([request])
  })

  it('dismisses a settled approval idempotently', () => {
    const first: ComputeApprovalRequest = {
      id: 'approval-1',
      operation: 'call_command',
      provider_id: 'ssh:lab',
      provider_name: 'Lab',
      shape: 'direct_ssh',
      intent: 'Run analysis',
      command_preview: 'run-analysis',
      command_full: 'run-analysis'
    }
    const second = { ...first, id: 'approval-2' }

    useComputeStore.setState({ pendingApprovals: [first, second] })
    useComputeStore.getState().dismissApproval('approval-1')
    useComputeStore.getState().dismissApproval('approval-1')

    expect(useComputeStore.getState().pendingApprovals).toEqual([second])
  })
})
