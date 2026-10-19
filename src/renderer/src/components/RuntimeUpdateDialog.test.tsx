// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeUpdateOutcomeNotice } from './runtime-update-outcome-notice'
import { UpdateDialog } from './UpdateDialog'
import { RuntimeUpdateDialog } from './RuntimeUpdateDialog'
import { useUpdateStore } from '@/stores/update-store'
import type { UpdateStatus } from '../../../shared/update'

let root: Root, container: HTMLDivElement
const original = useUpdateStore.getState()
const buttons = (label: string): HTMLButtonElement[] =>
  [...document.querySelectorAll('button')].filter((b) => b.textContent === label)
const r = (
  extra: Partial<NonNullable<UpdateStatus['recovery']>> = {}
): NonNullable<UpdateStatus['recovery']> => ({
  phase: 'preparing',
  runtime: 'running',
  installation: 'unchanged',
  canCancel: true,
  canRetryInstall: false,
  canRecover: false,
  ...extra
})
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useUpdateStore.setState({
    ...original,
    isDialogOpen: true,
    status: { state: 'ready', current: '1', latest: '2', recovery: r() }
  })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useUpdateStore.setState(original)
})
const render = (): void => act(() => root.render(<RuntimeUpdateDialog />))
describe('runtime update operation boundaries', () => {
  it('allows cancellation while the apply request is unresolved', async () => {
    let finish!: () => void
    const apply = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          })
      ),
      cancel = vi.fn(async () => {})
    useUpdateStore.setState({ apply, cancel })
    render()
    act(() => buttons('Restart to update')[0].click())
    expect(buttons('Cancel')[0].disabled).toBe(false)
    await act(async () => buttons('Cancel')[0].click())
    expect(cancel).toHaveBeenCalledOnce()
    await act(async () => finish())
  })
  it.each(['handoff', 'cancelling'] as const)(
    'blocks cancellation after %s including Escape',
    async (phase) => {
      const cancel = vi.fn(async () => {})
      useUpdateStore.setState({
        cancel,
        status: {
          state: 'applying',
          current: '1',
          latest: '2',
          recovery: r({ phase, canCancel: true })
        }
      })
      render()
      expect(buttons('Cancel')).toHaveLength(0)
      await act(async () =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      )
      expect(cancel).not.toHaveBeenCalled()
    }
  )
  it('requires explicit exact-token CLI consent and reports its source', async () => {
    const apply = vi.fn(async () => {}),
      cancel = vi.fn(async () => {})
    useUpdateStore.setState({
      apply,
      cancel,
      status: {
        state: 'ready',
        current: '1',
        latest: '2',
        recovery: r(),
        cliConfirmation: {
          token: 'reviewed',
          pid: 123,
          port: 9000,
          source: 'another-installation',
          entryPath: '/isolated/service'
        }
      }
    })
    render()
    expect(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).toHaveLength(1)
    expect(buttons('Cancel')).toHaveLength(1)
    expect(buttons('Update')).toHaveLength(1)
    expect(buttons('Restart to update')).toHaveLength(0)
    expect(document.body.textContent).toContain('/isolated/service')
    expect(document.body.textContent).toContain('separate installation will not be updated')
    expect(apply).not.toHaveBeenCalled()
    await act(async () => buttons('Update')[0].click())
    expect(apply).toHaveBeenCalledWith({ force: false, cliConsentToken: 'reviewed' })
  })
  it('closes CLI cancellation without applying', async () => {
    const apply = vi.fn(async () => {}),
      cancel = vi.fn(async () => {})
    useUpdateStore.setState({
      apply,
      cancel,
      status: {
        state: 'ready',
        current: '1',
        latest: '2',
        recovery: r(),
        cliConfirmation: {
          token: 'reviewed',
          pid: 123,
          port: 9000,
          source: 'this-installation',
          entryPath: '/isolated/app'
        }
      }
    })
    render()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelectorAll('button')).toHaveLength(3)
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(cancel).toHaveBeenCalledOnce()
    expect(apply).not.toHaveBeenCalled()
    expect(useUpdateStore.getState().isDialogOpen).toBe(false)
  })
  it('does not expose install or Escape dismissal for incomplete files', async () => {
    const cancel = vi.fn(async () => {})
    useUpdateStore.setState({
      cancel,
      status: {
        state: 'error',
        current: '1',
        latest: '2',
        reason: 'install-failed',
        recovery: r({
          runtime: 'stopped-clean',
          installation: 'incomplete',
          canRecover: true,
          canRetryInstall: true
        })
      }
    })
    render()
    expect(buttons('Restart to update')).toHaveLength(0)
    expect(buttons('Retry')).toHaveLength(1)
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(cancel).not.toHaveBeenCalled()
  })
})

it('preserves exact-token legacy record recovery on the structured update surface', async () => {
  const apply = vi.fn(async () => {})
  useUpdateStore.setState({
    apply,
    status: {
      state: 'ready',
      current: '1',
      latest: '2',
      reason: 'active-work',
      recovery: r(),
      legacyShellRecovery: { token: 'records-snapshot', count: 2 }
    }
  })
  render()
  act(() => buttons('Continue')[0].click())
  expect(apply).not.toHaveBeenCalled()
  const confirmation = document.querySelector('[role="dialog"]')!
  await act(async () =>
    [...confirmation.querySelectorAll('button')].find((b) => b.textContent === 'Update')!.click()
  )
  expect(apply).toHaveBeenCalledWith({ legacyShellRecoveryToken: 'records-snapshot' })
})

it('shows authoritative task titles and uses guarded workspace navigation', async () => {
  const { useNavigationStore } = await import('@/stores/navigation-store')
  const originalNavigate = useNavigationStore.getState().openSession
  const navigate = vi.fn(
    (_project: string, _session: string, _origin: string, after?: () => void) => {
      after?.()
      return true
    }
  )
  useNavigationStore.setState({ openSession: navigate })
  try {
    useUpdateStore.setState({
      status: {
        state: 'ready',
        current: '1',
        latest: '2',
        reason: 'active-work',
        blockedBy: ['agent'],
        blockedTasks: [
          {
            projectId: 'project',
            sessionId: 'session',
            title: 'Actual session title',
            kind: 'agent'
          }
        ],
        recovery: r()
      }
    })
    render()
    expect(document.body.textContent).toContain('Actual session title')
    act(() => buttons('View task')[0].click())
    expect(navigate).toHaveBeenCalledWith('project', 'session', 'user', expect.any(Function))
    expect(useUpdateStore.getState().isDialogOpen).toBe(false)
    expect(useUpdateStore.getState().status.reason).toBe('active-work')
  } finally {
    useNavigationStore.setState({ openSession: originalNavigate })
  }
})

it('shows certified completion outside the update modal and allows dismissal', () => {
  useUpdateStore.setState({
    isDialogOpen: false,
    status: { state: 'ready', current: '1', latest: '2', outcome: 'installed' }
  })
  act(() => root.render(<RuntimeUpdateOutcomeNotice />))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    'Interrupted tasks will not restart automatically.'
  )
  act(() => (document.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click())
  expect(document.querySelector('[role="status"]')).toBeNull()
})

it.each(['cancelled', 'recovered'] as const)(
  'reopens %s through the real store and rechecks without losing safety facts',
  async (outcome) => {
    const status: UpdateStatus = {
      state: 'ready',
      current: '1',
      latest: `reopen-${outcome}`,
      applyKind: 'restart',
      outcome,
      recovery: r({ runtime: 'stopped-unclean', canRecover: true, canCancel: false })
    }
    const recheck = vi.fn(async () => status)
    window.api = { update: { recheck } } as unknown as typeof window.api
    useUpdateStore.setState({ ...original, status, isDialogOpen: false })
    await act(async () => root.render(<UpdateDialog />))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => useUpdateStore.getState().openDialog())
    expect(recheck).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-runtime-update-state="S11"]')).not.toBeNull()
    expect(useUpdateStore.getState().status.recovery).toEqual(status.recovery)
    expect(useUpdateStore.getState().status.outcome).toBeUndefined()
    // A repeated main response carrying the acknowledged completion cannot hide the reopened dialog.
    await act(async () => useUpdateStore.getState().recheck())
    expect(document.querySelector('[data-runtime-update-state="S11"]')).not.toBeNull()
  }
)

it('reports a real store recheck rejection, redacts diagnostics, and clears stale errors on retry', async () => {
  const status: UpdateStatus = {
    state: 'ready',
    current: '1',
    latest: '2',
    reason: 'runtime-not-controlled',
    recovery: r({ detail: 'controller-held' })
  }
  let resolve!: (next: UpdateStatus) => void
  const recheck = vi
    .fn()
    .mockRejectedValueOnce(new Error('probe connection failed password=fixture-secret'))
    .mockImplementationOnce(
      () =>
        new Promise<UpdateStatus>((done) => {
          resolve = done
        })
    )
  window.api = { update: { recheck } } as unknown as typeof window.api
  useUpdateStore.setState({ ...original, status, isDialogOpen: true })
  await act(async () => root.render(<UpdateDialog />))
  await act(async () => buttons('Retry')[0].click())
  expect(document.body.textContent).toContain('The operation could not be completed.')
  expect(document.querySelector('pre')?.textContent).toContain('probe connection failed')
  expect(document.querySelector('pre')?.textContent).not.toContain('fixture-secret')
  expect(
    [...document.querySelectorAll('details')].find(
      (d) => d.querySelector('summary')?.textContent === 'Diagnostics'
    )?.open
  ).toBe(false)
  await act(async () => buttons('Retry')[0].click())
  expect(useUpdateStore.getState().status.error).toBeUndefined()
  expect(document.body.textContent).not.toContain('The operation could not be completed.')
  await act(async () => resolve(status))
  expect(buttons('Retry')[0].disabled).toBe(false)
  expect(
    [...document.querySelectorAll('details')].find(
      (d) => d.querySelector('summary')?.textContent === 'Diagnostics'
    )?.open
  ).toBe(false)
})

it('presents a second completed cancellation after reopening and starting another apply', async () => {
  const completed: UpdateStatus = {
    state: 'ready',
    current: '1',
    latest: 'repeat-completion',
    applyKind: 'restart',
    outcome: 'cancelled',
    recovery: r()
  }
  const ready = { ...completed, outcome: undefined }
  window.api = {
    update: {
      recheck: async () => completed,
      apply: async () => ready,
      cancel: async () => completed
    }
  } as unknown as typeof window.api
  useUpdateStore.setState({ ...original, status: completed, isDialogOpen: false })
  await act(async () =>
    root.render(
      <>
        <UpdateDialog />
        <RuntimeUpdateOutcomeNotice />
      </>
    )
  )
  await act(async () =>
    (document.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click()
  )
  await act(async () => useUpdateStore.getState().openDialog())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => buttons('Restart to update')[0].click())
  await act(async () => buttons('Cancel')[0].click())
  expect(useUpdateStore.getState().status.outcome).toBe('cancelled')
  expect(document.querySelector('[data-runtime-update-state="S15"]')).not.toBeNull()
  await act(async () => useUpdateStore.getState().openDialog())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
})

it('reopens after a completed recovery without retaining a failed-recovery warning', async () => {
  const blocked: UpdateStatus = {
    state: 'ready',
    current: '1',
    latest: 'recovery-chain',
    reason: 'runtime-stop-unclean',
    recovery: r({ runtime: 'stopped-unclean', canRecover: true, canCancel: false })
  }
  const ready: UpdateStatus = {
    state: 'ready',
    current: '1',
    latest: 'recovery-chain',
    applyKind: 'restart',
    recovery: r()
  }
  window.api = {
    update: {
      recover: async () => ({ ...ready, outcome: 'recovered' }),
      recheck: async () => ready,
      apply: async () => blocked
    }
  } as unknown as typeof window.api
  useUpdateStore.setState({ ...original, status: blocked, isDialogOpen: true })
  await act(async () => root.render(<UpdateDialog />))
  await act(async () => buttons('Retry')[0].click())
  expect(useUpdateStore.getState().status.outcome).toBe('recovered')
  await act(async () => useUpdateStore.getState().openDialog())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(document.body.textContent).not.toContain('Recovery has not been confirmed')
  await act(async () => buttons('Restart to update')[0].click())
  expect(document.querySelector('[data-runtime-update-state="S11"]')).not.toBeNull()
  expect(document.body.textContent).not.toContain('Recovery has not been confirmed')
})

it.each([
  'runtime-not-controlled',
  'runtime-configuration-unsupported',
  'installation-busy'
] as const)(
  'puts the available check action in the footer for %s without offering installation',
  async (reason) => {
    const recheck = vi.fn(async () => {})
    useUpdateStore.setState({
      recheck,
      status: { state: 'ready', current: '1', reason, recovery: r() }
    })
    render()
    expect(buttons('Restart to update')).toHaveLength(0)
    expect(buttons('Retry')).toHaveLength(1)
    expect(buttons('Retry')[0].parentElement?.className).toContain('border-t')
    await act(async () => buttons('Retry')[0].click())
    expect(recheck).toHaveBeenCalledOnce()
  }
)

it('checks incomplete installation through recovery without attempting repair or install', async () => {
  const recover = vi.fn(async () => {}),
    apply = vi.fn(async () => {})
  useUpdateStore.setState({
    recover,
    apply,
    status: {
      state: 'error',
      current: '1',
      recovery: r({ installation: 'incomplete', canRecover: true, canCancel: false })
    }
  })
  render()
  await act(async () => buttons('Retry')[0].click())
  expect(recover).toHaveBeenCalledOnce()
  expect(apply).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('it does not repair them')
})

it('offers only quit when main cannot perform recovery', async () => {
  const quit = vi.fn(async () => {}),
    recover = vi.fn(async () => {})
  window.api = { runtimeStartup: { quit } } as unknown as typeof window.api
  useUpdateStore.setState({
    recover,
    status: {
      state: 'error',
      current: '1',
      recovery: r({ installation: 'incomplete', canRecover: false, canCancel: false })
    }
  })
  render()
  expect(buttons('Retry')).toHaveLength(0)
  expect(buttons('Quit')).toHaveLength(1)
  await act(async () => buttons('Quit')[0].click())
  expect(quit).toHaveBeenCalledOnce()
  expect(recover).not.toHaveBeenCalled()
})

it('describes preparation failure without claiming an unknown installation result', () => {
  useUpdateStore.setState({
    status: {
      state: 'ready',
      current: '1',
      latest: '2',
      reason: 'install-failed',
      error: 'Save failed',
      recovery: r()
    }
  })
  render()
  expect(document.body.textContent).toContain('Update preparation failed')
  expect(document.body.textContent).not.toContain('Installation result is unknown')
  expect(buttons('Cancel')).toHaveLength(1)
})

describe('continuous in-place update dialog', () => {
  it('keeps one dialog and release notes from download through installation preparation', () => {
    const base: UpdateStatus = {
      state: 'available',
      current: '1.0.11',
      latest: '1.0.12',
      applyKind: 'restart',
      notes: 'Preserve the release notes throughout the update.',
      totalBytes: 1024
    }
    useUpdateStore.setState({ status: base })
    act(() => root.render(<UpdateDialog />))
    const dialog = document.querySelector('[role="dialog"]')
    expect(buttons('Download update (1.0 KB)')).toHaveLength(1)
    for (const state of ['downloading', 'error', 'ready', 'applying'] as const) {
      act(() =>
        useUpdateStore.setState({
          status: {
            ...base,
            state,
            progress: 50,
            error: state === 'error' ? 'Synthetic download failed' : undefined
          }
        })
      )
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
      expect(document.querySelector('[role="dialog"]')).toBe(dialog)
      expect(dialog?.textContent).toContain(base.notes)
      if (state === 'ready') {
        expect(buttons('Restart to update')).toHaveLength(1)
        expect(dialog?.textContent).not.toContain('Diagnostics')
      }
    }
    expect(dialog?.textContent).toContain('Preparing update')
  })

  it('cancels a pending download without starting installation', async () => {
    let finish!: () => void
    const download = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const cancel = vi.fn(async () => {})
    const apply = vi.fn(async () => {})
    useUpdateStore.setState({
      download,
      cancel,
      apply,
      status: { state: 'available', current: '1', latest: '2', applyKind: 'restart' }
    })
    act(() => root.render(<UpdateDialog />))
    act(() => buttons('Download update')[0].click())
    expect(buttons('Cancel')[0].disabled).toBe(false)
    await act(async () => buttons('Cancel')[0].click())
    expect(cancel).toHaveBeenCalledOnce()
    expect(apply).not.toHaveBeenCalled()
    await act(async () => finish())
  })
})

describe('update check and download admission', () => {
  it.each(['idle', 'up-to-date'] as const)(
    'hides installation actions when an open offer changes to %s, even with a stale version',
    (state) => {
      useUpdateStore.setState({
        status: { state: 'available', current: '1', latest: '2', applyKind: 'restart' }
      })
      act(() => root.render(<UpdateDialog />))
      expect(buttons('Download update')).toHaveLength(1)
      act(() => useUpdateStore.setState({ status: { ...useUpdateStore.getState().status, state } }))
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(buttons('Restart to update')).toHaveLength(0)
      expect(buttons('Download update')).toHaveLength(0)
    }
  )

  it.each([undefined, '2'])(
    'keeps an open dialog mounted during provider checks with target %s',
    (latest) => {
      useUpdateStore.setState({
        status: { state: 'available', current: '1', latest: '2', applyKind: 'restart' }
      })
      act(() => root.render(<UpdateDialog />))
      const dialog = document.querySelector('[role="dialog"]')
      act(() =>
        useUpdateStore.setState({
          status: { state: 'checking', current: '1', latest, applyKind: 'restart' }
        })
      )
      expect(document.querySelector('[role="dialog"]')).toBe(dialog)
      expect(dialog?.textContent).toContain('Checking for updates…')
      expect(dialog?.textContent).not.toContain('Ready to install')
      expect(buttons('Download update')).toHaveLength(0)
      expect(buttons('Restart to update')).toHaveLength(0)
      expect(buttons('Cancel')[0].disabled).toBe(false)
      act(() =>
        useUpdateStore.setState({
          status: { state: 'error', current: '1', applyKind: 'restart', error: 'Check failed' }
        })
      )
      expect(document.querySelector('[role="dialog"]')).toBe(dialog)
      expect(buttons('Retry')).toHaveLength(1)
    }
  )

  it('rechecks a versionless failure instead of downloading or installing', async () => {
    let finish!: () => void
    const check = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const download = vi.fn(async () => {})
    const apply = vi.fn(async () => {})
    useUpdateStore.setState({
      check,
      download,
      apply,
      status: {
        state: 'error',
        current: '1',
        applyKind: 'restart',
        error: 'Synthetic check failure'
      }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.body.textContent).toContain('Synthetic check failure')
    expect(document.body.textContent).not.toContain('Ready to install')
    expect(buttons('Download update')).toHaveLength(0)
    expect(buttons('Restart to update')).toHaveLength(0)
    expect(buttons('Retry')).toHaveLength(1)
    act(() => buttons('Retry')[0].click())
    expect(buttons('Checking…')[0].disabled).toBe(true)
    expect(check).toHaveBeenCalledOnce()
    expect(download).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    await act(async () => finish())
    expect(buttons('Retry')[0].disabled).toBe(false)
  })

  it('retries a failed transfer with a known release through download', async () => {
    const check = vi.fn(async () => {})
    const download = vi.fn(async () => {})
    const apply = vi.fn(async () => {})
    useUpdateStore.setState({
      check,
      download,
      apply,
      status: {
        state: 'error',
        current: '1',
        latest: '2',
        applyKind: 'restart',
        error: 'Transfer failed'
      }
    })
    act(() => root.render(<UpdateDialog />))
    await act(async () => buttons('Download update')[0].click())
    expect(download).toHaveBeenCalledOnce()
    expect(check).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('keeps runtime recovery visible when the update provider reports checking', () => {
    useUpdateStore.setState({
      status: {
        state: 'checking',
        current: '1',
        applyKind: 'restart',
        recovery: r({ runtime: 'stopped-clean', canRecover: true })
      }
    })
    act(() => root.render(<UpdateDialog />))
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(buttons('Retry')).toHaveLength(1)
  })
})
