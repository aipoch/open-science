// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '../../../../test/renderer/literature'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRuntimeRecoveryState } from '../../../shared/desktop-runtime-recovery'
import { DesktopRuntimeRecovery } from './desktop-runtime-recovery'
import { useDesktopRuntimeRecoveryStore } from '@/stores/desktop-runtime-recovery-store'

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

describe('desktop recovery notice', () => {
  let publish: (state: DesktopRuntimeRecoveryState) => void
  const reconnect = vi.fn(async () => ({ phase: 'connected', epoch: 1, closing: false }))
  beforeEach(() => {
    useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', epoch: 0, closing: false })
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
  it('focuses the first available recovery action and keeps keyboard focus inside the dialog', async () => {
    render(
      <>
        <textarea aria-label="draft" />
        <DesktopRuntimeRecovery />
      </>
    )
    const draft = screen.getByLabelText('draft')
    draft.focus()
    await act(async () => publish({ phase: 'disconnected', epoch: 1, closing: false }))
    const quit = screen.getByRole('button', { name: 'Quit' })
    const reconnectButton = screen.getByRole('button', { name: 'Reconnect' })
    expect(document.activeElement).toBe(quit)
    // jsdom does not perform browser Tab navigation. Exercise Radix's boundary handlers;
    // real forward Tab and Enter activation are covered by the Electron recovery scenario.
    fireEvent.keyDown(quit, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(reconnectButton)
    fireEvent.keyDown(reconnectButton, { key: 'Tab' })
    expect(document.activeElement).toBe(quit)
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

  it('keeps editable content mounted, announces loss, and disables repeated recovery while pending', async () => {
    render(
      <>
        <textarea aria-label="draft" defaultValue="unsent work" />
        <DesktopRuntimeRecovery />
      </>
    )
    const draft = screen.getByLabelText('draft')
    await act(async () => publish({ phase: 'disconnected', epoch: 1, closing: false }))
    expect(screen.getByRole('status').textContent).toContain('Desktop connection lost')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(reconnect).toHaveBeenCalledOnce()
    act(() => publish({ phase: 'reconnecting', epoch: 1, closing: false }))
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
    act(() => publish({ phase: 'connected', epoch: 1, closing: false }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByLabelText('draft')).toBe(draft)
    expect((draft as HTMLTextAreaElement).value).toBe('unsent work')
  })
})

it('offers quit as the primary action when reconnection is unavailable', async () => {
  useDesktopRuntimeRecoveryStore.setState({ phase: 'unavailable', epoch: 1, closing: false })
  window.api = {} as typeof window.api
  render(<DesktopRuntimeRecovery />)
  expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Quit' }).getAttribute('data-variant')).toBe('default')
  expect(screen.getByRole('status').textContent).toContain('may have completed')
})
