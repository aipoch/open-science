import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProvisionProgress, ProvisionStatus } from '../../../shared/notebook-env'
import { createInitialNotebookEnvState, useNotebookEnvStore } from './notebook-env-store'

type ProgressListener = (p: ProvisionProgress) => void
type NotebookEnvBridgeMock = {
  getStatus: ReturnType<typeof vi.fn>
  provision: ReturnType<typeof vi.fn>
  repair: ReturnType<typeof vi.fn>
  onProgress: ReturnType<typeof vi.fn>
}

const READY: ProvisionStatus = { pythonReady: true, rReady: false, version: 3, provisioning: false }

const installApi = (
  over: Partial<Record<string, unknown>> = {}
): { api: NotebookEnvBridgeMock; emit: (p: ProvisionProgress) => void } => {
  const listeners: ProgressListener[] = []
  const api: NotebookEnvBridgeMock = {
    getStatus: vi.fn(async () => READY),
    provision: vi.fn(async () => undefined),
    repair: vi.fn(async () => undefined),
    onProgress: vi.fn((l: ProgressListener) => {
      listeners.push(l)
      return () => {}
    }),
    ...over
  }
  ;(globalThis as { window?: unknown }).window = { api: { notebookEnv: api } }
  return { api, emit: (p: ProvisionProgress) => listeners.forEach((l) => l(p)) }
}

beforeEach(() => {
  // Merge (not replace) so `init`/`provision`/`retry` stay intact — matches every other store's
  // reset pattern in this codebase (setState(createInitialXState()), no `replace` flag).
  useNotebookEnvStore.setState(createInitialNotebookEnvState())
})

describe('notebook-env-store', () => {
  it('starts from a not-ready, not-provisioning baseline', () => {
    expect(useNotebookEnvStore.getState().status).toEqual({
      pythonReady: false,
      rReady: false,
      version: 0,
      provisioning: false
    })
  })

  it('init subscribes to progress and hydrates the status snapshot', async () => {
    const { api } = installApi()
    await useNotebookEnvStore.getState().init()
    expect(api.onProgress).toHaveBeenCalledOnce()
    expect(api.getStatus).toHaveBeenCalledOnce()
    expect(useNotebookEnvStore.getState().status.pythonReady).toBe(true)
  })

  it('calling init() twice on the same bridge registers onProgress exactly once', async () => {
    const { api } = installApi()
    await useNotebookEnvStore.getState().init()
    await useNotebookEnvStore.getState().init()
    expect(api.onProgress).toHaveBeenCalledOnce()
    // Both calls still refresh the status snapshot.
    expect(api.getStatus).toHaveBeenCalledTimes(2)
  })

  it('records the scope and forwards provision(lang) to the bridge', async () => {
    const { api } = installApi()
    await useNotebookEnvStore.getState().provision('r')
    expect(api.provision).toHaveBeenCalledWith('r')
    expect(useNotebookEnvStore.getState().scope).toBe('r')
  })

  it('applies a broadcast progress event and refreshes status', async () => {
    const status: ProvisionStatus = {
      pythonReady: false,
      rReady: false,
      version: 3,
      provisioning: true
    }
    const { api, emit } = installApi({ getStatus: vi.fn(async () => status) })
    await useNotebookEnvStore.getState().init()
    emit({ phase: 'download', message: 'Fetching bundle…', progress: 0.25 })
    expect(useNotebookEnvStore.getState().progress).toEqual({
      phase: 'download',
      message: 'Fetching bundle…',
      progress: 0.25
    })
    // status is re-hydrated after each progress tick so provisioning/ready flip in lockstep.
    expect(api.getStatus).toHaveBeenCalledTimes(2)
  })

  it('captures a rejected provision as error state', async () => {
    installApi({ provision: vi.fn(async () => Promise.reject(new Error('offline'))) })
    await useNotebookEnvStore.getState().provision('python')
    expect(useNotebookEnvStore.getState().error).toBe('offline')
  })

  it('derives ui from status/scope/progress/error via deriveProvisionUi', async () => {
    const status: ProvisionStatus = {
      pythonReady: false,
      rReady: false,
      version: 0,
      provisioning: true
    }
    installApi({ getStatus: vi.fn(async () => status) })
    await useNotebookEnvStore.getState().provision('python')
    const { ui } = useNotebookEnvStore.getState()
    expect(ui).toEqual({ kind: 'preparing', scope: 'python', phase: '', message: '', progress: 0 })
  })
})
