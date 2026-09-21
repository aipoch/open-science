// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { SessionDiagnosticsDialog } from './SessionDiagnosticsDialog'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))
const translate = vi.fn((key: string): string => key)
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const inspectDiagnostics = vi.fn()
const exportDiagnostics = vi.fn()
const cancelDiagnostics = vi.fn()
const onClose = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  inspectDiagnostics.mockResolvedValue({
    items: [
      { id: 'session', name: 'session.json', kind: 'session', available: true, sizeBytes: 29_840 },
      { id: 'database', name: 'db', kind: 'database', available: true },
      { id: 'log:main.log', name: 'main.log', kind: 'log', available: true, sizeBytes: 197_723 },
      {
        id: 'log:main.1.log',
        name: 'main.1.log',
        kind: 'log',
        available: true,
        sizeBytes: 5_242_719
      },
      {
        id: 'invalid:backup',
        name: 'session.json.invalid-1-1',
        kind: 'invalid-session',
        available: false,
        reason: 'unreadable'
      }
    ]
  })
  exportDiagnostics.mockResolvedValue({ status: 'partial', path: '/tmp/report.tar.gz' })
  cancelDiagnostics.mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { sessions: { inspectDiagnostics, exportDiagnostics, cancelDiagnostics } }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
const render = async (): Promise<void> => {
  await act(async () =>
    root.render(
      <SessionDiagnosticsDialog identity={{ projectId: 'p', sessionId: 's' }} onClose={onClose} />
    )
  )
}
const button = (name: string): HTMLButtonElement =>
  [...document.querySelectorAll('button')].find((item) => item.textContent === name)!
it('exports only selected available items, opts into historical logs and reports partial success', async () => {
  await render()
  const checkboxes = [...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
  expect(checkboxes.map((item) => item.getAttribute('aria-checked') === 'true')).toEqual([
    true,
    true,
    true,
    false,
    false
  ])
  expect(checkboxes[4].disabled).toBe(true)
  expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Export diagnostics')
  expect(checkboxes[0].textContent).toContain('29 KB')
  expect(checkboxes[2].textContent).toContain('193 KB')
  expect(checkboxes[3].textContent).toContain('5.0 MB')
  expect(checkboxes[1].textContent).toContain('Session database records')
  expect(checkboxes[2].textContent).toContain(
    'Current application log metadata, including activity outside this session.'
  )
  expect(checkboxes[3].textContent).toContain(
    'Historical application log metadata, including activity outside this session. Select manually to investigate earlier issues.'
  )
  await act(async () => fireEvent.click(checkboxes[2]))
  await act(async () => fireEvent.click(button('Export')))
  expect(exportDiagnostics).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: 'p',
      sessionId: 's',
      selectedItems: ['session', 'database']
    })
  )
  expect(document.body.textContent).toContain('Diagnostics exported with missing information.')
  await act(async () => fireEvent.click(checkboxes[3]))
  await act(async () => fireEvent.click(button('Export')))
  expect(exportDiagnostics).toHaveBeenLastCalledWith(
    expect.objectContaining({ selectedItems: ['session', 'database', 'log:main.1.log'] })
  )
})
it('cancels an in-flight inspection using its operation identity', async () => {
  inspectDiagnostics.mockReturnValue(new Promise(() => {}))
  await render()
  await act(async () => fireEvent.click(button('Cancel')))
  expect(cancelDiagnostics).toHaveBeenCalledWith({
    operationId: inspectDiagnostics.mock.calls[0][0].operationId
  })
  expect(onClose).toHaveBeenCalledOnce()
})
it('contains rejected exports in the dialog and permits retry', async () => {
  exportDiagnostics.mockRejectedValue(new Error('transport closed'))
  await render()
  await act(async () => fireEvent.click(button('Export')))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Diagnostic export failed.'
  )
  expect(button('Export').disabled).toBe(false)
  expect(onClose).not.toHaveBeenCalled()
})

it('cancels the export operation rather than the completed inspection', async () => {
  let finish!: (value: { status: string }) => void
  exportDiagnostics.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  cancelDiagnostics.mockImplementation(async () => {
    finish({ status: 'cancelled' })
  })
  await render()
  await act(async () => fireEvent.click(button('Export')))
  await act(async () => fireEvent.click(button('Cancel')))
  const exportId = exportDiagnostics.mock.calls[0][0].operationId
  expect(exportId).not.toBe(inspectDiagnostics.mock.calls[0][0].operationId)
  expect(cancelDiagnostics).toHaveBeenCalledWith({ operationId: exportId })
  expect(onClose).toHaveBeenCalledOnce()
})

it('retains the dialog if cancellation fails so the task is not silently abandoned', async () => {
  inspectDiagnostics.mockReturnValue(new Promise(() => {}))
  cancelDiagnostics.mockRejectedValue(new Error('transport closed'))
  await render()
  await act(async () => fireEvent.click(button('Cancel')))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not cancel diagnostic export.'
  )
  expect(onClose).not.toHaveBeenCalled()
})

it('waits for the final cancellation report and keeps cleanup failures visible', async () => {
  let finish!: (value: object) => void
  exportDiagnostics.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  await render()
  await act(async () => fireEvent.click(button('Export')))
  await act(async () => fireEvent.click(button('Cancel')))
  expect(onClose).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(button('Cancel')))
  expect(cancelDiagnostics).toHaveBeenCalledTimes(1)
  await act(async () =>
    finish({
      status: 'cancelled',
      error: 'Temporary diagnostic files could not be fully removed.',
      report: 'cleanup failed (EACCES)',
      reportPath: '/tmp/failure/export.log'
    })
  )
  expect(onClose).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('cleanup failed (EACCES)')
  expect(document.body.textContent).toContain('/tmp/failure/export.log')
  await act(async () => fireEvent.click(button('Close')))
  expect(onClose).toHaveBeenCalledOnce()
})
it('shows both the archive and independent report after partial export', async () => {
  const revealInFolder = vi.fn().mockResolvedValue(undefined)
  Object.assign(window.api, { compute: { revealInFolder } })
  exportDiagnostics.mockResolvedValue({
    status: 'partial',
    path: '/tmp/report.tar.gz',
    reportPath: '/tmp/failure/export.log',
    report: 'cleanup failure'
  })
  await render()
  await act(async () => fireEvent.click(button('Export')))
  expect(document.body.textContent).toContain('/tmp/report.tar.gz')
  expect(document.body.textContent).toContain('/tmp/failure/export.log')
  await act(async () => fireEvent.click(button('Show export log')))
  expect(revealInFolder).toHaveBeenCalledWith('/tmp/failure/export.log')
})

it.each([
  'Choose a location outside application data and log folders.',
  'The selected file already exists. Choose a new filename.',
  'Diagnostic operation timed out.',
  'Temporary diagnostic files could not be fully removed.',
  'Choose a new .tar.gz file.'
])('translates application guidance: %s', async (error) => {
  exportDiagnostics.mockResolvedValue({ status: 'failed', error })
  await render()
  await act(async () => fireEvent.click(button('Export')))
  expect(translate).toHaveBeenCalledWith(error)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(error)
})

it('displays translated unavailable guidance with only a recognized source code', async () => {
  inspectDiagnostics.mockResolvedValue({
    items: [
      {
        id: 'session',
        name: 'session.json',
        kind: 'session',
        available: false,
        reason: 'Diagnostic source failed (ENOENT)'
      },
      {
        id: 'db',
        name: 'db',
        kind: 'database',
        available: false,
        reason: 'arbitrary backend details'
      }
    ],
    error: 'unexpected backend error'
  })
  await render()
  expect(document.body.textContent).toContain('Unavailable: ENOENT')
  expect(document.body.textContent).not.toContain('Diagnostic source failed')
  expect(document.body.textContent).not.toContain('arbitrary backend details')
  expect(document.body.textContent).not.toContain('unexpected backend error')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Diagnostic export failed.'
  )
})
