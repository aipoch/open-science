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

it('shows real scan counts without inventing a total or percentage', async () => {
  render(<MigrationProgress bridge={bridge} />)
  act(() =>
    publish({ ...initial, phase: 'scanning', path: '/fixture/workspaces', completed: 2816 })
  )
  expect(screen.getByText('Scanning local files…')).toBeTruthy()
  expect(screen.getByText('Items checked: 2816')).toBeTruthy()
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.getByText('/fixture/workspaces')).toBeTruthy()
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
