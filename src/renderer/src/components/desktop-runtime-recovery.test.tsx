// @vitest-environment jsdom
import { useLayoutEffect, useRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRuntimeRecoveryState } from '../../../shared/desktop-runtime-recovery'
import { DesktopRuntimeRecovery } from './desktop-runtime-recovery'
import { useUpdateStore } from '@/stores/update-store'
import { useDesktopRuntimeRecoveryStore } from '@/stores/desktop-runtime-recovery-store'

const sessionMocks = vi.hoisted(() => ({
  sessions: [] as {
    id: string
    projectId: string
    resumeRecovery?: { cause: string; promptMessageId: string }
  }[],
  openSession: vi.fn(),
  save: vi.fn()
}))
vi.mock('@/stores/session-store', () => ({
  useSessionStore: { getState: () => ({ sessions: sessionMocks.sessions }) }
}))
vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: { getState: () => ({ openSession: sessionMocks.openSession }) }
}))
vi.mock('./save-runtime-diagnostics', () => ({ saveRuntimeDiagnostics: sessionMocks.save }))

vi.mock('@/pages/workspace/composer-draft-storage', () => ({ flushComposerDrafts: vi.fn() }))
vi.mock('@/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ loadProjects: async () => undefined }) }
}))
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: { getState: () => ({ load: async () => true }) }
}))
vi.mock('@/stores/session-job-store', () => ({
  useSessionJobStore: { getState: () => ({ hydrateForRecovery: async () => undefined }) }
}))

afterEach(cleanup)

describe('desktop recovery notice', () => {
  let publish: (state: DesktopRuntimeRecoveryState) => void
  const reconnect = vi.fn(async () => ({ phase: 'connected', epoch: 1, closing: false }))
  beforeEach(() => {
    useUpdateStore.setState({ status: { state: 'idle', current: '1' } })
    useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', epoch: 0, closing: false }, true)
    sessionMocks.sessions = []
    sessionMocks.openSession.mockReset()
    sessionMocks.save.mockReset()
    reconnect.mockClear()
    window.api = {
      desktopRuntime: {
        getState: async () => ({ phase: 'connected', epoch: 0, closing: false }),
        reconnect,
        quit: vi.fn(),
        reconciled: vi.fn(),
        onStateChanged: (listener: typeof publish) => {
          publish = listener
          return () => undefined
        }
      }
    } as unknown as Window['api']
  })
  afterEach(cleanup)
  it('keeps draft focus across repeated disconnects without a modal or duplicate notice', async () => {
    render(
      <>
        <textarea aria-label="draft" />
        <DesktopRuntimeRecovery />
      </>
    )
    const draft = screen.getByLabelText('draft')
    draft.focus()
    for (let epoch = 1; epoch <= 3; epoch++) {
      await act(async () => publish({ phase: 'disconnected', epoch, closing: false }))
      expect(document.activeElement).toBe(draft)
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(screen.getAllByRole('status')).toHaveLength(1)
      await act(async () => publish({ phase: 'reconnecting', epoch, closing: false }))
      expect(screen.getByRole('button', { name: 'Quit' })).toBeTruthy()
      expect(document.activeElement).toBe(draft)
      await act(async () => publish({ phase: 'connected', epoch, closing: false }))
      expect(screen.queryByRole('status')).toBeNull()
    }
  })

  it('returns focus to the still-mounted draft after successful recovery', async () => {
    render(
      <>
        <textarea aria-label="draft" defaultValue="retained draft" />
        <DesktopRuntimeRecovery />
      </>
    )
    const draft = screen.getByLabelText('draft')
    draft.focus()
    await act(async () => publish({ phase: 'disconnected', epoch: 1, closing: false }))
    screen.getByRole('button', { name: 'Reconnect' }).focus()
    await act(async () => publish({ phase: 'connected', epoch: 1, closing: false }))
    await waitFor(() => expect(document.activeElement).toBe(draft))
    expect((draft as HTMLTextAreaElement).value).toBe('retained draft')
  })

  it('remembers focus before recovery makes the composer non-editable', async () => {
    render(
      <>
        <textarea aria-label="draft" />
        <DesktopRuntimeRecovery />
      </>
    )
    const draft = screen.getByLabelText('draft')
    // Model the browser losing focus when a recovery subscriber disables the composer.
    const unsubscribe = useDesktopRuntimeRecoveryStore.subscribe((state) => {
      if (state.phase !== 'connected') draft.blur()
    })
    try {
      draft.focus()
      await act(async () => publish({ phase: 'disconnected', epoch: 1, closing: false }))
      expect(document.activeElement).toBe(document.body)
      await act(async () => publish({ phase: 'reconnecting', epoch: 1, closing: false }))
      await act(async () => publish({ phase: 'connected', epoch: 1, closing: false }))
      await waitFor(() => expect(document.activeElement).toBe(draft))
    } finally {
      unsubscribe()
    }
  })

  it('captures focus before the application makes the background inert', async () => {
    const Background = (): React.JSX.Element => {
      const phase = useDesktopRuntimeRecoveryStore((state) => state.phase)
      const draft = useRef<HTMLTextAreaElement>(null)
      useLayoutEffect(() => {
        // jsdom does not implement inert focus loss. Reproduce the browser's commit-time blur.
        if (phase !== 'connected') draft.current?.blur()
      }, [phase])
      return <textarea ref={draft} aria-label="draft" inert={phase !== 'connected'} />
    }
    render(
      <>
        <Background />
        <DesktopRuntimeRecovery />
      </>
    )
    const draft = screen.getByLabelText('draft')
    draft.focus()
    await act(async () => publish({ phase: 'disconnected', epoch: 1, closing: false }))
    expect(document.activeElement).toBe(document.body)
    await act(async () => publish({ phase: 'reconnecting', epoch: 1, closing: false }))
    await act(async () => publish({ phase: 'connected', epoch: 1, closing: false }))
    await waitFor(() => expect(document.activeElement).toBe(draft))
  })

  it('keeps editable content mounted, announces loss, and disables repeated recovery while pending', async () => {
    render(
      <>
        <textarea aria-label="draft" defaultValue="unsent work" />
        <DesktopRuntimeRecovery />
      </>
    )
    const draft = screen.getByLabelText('draft')
    await act(async () => publish({ phase: 'disconnected', epoch: 1, closing: false }))
    expect(screen.getByRole('status').textContent).toContain('Local service connection lost')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(reconnect).toHaveBeenCalledOnce()
    act(() => publish({ phase: 'reconnecting', epoch: 1, closing: false }))
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
    act(() => publish({ phase: 'connected', epoch: 1, closing: false }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByLabelText('draft')).toBe(draft)
    expect((draft as HTMLTextAreaElement).value).toBe('unsent work')
  })

  it('announces confirmed interrupted tasks once after a new generation synchronizes', async () => {
    sessionMocks.sessions = [{ id: 's', projectId: 'p' }]
    render(<DesktopRuntimeRecovery />)
    await act(async () => publish({ phase: 'reconnecting', epoch: 1, closing: false }))
    sessionMocks.sessions = [
      {
        id: 's',
        projectId: 'p',
        resumeRecovery: {
          cause: 'app-restart',
          promptMessageId: 'prompt'
        }
      }
    ]
    await act(async () =>
      publish({ phase: 'connected', epoch: 1, closing: false, restartedGeneration: 'new' })
    )
    expect(screen.getByText('Local service restarted')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View tasks' }))
    expect(sessionMocks.openSession).toHaveBeenCalledWith('p', 's', 'user')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await act(async () =>
      publish({ phase: 'connected', epoch: 2, closing: false, restartedGeneration: 'new' })
    )
    expect(screen.queryByText('Local service restarted')).toBeNull()
  })

  it('does not equate a new service process with interrupted tasks', async () => {
    render(<DesktopRuntimeRecovery />)
    await act(async () => publish({ phase: 'reconnecting', epoch: 1, closing: false }))
    await act(async () =>
      publish({ phase: 'connected', epoch: 1, closing: false, restartedGeneration: 'new' })
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps diagnostics download feedback visible after reconnection', async () => {
    render(<DesktopRuntimeRecovery />)
    await act(async () =>
      publish({
        phase: 'unavailable',
        epoch: 1,
        closing: false,
        reason: 'crash-limit',
        diagnostics: 'safe lifecycle summary'
      })
    )
    expect(screen.getByText('Local service keeps stopping')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save diagnostics', hidden: true }))
    expect(sessionMocks.save).toHaveBeenCalledWith('safe lifecycle summary')
    await act(async () => publish({ phase: 'connected', epoch: 1, closing: false }))
    expect(screen.getByText('Diagnostics download started.')).toBeTruthy()
  })

  it('uses generic stop wording when no command-line provenance is known', async () => {
    render(<DesktopRuntimeRecovery />)
    await act(async () =>
      publish({ phase: 'unavailable', epoch: 1, closing: false, reason: 'service-stopped' })
    )
    expect(screen.getByText('Local service stopped')).toBeTruthy()
    expect(screen.queryByText('Local service stopped from the command line')).toBeNull()
  })

  it('shows quit progress without stealing focus or presenting another quit decision', async () => {
    render(
      <>
        <textarea aria-label="draft" />
        <DesktopRuntimeRecovery />
      </>
    )
    const draft = screen.getByLabelText('draft')
    draft.focus()
    await act(async () =>
      publish({ phase: 'connected', epoch: 1, closing: true, shutdownProgress: true })
    )
    expect(screen.getByText('Closing Open-Science…')).toBeTruthy()
    expect(document.activeElement).toBe(draft)
    expect(screen.queryByRole('button', { name: 'Quit' })).toBeNull()
    await act(async () =>
      publish({ phase: 'connected', epoch: 1, closing: false, shutdownProgress: false })
    )
    expect(screen.queryByRole('status')).toBeNull()
  })
})

it('offers retry and quit when automatic recovery is unavailable', async () => {
  useDesktopRuntimeRecoveryStore.setState({ phase: 'unavailable', epoch: 1, closing: false })
  window.api = {} as typeof window.api
  render(<DesktopRuntimeRecovery />)
  expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Quit' })).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('may have completed')
})

it('leaves planned update shutdown to the update dialog, but exposes a failed handoff', () => {
  window.api = {} as typeof window.api
  useDesktopRuntimeRecoveryStore.setState({ phase: 'disconnected', closing: true, epoch: 1 })
  useUpdateStore.setState({ status: { state: 'applying', current: '1' } })
  render(<DesktopRuntimeRecovery />)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  act(() => useUpdateStore.setState({ status: { state: 'error', current: '1' } }))
  expect(screen.getByRole('status')).toBeTruthy()
  cleanup()
})

it('does not hide an unexpected disconnect just because an update is preparing', () => {
  window.api = {} as typeof window.api
  useDesktopRuntimeRecoveryStore.setState({ phase: 'disconnected', closing: false, epoch: 1 })
  useUpdateStore.setState({ status: { state: 'applying', current: '1' } })
  render(<DesktopRuntimeRecovery />)
  expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
  cleanup()
})
