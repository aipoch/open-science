// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { SessionDiagnosticsDialog } from './SessionDiagnosticsDialog'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))
const translate = vi.fn((key: string, values?: Record<string, string | number>): string =>
  key.replace(/\{\{(\w+)\}\}/g, (match, name: string) => String(values?.[name] ?? match))
)
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
const checkbox = (name: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`[role="checkbox"][aria-label^="${name}"]`)!
it('exports only selected available items, opts into historical logs and reports partial success', async () => {
  await render()
  const revealInFolder = vi.fn().mockResolvedValue(undefined)
  Object.assign(window.api, { compute: { revealInFolder } })
  const checkboxes = [...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
  expect(checkboxes.map((item) => item.getAttribute('aria-checked') === 'true')).toEqual([
    true,
    true,
    false,
    true,
    false
  ])
  expect(checkbox('Damaged session copy').disabled).toBe(true)
  expect(checkbox('Session state').textContent).toContain('29 KB')
  const sessionDescription = document.getElementById(
    checkbox('Session state').getAttribute('aria-describedby')!
  )
  expect(sessionDescription?.textContent).toContain('Session state, tool activity')
  expect(document.querySelectorAll('section[aria-label]')).toHaveLength(2)
  expect(document.querySelector('section[aria-label="Session and execution"]')).not.toBeNull()
  expect(document.querySelector('section[aria-label="Application logs"]')).not.toBeNull()
  const dbDetails = checkbox('Related database records').parentElement?.querySelector('details')
  expect(dbDetails?.open).toBe(false)
  expect(dbDetails?.textContent).toContain('db/ArtifactVersion.json')
  expect(dbDetails?.textContent).toContain('db/ReviewFindingDisposition.json')
  expect(dbDetails?.textContent).toContain('Generated during export')
  await act(async () => fireEvent.click(dbDetails!.querySelector('summary')!))
  expect(dbDetails?.open).toBe(true)
  await act(async () => fireEvent.click(checkbox('Current log')))
  await act(async () => fireEvent.click(button('Export')))
  expect(exportDiagnostics).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: 'p',
      sessionId: 's',
      selectedItems: ['session', 'database']
    })
  )
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    'Diagnostic package exported successfully.'
  )
  expect(document.body.textContent).toContain(
    'Some selected material could not be included in full.'
  )
  await act(async () => fireEvent.click(button('Show in folder')))
  expect(revealInFolder).toHaveBeenCalledWith('/tmp/report.tar.gz')
  await act(async () => fireEvent.click(checkbox('Historical log 1')))
  await act(async () => fireEvent.click(button('Export')))
  expect(exportDiagnostics).toHaveBeenLastCalledWith(
    expect.objectContaining({ selectedItems: ['session', 'database', 'log:main.1.log'] })
  )
})

it('groups only available notebook sources under one execution selection', async () => {
  inspectDiagnostics.mockResolvedValue({
    items: [
      {
        id: 'notebook',
        name: 'notebook/run.json',
        kind: 'notebook',
        available: true,
        sizeBytes: 1024
      },
      {
        id: 'notebook:frame:one',
        name: 'notebook/frames/one/run.json',
        kind: 'notebook',
        available: true,
        sizeBytes: 2048
      },
      {
        id: 'notebook:frame:missing',
        name: 'notebook/frames/missing/run.json',
        kind: 'notebook',
        available: false,
        reason: 'Diagnostic source failed (ENOENT)'
      },
      {
        id: 'notebook:frames-limited',
        name: 'notebook/frames/…',
        kind: 'notebook',
        available: false,
        reason: 'Notebook frame discovery limit reached'
      }
    ]
  })
  await render()
  expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(2)
  const execution = checkbox('Execution records')
  const code = checkbox('Include execution code')
  expect(code.getAttribute('aria-checked')).toBe('false')
  expect(execution.getAttribute('aria-checked')).toBe('true')
  expect(execution.textContent).toContain('2 available, 1 unavailable')
  expect(execution.textContent).toContain('Known size: 3 KB')
  const describedBy = execution.getAttribute('aria-describedby')!.split(' ')
  expect(describedBy.map((id) => document.getElementById(id)?.textContent).join(' ')).toContain(
    '2 available, 1 unavailable'
  )
  expect(document.body.textContent).toContain('Some execution records could not be listed.')
  const details = execution.parentElement?.querySelector('details')
  expect(details?.open).toBe(false)
  expect(details?.querySelectorAll('li')).toHaveLength(3)
  expect(details?.textContent).toContain('notebook/frames/missing/run.json')
  expect(details?.textContent).toContain('ENOENT')
  await act(async () => fireEvent.click(execution))
  expect(execution.getAttribute('aria-checked')).toBe('false')
  await act(async () => fireEvent.click(execution))
  await act(async () => fireEvent.click(button('Export')))
  expect(exportDiagnostics).toHaveBeenCalledWith(
    expect.objectContaining({ selectedItems: ['notebook', 'notebook:frame:one'] })
  )
  expect(exportDiagnostics.mock.lastCall?.[0]).not.toHaveProperty('includeExecutionCode')
  await act(async () => fireEvent.click(code))
  await act(async () => fireEvent.click(button('Export')))
  expect(exportDiagnostics.mock.lastCall?.[0]).toMatchObject({ includeExecutionCode: true })
  await act(async () => fireEvent.click(execution))
  expect(code.disabled).toBe(true)
  expect(code.getAttribute('aria-checked')).toBe('false')
  await act(async () => fireEvent.click(execution))
  expect(code.getAttribute('aria-checked')).toBe('false')
  await act(async () => fireEvent.click(button('Export')))
  expect(exportDiagnostics.mock.lastCall?.[0]).not.toHaveProperty('includeExecutionCode')
})

it('disables execution records when no notebook source is available', async () => {
  inspectDiagnostics.mockResolvedValue({
    items: [
      {
        id: 'notebook',
        name: 'notebook/run.json',
        kind: 'notebook',
        available: false,
        reason: 'Diagnostic source failed (ENOENT)'
      }
    ]
  })
  await render()
  expect(checkbox('Execution records').disabled).toBe(true)
  expect(checkbox('Execution records').textContent).toContain(
    'Execution records are unavailable for this session.'
  )
})

it('closes from the title bar without bypassing the dialog close flow', async () => {
  await render()
  await act(async () => {
    fireEvent.click(document.querySelector('[role="dialog"] button[aria-label="Close"]')!)
  })
  expect(onClose).toHaveBeenCalledOnce()
})
it('keeps sensitive evidence visible while requiring an explicit opt-in for original files', async () => {
  inspectDiagnostics.mockResolvedValue({
    items: [
      {
        id: 'sensitive-evidence',
        name: 'Sensitive-content evidence (redacted)',
        kind: 'sensitive-evidence',
        available: true
      },
      {
        id: 'sensitive-file:0',
        name: 'objects/matched.bin',
        kind: 'sensitive-file',
        available: true,
        sizeBytes: 4
      },
      {
        id: 'sensitive-file:1',
        name: 'objects/another.bin',
        kind: 'sensitive-file',
        available: true,
        sizeBytes: 5
      }
    ]
  })
  await render()
  const checkboxes = [...document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')]
  expect(checkboxes).toHaveLength(3)
  expect(checkboxes.map((item) => item.getAttribute('aria-checked') === 'true')).toEqual([
    true,
    false,
    false
  ])
  expect(document.body.textContent).toContain(
    'Sensitive-content files are unchecked by default. Selecting one includes its original bytes in the local diagnostic archive.'
  )
  expect(checkboxes[0].textContent).toContain('Redacted scanner evidence')
  expect(checkboxes[1].textContent).toContain('Original file that triggered')
  expect(checkboxes[1].getAttribute('aria-label')).toBe(
    'Flagged original file: objects/matched.bin'
  )
  expect(checkboxes[2].getAttribute('aria-label')).toBe(
    'Flagged original file: objects/another.bin'
  )
  expect(checkboxes[1].parentElement?.querySelector('details')?.textContent).toContain(
    'objects/matched.bin'
  )
  expect(document.querySelector('section[aria-label="Sensitive content"]')).not.toBeNull()
  await act(async () => fireEvent.click(checkboxes[1]))
  await act(async () => fireEvent.click(button('Export')))
  expect(exportDiagnostics).toHaveBeenCalledWith(
    expect.objectContaining({ selectedItems: ['sensitive-evidence', 'sensitive-file:0'] })
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

it.each(['footer', 'title bar'])('cancels the export operation from the %s', async (source) => {
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
  await act(async () =>
    fireEvent.click(
      source === 'footer'
        ? button('Cancel')
        : document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
    )
  )
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
      report: 'cleanup failed (EACCES)'
    })
  )
  expect(onClose).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain('cleanup failed (EACCES)')
  expect(document.body.textContent).toContain(
    'Temporary diagnostic files could not be fully removed.'
  )
  expect(button('Copy report')).toBeDefined()
  await act(async () => fireEvent.click(button('Close')))
  expect(onClose).toHaveBeenCalledOnce()
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
  expect(checkbox('Session state').textContent).toContain('This file was not found.')
  expect(checkbox('Session state').textContent).not.toContain('ENOENT')
  expect(checkbox('Session state').parentElement?.querySelector('details')?.textContent).toContain(
    'ENOENT'
  )
  expect(checkbox('Related database records').textContent).toContain(
    'This source could not be read.'
  )
  expect(document.body.textContent).not.toContain('Diagnostic source failed')
  expect(document.body.textContent).not.toContain('arbitrary backend details')
  expect(document.body.textContent).not.toContain('unexpected backend error')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Diagnostic export failed.'
  )
})

it.each(['failed', 'partial'])(
  'keeps an unsaved %s report copyable without showing inline logs',
  async (status) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    exportDiagnostics.mockResolvedValue({
      status,
      ...(status === 'partial'
        ? { path: '/tmp/report.tar.gz' }
        : { error: 'Diagnostic export failed.' }),
      report: 'Diagnostic output export.log failed (ENOSPC)'
    })
    await render()
    await act(async () => fireEvent.click(button('Export')))
    expect(document.body.textContent).not.toContain('Diagnostic output export.log failed (ENOSPC)')
    await act(async () => fireEvent.click(button('Copy report')))
    expect(writeText).toHaveBeenCalledWith('Diagnostic output export.log failed (ENOSPC)')
    expect(button('Copied')).toBeDefined()
    await act(async () => fireEvent.click(button('Export')))
    expect(button('Copy report')).toBeDefined()
  }
)

it('keeps the report available when clipboard copying fails', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('Clipboard unavailable'))
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  exportDiagnostics.mockResolvedValue({ status: 'failed', report: 'collection failed (ENOSPC)' })
  await render()
  await act(async () => fireEvent.click(button('Export')))
  await act(async () => fireEvent.click(button('Copy report')))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not copy report')
  expect(button('Copy report')).toBeDefined()
})
