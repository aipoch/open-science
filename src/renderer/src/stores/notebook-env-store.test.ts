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

  it('maps a recovery-blocked status flag to a RUNTIME_RECOVERY_BLOCKED langError (surfaces Reset)', async () => {
    // Recovery blocks a prefix in the main process WITHOUT touching the ready marker, so status can read
    // ready. The store must translate the *RecoveryBlocked flag into a langError so the UI shows Reset.
    const blocked: ProvisionStatus = { ...READY, pythonReady: true, pythonRecoveryBlocked: true }
    installApi({ getStatus: vi.fn(async () => blocked) })
    await useNotebookEnvStore.getState().init()
    expect(useNotebookEnvStore.getState().byLang.python?.error).toContain(
      'RUNTIME_RECOVERY_BLOCKED'
    )
    expect(useNotebookEnvStore.getState().byLang.r?.error).toBeUndefined()
  })

  it('clears the recovery-blocked langError once the block is gone', async () => {
    // First hydrate blocked, then a later status refresh with the flag cleared drops the message.
    let flag = true
    const { emit } = installApi({
      getStatus: vi.fn(async () => ({ ...READY, pythonRecoveryBlocked: flag }))
    })
    await useNotebookEnvStore.getState().init()
    expect(useNotebookEnvStore.getState().byLang.python?.error).toContain(
      'RUNTIME_RECOVERY_BLOCKED'
    )
    // A subsequent progress event re-reads status (now unblocked) and clears the recovery message.
    flag = false
    emit({ phase: 'done', message: 'ok', progress: 1, language: 'python' })
    await Promise.resolve()
    await Promise.resolve()
    expect(useNotebookEnvStore.getState().byLang.python?.error).toBeUndefined()
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

  it('maps language progress scopes and clears the scope for a global upgrade', async () => {
    const { emit } = installApi()
    await useNotebookEnvStore.getState().init()

    emit({ phase: 'create-r', message: 'Preparing R', progress: 0.4, scope: 'r' })
    expect(useNotebookEnvStore.getState().scope).toBe('r')

    emit({ phase: 'upgrade', message: 'Updating runtimes', progress: 0.5, scope: 'upgrade' })
    expect(useNotebookEnvStore.getState().scope).toBeUndefined()
  })

  it('clears stale progress when a new provision starts', async () => {
    installApi()
    useNotebookEnvStore.setState({
      progress: { phase: 'error', message: 'Previous failure', progress: 0.8 },
      error: 'Previous failure'
    })

    const pending = useNotebookEnvStore.getState().provision('python')

    expect(useNotebookEnvStore.getState().progress).toBeUndefined()
    expect(useNotebookEnvStore.getState().error).toBeUndefined()
    await pending
  })

  it('captures a rejected provision as error state', async () => {
    installApi({ provision: vi.fn(async () => Promise.reject(new Error('offline'))) })
    await useNotebookEnvStore.getState().provision('python')
    expect(useNotebookEnvStore.getState().error).toBe('offline')
  })

  it('captures an automatic provisioning error broadcast', async () => {
    const { emit } = installApi()
    await useNotebookEnvStore.getState().init()

    emit({ phase: 'error', message: 'Managed runtime download failed', progress: 0 })

    expect(useNotebookEnvStore.getState().error).toBe('Managed runtime download failed')
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

  it('routes a language-tagged progress event into that language byLang slot only', async () => {
    const { emit } = installApi()
    await useNotebookEnvStore.getState().init()
    emit({ phase: 'create-r', message: 'Creating default-r…', progress: 0.5, language: 'r' })
    const { byLang } = useNotebookEnvStore.getState()
    expect(byLang.r).toMatchObject({ preparing: true, progress: { progress: 0.5, language: 'r' } })
    // Python's slot is untouched by an R event.
    expect(byLang.python).toBeUndefined()
  })

  it('settles a language byLang slot on its done/error event', async () => {
    const { emit } = installApi()
    await useNotebookEnvStore.getState().init()
    emit({ phase: 'create-python', message: 'Creating…', progress: 0.6, language: 'python' })
    expect(useNotebookEnvStore.getState().byLang.python?.preparing).toBe(true)
    emit({ phase: 'done', message: 'Python environment ready', progress: 1, language: 'python' })
    expect(useNotebookEnvStore.getState().byLang.python?.preparing).toBe(false)
  })

  it('keeps python preparing when R is requested concurrently (no phantom cancel — issue 3.1)', async () => {
    // The reported bug: requesting python then R made python look cancelled. Model the serialized
    // provisioner: python's request is still in flight (pending) when R is requested; both languages
    // must read as preparing on their own slots, and python must NOT be cleared by R's request.
    let resolvePython: (() => void) | undefined
    const provision = vi.fn((lang: string) =>
      lang === 'python'
        ? new Promise<void>((r) => {
            resolvePython = r
          })
        : Promise.resolve(undefined)
    )
    installApi({ provision })

    const pythonRun = useNotebookEnvStore.getState().provision('python')
    // R requested while python is still provisioning (queued behind it in the real provisioner).
    await useNotebookEnvStore.getState().provision('r')

    const mid = useNotebookEnvStore.getState().byLang
    expect(mid.python?.preparing).toBe(true) // python still preparing, NOT cancelled by the R request
    expect(mid.r?.preparing).toBe(false) // R's own request already settled (resolved bridge call)

    resolvePython?.()
    await pythonRun
    expect(useNotebookEnvStore.getState().byLang.python?.preparing).toBe(false)
  })

  it('settles a language card on its own tagged error (auto-provision failure — issue B2)', async () => {
    // A first-use (auto) provision emits language-tagged progress, so its failure MUST arrive tagged or
    // the card stays stuck preparing. A tagged error settles that slot and records the message.
    const { emit } = installApi()
    await useNotebookEnvStore.getState().init()
    emit({ phase: 'create-r', message: 'Creating…', progress: 0.5, language: 'r' })
    expect(useNotebookEnvStore.getState().byLang.r?.preparing).toBe(true)
    emit({ phase: 'error', message: 'Could not prepare default-r', progress: 0, language: 'r' })
    const { r } = useNotebookEnvStore.getState().byLang
    expect(r?.preparing).toBe(false)
    expect(r?.error).toBe('Could not prepare default-r')
  })

  it('an UNTAGGED error settles every preparing card (safety net — issue B2)', async () => {
    // An error we can't attribute to a language (e.g. a startup-gate failure) must still clear every
    // in-flight card, or a slot whose progress events were tagged would spin forever.
    const { emit } = installApi()
    await useNotebookEnvStore.getState().init()
    emit({ phase: 'create-python', message: 'Creating…', progress: 0.5, language: 'python' })
    emit({ phase: 'create-r', message: 'Creating…', progress: 0.5, language: 'r' })
    emit({ phase: 'error', message: 'Environment preparation failed', progress: 0 }) // no language
    const { byLang } = useNotebookEnvStore.getState()
    expect(byLang.python?.preparing).toBe(false)
    expect(byLang.r?.preparing).toBe(false)
  })

  it('cancel(lang) forwards the language to the bridge and clears that card (issue B1)', async () => {
    const cancel = vi.fn(async () => undefined)
    installApi({ cancel })
    await useNotebookEnvStore.getState().init()
    // R is preparing…
    useNotebookEnvStore.setState({ byLang: { r: { preparing: true } } })
    await useNotebookEnvStore.getState().cancel('r')
    // …and cancelling it forwards 'r' (so main never aborts the OTHER language) and clears R's card.
    expect(cancel).toHaveBeenCalledWith('r')
    expect(useNotebookEnvStore.getState().byLang.r?.preparing).toBe(false)
  })

  it('reset(lang) force-recovers via bridge.repair and settles the card (explicit recovery entry)', async () => {
    const repair = vi.fn(async () => undefined)
    installApi({ repair })
    await useNotebookEnvStore.getState().init()
    // A card stuck on a recovery block.
    useNotebookEnvStore.setState({
      byLang: { python: { preparing: false, error: 'RUNTIME_RECOVERY_BLOCKED: …' } }
    })
    await useNotebookEnvStore.getState().reset('python')
    expect(repair).toHaveBeenCalledWith('python') // force-recovery via the repair IPC
    const { python } = useNotebookEnvStore.getState().byLang
    expect(python?.preparing).toBe(false)
    expect(python?.error).toBeUndefined() // cleared on success
  })

  it('cancelling a queued Reset re-surfaces the recovery-blocked message (not "cancelled")', async () => {
    // The Reset never ran (it was cancelled while queued), so the block persists: status still reports
    // pythonRecoveryBlocked. cancel()'s status refresh must reapply it, or the card would show a bare
    // cleared/"cancelled" state and hide the Reset affordance until the component remounts.
    const cancel = vi.fn(async () => undefined)
    installApi({
      cancel,
      getStatus: vi.fn(async () => ({ ...READY, pythonRecoveryBlocked: true }))
    })
    await useNotebookEnvStore.getState().init()
    useNotebookEnvStore.setState({
      byLang: { python: { preparing: true, error: undefined } }
    })
    await useNotebookEnvStore.getState().cancel('python')
    expect(useNotebookEnvStore.getState().byLang.python?.preparing).toBe(false)
    expect(useNotebookEnvStore.getState().byLang.python?.error).toContain(
      'RUNTIME_RECOVERY_BLOCKED'
    )
  })

  it('a successful provision clears a stale recovery-blocked message for the OTHER language', async () => {
    // provision(lang) only touches its own language card directly; the recovery-block reapply must still
    // run off the returned status so an unrelated language's stale block message is refreshed too.
    // Seed R's block through init() (so it holds the exact RECOVERY_BLOCKED_MESSAGE the clear compares
    // against), then flip the flag off before provisioning python.
    let rBlocked = true
    installApi({ getStatus: vi.fn(async () => ({ ...READY, rRecoveryBlocked: rBlocked })) })
    await useNotebookEnvStore.getState().init()
    expect(useNotebookEnvStore.getState().byLang.r?.error).toContain('RUNTIME_RECOVERY_BLOCKED')
    rBlocked = false
    await useNotebookEnvStore.getState().provision('python')
    expect(useNotebookEnvStore.getState().byLang.r?.error).toBeUndefined()
  })
})
