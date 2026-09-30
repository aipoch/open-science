// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { read } from 'styled-exceljs'
import { JournalManager } from './JournalManager'
import { ApplicationCommandError } from '../../../../shared/application-command-contract'
import type {
  JournalDataset,
  JournalRequest,
  JournalResult
} from '../../../../shared/journal-attributes'

const valueRender = vi.hoisted(() => vi.fn())
vi.mock('./JournalAttributes', async () => {
  const actual = await vi.importActual<typeof import('./JournalAttributes')>('./JournalAttributes')
  return {
    ...actual,
    JournalAttributeValue: (props: Parameters<typeof actual.JournalAttributeValue>[0]) => {
      valueRender(props.attribute.key)
      return <actual.JournalAttributeValue {...props} />
    }
  }
})

vi.mock('./LiteratureImportDialogFrame', () => ({
  LiteratureImportDialogFrame: ({
    children,
    footer
  }: {
    children: React.ReactNode
    footer: React.ReactNode
  }) => (
    <div>
      {children}
      {footer}
    </div>
  )
}))
afterEach(() => {
  cleanup()
  window.localStorage.removeItem('open-science:journal-source-years')
})
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  window.matchMedia = vi.fn().mockReturnValue({ matches: false })
})

const choose = async (label: string, option: string): Promise<void> => {
  fireEvent.click(await screen.findByRole('combobox', { name: label }))
  fireEvent.click(await screen.findByRole('option', { name: option }))
}
const dataset: JournalDataset = {
  id: 'invented-dataset',
  source: 'Fictional source',
  year: 2031,
  revision: 1,
  count: 1,
  importedAt: 1,
  fields: [{ id: 'signal', label: 'Signal index', kind: 'number', colors: {}, visible: true }]
}
it('keeps custom namespaces editable and rejects blank or invalid values before review', async () => {
  vi.stubGlobal(
    'Worker',
    class {
      onmessage?: (event: MessageEvent) => void
      terminate = vi.fn()
      postMessage(): void {
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              result: {
                rows: [
                  ['Journal name', 'Provider code', 'Signal'],
                  ['Imaginary Review', 'fictional-42', '4.8']
                ],
                names: [],
                selected: ''
              }
            }
          } as MessageEvent)
        )
      }
    }
  )
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
    if (request.action === 'begin') return { token: '11111111-1111-4111-8111-111111111111' }
    if (request.action === 'preview')
      return { rows: [], digest: 'a'.repeat(64), ready: 1, problems: 0, total: 1 }
    return { datasets: [] }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  try {
    render(<JournalManager onOpenItem={() => {}} onClose={() => {}} />)
    const file = new File(['synthetic'], 'fictional-2031.csv')
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(0) })
    fireEvent.change(screen.getByLabelText('Import journal file'), { target: { files: [file] } })
    await screen.findByText(file.name)
    expect(
      screen.getByText(
        'Use identity columns to match journals. Choose Journal attribute for values to show and filter in the literature table.'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('combobox', { name: 'Role for column 2' }))
    const identityGroup = await screen.findByRole('group', { name: 'Identify journals' })
    expect(
      within(identityGroup)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Journal name', 'Abbreviation', 'ISSN', 'External journal ID'])
    expect(
      within(identityGroup).getByText('Used for matching, not as attribute columns.')
    ).toBeTruthy()
    const attributeGroup = screen.getByRole('group', { name: 'Save as attribute columns' })
    expect(within(attributeGroup).getAllByRole('option')).toHaveLength(1)
    expect(within(attributeGroup).getByRole('option', { name: 'Journal attribute' })).toBeTruthy()
    expect(
      within(attributeGroup).getByText('Show and filter these columns in the literature table.')
    ).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Skip' }).closest('[role="group"]')).toBeNull()
    fireEvent.click(within(identityGroup).getByRole('option', { name: 'External journal ID' }))
    expect(screen.getByRole('combobox', { name: 'Role for column 2' }).textContent).toBe(
      'External journal ID'
    )
    await choose('Role for column 3', 'Journal attribute')
    await choose('External identifier namespace', 'Custom namespace')
    const input = screen.getByRole('textbox', { name: 'Custom namespace' }) as HTMLInputElement
    for (const value of ['j', 'jc', 'jcr', 'jcr-custom', '', '123 invalid']) {
      fireEvent.change(input, { target: { value } })
      expect(screen.getByRole('textbox', { name: 'Custom namespace' })).toBe(input)
      expect(input.value).toBe(value)
      if (!value || value === '123 invalid') {
        await act(async () =>
          fireEvent.click(screen.getByRole('button', { name: 'Review import' }))
        )
        expect(journals.mock.calls.some(([request]) => request.action === 'begin')).toBe(false)
      }
    }
    await choose('External identifier namespace', 'JCR')
    expect(screen.queryByRole('textbox', { name: 'Custom namespace' })).toBeNull()
    await choose('External identifier namespace', 'Custom namespace')
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom namespace' }), {
      target: { value: 'publisher-id' }
    })
    await choose('Role for column 1', 'Skip')
    expect(
      (screen.getByRole('button', { name: 'Review import' }) as HTMLButtonElement).disabled
    ).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Review import' }))
    await screen.findByRole('button', { name: 'Edit mapping' })
    const appended = journals.mock.calls.find(([request]) => request.action === 'append')![0]
    expect(appended).toMatchObject({
      rows: [
        { name: '', issns: [], externalIds: [{ namespace: 'publisher-id', value: 'fictional-42' }] }
      ]
    })
  } finally {
    vi.unstubAllGlobals()
  }
})
it('keeps field drafts separate, cancels without a fetch, and saves only explicitly', async () => {
  let stored = structuredClone(dataset)
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
    if (request.action === 'fields') {
      expect(request.expectedRevision).toBe(1)
      stored = { ...stored, fields: request.fields, revision: 2 }
    }
    if (request.action === 'entries')
      return {
        total: 1,
        entries: [
          {
            id: 'invented-journal',
            row: 1,
            name: 'Imaginary Moonlight Review',
            aliases: [],
            issns: [],
            values: { signal: '3' }
          }
        ]
      }
    return { datasets: [stored] }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalManager onOpenItem={() => {}} onClose={() => {}} />)
  await screen.findByText('Imaginary Moonlight Review')
  fireEvent.click(screen.getByRole('button', { name: 'Customize columns' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Attribute name' }), {
    target: { value: 'Draft label' }
  })
  expect(screen.getByRole('button', { name: 'Signal index' })).toBeTruthy()
  const calls = journals.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(journals.mock.calls).toHaveLength(calls)
  fireEvent.click(screen.getByRole('button', { name: 'Customize columns' }))
  expect((screen.getByRole('textbox', { name: 'Attribute name' }) as HTMLInputElement).value).toBe(
    'Signal index'
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'Attribute name' }), {
    target: { value: 'Revised signal' }
  })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Revised signal' })).toBeTruthy())
  expect(journals.mock.calls.filter(([request]) => request.action === 'fields')).toHaveLength(1)
  expect(stored.fields[0].label).toBe('Revised signal')
})
it('edits one journal row from the fixed action column', async () => {
  let stored = structuredClone(dataset)
  let value = '3'
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
    if (request.action === 'entries')
      return {
        total: 1,
        entries: [
          {
            id: 'invented-journal',
            row: 1,
            name: 'Imaginary Moonlight Review',
            aliases: [],
            issns: [],
            values: { signal: value }
          }
        ]
      }
    if (request.action === 'entry') {
      value = request.values.signal ?? value
      stored = { ...stored, revision: stored.revision + 1 }
    }
    return { datasets: [stored] }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalManager onOpenItem={() => {}} onClose={() => {}} />)
  await screen.findByText('Imaginary Moonlight Review')
  fireEvent.click(screen.getByRole('button', { name: 'Edit journal attributes' }))
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Signal index: Imaginary Moonlight Review' }),
    {
      target: { value: '8.5' }
    }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save journal row' }))
  await waitFor(() => expect(value).toBe('8.5'))
  expect(journals.mock.calls.some(([request]) => request.action === 'entry')).toBe(true)
})

it('cancels file preparation, terminates the parser and leaves persisted data alone', async () => {
  const terminate = vi.fn()
  const postMessage = vi.fn()
  vi.stubGlobal(
    'Worker',
    class {
      terminate = terminate
      postMessage = postMessage
    }
  )
  const journals = vi.fn(async (): Promise<JournalResult> => ({ datasets: [] }))
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  try {
    render(<JournalManager onOpenItem={() => {}} onClose={() => {}} />)
    const file = new File(['fictional'], 'imaginary.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(0) })
    fireEvent.change(screen.getByLabelText('Import journal file'), { target: { files: [file] } })
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })))
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(journals).toHaveBeenCalledTimes(1)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('preserves a dirty draft on remote changes and reloads after an explicit cancel', async () => {
  let stored = structuredClone(dataset)
  let changed: () => void = () => {}
  const unsubscribe = vi.fn()
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> =>
    request.action === 'entries' ? { entries: [], total: 0 } : { datasets: [stored] }
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        journals,
        onChanged: (listener: () => void) => {
          changed = listener
          return unsubscribe
        }
      }
    }
  })
  const view = render(<JournalManager onOpenItem={() => {}} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Customize columns' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Attribute name' }), {
    target: { value: 'Local draft' }
  })
  stored = { ...stored, revision: 2, fields: [{ ...stored.fields[0], label: 'Remote label' }] }
  act(() => changed())
  await screen.findByText(
    'Journal data changed in another window. Your draft is preserved. Cancel this draft to load the latest data.'
  )
  expect((screen.getByRole('textbox', { name: 'Attribute name' }) as HTMLInputElement).value).toBe(
    'Local draft'
  )
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await screen.findByRole('button', { name: 'Remote label' })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(journals.mock.calls.some(([request]) => request.action === 'fields')).toBe(false)
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

it('refreshes a clean manager on reconnect and handles remote deletion', async () => {
  let datasets = [structuredClone(dataset)]
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> =>
    request.action === 'entries' ? { entries: [], total: 0 } : { datasets }
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { journals, onChanged: () => () => {} } }
  })
  render(<JournalManager onOpenItem={() => {}} onClose={() => {}} />)
  await screen.findByRole('button', { name: 'Customize columns' })
  datasets = []
  act(() => window.dispatchEvent(new Event('open-science:web-events-open')))
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Customize columns' })).toBeNull()
  )
  expect(screen.queryByRole('combobox', { name: 'Journal dataset' })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('downloads a workbook template with instructions and a separate example sheet', async () => {
  const journals = vi.fn(async (): Promise<JournalResult> => ({ datasets: [] }))
  const saveBlobFile = vi.fn<
    (request: { data: ArrayBuffer; mimeType: string; suggestedName: string }) => Promise<void>
  >(async () => {})
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { journals }, saveBlobFile }
  })
  render(<JournalManager onOpenItem={() => {}} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Download template' }))
  await waitFor(() => expect(saveBlobFile).toHaveBeenCalledTimes(1))
  const request = saveBlobFile.mock.calls[0][0] as {
    data: ArrayBuffer
    mimeType: string
    suggestedName: string
  }
  const workbook = read(request.data, { type: 'array' })
  expect(request.suggestedName).toBe('journal-attributes-template.xlsx')
  expect(request.mimeType).toContain('spreadsheetml.sheet')
  expect(workbook.SheetNames).toEqual(['Journal data', 'Instructions', 'Example'])
  expect(workbook.Sheets['Journal data']['A1'].v).toBe('Journal name')
  expect(workbook.Sheets.Instructions['A1'].v).toBe('How to fill this template')
  expect(workbook.Sheets.Example['A2'].v).toBe('Example Journal Alpha')
})

it('shows parsed skipped columns and lets users collapse them', async () => {
  vi.stubGlobal(
    'Worker',
    class {
      onmessage?: (event: MessageEvent) => void
      terminate = vi.fn()
      postMessage(): void {
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              result: {
                rows: [
                  ['Journal name', 'ISSN', 'JIF', 'Publisher'],
                  ['Imaginary Harbor Journal', '1234-5678', '4.2', 'Fictional Press']
                ],
                names: [],
                selected: ''
              }
            }
          } as MessageEvent)
        )
      }
    }
  )
  const journals = vi.fn(async (): Promise<JournalResult> => ({ datasets: [] }))
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  try {
    render(<JournalManager onOpenItem={() => {}} onClose={() => {}} />)
    const file = new File(['synthetic'], 'synthetic.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(0) })
    fireEvent.change(screen.getByLabelText('Import journal file'), { target: { files: [file] } })
    await screen.findByText('synthetic.csv')
    expect((screen.getByLabelText('Source') as HTMLInputElement).value).toBe('synthetic')
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'Fictional source' } })
    expect(screen.getByRole('status').textContent).toContain('Enter the metric year to continue.')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('File preview')
    expect(screen.getAllByText('Fictional Press').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Publisher').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Hide preview' }))
    fireEvent.click(screen.getByRole('button', { name: /Hide skipped columns/ }))
    expect(screen.queryByText('Publisher')).toBeNull()
  } finally {
    vi.unstubAllGlobals()
  }
})

it.each([false, true])(
  'exports all problem pages safely, with cancel-and-retry=%s',
  async (cancelFirst) => {
    const parsedRows = [
      ['Publication label', 'Signal index'],
      ['Imaginary Valid Review', '1'],
      ...Array.from({ length: 65 }, (_, i) => [
        i === 0 ? '=SUM(1,2)' : `Imaginary Invalid Review ${i}`,
        'unknown'
      ])
    ]
    vi.stubGlobal(
      'Worker',
      class {
        onmessage?: (event: MessageEvent) => void
        terminate = vi.fn()
        postMessage(): void {
          queueMicrotask(() =>
            this.onmessage?.({
              data: { result: { rows: parsedRows, names: [], selected: '' } }
            } as MessageEvent)
          )
        }
      }
    )
    const imported: import('../../../../shared/journal-attributes').JournalImportRow[] = []
    const saveBlobFile = vi
      .fn<(request: { data: ArrayBuffer; suggestedName: string }) => Promise<void>>()
      .mockResolvedValue(undefined)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let pauseExport = cancelFirst
    const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
      if (request.action === 'begin') return { token: '08a86e63-af71-4fc6-8a0f-2671e6a39b33' }
      if (request.action === 'append') {
        imported.push(...request.rows)
        return { total: imported.length }
      }
      if (request.action === 'commit') {
        await gate
        return { datasets: [dataset] }
      }
      if (request.action === 'preview') {
        if (request.problemsOnly && pauseExport) {
          pauseExport = false
          await gate
        }
        const rows = imported.map((row, index) => ({
          ...row,
          previous: index ? undefined : { signal: '7.5' },
          status: index ? ('invalid' as const) : ('new' as const),
          warnings: index ? ['invalid-value' as const] : []
        }))
        const filtered = request.problemsOnly ? rows.slice(1) : rows
        return {
          rows: filtered.slice(request.offset, request.offset + (request.limit ?? 50)),
          digest: 'a'.repeat(64),
          total: rows.length,
          ready: 1,
          problems: 65
        }
      }
      if (request.action === 'entries') return { entries: [], total: 0 }
      return { datasets: [dataset] }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { literature: { journals }, saveBlobFile }
    })
    try {
      render(<JournalManager onOpenItem={() => {}} onClose={() => {}} />)
      await screen.findByRole('button', { name: 'Customize columns' })
      const file = new File(['fictional'], 'imaginary.csv')
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(0) })
      fireEvent.change(screen.getByLabelText('Import journal file'), { target: { files: [file] } })
      fireEvent.click(await screen.findByRole('button', { name: 'Review import' }))
      const importButton = await screen.findByRole('button', { name: 'Import attributes' })
      expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
        'Row',
        'Journal name',
        'Status',
        'Signal index'
      ])
      const previewRow = screen.getByText('Imaginary Valid Review').closest('tr')!
      expect(previewRow.cells[3].textContent).toBe('7.5')
      expect((importButton as HTMLButtonElement).disabled).toBe(false)
      expect(
        screen
          .getByRole('checkbox', { name: 'Skip ambiguous, invalid and duplicate rows' })
          .getAttribute('aria-checked')
      ).toBe('true')
      expect(screen.queryByText('Rows to skip: 65. Only ready rows will be imported.')).toBeNull()
      const reviewHelp = screen.getByRole('button', { name: 'About Review import' })
      fireEvent.focus(reviewHelp)
      expect((await screen.findByRole('tooltip')).textContent).toContain(
        'Rows to skip: 65. Only ready rows will be imported.'
      )
      fireEvent.blur(reviewHelp)
      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
      expect(screen.getAllByRole('row')).toHaveLength(26)
      expect(screen.getByText('1–25 of 66')).toBeTruthy()
      if (!cancelFirst) {
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
        await screen.findByText('26–50 of 66')
        fireEvent.click(screen.getByRole('button', { name: 'Show problem rows' }))
        await screen.findByRole('button', { name: 'Show all rows' })
        expect(screen.queryByText('Imaginary Valid Review')).toBeNull()
        expect(screen.getByText('1–25 of 65')).toBeTruthy()
        expect(screen.getAllByText('Invalid attribute value')).toHaveLength(25)
        fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
        await screen.findByText('26–50 of 65')
        expect(journals).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'preview', offset: 25, limit: 25, problemsOnly: true })
        )
        fireEvent.click(screen.getByRole('button', { name: 'Show all rows' }))
        await screen.findByText('Imaginary Valid Review')
        expect(screen.getByText('1–25 of 66')).toBeTruthy()
      }
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Skip ambiguous, invalid and duplicate rows' })
      )
      expect((importButton as HTMLButtonElement).disabled).toBe(true)
      expect(screen.queryByText('Rows to skip: 65. Only ready rows will be imported.')).toBeNull()
      expect(screen.getByText('Skip the rows needing attention to enable import.')).toBeTruthy()
      const importHelp = importButton.parentElement!
      expect(importHelp.tabIndex).toBe(0)
      fireEvent.focus(importHelp)
      expect((await screen.findByRole('tooltip')).textContent).toContain(
        'Skip the rows needing attention to enable import.'
      )
      expect(importHelp.className).toContain('cursor-not-allowed')
      fireEvent.pointerDown(importHelp, { button: 0 })
      fireEvent.click(importHelp)
      expect(screen.getByRole('tooltip').textContent).toContain(
        'Skip the rows needing attention to enable import.'
      )
      expect(journals.mock.calls.some(([request]) => request.action === 'commit')).toBe(false)
      fireEvent.blur(importHelp)
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Skip ambiguous, invalid and duplicate rows' })
      )
      expect((importButton as HTMLButtonElement).disabled).toBe(false)
      const exportButton = await screen.findByRole('button', { name: 'Export problem rows' })
      await act(async () => fireEvent.click(exportButton))
      if (cancelFirst) {
        await waitFor(() =>
          expect(
            journals.mock.calls.some(
              ([request]) => request.action === 'preview' && request.problemsOnly
            )
          ).toBe(true)
        )
        fireEvent.click(
          screen
            .getAllByRole('button', { name: 'Cancel' })
            .find((button) => !(button as HTMLButtonElement).disabled)!
        )
        await act(async () => release())
        await waitFor(() => expect((exportButton as HTMLButtonElement).disabled).toBe(false))
        expect(saveBlobFile).not.toHaveBeenCalled()
        expect(journals.mock.calls.some(([request]) => request.action === 'discard')).toBe(false)
        await act(async () => fireEvent.click(exportButton))
      }
      await waitFor(() => expect(saveBlobFile).toHaveBeenCalledTimes(1))
      const request = saveBlobFile.mock.calls[0][0] as { data: ArrayBuffer; suggestedName: string }
      const csv = new TextDecoder().decode(request.data)
      const rows = (await import('papaparse')).default.parse<string[]>(csv).data
      expect(rows).toHaveLength(66)
      expect(rows[1][0]).toBe('3')
      expect(rows[1][2]).toBe("'=SUM(1,2)")
      expect(rows[65][0]).toBe('67')
      expect(
        journals.mock.calls
          .filter(
            ([request]) =>
              request.action === 'preview' && request.problemsOnly && request.limit === undefined
          )
          .map(([request]) => request.action === 'preview' && request.offset)
      ).toEqual(cancelFirst ? [0, 0, 50] : [0, 50])
      if (!cancelFirst) {
        fireEvent.click(importButton)
        const importing = await screen.findByRole('button', { name: 'Importing…' })
        expect((importing as HTMLButtonElement).disabled).toBe(true)
        expect(importing.getAttribute('aria-busy')).toBe('true')
        expect(importing.querySelector('.animate-spin')).not.toBeNull()
        fireEvent.click(importing)
        expect(journals.mock.calls.filter(([request]) => request.action === 'commit')).toHaveLength(
          1
        )
        expect(journals).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'commit', skipProblems: true })
        )
        await act(async () => release())
        await screen.findByText('Journal attributes imported.')
        expect(screen.queryByRole('button', { name: 'Importing…' })).toBeNull()
      }
    } finally {
      vi.unstubAllGlobals()
    }
  }
)

it('edits colors across the entire dataset without losing choices from another search page', async () => {
  let stored: JournalDataset = {
    ...dataset,
    count: 135,
    fields: [{ ...dataset.fields[0], kind: 'singleSelect', label: 'Editorial band' }]
  }
  const values = Array.from({ length: 135 }, (_, i) => `Band ${i}`)
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
    if (request.action === 'entries')
      return {
        entries: [
          {
            id: 'invented-journal',
            row: 2,
            name: 'Imaginary Color Review',
            aliases: [],
            issns: [],
            values: { signal: 'Band 0' }
          }
        ],
        total: 1
      }
    if (request.action === 'choices') {
      expect(request.expectedRevision).toBe(1)
      const filtered = values.filter((value) => value.includes(request.query))
      return {
        choices: filtered.slice(request.offset, request.offset + 50),
        total: filtered.length
      }
    }
    if (request.action === 'fields') stored = { ...stored, fields: request.fields, revision: 2 }
    return { datasets: [stored] }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalManager onOpenItem={() => {}} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Customize columns' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit category colors' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Color for Band 49' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Red' }))
  fireEvent.click(
    screen
      .getAllByRole('button', { name: 'Next' })
      .find((button) => !(button as HTMLButtonElement).disabled)!
  )
  await screen.findByRole('button', { name: 'Color for Band 50' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Search choices' }), {
    target: { value: 'Band 134' }
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Color for Band 134' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Blue' }))
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })))
  await screen.findByRole('button', { name: 'Customize columns' })
  expect(stored.fields[0].colors).toEqual({ 'Band 49': 'red', 'Band 134': 'blue' })
  expect(
    journals.mock.calls.some(([request]) => request.action === 'choices' && request.offset === 50)
  ).toBe(true)
})

it('reviews removal counts and sends the reviewed digest only after explicit confirmation', async () => {
  const digest = 'a'.repeat(64)
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
    if (request.action === 'remove-preview')
      return { removal: { journals: 3, bindings: 7, digest } }
    if (request.action === 'remove') return { datasets: [] }
    return { datasets: [dataset], entries: [], total: 0 }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalManager onOpenItem={() => {}} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'More actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
  await screen.findByText('Manual confirmations to remove: 7')
  expect(screen.getByText('Journal identities to remove: 3')).toBeTruthy()
  expect(journals.mock.calls.some(([request]) => request.action === 'remove')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() =>
    expect(journals).toHaveBeenCalledWith({
      action: 'remove',
      datasetId: dataset.id,
      expectedRevision: 1,
      expectedRemovalDigest: digest
    })
  )
})

it.each([false, true])(
  'requires explicit selection to inherit an earlier field and resets it when the source changes (embedded=%s)',
  async (embedded) => {
    vi.stubGlobal(
      'Worker',
      class {
        onmessage?: (event: MessageEvent) => void
        terminate = vi.fn()
        postMessage(): void {
          queueMicrotask(() =>
            this.onmessage?.({
              data: {
                result: {
                  rows: [
                    ['Publication label', 'New measurement'],
                    ['Imaginary Next Review', '4']
                  ],
                  names: [],
                  selected: ''
                }
              }
            } as MessageEvent)
          )
        }
      }
    )
    const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
      if (request.action === 'begin') return { token: '11111111-1111-4111-8111-111111111111' }
      if (request.action === 'preview')
        return { rows: [], digest: 'a'.repeat(64), ready: 1, problems: 0, total: 1 }
      return { datasets: [dataset], entries: [], total: 0 }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { literature: { journals } }
    })
    try {
      render(<JournalManager onOpenItem={() => {}} embedded={embedded} onClose={() => {}} />)
      await screen.findByRole('button', { name: 'Customize columns' })
      await choose('Journal dataset', 'New dataset')
      const file = new File(['synthetic'], 'synthetic.csv')
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(0) })
      fireEvent.change(screen.getByLabelText('Import journal file'), { target: { files: [file] } })
      await screen.findByText('synthetic.csv')
      fireEvent.change(screen.getByLabelText('Source'), { target: { value: dataset.source } })
      fireEvent.change(screen.getByLabelText('Metric year'), { target: { value: '2032' } })
      await choose('Role for column 2', 'Journal attribute')
      expect(screen.getByRole('combobox', { name: 'Journal attribute' }).textContent).toContain(
        'New'
      )
      await choose('Journal attribute', 'Signal index')
      expect(
        (screen.getByRole('combobox', { name: 'Attribute type' }) as HTMLButtonElement).disabled
      ).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Review import' }))
      await screen.findByRole('button', { name: 'Edit mapping' })
      const begin = journals.mock.calls.find(([request]) => request.action === 'begin')![0]
      expect(begin).toMatchObject({
        definition: {
          source: dataset.source,
          year: 2032,
          fields: [{ ...dataset.fields[0], columnKey: `${dataset.id}:signal` }]
        }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Edit mapping' }))
      fireEvent.change(screen.getByLabelText('Source'), {
        target: { value: 'Other fictional source' }
      })
      expect(screen.queryByRole('combobox', { name: 'Journal attribute' })).toBeNull()
      expect(
        (screen.getByRole('combobox', { name: 'Attribute type' }) as HTMLButtonElement).disabled
      ).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  }
)

it('reorders columns by drag and keyboard, cancels drafts, and saves the requested order', async () => {
  let stored = {
    ...structuredClone(dataset),
    fields: ['First', 'Second', 'Third'].map((label, index) => ({
      ...dataset.fields[0],
      id: `field-${index}`,
      label
    }))
  }
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
    if (request.action === 'fields')
      stored = { ...stored, fields: request.fields, revision: stored.revision + 1 }
    return { datasets: [stored], entries: [], total: 0 }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalManager onOpenItem={() => {}} embedded onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Customize columns' }))
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-journal-field-id]'))
  rows.forEach((node, index) =>
    vi
      .spyOn(node, 'getBoundingClientRect')
      .mockReturnValue({ top: index * 48, height: 40 } as DOMRect)
  )
  const handle = screen.getByRole('button', { name: 'Reorder First' })
  const pointer = (type: string, y: number): void => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientY: y })
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } })
    fireEvent(handle, event)
  }
  pointer('pointerdown', 20)
  pointer('pointermove', 116)
  expect(rows[0].dataset.dragging).toBe('true')
  expect(rows[0].style.transform).toBe('translateY(96px)')
  expect(rows[1].style.transform).toBe('translateY(-48px)')
  pointer('pointerup', 116)
  expect(rows[0].style.transform).toBe('')
  const names = (): string[] =>
    screen.getAllByLabelText('Attribute name').map((node) => (node as HTMLInputElement).value)
  expect(names()).toEqual(['Second', 'Third', 'First'])
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(journals.mock.calls.some(([request]) => request.action === 'fields')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Customize columns' }))
  expect(names()).toEqual(['First', 'Second', 'Third'])
  fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder First' }), { key: 'ArrowDown' })
  expect(names()).toEqual(['Second', 'First', 'Third'])
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(stored.fields.map(({ label }) => label)).toEqual(['Second', 'First', 'Third'])
  )
})

it('shows the shared journal pagination, changes pages, and resets the page when changing page size', async () => {
  let finishPage: (() => void) | undefined
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
    if (request.action !== 'entries') return { datasets: [dataset] }
    if (request.offset === 25)
      await new Promise<void>((resolve) => {
        finishPage = resolve
      })
    return {
      total: 123,
      entries: [
        {
          id: `journal-${request.offset}`,
          row: 999,
          name: 'Numbered journal',
          aliases: [],
          issns: [],
          values: {}
        }
      ]
    }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalManager onOpenItem={() => {}} embedded onClose={() => {}} />)
  const next = await screen.findByRole('button', { name: 'Next page' })
  expect(screen.getByRole('columnheader', { name: '#' })).toBeTruthy()
  expect(document.querySelector('[data-row-number]')?.textContent).toBe('1')
  fireEvent.click(next)
  expect(document.querySelector('[data-row-number]')?.textContent).toBe('1')
  await act(async () => finishPage?.())
  expect(document.querySelector('[data-row-number]')?.textContent).toBe('26')
  await waitFor(() =>
    expect(journals).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'entries', offset: 25, limit: 25 })
    )
  )
  await waitFor(() =>
    expect(
      (screen.getByRole('combobox', { name: 'Journals per page' }) as HTMLButtonElement).disabled
    ).toBe(false)
  )
  await choose('Journals per page', '100')
  await waitFor(() =>
    expect(journals).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'entries', offset: 0, limit: 100 })
    )
  )
  expect(document.querySelector('[data-row-number]')?.textContent).toBe('1')
  expect(screen.getByRole('button', { name: 'Page 1' }).getAttribute('aria-current')).toBe('page')
})

it.each([
  new Error('Journal data changed. Reload the dataset.'),
  new ApplicationCommandError('command-failed', 'Journal data changed. Reload the dataset.')
])('retries a journal read invalidated by a concurrent write (%s)', async (conflict) => {
  const entries = vi
    .fn()
    .mockRejectedValueOnce(conflict)
    .mockResolvedValue({ entries: [], total: 123 })
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> =>
    request.action === 'entries' ? entries(request) : { datasets: [dataset] }
  )
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  try {
    render(<JournalManager onOpenItem={() => {}} embedded onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Next page' })
    expect(entries).toHaveBeenCalledTimes(2)
    expect(entries.mock.calls[1]).toEqual(entries.mock.calls[0])
    expect(screen.queryByText('Could not load journals. Reload to try again.')).toBeNull()
    expect(errorLog).not.toHaveBeenCalled()
  } finally {
    errorLog.mockRestore()
  }
})

it.each([
  ['Journal data changed. Reload the dataset.', 2],
  ['Fixture connection unavailable', 1]
])('retains the load error with bounded attempts for %s', async (message, attempts) => {
  const entries = vi.fn().mockRejectedValue(new Error(message))
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> =>
    request.action === 'entries' ? entries(request) : { datasets: [dataset] }
  )
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  try {
    render(<JournalManager onOpenItem={() => {}} embedded onClose={() => {}} />)
    await screen.findByText('Could not load journals. Reload to try again.')
    expect(entries).toHaveBeenCalledTimes(attempts)
    expect(errorLog).toHaveBeenCalledTimes(1)
  } finally {
    errorLog.mockRestore()
  }
})

it('does not retry an invalidated journal read after the manager unmounts', async () => {
  let reject!: (error: Error) => void
  const pending = new Promise<JournalResult>((_, rejectRead) => {
    reject = rejectRead
  })
  const entries = vi.fn().mockReturnValue(pending)
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> =>
    request.action === 'entries' ? entries(request) : { datasets: [dataset] }
  )
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  try {
    const view = render(<JournalManager onOpenItem={() => {}} embedded onClose={() => {}} />)
    await waitFor(() => expect(entries).toHaveBeenCalledTimes(1))
    view.unmount()
    await act(async () => reject(new Error('Journal data changed. Reload the dataset.')))
    expect(entries).toHaveBeenCalledTimes(1)
    expect(errorLog).not.toHaveBeenCalled()
  } finally {
    errorLog.mockRestore()
  }
})

it('shows a load error instead of an empty count and reloads successfully in Strict Mode', async () => {
  let unavailable = true
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
    if (request.action !== 'entries') return { datasets: [structuredClone(dataset)] }
    if (unavailable) throw new Error('Fixture connection unavailable')
    return { entries: [], total: 123 }
  })
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  try {
    render(
      <StrictMode>
        <JournalManager onOpenItem={() => {}} embedded onClose={() => {}} />
      </StrictMode>
    )
    await screen.findByText('Could not load journals. Reload to try again.')
    expect(screen.queryByRole('combobox', { name: 'Journals per page' })).toBeNull()
    unavailable = false
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await screen.findByRole('button', { name: 'Next page' })
    expect(screen.queryByText('Could not load journals. Reload to try again.')).toBeNull()
  } finally {
    errorLog.mockRestore()
  }
})

it('does not rerender metric cells for menus, dialog typing, column drafts or another row draft', async () => {
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> =>
    request.action === 'entries'
      ? {
          total: 30,
          entries: Array.from({ length: 30 }, (_, index) => ({
            id: `render-${index}`,
            row: index + 1,
            name: `Render fixture ${index}`,
            aliases: [],
            issns: [],
            values: { signal: '3' }
          }))
        }
      : { datasets: [dataset] }
  )
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalManager onOpenItem={() => {}} embedded onClose={() => {}} />)
  await screen.findByText('Render fixture 0')
  valueRender.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit dataset' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: 'Typing a dataset name' }
  })
  expect(valueRender).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Customize columns' }))
  valueRender.mockClear()
  fireEvent.change(screen.getByRole('textbox', { name: 'Attribute name' }), {
    target: { value: 'Typing a column name' }
  })
  expect(valueRender).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit journal attributes' })[0])
  valueRender.mockClear()
  fireEvent.change(screen.getByRole('textbox', { name: 'Signal index: Render fixture 0' }), {
    target: { value: '4.2' }
  })
  expect(valueRender).not.toHaveBeenCalled()
})

it.each(['fixture.journal.json', 'fixture.json', 'fixture.JSON'])(
  'imports %s without column mapping and offers its configured data for export',
  async (filename) => {
    let saved: JournalDataset[] = []
    const bundle = {
      format: 'open-science-journals',
      version: 1,
      dataset: {
        name: 'Portable fixture',
        source: dataset.source,
        year: dataset.year,
        fields: dataset.fields
      },
      rows: [
        { row: 1, name: 'Portable journal', aliases: [], issns: [], values: { signal: '4.2' } }
      ]
    }
    const saveBlobFile = vi.fn().mockResolvedValue(undefined)
    const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
      if (request.action === 'begin') {
        expect(request.definition).toEqual(bundle.dataset)
        return { token: '11111111-1111-4111-8111-111111111111' }
      }
      if (request.action === 'append') return { total: 1 }
      if (request.action === 'preview')
        return { digest: 'a'.repeat(64), total: 1, ready: 1, problems: 0 }
      if (request.action === 'commit') saved = [{ ...dataset, name: 'Portable fixture' }]
      if (request.action === 'entries')
        return { entries: [{ id: 'portable', ...bundle.rows[0] }], total: 1 }
      if (request.action === 'export')
        return { exportPage: { dataset: saved[0], snapshot: 'fixture:1', rows: bundle.rows } }
      return { datasets: saved }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { literature: { journals }, saveBlobFile }
    })
    render(<JournalManager onOpenItem={() => {}} embedded onClose={() => {}} />)
    await screen.findByText('Drag and drop or click to upload')
    const input = screen.getByLabelText('Import journal file') as HTMLInputElement
    expect(input.accept.split(',')).toContain('.json')
    const file = new File(['bundle'], filename, { type: 'application/json' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode(JSON.stringify(bundle)).buffer
    })
    fireEvent.change(screen.getByLabelText('Import journal file'), { target: { files: [file] } })
    await screen.findByText('Portable journal')
    expect(screen.queryByText('Import settings')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Review import' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export journal bundle' }))
    await waitFor(() => expect(saveBlobFile).toHaveBeenCalledTimes(1))
    expect(JSON.parse(new TextDecoder().decode(saveBlobFile.mock.calls[0][0].data))).toEqual(bundle)
  }
)

it('starts pagination immediately, debounces search and revalidates a retained manager after background changes', async () => {
  let changed!: () => void
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> =>
    request.action === 'entries'
      ? {
          total: 123,
          entries: [
            {
              id: 'retained',
              row: 1,
              name: 'Retained journal',
              aliases: [],
              issns: [],
              values: { signal: '3' }
            }
          ]
        }
      : { datasets: [structuredClone(dataset)] }
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        journals,
        onChanged: (listener: typeof changed) => {
          changed = listener
          return () => {}
        }
      }
    }
  })
  const onClose = vi.fn()
  const view = render(<JournalManager onOpenItem={() => {}} embedded active onClose={onClose} />)
  await screen.findByText('Retained journal')
  vi.useFakeTimers()
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(journals).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'entries', offset: 25, limit: 25 })
    )
    await act(async () => {})
    journals.mockClear()
    const search = screen.getByRole('textbox', { name: 'Search journals' })
    fireEvent.change(search, { target: { value: 'R' } })
    fireEvent.change(search, { target: { value: 'Retained' } })
    expect(journals).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(150))
    expect(journals).toHaveBeenCalledTimes(1)
    expect(journals).toHaveBeenCalledWith(expect.objectContaining({ query: 'Retained' }))
    journals.mockClear()
    view.rerender(
      <JournalManager onOpenItem={() => {}} embedded active={false} onClose={onClose} />
    )
    view.rerender(<JournalManager onOpenItem={() => {}} embedded active onClose={onClose} />)
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(journals).not.toHaveBeenCalled()
    expect(
      (screen.getByRole('textbox', { name: 'Search journals' }) as HTMLInputElement).value
    ).toBe('Retained')
    view.rerender(
      <JournalManager onOpenItem={() => {}} embedded active={false} onClose={onClose} />
    )
    act(() => changed())
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(journals).not.toHaveBeenCalled()
    valueRender.mockClear()
    view.rerender(<JournalManager onOpenItem={() => {}} embedded active onClose={onClose} />)
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(journals).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'entries', query: 'Retained' })
    )
    expect(journals).toHaveBeenCalledWith({ action: 'list' })
    expect(valueRender).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('preserves a row draft and its revision during remote changes until the user cancels', async () => {
  let stored = structuredClone(dataset)
  let value = '3'
  let changed!: () => void
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> =>
    request.action === 'entries'
      ? {
          total: 1,
          entries: [
            {
              id: 'conflict-row',
              row: 1,
              name: 'Conflicting journal',
              aliases: [],
              issns: [],
              values: { signal: value }
            }
          ]
        }
      : { datasets: [structuredClone(stored)] }
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        journals,
        onChanged: (listener: typeof changed) => {
          changed = listener
          return () => {}
        }
      }
    }
  })
  render(<JournalManager onOpenItem={() => {}} embedded onClose={() => {}} />)
  await screen.findByText('Conflicting journal')
  fireEvent.click(screen.getByRole('button', { name: 'Edit journal attributes' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Signal index: Conflicting journal' }), {
    target: { value: 'Local draft' }
  })
  const reads = journals.mock.calls.filter(([request]) => request.action === 'entries').length
  stored = { ...stored, revision: 2 }
  value = '9'
  act(() => changed())
  await screen.findByText(
    'Journal data changed in another window. Your draft is preserved. Cancel this draft to load the latest data.'
  )
  expect(
    (screen.getByRole('textbox', { name: 'Signal index: Conflicting journal' }) as HTMLInputElement)
      .value
  ).toBe('Local draft')
  expect(
    (screen.getByRole('button', { name: 'Save journal row' }) as HTMLButtonElement).disabled
  ).toBe(true)
  expect(journals.mock.calls.filter(([request]) => request.action === 'entries')).toHaveLength(
    reads
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save journal row' }))
  expect(journals.mock.calls.some(([request]) => request.action === 'entry')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel editing journal row' }))
  await screen.findByText('9')
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})

it('saves identity column visibility locally, preserves cancelled drafts and restores columns', async () => {
  const preferenceKey = 'open-science:journal-identity-columns'
  window.localStorage.removeItem(preferenceKey)
  const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> =>
    request.action === 'entries'
      ? {
          total: 1,
          entries: [
            {
              id: 'identity-row',
              row: 1,
              name: 'Identity Review',
              aliases: [],
              issns: ['1234-5678'],
              externalIds: [{ namespace: 'nlm', value: 'example-id' }],
              values: { signal: '3' }
            }
          ]
        }
      : { datasets: [structuredClone(dataset)] }
  )
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  try {
    const view = render(<JournalManager onOpenItem={() => {}} onClose={() => {}} />)
    await screen.findByText('1234-5678')
    expect(screen.getByRole('columnheader', { name: 'External IDs' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Customize columns' }))
    fireEvent.click(screen.getByRole('button', { name: 'ISSN: Hide column' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('1234-5678')).toBeTruthy()
    expect(window.localStorage.getItem(preferenceKey)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Customize columns' }))
    fireEvent.click(screen.getByRole('button', { name: 'ISSN: Hide column' }))
    fireEvent.click(screen.getByRole('button', { name: 'External IDs: Hide column' }))
    const reads = journals.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.queryByRole('columnheader', { name: 'ISSN' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'External IDs' })).toBeNull()
    expect(screen.queryByText('1234-5678')).toBeNull()
    expect(screen.queryByText('nlm:example-id')).toBeNull()
    expect(journals).toHaveBeenCalledTimes(reads)
    view.unmount()

    render(<JournalManager onOpenItem={() => {}} onClose={() => {}} />)
    await screen.findByText('Identity Review')
    expect(screen.queryByRole('columnheader', { name: 'ISSN' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'External IDs' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Customize columns' }))
    fireEvent.click(screen.getByRole('button', { name: 'ISSN: Show column' }))
    fireEvent.click(screen.getByRole('button', { name: 'External IDs: Show column' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText('1234-5678')).toBeTruthy()
    expect(screen.getByText('nlm:example-id')).toBeTruthy()
    expect(journals.mock.calls.some(([request]) => request.action === 'fields')).toBe(false)
  } finally {
    window.localStorage.removeItem(preferenceKey)
  }
})

it.each([false, true])(
  'reveals review progress and failures without losing mapping (embedded=%s)',
  async (embedded) => {
    vi.stubGlobal(
      'Worker',
      class {
        onmessage?: (event: MessageEvent) => void
        terminate = vi.fn()
        postMessage(): void {
          queueMicrotask(() =>
            this.onmessage?.({
              data: {
                result: {
                  rows: [
                    ['Journal name', 'JIF'],
                    ['Imaginary Review', '4.2']
                  ],
                  names: [],
                  selected: ''
                }
              }
            } as MessageEvent)
          )
        }
      }
    )
    let failPreview = true
    let rejectPreview!: (reason: unknown) => void
    const journals = vi.fn(async (request: JournalRequest): Promise<JournalResult> => {
      if (request.action === 'begin') return { token: '08a86e63-af71-4fc6-8a0f-2671e6a39b33' }
      if (request.action === 'preview') {
        if (failPreview)
          return new Promise((_, reject) => {
            rejectPreview = reject
          })
        return { rows: [], ready: 1, total: 1, problems: 0, digest: 'a'.repeat(64) }
      }
      return { datasets: [] }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { literature: { journals } }
    })
    try {
      const view = render(
        <JournalManager onOpenItem={() => {}} embedded={embedded} onClose={() => {}} />
      )
      await screen.findByRole('button', { name: 'Download template' })
      const file = new File(['synthetic'], 'imaginary-2024.csv')
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(0) })
      fireEvent.change(screen.getByLabelText('Import journal file'), { target: { files: [file] } })
      await screen.findByText(file.name)
      fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'Imaginary source' } })
      await choose('Role for column 2', 'Journal attribute')
      const scroll = view.container.querySelector<HTMLElement>('.overflow-auto')!
      scroll.scrollTop = 900
      fireEvent.click(screen.getByRole('button', { name: 'Review import' }))
      expect(scroll.scrollTop).toBe(0)
      await waitFor(() =>
        expect(journals).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'preview', limit: 25 })
        )
      )
      expect(screen.getByRole('status').textContent).toContain('Reviewing import…')
      scroll.scrollTop = 500
      await act(async () =>
        rejectPreview({ code: 'invalid-command-arguments', message: 'Invalid arguments' })
      )
      expect(scroll.scrollTop).toBe(0)
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toContain('Restart the app')
      expect(document.activeElement?.contains(alert)).toBe(true)
      expect((screen.getByLabelText('Source') as HTMLInputElement).value).toBe('Imaginary source')
      expect(
        (screen.getByRole('button', { name: 'Review import' }) as HTMLButtonElement).disabled
      ).toBe(false)
      expect(journals).toHaveBeenCalledWith(expect.objectContaining({ action: 'discard' }))
      failPreview = false
      fireEvent.click(screen.getByRole('button', { name: 'Review import' }))
      await screen.findByRole('button', { name: 'Import attributes' })
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  }
)

it('switches the literature source year from the current dataset and persists visibility', async () => {
  const newer = { ...dataset, id: 'newer', year: 2032 }
  const journals = vi.fn(async (request: JournalRequest) =>
    request.action === 'entries' ? { entries: [], total: 0 } : { datasets: [newer, dataset] }
  )
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalManager onOpenItem={() => {}} embedded onClose={() => {}} />)
  const toggle = await screen.findByRole('switch', { name: 'Show in literature' })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  await choose('Journal dataset', 'Fictional source 2031')
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle)
  expect(JSON.parse(localStorage.getItem('open-science:journal-source-years')!)).toEqual({
    'Fictional source': 2031
  })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  expect(JSON.parse(localStorage.getItem('open-science:journal-source-years')!)).toEqual({
    'Fictional source': null
  })
  const entryCalls = journals.mock.calls.filter(([request]) => request.action === 'entries').length
  await act(async () => {})
  expect(journals.mock.calls.filter(([request]) => request.action === 'entries')).toHaveLength(
    entryCalls
  )
})

it.each(['{"data":[]}', '{broken'])(
  'rejects unsupported JSON without starting an import: %s',
  async (contents) => {
    const journals = vi.fn(async () => ({ datasets: [] }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { literature: { journals } }
    })
    render(<JournalManager onOpenItem={() => {}} embedded onClose={() => {}} />)
    await screen.findByText('Drag and drop or click to upload')
    const file = new File([contents], 'data.json', { type: 'application/json' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode(contents).buffer
    })
    fireEvent.change(screen.getByLabelText('Import journal file'), { target: { files: [file] } })
    expect(
      await screen.findByText('Could not import this journal bundle. Check the file and try again.')
    ).toBeTruthy()
    expect(journals).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'begin' }))
    expect(screen.queryByText('Import settings')).toBeNull()
  }
)

it('keeps category colors in a compact popover and discards edits on cancel', async () => {
  const stored = {
    ...dataset,
    fields: [{ ...dataset.fields[0], label: 'Quartile', kind: 'singleSelect' as const }]
  }
  const journals = vi.fn(async (request: JournalRequest) =>
    request.action === 'choices'
      ? { choices: request.query ? [] : ['Q1', 'Q2'], total: request.query ? 0 : 2 }
      : request.action === 'entries'
        ? { entries: [], total: 0 }
        : { datasets: [stored] }
  )
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalManager onOpenItem={() => {}} embedded onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Customize columns' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit category colors' }))
  const choice = await screen.findByRole('button', { name: 'Color for Q1' })
  expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
  fireEvent.click(choice)
  fireEvent.click(screen.getByRole('button', { name: 'Red' }))
  expect(screen.getByRole('textbox', { name: 'Search choices' })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search choices' }), {
    target: { value: 'missing' }
  })
  expect(await screen.findByText('No results found')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(journals).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'fields' }))
  fireEvent.click(screen.getByRole('button', { name: 'Customize columns' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit category colors' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Color for Q1' }))
  expect(screen.getByRole('button', { name: 'Automatic' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
})
