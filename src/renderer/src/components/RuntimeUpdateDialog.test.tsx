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
      expect(buttons('Cancel')[0].disabled).toBe(true)
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
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('/isolated/service')
    expect(document.body.textContent).toContain('standalone installation stays')
    expect(apply).not.toHaveBeenCalled()
    await act(async () => buttons('Stop server, update, and use Desktop')[0].click())
    expect(apply).toHaveBeenCalledWith({ force: false, cliConsentToken: 'reviewed' })
  })
  it('returns CLI cancellation to the update page without applying', async () => {
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
    const dialog = document.querySelector('[role="alertdialog"]')!
    await act(async () =>
      [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click()
    )
    expect(cancel).toHaveBeenCalledOnce()
    expect(apply).not.toHaveBeenCalled()
    expect(useUpdateStore.getState().isDialogOpen).toBe(true)
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
    expect(buttons('Recover app')).toHaveLength(1)
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
  act(() => buttons('Back up records and retry')[0].click())
  expect(apply).not.toHaveBeenCalled()
  const confirmation = document.querySelector('[role="alertdialog"]')!
  await act(async () =>
    [...confirmation.querySelectorAll('button')]
      .find((b) => b.textContent === 'Back up records and retry')!
      .click()
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
  await act(async () => buttons('Recheck')[0].click())
  expect(document.body.textContent).toContain('The operation could not be completed.')
  expect(document.querySelector('pre')?.textContent).toContain('probe connection failed')
  expect(document.querySelector('pre')?.textContent).not.toContain('fixture-secret')
  expect(
    [...document.querySelectorAll('details')].find(
      (d) => d.querySelector('summary')?.textContent === 'How to fix'
    )?.open
  ).toBe(true)
  await act(async () => buttons('Recheck')[0].click())
  expect(useUpdateStore.getState().status.error).toBeUndefined()
  expect(document.body.textContent).not.toContain('The operation could not be completed.')
  await act(async () => resolve(status))
  expect(buttons('Recheck')[0].disabled).toBe(false)
  expect(
    [...document.querySelectorAll('details')].find(
      (d) => d.querySelector('summary')?.textContent === 'How to fix'
    )?.open
  ).toBe(true)
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
  await act(async () => buttons('Recover app')[0].click())
  expect(useUpdateStore.getState().status.outcome).toBe('recovered')
  await act(async () => useUpdateStore.getState().openDialog())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(document.body.textContent).not.toContain('Recovery has not been confirmed')
  await act(async () => buttons('Restart to update')[0].click())
  expect(document.querySelector('[data-runtime-update-state="S11"]')).not.toBeNull()
  expect(document.body.textContent).not.toContain('Recovery has not been confirmed')
})
