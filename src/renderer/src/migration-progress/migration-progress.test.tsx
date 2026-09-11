// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import { MigrationProgress } from './migration-progress'
import type { MigrationProgressBridge, MigrationProgressState } from './state'

let publish: (state: MigrationProgressState) => void
const initial = { phase: 'checking', startedAt: Date.now(), updatedAt: Date.now() }
let bridge: MigrationProgressBridge
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  bridge = {
    getState: async () => initial,
    subscribe: (listener) => {
      publish = listener
      return () => undefined
    },
    painted: vi.fn(),
    close: vi.fn(),
    copyDiagnostics: vi.fn(async () => {})
  }
})
afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await i18next.changeLanguage('en')
})

it('shows an indeterminate bar until the whole migration workload is counted', async () => {
  render(<MigrationProgress bridge={bridge} />)
  act(() =>
    publish({ ...initial, phase: 'scanning', path: '/fixture/workspaces', completed: 2816 })
  )
  expect(screen.getByText('Scanning local files…')).toBeTruthy()
  expect(screen.getByText('Items checked: 2816')).toBeTruthy()
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
  expect(screen.getByText('/fixture/workspaces')).toBeTruthy()
})
it('shows whole-operation progress independently of the current directory count', async () => {
  render(<MigrationProgress bridge={bridge} />)
  act(() =>
    publish({
      ...initial,
      phase: 'verifying',
      completed: 5,
      total: 5,
      overall: { completed: 620, total: 1000, entries: 48640, bytes: 900000 }
    })
  )
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('62')
  expect(screen.getByText('62%')).toBeTruthy()
  act(() =>
    publish({
      ...initial,
      phase: 'before-commit',
      overall: { completed: 999.9, total: 1000, entries: 48640, bytes: 900000 }
    })
  )
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('99')
  act(() =>
    publish({
      ...initial,
      phase: 'before-commit',
      overall: { completed: 1000, total: 1000, entries: 48640, bytes: 900000 }
    })
  )
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('99')
  act(() =>
    publish({
      ...initial,
      phase: 'completed',
      overall: { completed: 1000, total: 1000, entries: 48640, bytes: 900000 }
    })
  )
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100')
  expect(screen.getByText('100%')).toBeTruthy()
})
it('keeps the key reminder visible with long paths and after migration finishes', async () => {
  render(<MigrationProgress bridge={bridge} />)
  const warning =
    'Configuration migration invalidates encrypted keys. Add your model keys again after migration finishes.'
  expect(screen.getByText(warning)).toBeTruthy()
  act(() => publish({ ...initial, phase: 'completed' }))
  expect(screen.getByText(warning)).toBeTruthy()
})
it('retains an error that arrives before the initial state response', async () => {
  let resolve!: (state: MigrationProgressState) => void
  bridge.getState = () =>
    new Promise((r) => {
      resolve = r
    })
  render(<MigrationProgress bridge={bridge} />)
  act(() => publish({ ...initial, phase: 'failed', error: 'Occupied by PID 123' }))
  await act(async () => resolve(initial))
  expect(screen.getByText('Local data migration could not finish')).toBeTruthy()
  expect(screen.getByText('Occupied by PID 123')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
  expect(bridge.copyDiagnostics).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(bridge.close).toHaveBeenCalledOnce()
})
it('uses the saved interface language without reading application storage', async () => {
  bridge.getState = async () => ({ ...initial, phase: 'copying', locale: 'zh-Hans' })
  render(<MigrationProgress bridge={bridge} />)
  await waitFor(() => expect(screen.getByText('正在复制本地文件…')).toBeTruthy())
})
