// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComparisonResult, ComparisonTable } from '../../../../../shared/literature-comparison'
import { LiteratureComparisonPage } from './LiteratureComparisonPage'
import { ComparisonCellReview } from './ComparisonCellReview'
import { ComparisonDestinationDialog } from './ComparisonDestinationDialog'
import { comparisonCellView } from './comparison-display'
import { useComparisonTables } from './useComparisonTables'

const getReference = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ item: { abstract: '' }, attachments: [] })
)
const saveBlobFile = vi.hoisted(() => vi.fn().mockResolvedValue({ saved: true }))
const comparisons = vi.hoisted(() => vi.fn())
vi.mock('../renderer-host', () => {
  const api = { saveBlobFile, literature: { get: getReference, comparisons } }
  return { useLiteratureHost: () => ({ api }) }
})
const backgroundTaskProps = vi.hoisted(() => vi.fn())
vi.mock('../workflows/LiteratureBackgroundTasks', () => ({
  LiteratureBackgroundTasks: (props: unknown) => {
    backgroundTaskProps(props)
    return null
  }
}))
const translate = vi.hoisted(() =>
  vi.fn<(key: string, options?: Record<string, unknown>) => string>((key) => key)
)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } })
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
function chooseTableAction(name: string): void {
  fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('menuitem', { name }))
}
function exportDisabled(): boolean {
  const trigger = screen.getByRole('button', { name: 'More actions' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  const item = screen.getByRole('menuitem', { name: 'Export' })
  const disabled = item.getAttribute('aria-disabled') === 'true'
  fireEvent.keyDown(item, { key: 'Escape' })
  return disabled
}
function chooseOption(trigger: HTMLElement, name: string | RegExp): void {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.click(screen.getByRole('option', { name }))
}
function selectFilter(value: 'pending' | 'review' | 'failed'): void {
  chooseOption(
    screen.getByRole('combobox', { name: 'Filters' }),
    { pending: /Pending references/, review: /Ready for review/, failed: /Failed \/ unavailable/ }[
      value
    ]
  )
}
function columnMenuItem(name: string, index = 0): HTMLElement {
  const triggers = screen.getAllByRole('button', { name: / · More actions$/ })
  fireEvent.keyDown(triggers[index], { key: 'ArrowDown' })
  return screen.getByRole('menuitem', { name })
}
function fixture(): ComparisonTable {
  return {
    id: 'table',
    name: 'Evidence',
    language: 'en',
    sourcePolicy: 'abstract',
    revision: 1,
    fields: [{ id: 'field', name: 'Population', rule: 'Report the population', version: 1 }],
    members: [{ itemId: 'paper', title: 'Paper', abstract: '42 adults', sourceKey: 'source' }],
    itemIds: ['paper'],
    state: 'idle',
    remainingCellIds: [],
    cells: [
      {
        id: 'cell',
        itemId: 'paper',
        fieldId: 'field',
        status: 'succeeded',
        history: [
          {
            id: 'attempt',
            fieldVersion: 1,
            sourceKey: 'source',
            at: '2026-11-06',
            status: 'succeeded',
            value: '42 adults',
            coverage: 'abstract',
            evidence: [{ pageStart: null, pageEnd: null, quote: '42 adults' }]
          }
        ]
      }
    ]
  }
}
function page(
  table: ComparisonTable,
  command = vi.fn().mockResolvedValue({ tables: [table] })
): typeof command {
  render(
    <LiteratureComparisonPage
      table={table}
      command={command}
      onChooseReferences={vi.fn()}
      onOpenItem={vi.fn()}
      onOpenDiscovery={vi.fn()}
      onOpenComparison={vi.fn()}
    />
  )
  return command
}
describe('comparison workflow', () => {
  it.each(['configuration', 'failed review'])(
    'preserves the new table %s draft when the previous table command finishes',
    async (editor) => {
      const a = { ...fixture(), id: 'A', name: 'Table A', state: 'running' as const }
      const b = { ...fixture(), id: 'B', name: 'Table B' }
      const paused = Promise.withResolvers<void>()
      const refreshed = Promise.withResolvers<void>()
      let bReads = 0
      comparisons.mockImplementation(async (request) => {
        if (request.action === 'list')
          return {
            tables: [],
            summaries: [a, b].map((table) => ({
              id: table.id,
              state: table.state,
              name: table.name
            }))
          }
        if (request.action === 'pause') {
          await paused.promise
          return { tables: [a] }
        }
        if (request.action === 'edit-cell') throw new Error('offline')
        if (request.tableId === 'B' && ++bReads > 1) await refreshed.promise
        return { tables: [request.tableId === 'A' ? a : b] }
      })
      const draftStatus = vi.fn()
      function SelectedComparison(): React.JSX.Element {
        const [id, select] = useState('A')
        const current = useComparisonTables(id)
        return (
          <>
            <button onClick={() => select('B')}>Switch to B</button>
            <LiteratureComparisonPage
              key={`${id}:${Boolean(current.selectedTable)}`}
              table={current.selectedTable}
              command={current.command}
              onChooseReferences={vi.fn()}
              onOpenItem={vi.fn()}
              onOpenDiscovery={vi.fn()}
              onOpenComparison={select}
              onDraftStatusChange={draftStatus}
            />
          </>
        )
      }
      render(<SelectedComparison />)
      fireEvent.click(await screen.findByRole('button', { name: 'Pause after current cell' }))
      fireEvent.click(screen.getByRole('button', { name: 'Switch to B' }))
      await screen.findByRole('heading', { name: 'Table B' })
      if (editor === 'configuration') chooseTableAction('Table settings')
      else {
        fireEvent.click(screen.getByRole('button', { name: /42 adults/ }))
        fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
      }
      const label = editor === 'configuration' ? 'Extraction requirements' : 'Manual value'
      const input = screen.getByRole('textbox', { name: label }) as HTMLTextAreaElement
      fireEvent.change(input, { target: { value: 'Keep this B draft' } })
      if (editor === 'failed review') {
        await waitFor(() =>
          expect(draftStatus).toHaveBeenLastCalledWith({ pending: false, failed: true })
        )
      }
      await act(async () => paused.resolve())
      await waitFor(() => expect(bReads).toBe(2))
      expect(screen.getByRole('textbox', { name: label })).toBe(input)
      expect(input.value).toBe('Keep this B draft')
      await act(async () => refreshed.resolve())
      expect(bReads).toBe(2)
      expect(screen.getByRole('textbox', { name: label })).toBe(input)
      expect(input.value).toBe('Keep this B draft')
      expect(
        comparisons.mock.calls.filter(
          ([request]) => request.action === 'read' && request.tableId === 'A'
        )
      ).toHaveLength(1)
      if (editor === 'failed review') {
        expect(draftStatus).toHaveBeenLastCalledWith({ pending: false, failed: true })
        expect(screen.getAllByText('Draft could not be saved.').length).toBeGreaterThan(0)
        expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
          true
        )
      }
    }
  )
  it('offers review after the task completes even with missing sources and unrelated pending cells', () => {
    const table = fixture()
    table.state = 'completed'
    table.taskId = 'CMP-003'
    table.taskSources = [{ cellId: 'cell', sourceKey: 'source', fieldVersion: 1 }]
    table.cells.push(
      { id: 'missing', itemId: 'paper', fieldId: 'field', status: 'unavailable', history: [] },
      { id: 'later', itemId: 'paper', fieldId: 'field', status: 'pending', history: [] }
    )
    const before = structuredClone(table)
    const command = page(table)
    expect(screen.getByText('Current task finished; results need review')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Sample references:/ }))
    expect(screen.queryByRole('button', { name: 'Use selection as sample' })).toBeNull()
    expect(translate).toHaveBeenCalledWith('Task: {{id}}', { id: 'CMP-003' })
    expect(translate).toHaveBeenCalledWith('Current task progress: {{done}} / {{total}}', {
      done: 1,
      total: 1
    })
    expect(translate).toHaveBeenCalledWith('Start review ({{count}} cells)', {
      count: 1,
      defaultValue_one: 'Start review ({{count}} cell)'
    })
    expect(
      screen.getByText(
        '{{count}} cells are waiting for sources, separate from failed requests. Add or repair their sources to continue extraction.'
      )
    ).toBeTruthy()
    const review = screen.getByRole('button', {
      name: 'Start review ({{count}} cells)'
    }) as HTMLButtonElement
    expect(review.disabled).toBe(false)
    fireEvent.click(review)
    expect(command).not.toHaveBeenCalled()
    expect(table).toEqual(before)
    expect(screen.getByText('Confirm result')).toBeTruthy()
  })

  it.each(['paused', 'interrupted', 'running'] as const)(
    'does not announce task completion while %s',
    (state) => {
      const table = fixture()
      table.state = state
      table.taskId = 'CMP-003'
      table.remainingCellIds = ['cell']
      page(table)
      expect(screen.queryByText('Current task finished; results need review')).toBeNull()
      expect(screen.queryByText('Current task finished')).toBeNull()
    }
  )

  it('keeps failed requests distinct from waiting sources after task completion', () => {
    const table = fixture()
    table.state = 'completed'
    table.taskId = 'CMP-003'
    table.cells.push({
      id: 'failed',
      itemId: 'paper',
      fieldId: 'field',
      status: 'failed',
      history: []
    })
    page(table)
    expect(screen.getByText('Current task finished; results need review')).toBeTruthy()
    expect(
      screen.queryByText(
        '{{count}} cells are waiting for sources, separate from failed requests. Add or repair their sources to continue extraction.'
      )
    ).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry selected cells' })).toBeTruthy()
  })

  it('restores the recovery summary and most recent saved result on reopening', () => {
    const table = fixture()
    table.state = 'interrupted'
    table.taskId = 'CMP-003'
    table.remainingCellIds = ['pending']
    table.cells.push({
      id: 'pending',
      itemId: 'paper',
      fieldId: 'field',
      status: 'pending',
      history: []
    })
    const command = page(structuredClone(table))
    expect(screen.getByText('Previous extraction was interrupted')).toBeTruthy()
    expect(translate).toHaveBeenCalledWith('Most recently saved: {{reference}} / {{field}}', {
      reference: 'Paper',
      field: 'Population'
    })
    expect(translate).toHaveBeenCalledWith('Task: {{id}}', { id: 'CMP-003' })
    expect(translate).toHaveBeenCalledWith('Continue {{count}} cells', {
      count: 1,
      defaultValue_one: 'Continue {{count}} cell'
    })
    expect(command).not.toHaveBeenCalled()
  })

  it.each(['unchanged', 'source-changed', 'field-changed', 'missing', 'legacy'] as const)(
    'only skips resume confirmation for an unchanged readable task: %s',
    async (scenario) => {
      const table = fixture()
      table.state = 'interrupted'
      table.remainingCellIds = ['cell']
      table.cells[0].status = 'pending'
      table.cells[0].history = []
      if (scenario !== 'legacy')
        table.taskSources = [
          {
            cellId: 'cell',
            sourceKey: 'source',
            fieldVersion: scenario === 'field-changed' ? 2 : 1
          }
        ]
      const checks = [
        {
          itemId: 'paper',
          sourceKey: scenario === 'source-changed' ? 'new-source' : 'source',
          status: scenario === 'missing' ? 'missing' : 'available'
        }
      ]
      const command = page(table, vi.fn().mockResolvedValue({ tables: [], sourceChecks: checks }))
      fireEvent.click(screen.getByRole('button', { name: 'Continue {{count}} cells' }))
      if (scenario === 'unchanged') {
        await waitFor(() =>
          expect(command).toHaveBeenCalledWith({
            action: 'resume',
            tableId: 'table',
            expectedRevision: 1,
            expectedSources: [{ itemId: 'paper', sourceKey: 'source' }],
            useCurrentSources: false
          })
        )
        expect(screen.queryByRole('dialog')).toBeNull()
      } else {
        expect(await screen.findByRole('dialog')).toBeTruthy()
        expect(command.mock.calls.every(([request]) => request.action === 'check-sources')).toBe(
          true
        )
        if (scenario === 'source-changed' || scenario === 'field-changed')
          expect(
            screen.getByRole('button', { name: 'Continue with latest sources and rules' })
          ).toBeTruthy()
      }
      expect(screen.queryByText('Most recently saved: {{reference}} / {{field}}')).toBeNull()
    }
  )

  it.each(['check', 'resume'] as const)(
    'keeps recovery available when %s fails',
    async (failure) => {
      const table = fixture()
      table.state = 'interrupted'
      table.remainingCellIds = ['cell']
      table.taskSources = [{ cellId: 'cell', sourceKey: 'source', fieldVersion: 1 }]
      const command = page(
        table,
        vi.fn().mockImplementation(async (request) => {
          if (
            (failure === 'check' && request.action === 'check-sources') ||
            request.action === 'resume'
          )
            throw new Error('unavailable')
          return {
            tables: [],
            sourceChecks: [{ itemId: 'paper', sourceKey: 'source', status: 'available' }]
          }
        })
      )
      fireEvent.click(screen.getByRole('button', { name: 'Continue {{count}} cells' }))
      expect(await screen.findByRole('dialog')).toBeTruthy()
      await waitFor(() =>
        expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
          false
        )
      )
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.getByText('Previous extraction was interrupted')).toBeTruthy()
      expect(
        (screen.getByRole('button', { name: 'Continue {{count}} cells' }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
      expect(command).toHaveBeenCalledTimes(failure === 'check' ? 1 : 2)
    }
  )

  it('does not automatically resume a table changed while source checks were pending', async () => {
    const table = fixture()
    table.state = 'interrupted'
    table.remainingCellIds = ['cell']
    table.taskSources = [{ cellId: 'cell', sourceKey: 'source', fieldVersion: 1 }]
    let resolve!: (value: ComparisonResult) => void
    const command = vi.fn(
      () =>
        new Promise<ComparisonResult>((done) => {
          resolve = done
        })
    )
    const props = {
      command,
      onChooseReferences: vi.fn(),
      onOpenItem: vi.fn(),
      onOpenDiscovery: vi.fn(),
      onOpenComparison: vi.fn()
    }
    const { rerender } = render(<LiteratureComparisonPage table={table} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue {{count}} cells' }))
    rerender(<LiteratureComparisonPage table={{ ...table, revision: 2 }} {...props} />)
    await act(async () =>
      resolve({
        tables: [],
        sourceChecks: [{ itemId: 'paper', sourceKey: 'source', status: 'available' }]
      })
    )
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(command).toHaveBeenCalledTimes(1)
    expect(
      (screen.getByRole('button', { name: 'Confirm and start' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('separates current table totals from the fixed task scope and excludes outdated history from valid results', () => {
    const table = fixture()
    table.state = 'running'
    table.taskId = 'current-task'
    table.cells[0].manual = {
      value: '42 adults',
      confirmed: true,
      fieldVersion: 1,
      sourceKey: 'source',
      attemptId: 'attempt',
      updatedAt: 'saved'
    }
    table.fields.push(
      ...['unreviewed', 'revised', 'missing', 'failed', 'active'].map((id) => ({
        id,
        name: id,
        rule: 'Report result',
        version: id === 'revised' ? 2 : 1
      }))
    )
    table.cells.push(
      {
        ...structuredClone(table.cells[0]),
        id: 'unreviewed',
        fieldId: 'unreviewed',
        manual: undefined
      },
      { ...structuredClone(table.cells[0]), id: 'old-rule', fieldId: 'revised', status: 'pending' },
      { id: 'missing', itemId: 'paper', fieldId: 'missing', status: 'unavailable', history: [] },
      { id: 'failed', itemId: 'paper', fieldId: 'failed', status: 'failed', history: [] },
      { id: 'active', itemId: 'paper', fieldId: 'active', status: 'running', history: [] }
    )
    table.remainingCellIds = ['active']
    table.taskSources = [
      { cellId: 'cell', sourceKey: 'source', fieldVersion: 1 },
      { cellId: 'active', sourceKey: 'source', fieldVersion: 1 }
    ]
    const props = {
      command: vi.fn(),
      onChooseReferences: vi.fn(),
      onOpenItem: vi.fn(),
      onOpenDiscovery: vi.fn(),
      onOpenComparison: vi.fn()
    }
    const { rerender } = render(<LiteratureComparisonPage table={table} {...props} />)
    expect(translate).toHaveBeenCalledWith('Current task progress: {{done}} / {{total}}', {
      done: 1,
      total: 2
    })
    expect(translate).toHaveBeenCalledWith('Extracted cells: {{extracted}} / {{total}}', {
      extracted: 2,
      total: 6
    })
    expect(translate).toHaveBeenCalledWith('Reviewed cells: {{reviewed}}', { reviewed: 1 })
    expect(translate).toHaveBeenCalledWith('Outdated rule cells: {{outdated}}', { outdated: 1 })
    expect(translate).toHaveBeenCalledWith('Pending extraction: {{pending}}', { pending: 1 })
    fireEvent.click(screen.getByRole('button', { name: /Table totals/ }))
    const totals = screen.getByRole('list', { name: 'Table totals' })
    for (const [label, expected] of [
      ['Needs review', '2'],
      ['Waiting for source', '1'],
      ['Failed', '1']
    ])
      expect(within(totals).getByText(label).nextElementSibling?.textContent).toBe(expected)
    const expanded = structuredClone(table)
    expanded.itemIds.push('later')
    expanded.members.push({ ...table.members[0], itemId: 'later', title: 'Later report' })
    expanded.cells.push(
      ...expanded.fields.map((field) => ({
        id: `later-${field.id}`,
        itemId: 'later',
        fieldId: field.id,
        status: 'pending' as const,
        history: []
      }))
    )
    rerender(<LiteratureComparisonPage table={expanded} {...props} />)
    expect(
      translate.mock.calls
        .filter(([key]) => key === 'Current task progress: {{done}} / {{total}}')
        .every(([, values]) => JSON.stringify(values) === JSON.stringify({ done: 1, total: 2 }))
    ).toBe(true)
  })

  it('does not invent a task progress denominator for legacy tasks without admitted sources', () => {
    const table = fixture()
    table.state = 'running'
    table.taskId = 'legacy-task'
    page(table)
    expect(screen.getByText('Current task progress unavailable.')).toBeTruthy()
    expect(
      translate.mock.calls.some(([key]) => key === 'Current task progress: {{done}} / {{total}}')
    ).toBe(false)
  })

  it('keeps pause in flight visible until the current cell is saved, then offers resume', async () => {
    const table = fixture()
    table.state = 'running'
    table.taskId = 'task'
    table.taskSources = [{ cellId: 'cell', sourceKey: 'source', fieldVersion: 1 }]
    table.remainingCellIds = ['cell']
    table.cells[0].status = 'running'
    table.cells[0].history = []
    const command = vi.fn().mockResolvedValue({ tables: [table] })
    const props = {
      command,
      onChooseReferences: vi.fn(),
      onOpenItem: vi.fn(),
      onOpenDiscovery: vi.fn(),
      onOpenComparison: vi.fn()
    }
    const { rerender } = render(<LiteratureComparisonPage table={table} {...props} />)
    for (const name of [
      'Extract sample',
      'Use selection as sample',
      'Review sample',
      'Extract remaining',
      'Check sources',
      'Table settings'
    ])
      expect(screen.queryByRole('button', { name })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pause after current cell' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'pause', tableId: 'table' }))
    const saving = { ...table, state: 'paused' as const }
    rerender(<LiteratureComparisonPage table={saving} {...props} />)
    expect(screen.getByText('Saving the current cell before pausing…')).toBeTruthy()
    expect(screen.queryByText('Paused')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue {{count}} cells' })).toBeNull()
    expect(screen.getByText('Extraction continues when you leave this page.')).toBeTruthy()
    const paused = { ...saving, remainingCellIds: [], cells: fixture().cells }
    rerender(<LiteratureComparisonPage table={paused} {...props} />)
    expect(screen.getByText('Paused')).toBeTruthy()
    expect(screen.queryByText('Saving the current cell before pausing…')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Continue {{count}} cells' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(translate).toHaveBeenCalledWith('Current task progress: {{done}} / {{total}}', {
      done: 1,
      total: 1
    })
  })

  it('maps a matrix header task reference action to the reference without navigating the matrix', () => {
    const table = fixture()
    const onOpenItem = vi.fn()
    const onOpenComparison = vi.fn()
    const command = vi.fn()
    render(
      <LiteratureComparisonPage
        table={table}
        command={command}
        onChooseReferences={vi.fn()}
        onOpenItem={onOpenItem}
        onOpenDiscovery={vi.fn()}
        onOpenComparison={onOpenComparison}
      />
    )
    const matrix = screen.getByRole('table', { name: 'Comparison matrix' })
    const props = backgroundTaskProps.mock.lastCall![0] as {
      onOpenItem: (itemId: string, onReturn: () => void) => void
    }
    const onReturn = vi.fn()
    act(() => props.onOpenItem('pending-reference', onReturn))
    expect(onOpenItem).toHaveBeenCalledExactlyOnceWith(
      { kind: 'reference', itemId: 'pending-reference' },
      onReturn
    )
    expect(onOpenComparison).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalled()
    expect(screen.getByRole('table', { name: 'Comparison matrix' })).toBe(matrix)
  })

  it('follows matrix selection in wide review and restores focus to the last reviewed cell', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ media: query, matches: true }))
    try {
      const table = fixture()
      table.fields.push({ id: 'second', name: 'Outcome', rule: 'Report outcome', version: 1 })
      table.cells.push({
        ...table.cells[0],
        id: 'other',
        fieldId: 'second',
        history: [{ ...table.cells[0].history[0], id: 'other-attempt', value: 'Improved outcome' }]
      })
      page(table)
      const first = screen.getByRole('button', { name: /42 adults/ })
      fireEvent.click(first)

      const panel = screen.getByRole('complementary', { name: 'Review cell' })
      const other = screen.getByRole('button', { name: /Improved outcome/ })
      fireEvent.click(other)
      expect(within(panel).getByRole('heading', { name: 'Outcome' })).toBeTruthy()
      fireEvent.keyDown(other, { key: 'ArrowLeft' })
      expect(within(panel).getByRole('heading', { name: 'Population' })).toBeTruthy()
      fireEvent.keyDown(first, { key: 'Escape' })
      await waitFor(() => expect(document.activeElement).toBe(first))
      expect(screen.queryByRole('complementary', { name: 'Review cell' })).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the matrix behind the modal drawer, navigates inside it and restores focus on close', async () => {
    const table = fixture()
    table.fields.push({ id: 'second', name: 'Outcome', rule: 'Report outcome', version: 1 })
    table.cells.push({
      ...table.cells[0],
      id: 'other',
      fieldId: 'second',
      history: [{ ...table.cells[0].history[0], id: 'other-attempt', value: 'Improved outcome' }]
    })
    page(table)
    const matrix = screen.getByRole('table', { name: 'Comparison matrix' })
    const scroll = matrix.parentElement!
    scroll.scrollLeft = 120
    fireEvent.click(screen.getByRole('button', { name: /42 adults/ }))
    const drawer = screen.getByRole('dialog', { name: 'Review cell' })
    expect(screen.queryByRole('table')).toBeNull()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Next cell' }))
    expect(screen.getByRole('dialog')).toBe(drawer)
    expect(within(drawer).getByRole('heading', { name: 'Outcome' })).toBeTruthy()
    expect(
      (within(drawer).getByRole('button', { name: 'Next cell' }) as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.click(within(drawer).getByRole('button', { name: 'Previous cell' }))
    expect(within(drawer).getByRole('heading', { name: 'Population' })).toBeTruthy()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /42 adults/ }))
    )
    expect(screen.getByRole('table')).toBe(matrix)
    expect(scroll.scrollLeft).toBe(120)
  })

  it.each([false, true])(
    'preserves a pending manual draft and its confirmation across breakpoints (initial wide: %s)',
    async (initialWide) => {
      const media = Object.assign(new EventTarget(), {
        matches: initialWide,
        media: '(min-width: 1200px)'
      })
      vi.stubGlobal(
        'matchMedia',
        vi.fn(() => media)
      )
      try {
        const table = fixture()
        let releaseSave!: (result: ComparisonResult) => void
        const command = vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<ComparisonResult>((resolve) => {
                releaseSave = resolve
              })
          )
          .mockResolvedValue({ tables: [table] })
        page(table, command)
        fireEvent.click(screen.getByRole('button', { name: /42 adults/ }))
        let panel = screen.getByRole(initialWide ? 'complementary' : 'dialog', {
          name: 'Review cell'
        })
        fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
        fireEvent.change(within(panel).getByRole('textbox', { name: 'Manual value' }), {
          target: { value: 'Protected across viewport changes' }
        })
        await waitFor(() => expect(command).toHaveBeenCalledOnce())
        for (const wide of [!initialWide, initialWide]) {
          act(() => {
            media.matches = wide
            media.dispatchEvent(new Event('change'))
          })
          panel = screen.getByRole(wide ? 'complementary' : 'dialog', { name: 'Review cell' })
          expect(Boolean(screen.queryByRole('table'))).toBe(wide)
          expect(
            (within(panel).getByRole('textbox', { name: 'Manual value' }) as HTMLTextAreaElement)
              .value
          ).toBe('Protected across viewport changes')
          expect(
            (within(panel).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled
          ).toBe(true)
          expect(
            (
              within(panel).getByRole('button', {
                name: 'Confirm revision'
              }) as HTMLButtonElement
            ).disabled
          ).toBe(true)
          expect(command).toHaveBeenCalledOnce()
        }
        await act(async () => releaseSave({ tables: [table] }))
        const confirm = within(panel).getByRole('button', {
          name: 'Confirm revision'
        }) as HTMLButtonElement
        await waitFor(() => expect(confirm.disabled).toBe(false))
        confirm.focus()
        expect(document.activeElement).toBe(confirm)
        fireEvent.click(confirm)
        await waitFor(() =>
          expect(command).toHaveBeenLastCalledWith({
            action: 'edit-cell',
            tableId: table.id,
            cellId: 'cell',
            value: 'Protected across viewport changes',
            confirmed: true,
            expectedFieldVersion: 1,
            expectedSourceKey: 'source',
            expectedAttemptId: 'attempt'
          })
        )
      } finally {
        vi.unstubAllGlobals()
      }
    }
  )

  it.each([false, true])(
    'keeps complete long evidence separate from editing and confirmation (wide: %s)',
    async (wide) => {
      vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({
          matches: wide,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn()
        }))
      )
      try {
        const table = fixture()
        const quote = 'Complete source evidence. '.repeat(400) + 'END OF EVIDENCE'
        table.cells[0].history[0].evidence = [{ quote, pageStart: 6, pageEnd: 7 }]
        table.cells[0].history.unshift({
          ...structuredClone(table.cells[0].history[0]),
          id: 'old',
          value: 'Old result'
        })
        const before = structuredClone(table)
        const command = page(table)
        fireEvent.click(screen.getByRole('button', { name: /42 adults/ }))
        const panel = screen.getByRole(wide ? 'complementary' : 'dialog', { name: 'Review cell' })
        const evidence = within(panel).getByRole('region', { name: 'Machine results and evidence' })
        expect(evidence.tabIndex).toBe(0)
        expect(
          within(evidence)
            .getAllByText(quote)
            .every((element) => element.textContent === quote)
        ).toBe(true)
        const history = within(evidence).getByText(/Machine history/)
        fireEvent.click(history)
        expect(history.closest('details')?.open).toBe(true)
        fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
        const input = within(panel).getByRole('textbox', { name: 'Manual value' })
        const confirm = within(panel).getByRole('button', {
          name: 'Confirm result'
        })
        expect(evidence.contains(input)).toBe(false)
        expect(evidence.contains(confirm)).toBe(false)
        fireEvent.change(input, { target: { value: 'Reviewed manual value' } })
        await waitFor(() =>
          expect(command).toHaveBeenCalledWith({
            action: 'edit-cell',
            tableId: table.id,
            cellId: 'cell',
            value: 'Reviewed manual value',
            confirmed: false,
            expectedFieldVersion: 1,
            expectedSourceKey: 'source'
          })
        )
        expect(table).toEqual(before)
      } finally {
        vi.unstubAllGlobals()
      }
    }
  )

  it('blocks sidebar navigation while a manual draft is saving or failed and allows retry', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    )
    try {
      const table = fixture()
      let rejectSave!: (error: Error) => void
      const command = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              rejectSave = reject
            })
        )
        .mockResolvedValue({ tables: [table] })
      const next = vi.fn()
      render(
        <ComparisonCellReview
          tableId={table.id}
          cell={table.cells[0]}
          field={table.fields[0]}
          sourceKey="source"
          command={command}
          onClose={vi.fn()}
          onOpenItem={vi.fn()}
          navigation={{ position: 1, total: 2, reviewed: 0, onPrevious: vi.fn(), onNext: next }}
        />
      )
      const panel = screen.getByRole('dialog', { name: 'Review cell' })
      fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
      fireEvent.change(within(panel).getByRole('textbox', { name: 'Manual value' }), {
        target: { value: 'Saved human interpretation' }
      })
      const nextButton = within(panel).getByRole('button', {
        name: 'Next cell'
      }) as HTMLButtonElement
      expect(nextButton.disabled).toBe(true)
      await waitFor(() => expect(command).toHaveBeenCalledOnce())
      await act(async () => rejectSave(new Error('offline')))
      expect(nextButton.disabled).toBe(true)
      expect(
        (within(panel).getByRole('textbox', { name: 'Manual value' }) as HTMLTextAreaElement).value
      ).toBe('Saved human interpretation')
      fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(nextButton.disabled).toBe(false))
      expect(command.mock.calls[1][0]).toMatchObject({
        value: 'Saved human interpretation',
        confirmed: false,
        expectedFieldVersion: 1
      })
      fireEvent.click(nextButton)
      expect(next).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows rule text on demand and saves a rule from the compact field popup', async () => {
    const table = fixture()
    const command = page(table)
    const header = screen.getByRole('columnheader', { name: 'Population' })
    expect(header.textContent).not.toContain('Report the population')
    expect(screen.queryByRole('menuitem')).toBeNull()
    const info = within(header).getByRole('button', {
      name: 'Population · Extraction requirements'
    })
    fireEvent.click(info)
    const editor = screen.getByRole('dialog', { name: 'Population' })
    expect(within(editor).queryByRole('textbox', { name: 'Field name' })).toBeNull()
    const input = within(editor).getByRole('textbox', { name: 'Extraction requirements' })
    expect(input).toHaveProperty('value', 'Report the population')
    fireEvent.change(input, { target: { value: 'Report enrolled participants' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update',
        expectedRevision: 1,
        fields: [{ id: 'field', name: 'Population', rule: 'Report enrolled participants' }]
      })
    )
    await waitFor(() => expect(document.activeElement).toBe(info))
  })
  it('anchors the editor to its own column button without a modal overlay', async () => {
    const table = fixture()
    table.fields.push({ id: 'other', name: 'Outcome', rule: 'Report the outcome', version: 4 })
    page(table)
    const triggers = screen.getAllByRole('button', { name: 'Edit field' })
    fireEvent.click(triggers[1])
    const editor = screen.getByRole('dialog', { name: 'Edit {{field}}' })
    expect(editor.getAttribute('data-slot')).toBe('field-editor-popover')
    expect(editor.getAttribute('aria-modal')).not.toBe('true')
    expect(triggers[1].getAttribute('aria-controls')).toBe(editor.id)
    expect(triggers[1].getAttribute('aria-expanded')).toBe('true')
    expect(triggers[0].getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-radix-popper-content-wrapper]')).toBeTruthy()
    expect(document.querySelector('[data-scroll-locked]')).toBeNull()
    expect(document.querySelector('.fixed.inset-0')).toBeNull()
    expect(editor.className).toContain('w-[min(28rem,calc(100vw-2rem))]')
    expect(editor.className).toContain('--radix-popover-content-available-height')
    expect(
      (within(editor).getByRole('textbox', { name: 'Field name' }) as HTMLInputElement).value
    ).toBe('Outcome')
    fireEvent.keyDown(editor, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(triggers[1]))
  })

  it('keeps a changed column draft when an outside action is clicked until explicitly canceled', async () => {
    const command = page(fixture())
    const trigger = screen.getByRole('button', { name: 'Edit field' })
    fireEvent.click(trigger)
    const editor = screen.getByRole('dialog')
    const rule = within(editor).getByRole('textbox', {
      name: 'Extraction requirements'
    }) as HTMLTextAreaElement
    fireEvent.change(rule, { target: { value: 'Protected draft' } })
    const backgroundAction = screen.getByRole('button', { name: 'More actions' })
    fireEvent.pointerDown(backgroundAction)
    fireEvent.click(backgroundAction)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog')).toBe(editor)
    expect(rule.value).toBe('Protected draft')
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    chooseTableAction('Table settings')
    expect(screen.getByRole('dialog', { name: 'Table settings' })).toBeTruthy()
  })

  it.each(['column', 'configuration'] as const)(
    'keeps the %s edit baseline and draft after a concurrent configuration change',
    async (editor) => {
      const table = fixture()
      const updated = structuredClone(table)
      updated.revision = 2
      updated.fields[0].rule = 'Another client saved this rule'
      updated.fields[0].version = 2
      const command = vi.fn(
        async (
          request: import('../../../../../shared/literature-comparison').ComparisonRequest
        ) => {
          if (request.action === 'update' && request.expectedRevision !== 2)
            throw new Error('comparison-config-changed')
          return { tables: [updated] }
        }
      )
      const props = {
        command,
        onChooseReferences: vi.fn(),
        onOpenItem: vi.fn(),
        onOpenDiscovery: vi.fn(),
        onOpenComparison: vi.fn()
      }
      const { rerender } = render(<LiteratureComparisonPage table={table} {...props} />)
      const open = (): void => {
        if (editor === 'column') fireEvent.click(screen.getByRole('button', { name: 'Edit field' }))
        else chooseTableAction('Table settings')
      }
      const save = (): void => {
        fireEvent.click(
          screen.getByRole('button', {
            name: editor === 'column' ? 'Save rule revision' : 'Save'
          })
        )
      }
      open()
      const draft = screen.getByRole('textbox', {
        name: 'Extraction requirements'
      }) as HTMLTextAreaElement
      fireEvent.change(draft, { target: { value: 'My unsaved rule' } })
      rerender(<LiteratureComparisonPage table={updated} {...props} />)
      save()
      const conflict =
        'This table changed while you were editing. Copy your draft, then cancel and reopen the editor to load the latest configuration.'
      await screen.findByText(conflict)
      expect(draft.value).toBe('My unsaved rule')
      expect(command.mock.calls[0][0]).toMatchObject({ action: 'update', expectedRevision: 1 })
      save()
      await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
      await screen.findByText(conflict)
      expect(command.mock.calls[1][0]).toMatchObject({ action: 'update', expectedRevision: 1 })
      expect(draft.value).toBe('My unsaved rule')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      open()
      const latest = screen.getByRole('textbox', {
        name: 'Extraction requirements'
      }) as HTMLTextAreaElement
      expect(latest.value).toBe('Another client saved this rule')
      fireEvent.change(latest, { target: { value: 'Merged rule after review' } })
      save()
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(command.mock.calls[2][0]).toMatchObject({ action: 'update', expectedRevision: 2 })
    }
  )

  it.each([false, true])(
    'keeps a deleted column draft copyable and cancellable after a concurrent refresh (save conflict: %s)',
    async (saveConflict) => {
      const table = fixture()
      table.cells = []
      table.fields.push({ id: 'other', name: 'Outcome', rule: 'Report outcome', version: 1 })
      const props = {
        command: vi.fn().mockRejectedValue(new Error('comparison-config-changed')),
        onChooseReferences: vi.fn(),
        onOpenItem: vi.fn(),
        onOpenDiscovery: vi.fn(),
        onOpenComparison: vi.fn()
      }
      const { rerender } = render(<LiteratureComparisonPage table={table} {...props} />)
      fireEvent.click(screen.getAllByRole('button', { name: 'Edit field' })[0])
      fireEvent.change(screen.getByRole('textbox', { name: 'Extraction requirements' }), {
        target: { value: 'Keep this deleted column draft' }
      })
      if (saveConflict) {
        fireEvent.click(screen.getByRole('button', { name: 'Save rule revision' }))
        await screen.findByText(
          'This table changed while you were editing. Copy your draft, then cancel and reopen the editor to load the latest configuration.'
        )
      }
      const updated = structuredClone(table)
      updated.revision = 2
      updated.fields = updated.fields.filter((field) => field.id !== 'field')
      rerender(<LiteratureComparisonPage table={updated} {...props} />)
      const recovery = screen.getByRole('dialog', { name: 'Edit {{field}}' })
      const draft = within(recovery).getByRole('textbox', {
        name: 'Extraction requirements'
      }) as HTMLTextAreaElement
      expect(draft.value).toBe('Keep this deleted column draft')
      expect(draft.disabled).toBe(false)
      expect(draft.readOnly).toBe(true)
      expect(within(recovery).getByRole('textbox', { name: 'Field name' })).toHaveProperty(
        'value',
        'Population'
      )
      fireEvent.click(within(recovery).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      chooseTableAction('Table settings')
      expect(screen.getByRole('dialog', { name: 'Table settings' })).toBeTruthy()
      expect(props.command).toHaveBeenCalledTimes(saveConflict ? 1 : 0)
    }
  )

  it('saves a table rename without checking unchanged extraction fields', async () => {
    const table = fixture()
    const command = page(table)
    chooseTableAction('Table settings')
    const dialog = within(screen.getByRole('dialog', { name: 'Table settings' }))
    fireEvent.change(dialog.getByRole('textbox', { name: 'Table name' }), {
      target: { value: 'Renamed comparison' }
    })
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'update',
          tableId: table.id,
          expectedRevision: table.revision,
          name: 'Renamed comparison',
          sourcePolicy: table.sourcePolicy,
          fields: table.fields.map(({ id, name, rule }) => ({ id, name, rule }))
        })
      )
    )
  })

  it('reviews a successful sample cell while another sample cell failed and keeps retries targeted', () => {
    const table = fixture()
    table.cells[0].status = 'failed'
    table.cells[0].history = []
    table.itemIds.push('second', 'third')
    table.members.push(
      { ...table.members[0], itemId: 'second', title: 'Second report' },
      { ...table.members[0], itemId: 'third', title: 'Third report' }
    )
    table.cells.push(
      { ...structuredClone(fixture().cells[0]), id: 'second', itemId: 'second' },
      { id: 'third', itemId: 'third', fieldId: 'field', status: 'pending', history: [] }
    )
    const command = page(table)
    expect(screen.queryByRole('button', { name: 'Extract sample' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Extract remaining' })).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Retry selected cells' }) as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Review sample' }))
    expect(screen.getByRole('dialog', { name: 'Review cell' }).textContent).toContain(
      'Second report'
    )
    expect(command).not.toHaveBeenCalled()
  })

  it('validates configuration inline and enables a direct save only for complete unique fields', async () => {
    const table = fixture()
    const command = page(table)
    chooseTableAction('Table settings')
    const dialog = screen.getByRole('dialog', { name: 'Table settings' })
    expect(within(dialog).queryByRole('button', { name: 'Check fields' })).toBeNull()
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add field' }))
    const newName = within(dialog).getByRole('textbox', { name: 'Field name' })
    const requirement = within(dialog).getByRole('textbox', { name: 'Extraction requirements' })
    expect(save.disabled).toBe(true)
    expect(newName.getAttribute('aria-invalid')).toBe('true')
    expect(within(dialog).getAllByText('Required')).toHaveLength(2)
    fireEvent.change(newName, { target: { value: '  POPULATION  ' } })
    fireEvent.change(requirement, { target: { value: 'Report the outcome' } })
    expect(within(dialog).getByText('Field names must be unique.')).toBeTruthy()
    expect(newName.getAttribute('aria-invalid')).toBe('true')
    expect(save.disabled).toBe(true)
    fireEvent.change(newName, { target: { value: 'Outcome' } })
    expect(within(dialog).queryByText('Field names must be unique.')).toBeNull()
    expect(save.disabled).toBe(false)
    const tableName = within(dialog).getByRole('textbox', { name: 'Table name' })
    fireEvent.change(tableName, { target: { value: '  ' } })
    expect(tableName.getAttribute('aria-invalid')).toBe('true')
    expect(save.disabled).toBe(true)
    fireEvent.change(tableName, { target: { value: 'Reviewed evidence' } })
    fireEvent.click(save)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(command).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: 'update',
        expectedRevision: 1,
        name: 'Reviewed evidence',
        fields: [
          { id: 'field', name: 'Population', rule: 'Report the population' },
          { id: expect.any(String), name: 'Outcome', rule: 'Report the outcome' }
        ]
      })
    )
  })

  it('keeps a failed bulk configuration visible with its draft and returns focus after retrying save', async () => {
    const table = fixture()
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error('write-failed'))
      .mockResolvedValue({ tables: [table] })
    page(table, command)
    const trigger = screen.getByRole('button', { name: 'More actions' })
    chooseTableAction('Table settings')
    const dialog = screen.getByRole('dialog', { name: 'Table settings' })
    const name = within(dialog).getByRole('textbox', { name: 'Table name' }) as HTMLInputElement
    const policy = within(dialog).getByRole('combobox', {
      name: 'Source policy'
    }) as HTMLButtonElement
    const rule = within(dialog).getByRole('textbox', {
      name: 'Extraction requirements'
    }) as HTMLTextAreaElement
    fireEvent.change(name, { target: { value: 'Revised table' } })
    chooseOption(policy, 'Require full text')
    fireEvent.change(rule, { target: { value: 'Revised requirements' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(within(dialog).getByText('Comparison table could not be updated.')).toBeTruthy()
    )
    expect(name.value).toBe('Revised table')
    expect(policy.textContent).toBe('Require full text')
    expect(rule.value).toBe('Revised requirements')
    expect(table.name).toBe('Evidence')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(command).toHaveBeenCalledTimes(2)
    expect(command.mock.calls[0][0]).toEqual({
      action: 'update',
      expectedRevision: 1,
      tableId: 'table',
      name: 'Revised table',
      sourcePolicy: 'full-text',
      fields: [{ id: 'field', name: 'Population', rule: 'Revised requirements' }]
    })
    expect(command.mock.calls[1]).toEqual(command.mock.calls[0])
  })

  it.each(['cancel', 'escape'] as const)(
    'returns bulk configuration focus to the top button after %s without updating',
    async (method) => {
      const command = page(fixture())
      const trigger = screen.getByRole('button', { name: 'More actions' })
      trigger.focus()
      chooseTableAction('Table settings')
      const dialog = screen.getByRole('dialog')
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Table name' }), {
        target: { value: 'Unsaved table name' }
      })
      if (method === 'cancel')
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      else fireEvent.keyDown(dialog, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(trigger))
      expect(command).not.toHaveBeenCalled()
      chooseTableAction('Table settings')
      expect((screen.getByRole('textbox', { name: 'Table name' }) as HTMLInputElement).value).toBe(
        'Evidence'
      )
    }
  )

  it('explains a duplicate column name accessibly and clears the error after a unique correction', () => {
    const table = fixture()
    table.fields.push({ id: 'other', name: 'Outcome', rule: 'Report the outcome', version: 4 })
    const command = page(table)
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit field' })[0])
    const dialog = screen.getByRole('dialog')
    const name = within(dialog).getByRole('textbox', { name: 'Field name' }) as HTMLInputElement
    fireEvent.change(name, { target: { value: ' outcome ' } })
    const explanation = within(dialog).getByText('Field names must be unique.')
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(name.getAttribute('aria-describedby')).toBe(explanation.id)
    const save = within(dialog).getByRole('button', {
      name: 'Save rule revision'
    }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(command).not.toHaveBeenCalled()
    fireEvent.change(name, { target: { value: 'Study population' } })
    expect(name.hasAttribute('aria-invalid')).toBe(false)
    expect(name.hasAttribute('aria-describedby')).toBe(false)
    expect(within(dialog).queryByText('Field names must be unique.')).toBeNull()
    expect(save.disabled).toBe(false)
  })

  it('saves a column rule revision directly while preserving the other field and table settings', async () => {
    const table = fixture()
    table.sourcePolicy = 'full-text'
    table.fields.push({ id: 'other', name: 'Outcome', rule: 'Report the outcome', version: 4 })
    const command = page(table)
    const trigger = screen.getAllByRole('button', { name: 'Edit field' })[0]
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Edit {{field}}' })
    expect(within(dialog).queryByRole('button', { name: 'Check fields' })).toBeNull()
    expect(within(dialog).queryByRole('textbox', { name: 'Table name' })).toBeNull()
    expect(within(dialog).queryByRole('combobox')).toBeNull()
    expect(within(dialog).getByText('Current rule: v{{version}}', { exact: false })).toBeTruthy()
    expect(within(dialog).queryByText('After saving: v{{version}}', { exact: false })).toBeNull()
    expect(translate).toHaveBeenCalledWith('Current rule: v{{version}}', { version: 1 })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Field name' }), {
      target: { value: 'Analysis population' }
    })
    expect(translate).toHaveBeenCalledWith('After saving: v{{version}}', { version: 2 })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Extraction requirements' }), {
      target: { value: 'Report the analysis population and sample size' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule revision' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(command).toHaveBeenCalledExactlyOnceWith({
      action: 'update',
      expectedRevision: 1,
      tableId: 'table',
      name: 'Evidence',
      sourcePolicy: 'full-text',
      fields: [
        {
          id: 'field',
          name: 'Analysis population',
          rule: 'Report the analysis population and sample size'
        },
        { id: 'other', name: 'Outcome', rule: 'Report the outcome' }
      ]
    })
    expect(table.fields[1].version).toBe(4)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('keeps a failed rule draft in the dialog and retries the same revision', async () => {
    const table = fixture()
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error('write-failed'))
      .mockResolvedValue({ tables: [table] })
    page(table, command)
    fireEvent.click(screen.getByRole('button', { name: 'Edit field' }))
    const dialog = screen.getByRole('dialog')
    const rule = within(dialog).getByRole('textbox', {
      name: 'Extraction requirements'
    }) as HTMLTextAreaElement
    fireEvent.change(rule, { target: { value: 'Keep this unsaved revision' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule revision' }))
    await waitFor(() =>
      expect(within(dialog).getByText('Comparison table could not be updated.')).toBeTruthy()
    )
    expect(rule.value).toBe('Keep this unsaved revision')
    expect(table.fields[0].rule).toBe('Report the population')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule revision' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(command).toHaveBeenCalledTimes(2)
    expect(command.mock.calls[1]).toEqual(command.mock.calls[0])
  })

  it('keeps a saving rule revision open and prevents duplicate writes or draft changes', async () => {
    const table = fixture()
    let resolveSave!: () => void
    const pending = new Promise<void>((resolve) => {
      resolveSave = resolve
    })
    const command = vi.fn(async () => {
      await pending
      return { tables: [table] }
    })
    page(table, command)
    fireEvent.click(screen.getByRole('button', { name: 'Edit field' }))
    const dialog = screen.getByRole('dialog')
    const rule = within(dialog).getByRole('textbox', {
      name: 'Extraction requirements'
    }) as HTMLTextAreaElement
    fireEvent.change(rule, { target: { value: 'Revised rule' } })
    const save = within(dialog).getByRole('button', {
      name: 'Save rule revision'
    }) as HTMLButtonElement
    fireEvent.click(save)
    expect(save.disabled).toBe(true)
    expect(rule.disabled).toBe(true)
    expect(
      (within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.click(save)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(command).toHaveBeenCalledTimes(1)
    await act(async () => resolveSave())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it.each(['cancel', 'escape'] as const)(
    'discards a column draft on %s without updating and returns focus to its column button',
    async (method) => {
      const command = page(fixture())
      const trigger = screen.getByRole('button', { name: 'Edit field' })
      trigger.focus()
      fireEvent.click(trigger)
      const dialog = screen.getByRole('dialog')
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Field name' }), {
        target: { value: 'Unsaved field name' }
      })
      if (method === 'cancel')
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      else fireEvent.keyDown(dialog, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(trigger))
      expect(command).not.toHaveBeenCalled()
      fireEvent.click(trigger)
      expect((screen.getByRole('textbox', { name: 'Field name' }) as HTMLInputElement).value).toBe(
        'Population'
      )
    }
  )

  it('blocks rule edits during extraction and while manual review has an unsaved write', async () => {
    const table = fixture()
    table.state = 'running'
    const command = page(table)
    expect((screen.getByRole('button', { name: 'Edit field' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    cleanup()
    table.state = 'idle'
    let resolveSave!: () => void
    const pending = new Promise<void>((resolve) => {
      resolveSave = resolve
    })
    command.mockImplementation(async () => {
      await pending
      return { tables: [table] }
    })
    page(table, command)
    fireEvent.click(screen.getByRole('button', { name: /42 adults/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual value' }), {
      target: { value: 'Review draft' }
    })
    expect(
      (screen.getByRole('button', { name: 'Edit field', hidden: true }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    await act(async () => resolveSave())
  })

  it('distinguishes all cells needing review from current results ready for review after a rule revision', () => {
    const table = fixture()
    table.fields.push({ id: 'revised', name: 'Revised outcome', rule: 'Updated rule', version: 2 })
    table.cells.push({
      ...structuredClone(table.cells[0]),
      id: 'old-manual',
      fieldId: 'revised',
      status: 'pending',
      manual: {
        value: 'Old correction',
        fieldVersion: 1,
        sourceKey: 'source',
        updatedAt: 'earlier',
        confirmed: true
      }
    })
    page(table)
    fireEvent.click(screen.getByRole('button', { name: /Table totals/ }))
    const totals = screen.getByRole('list', { name: 'Table totals' })
    expect(within(totals).getByText('Needs review').nextElementSibling?.textContent).toBe('2')
    const filter = screen.getByRole('combobox', { name: 'Filters' })
    fireEvent.keyDown(filter, { key: 'ArrowDown' })
    const option = screen.getByRole('option', { name: 'Ready for review (1)' })
    fireEvent.keyDown(option, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Start review ({{count}} cells)' }))
    expect(screen.getByRole('dialog', { name: 'Review cell' }).textContent).toContain('42 adults')
    expect(translate).toHaveBeenCalledWith(
      'Start review ({{count}} cells)',
      expect.objectContaining({ count: 1 })
    )
  })

  it('labels outdated rule results with both versions and keeps the manual edit awaiting review', () => {
    const table = fixture()
    table.fields[0].version = 2
    table.cells[0].manual = {
      value: 'Retained correction',
      fieldVersion: 1,
      sourceKey: 'source',
      updatedAt: 'earlier',
      confirmed: true
    }
    page(table)
    expect(
      screen.getByRole('button', { name: 'Population · Extraction requirements' })
    ).toBeTruthy()
    const cell = screen.getByRole('button', { name: /Retained correction/ })
    expect(
      within(cell).getByText('Outdated rule v{{previous}} (current: v{{current}})')
    ).toBeTruthy()
    expect(within(cell).getByText('Needs review')).toBeTruthy()
    expect(translate).toHaveBeenCalledWith('Rule v{{version}}', { version: 2 })
    expect(translate).toHaveBeenCalledWith('Outdated rule v{{previous}} (current: v{{current}})', {
      previous: 1,
      current: 2
    })
  })

  it.each([
    [27, 27],
    [28, 3],
    [52, 27]
  ])('keeps short trailing pages accessible for %i references', (total, lastPageRows) => {
    const table = fixture()
    for (let index = 1; index < total; index++) {
      const itemId = 'paper-' + index
      table.itemIds.push(itemId)
      table.members.push({ ...table.members[0], itemId, title: 'Paper ' + (index + 1) })
      table.cells.push({ ...table.cells[0], itemId, id: 'cell-' + index })
    }
    page(table)
    const matrix = screen.getByRole('table', { name: 'Comparison matrix' })
    if (total > 27) {
      expect(within(matrix).getAllByRole('rowheader')).toHaveLength(25)
      fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    }
    expect(within(matrix).getAllByRole('rowheader')).toHaveLength(lastPageRows)
    expect(within(matrix).getByText('Paper ' + total)).toBeTruthy()
    expect(
      (screen.queryByRole('button', { name: 'Next page' }) as HTMLButtonElement | null)?.disabled ??
        true
    ).toBe(true)
  })

  it('searches titles and displayed values across pages and intersects the status filter', async () => {
    const table = fixture()
    for (let i = 1; i <= 28; i++) {
      const itemId = 'paper-' + i
      table.itemIds.push(itemId)
      table.members.push({
        ...table.members[0],
        itemId,
        title: 'Paper ' + i,
        abstract: 'unsearchable abstract'
      })
      table.cells.push({
        ...table.cells[0],
        id: 'cell-' + i,
        itemId,
        status: 'pending',
        history: []
      })
    }
    table.cells[0].manual = {
      value: 'Reviewed value',
      confirmed: false,
      fieldVersion: 1,
      sourceKey: 'source',
      updatedAt: 'saved'
    }
    page(table)
    const search = screen.getByRole('textbox', { name: 'Search titles and results' })
    const matrix = screen.getByRole('table', { name: 'Comparison matrix' })
    const change = (value: string): void => {
      fireEvent.change(search, { target: { value } })
    }
    change('PAPER 28')
    await within(matrix).findByText('Paper 28')
    expect(within(matrix).getAllByRole('rowheader')).toHaveLength(1)
    selectFilter('pending')
    change('reviewed VALUE')
    await screen.findByText('No matching references')
    chooseOption(screen.getByRole('combobox', { name: 'Filters' }), 'All references')
    await within(matrix).findByText('Reviewed value')
    change('42 adults')
    await screen.findByText('No matching references')
    change('unsearchable abstract')
    await waitFor(() => expect(within(matrix).queryAllByRole('rowheader')).toHaveLength(0))
    change('')
    await waitFor(() => expect(within(matrix).getAllByRole('rowheader')).toHaveLength(25))
  })
  it('keeps the reference column fixed while the comparison matrix scrolls horizontally', () => {
    page(fixture())
    const table = screen.getByRole('table', { name: 'Comparison matrix' })
    expect(table.classList.contains('w-full')).toBe(true)
    expect(table.style.minWidth).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Bibliographic record' }).className).toContain(
      'sticky'
    )
  })

  it('discards only the failed local draft after confirmation and preserves the saved manual value', async () => {
    const table = fixture()
    table.cells[0].manual = {
      value: 'Previously saved manual',
      confirmed: false,
      fieldVersion: 1,
      sourceKey: 'source',
      updatedAt: 'earlier'
    }
    const saved = JSON.stringify(table)
    const command = vi.fn().mockRejectedValue(new Error('source-unavailable'))
    const onDraftStatusChange = vi.fn()
    render(
      <LiteratureComparisonPage
        table={table}
        command={command}
        onChooseReferences={vi.fn()}
        onOpenItem={vi.fn()}
        onOpenDiscovery={vi.fn()}
        onOpenComparison={vi.fn()}
        onDraftStatusChange={onDraftStatusChange}
      />
    )
    const cell = screen.getByRole('button', { name: /Previously saved manual/ })
    fireEvent.click(cell)
    const input = screen.getByRole('textbox', { name: 'Manual value' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Unsavable local correction' } })
    const discard = await screen.findByRole('button', { name: 'Discard changes' })
    discard.focus()
    fireEvent.click(discard)
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(document.activeElement).toBe(discard))
    expect(input.value).toBe('Unsavable local correction')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(onDraftStatusChange).toHaveBeenLastCalledWith({ pending: false, failed: true })
    fireEvent.click(discard)
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Review cell' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(cell))
    expect(onDraftStatusChange).toHaveBeenLastCalledWith({ pending: false, failed: false })
    expect(command).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(table)).toBe(saved)
    fireEvent.click(cell)
    expect(
      (screen.getByRole('textbox', { name: 'Manual value' }) as HTMLTextAreaElement).value
    ).toBe('Previously saved manual')
    expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull()
  })

  it('waits for every queued write to settle before offering failed draft discard', async () => {
    const table = fixture()
    let rejectFirst!: (error: Error) => void
    let rejectSecond!: (error: Error) => void
    const command = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSecond = reject
          })
      )
    render(
      <ComparisonCellReview
        tableId={table.id}
        cell={table.cells[0]}
        field={table.fields[0]}
        sourceKey="source"
        command={command}
        onClose={vi.fn()}
        onOpenItem={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
    const input = screen.getByRole('textbox', { name: 'Manual value' })
    fireEvent.change(input, { target: { value: 'First queued write' } })
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { value: 'Second queued write' } })
    expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull()
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    await act(async () => rejectFirst(new Error('unavailable')))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    expect(
      (screen.getByRole('button', { name: 'Discard changes' }) as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await act(async () => rejectSecond(new Error('unavailable')))
    const discard = screen.getByRole('button', { name: 'Discard changes' }) as HTMLButtonElement
    expect(discard.disabled).toBe(false)
    fireEvent.click(discard)
    // Even an external synthetic edit cannot queue a write behind the confirmation modal.
    fireEvent.change(input, { target: { value: 'Behind the modal' } })
    expect((input as HTMLTextAreaElement).value).toBe('Second queued write')
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(command).toHaveBeenCalledTimes(2)
  })

  it('publishes draft status synchronously and ignores save completion after unmount', async () => {
    const table = fixture()
    let resolveSave!: () => void
    const pendingSave = new Promise<void>((resolve) => {
      resolveSave = resolve
    })
    const command = vi.fn(async () => {
      await pendingSave
      return { tables: [table] }
    })
    const onDraftStatusChange = vi.fn()
    const rendered = render(
      <LiteratureComparisonPage
        table={table}
        command={command}
        onChooseReferences={vi.fn()}
        onOpenItem={vi.fn()}
        onOpenDiscovery={vi.fn()}
        onOpenComparison={vi.fn()}
        onDraftStatusChange={onDraftStatusChange}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /42 adults/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual value' }), {
      target: { value: 'Human correction' }
    })
    expect(onDraftStatusChange).toHaveBeenCalledExactlyOnceWith({ pending: true, failed: false })
    rendered.unmount()
    await act(async () => {
      resolveSave()
    })
    expect(onDraftStatusChange).toHaveBeenCalledTimes(1)
  })

  it('requires selected members and defaults to the three-field full-text template without running', async () => {
    const command = vi.fn()
    render(
      <ComparisonDestinationDialog
        tables={[]}
        itemIds={[]}
        command={command}
        onClose={vi.fn()}
        onAdded={vi.fn()}
      />
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Table name' }), {
      target: { value: 'Review table' }
    })
    expect(screen.getByRole('combobox', { name: 'Source policy' }).textContent).toBe(
      'Full text required, no abstract fallback'
    )
    expect(screen.queryAllByRole('textbox', { name: 'Field name' })).toHaveLength(0)
    const configure = screen.getByRole('button', { name: 'Configure fields' })
    fireEvent.click(configure)
    expect(configure.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('combobox', { name: 'Starting fields' }).textContent).toContain(
      'Clinical trial'
    )
    const inputs = screen.getAllByRole('textbox', { name: 'Field name' })
    expect(inputs).toHaveLength(3)
    fireEvent.change(inputs[0], { target: { value: 'Follow-up duration' } })
    fireEvent.click(configure)
    expect(configure.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('textbox', { name: 'Field name' })).toBeNull()
    fireEvent.click(configure)
    expect(screen.getByDisplayValue('Follow-up duration')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Starting fields' }).textContent).toBe(
      'Custom fields'
    )
    expect(
      (screen.getByRole('button', { name: 'Create and open matrix' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(command).not.toHaveBeenCalled()
  })
  it('adds references to an existing table without starting extraction', async () => {
    const command = vi.fn().mockResolvedValue({ tables: [fixture()] })
    render(
      <ComparisonDestinationDialog
        tables={[fixture()]}
        mode="existing"
        itemIds={['new-paper']}
        command={command}
        onClose={vi.fn()}
        onAdded={vi.fn()}
      />
    )
    chooseOption(screen.getByRole('combobox', { name: 'Comparison table' }), 'Evidence')
    fireEvent.click(screen.getByRole('button', { name: 'Add to comparison table' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(command).toHaveBeenCalledWith({
      action: 'add-members',
      tableId: 'table',
      itemIds: ['new-paper']
    })
  })
  it('creates a table with the selected source policy and starting field rule', async () => {
    const command = vi.fn().mockResolvedValue({ tables: [fixture()] })
    render(
      <ComparisonDestinationDialog
        tables={[]}
        itemIds={['paper-a', 'paper-b']}
        command={command}
        onClose={vi.fn()}
        onAdded={vi.fn()}
      />
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Table name' }), {
      target: { value: 'Treatment comparison' }
    })
    chooseOption(
      screen.getByRole('combobox', { name: 'Source policy' }),
      'Full text required, no abstract fallback'
    )
    chooseOption(screen.getByRole('combobox', { name: 'Starting fields' }), 'Custom fields')
    fireEvent.change(screen.getByRole('textbox', { name: 'Field name' }), {
      target: { value: 'Primary outcome' }
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Extraction requirements' }), {
      target: { value: 'Extract the primary outcome and time point.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create and open matrix' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create',
        name: 'Treatment comparison',
        sourcePolicy: 'full-text',
        itemIds: ['paper-a', 'paper-b'],
        fields: [
          expect.objectContaining({
            name: 'Primary outcome',
            rule: 'Extract the primary outcome and time point.'
          })
        ]
      })
    )
  })
  it('counts linked PDFs and abstracts from the selected reference snapshots', async () => {
    getReference.mockResolvedValueOnce({
      item: { abstract: 'Available abstract' },
      attachments: [{ versions: [{ contentType: 'application/pdf' }] }]
    })
    getReference.mockResolvedValueOnce({ item: { abstract: '' }, attachments: [] })
    render(
      <ComparisonDestinationDialog
        tables={[]}
        itemIds={['with-pdf', 'without-pdf']}
        command={vi.fn()}
        onClose={vi.fn()}
        onAdded={vi.fn()}
      />
    )
    await waitFor(() =>
      expect(translate).toHaveBeenCalledWith(
        'PDF linked: {{pdf}}; missing PDF: {{missing}}; abstract available: {{abstract}}.',
        { pdf: 1, missing: 1, abstract: 1 }
      )
    )
    expect(getReference).toHaveBeenCalledWith('with-pdf')
    expect(getReference).toHaveBeenCalledWith('without-pdf')
  })
  it('shows a retryable source lookup error instead of fabricated counts', async () => {
    getReference.mockRejectedValueOnce(new Error('unavailable'))
    render(
      <ComparisonDestinationDialog
        tables={[]}
        itemIds={['missing']}
        command={vi.fn()}
        onClose={vi.fn()}
        onAdded={vi.fn()}
      />
    )
    await screen.findByText('Source availability could not be loaded.')
    expect(
      screen.queryByText(
        'PDF linked: {{pdf}}; missing PDF: {{missing}}; abstract available: {{abstract}}.'
      )
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText(
      'PDF linked: {{pdf}}; missing PDF: {{missing}}; abstract available: {{abstract}}.'
    )
  })
  it('does not run on open and requires persisted sample confirmations before remaining extraction', () => {
    const command = page(fixture())
    expect(command).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Extract remaining' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Table totals/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Review sample' }))
    expect(screen.getByRole('dialog', { name: 'Review cell' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Extract remaining' })).toBeNull()
  })
  it('allows matrix export from the actions menu after all current results are reviewed', () => {
    const table = fixture()
    table.cells[0].manual = {
      value: '42 adults',
      confirmed: true,
      fieldVersion: 1,
      sourceKey: 'source',
      attemptId: 'attempt',
      updatedAt: '2026-11-06'
    }
    page(table)
    expect(screen.queryByRole('button', { name: 'Extract remaining' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start review ({{count}} cells)' })).toBeNull()
    expect(exportDisabled()).toBe(false)
  })
  it('requires review when an earlier manual confirmation has no binding to the extracted attempt', () => {
    const table = fixture()
    table.cells[0].manual = {
      value: 'Human value',
      confirmed: true,
      fieldVersion: 1,
      sourceKey: 'source',
      updatedAt: '2026-11-06'
    }
    page(table)
    expect(screen.getByRole('button', { name: 'Start review ({{count}} cells)' })).toBeTruthy()
    expect(screen.queryByText('Confirmed')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start review ({{count}} cells)' }))
    expect(
      screen.getByRole('button', {
        name: /^(Confirm value|Confirm result|Confirm revision)$/
      })
    ).toBeTruthy()
  })
  it('shows historical field meaning and requested source separately from the revised field', () => {
    const table = fixture()
    table.fields[0] = {
      ...table.fields[0],
      name: 'Completers',
      rule: 'Report completed follow-up',
      version: 2
    }
    table.cells[0].history[0].fieldSnapshot = {
      id: 'field',
      name: 'Enrolled participants',
      rule: 'Report all enrolled participants',
      version: 1
    }
    table.cells[0].history[0].sourcePolicy = 'abstract'
    render(
      <ComparisonCellReview
        tableId="table"
        sourceKey="source"
        cell={table.cells[0]}
        field={table.fields[0]}
        onClose={vi.fn()}
        onOpenItem={vi.fn()}
        command={vi.fn().mockResolvedValue({ tables: [table] })}
      />
    )
    expect(screen.getByRole('heading', { name: 'Completers' })).toBeTruthy()
    fireEvent.click(screen.getByText('Details', { selector: 'summary' }))
    expect(screen.getByText('Enrolled participants')).toBeTruthy()
    expect(screen.getByText('Report all enrolled participants')).toBeTruthy()
    expect(screen.getByText(/Report completed follow-up/)).toBeTruthy()
    expect(screen.getByText(/Source policy/).textContent).toContain('Abstract only')
  })
  it('offers complete-result review and identifies the reference in the review panel', () => {
    page(fixture())
    const review = screen.getByRole('button', { name: 'Start review ({{count}} cells)' })
    expect(review.className).toContain('bg-primary')
    fireEvent.click(review)
    expect(screen.getByRole('dialog', { name: 'Review cell' }).textContent).toContain('Paper')
  })
  it('keeps waiting sources separate from failed extraction and offers targeted recovery', async () => {
    const table = fixture()
    table.sourcePolicy = 'full-text'
    table.state = 'completed'
    table.cells[0].status = 'unavailable'
    table.cells[0].history = []
    const sourceChecks = [{ itemId: 'paper', sourceKey: 'source', status: 'available' }]
    const command = page(table, vi.fn().mockResolvedValue({ tables: [table], sourceChecks }))
    expect(translate).toHaveBeenCalledWith('Pending extraction: {{pending}}', { pending: 0 })
    expect(screen.getByRole('button', { name: 'Extract sample' })).toBeTruthy()
    expect(
      screen.getByText('Full text is required. Add a PDF to the reference, then retry this cell.')
    ).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Open reference' }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Check source and retry' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and start' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        action: 'retry',
        tableId: 'table',
        cellIds: ['cell'],
        expectedRevision: table.revision,
        expectedSources: [{ itemId: 'paper', sourceKey: 'source' }]
      })
    )
  })
  it.each([
    ['paused', 'available'],
    ['interrupted', 'available'],
    ['paused', 'missing']
  ] as const)(
    'offers resume and blocks new extraction for a %s unfinished queue with a %s source',
    async (state, status) => {
      const table = fixture()
      table.state = state
      table.remainingCellIds = ['cell']
      table.cells[0].status = 'pending'
      table.cells[0].history = []
      const command = page(
        table,
        vi.fn().mockResolvedValue({
          tables: [table],
          sourceChecks: [{ itemId: 'paper', sourceKey: 'source', status }]
        })
      )
      expect(screen.queryByRole('button', { name: 'Extract sample' })).toBeNull()
      expect(columnMenuItem('Rerun column').getAttribute('aria-disabled')).toBe('true')
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      fireEvent.click(screen.getByRole('button', { name: 'Continue {{count}} cells' }))
      const confirm = (await screen.findByRole('button', {
        name: 'Confirm and start'
      })) as HTMLButtonElement
      await waitFor(() => expect(confirm.disabled).toBe(false))
      fireEvent.click(confirm)
      await waitFor(() =>
        expect(command).toHaveBeenCalledWith({
          action: 'resume',
          tableId: 'table',
          expectedRevision: table.revision,
          expectedSources: [{ itemId: 'paper', sourceKey: 'source' }],
          useCurrentSources: false
        })
      )
    }
  )
  it('shows selection actions after checking references and clears them with one click', () => {
    page(fixture())
    const matrix = screen.getByRole('table', { name: 'Comparison matrix' })
    const headers = within(matrix).getAllByRole('columnheader')
    const all = within(headers[0]).getByRole('checkbox') as HTMLInputElement
    expect(headers[1].textContent).toBe('#')
    expect(headers[2].textContent).toBe('Bibliographic record')
    expect(screen.queryByRole('button', { name: 'Re-extract a column' })).toBeNull()
    fireEvent.click(all)
    expect(
      within(matrix)
        .getAllByRole('checkbox')
        .every((input) => (input as HTMLInputElement).checked)
    ).toBe(true)
    expect(screen.getByRole('button', { name: 'Re-extract a column' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(all.checked).toBe(false)
    expect(screen.queryByRole('button', { name: 'Re-extract a column' })).toBeNull()
  })
  it('requires matrix selection before rerunning a column and explains the disabled action', () => {
    const command = page(fixture())
    const rerun = columnMenuItem('Rerun column')
    const hint = screen.getByText('Select references in the matrix before rerunning a column.')
    expect(rerun.getAttribute('aria-disabled')).toBe('true')
    expect(rerun.getAttribute('aria-describedby')).toBe(hint.id)
    fireEvent.click(rerun)
    expect(command).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps unrestricted matrix selection independent from the reviewed sample until explicitly replaced', () => {
    const table = fixture()
    table.cells[0].manual = {
      value: '42 adults',
      confirmed: true,
      fieldVersion: 1,
      sourceKey: 'source',
      attemptId: 'attempt',
      updatedAt: 'saved'
    }
    for (const [itemId, title] of [
      ['second', 'Second report'],
      ['third', 'Third report']
    ]) {
      table.itemIds.push(itemId)
      table.members.push({ ...table.members[0], itemId, title })
      table.cells.push({
        ...structuredClone(table.cells[0]),
        id: `${itemId}-cell`,
        itemId,
        ...(itemId === 'third'
          ? { status: 'pending' as const, history: [], manual: undefined }
          : {})
      })
    }
    page(table)
    const remaining = screen.getByRole('button', { name: 'Extract remaining' }) as HTMLButtonElement
    fireEvent.click(screen.getByRole('button', { name: /Table totals/ }))
    const sampleAction = (): HTMLElement | null =>
      screen.queryByRole('button', { name: 'Use selection as sample' })
    expect(remaining.disabled).toBe(false)
    expect(sampleAction()).toBeNull()
    const sampleSummary = screen.getByText(/Sample references:/)
    expect(sampleSummary.textContent).toContain('Paper, Second report')
    const selections = screen.getAllByRole('checkbox', { name: 'Select {{title}}' })
    for (const checkbox of selections) fireEvent.click(checkbox)
    expect(selections.every((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true)
    expect(translate).toHaveBeenCalledWith('Selected references: {{selected}}', { selected: '3' })
    expect(sampleAction()).toBeNull()
    expect(remaining.disabled).toBe(false)
    expect(sampleSummary.textContent).toContain('Paper, Second report')
    fireEvent.click(selections[0])
    fireEvent.click(screen.getByRole('button', { name: 'Use selection as sample' }))
    fireEvent.click(screen.getByRole('button', { name: /Sample references:/ }))
    expect(
      within(screen.getByRole('dialog', { name: /Sample references:/ })).getByText(
        /Second report, Third report/
      )
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Extract remaining' })).toBeNull()
  })

  it('lets a pending source check be dismissed without reopening its confirmation', async () => {
    const table = fixture()
    const deferred = Promise.withResolvers<{ tables: ComparisonTable[]; sourceChecks: [] }>()
    const command = page(table, vi.fn().mockReturnValue(deferred.promise))
    chooseTableAction('Check sources')
    const scope = await screen.findByRole('dialog', { name: 'Confirm sources and scope' })
    fireEvent.click(within(scope).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => deferred.resolve({ tables: [], sourceChecks: [] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(command).toHaveBeenCalledTimes(1)
    chooseTableAction('Table settings')
    expect(
      (
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Remove'
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })
  it('extracts only the open pending cell before confirming a saved manual draft', async () => {
    const table = fixture()
    const cell = table.cells[0]
    cell.status = 'pending'
    cell.history = []
    cell.manual = {
      value: '123',
      confirmed: false,
      fieldVersion: 1,
      sourceKey: 'source',
      updatedAt: 'now'
    }
    table.itemIds.push('other')
    table.members.push({ ...table.members[0], itemId: 'other', title: 'Other reference' })
    table.cells.push({ ...cell, id: 'other-cell', itemId: 'other', manual: undefined })
    const sourceChecks = [{ itemId: 'paper', sourceKey: 'source', status: 'available' }]
    const command = page(table, vi.fn().mockResolvedValue({ tables: [table], sourceChecks }))
    fireEvent.click(screen.getByRole('button', { name: /123/ }))
    expect(screen.getByDisplayValue('123')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Extract this cell' }))
    const scope = within(await screen.findByRole('dialog', { name: 'Extract this cell' }))
    await scope.findByText('Paper')
    expect(scope.queryByText('Other reference')).toBeNull()
    expect(scope.queryByRole('checkbox')).toBeNull()
    expect(scope.getByText('Population')).toBeTruthy()
    fireEvent.click(scope.getByRole('button', { name: 'Confirm and start' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'rerun-field',
          fieldId: 'field',
          itemIds: ['paper'],
          expectedRevision: table.revision
        })
      )
    )
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'edit-cell' }))
  })

  it('reruns only the matrix-selected references in one chosen column and preserves selection after scope edits', async () => {
    const table = fixture()
    table.fields.push({ id: 'outcome', name: 'Outcome', rule: 'Report outcome', version: 1 })
    for (const [itemId, title] of [
      ['second', 'Second report'],
      ['third', 'Third report']
    ]) {
      table.itemIds.push(itemId)
      table.members.push({ ...table.members[0], itemId, title })
      table.cells.push({ ...structuredClone(table.cells[0]), id: `${itemId}-cell`, itemId })
    }
    for (const itemId of table.itemIds)
      table.cells.push({
        ...structuredClone(table.cells[0]),
        id: `${itemId}-outcome`,
        itemId,
        fieldId: 'outcome'
      })
    const sourceChecks = table.itemIds.map((itemId) => ({
      itemId,
      sourceKey: 'source',
      status: itemId === 'third' ? 'missing' : 'available'
    }))
    const command = page(table, vi.fn().mockResolvedValue({ tables: [table], sourceChecks }))
    const matrixSelections = screen.getAllByRole('checkbox', { name: 'Select {{title}}' })
    fireEvent.click(matrixSelections[0])
    fireEvent.click(matrixSelections[2])
    fireEvent.keyDown(screen.getByRole('button', { name: 'Re-extract a column' }), {
      key: 'ArrowDown'
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Outcome' }))
    const dialog = await screen.findByRole('dialog', { name: 'Confirm rerun scope' })
    expect(within(dialog).queryByText(/Pending extraction scope:/)).toBeNull()
    await within(dialog).findByText(/Ready cells: 1/)
    expect(within(dialog).getByText('Waiting for source: 1')).toBeTruthy()
    expect(translate).toHaveBeenCalledWith('Rerun scope: {{selected}} × 1 (references × fields)', {
      selected: 2
    })
    expect(within(dialog).getByText(/Rerun scope:/).textContent).toContain('Outcome')
    const scopeSelections = within(dialog).getAllByRole('checkbox', {
      name: 'Select {{title}} for rerun'
    }) as HTMLInputElement[]
    expect(scopeSelections.map((checkbox) => checkbox.checked)).toEqual([true, false, true])
    fireEvent.click(scopeSelections[2])
    expect(translate).toHaveBeenCalledWith('Rerun scope: {{selected}} × 1 (references × fields)', {
      selected: 1
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(matrixSelections.map((checkbox) => (checkbox as HTMLInputElement).checked)).toEqual([
      true,
      false,
      true
    ])
    fireEvent.click(columnMenuItem('Rerun column', 1))
    const start = await screen.findByRole('button', { name: 'Confirm and start' })
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(start)
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        action: 'rerun-field',
        tableId: 'table',
        fieldId: 'outcome',
        itemIds: ['paper', 'third'],
        expectedRevision: table.revision,
        expectedSources: sourceChecks.map(({ itemId, sourceKey }) => ({ itemId, sourceKey }))
      })
    )
  })

  it('reruns the selected references in the chosen column', async () => {
    const table = fixture()
    const command = page(
      table,
      vi.fn().mockResolvedValue({
        tables: [table],
        sourceChecks: [{ itemId: 'paper', sourceKey: 'source', status: 'available' }]
      })
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select {{title}}' }))
    fireEvent.click(columnMenuItem('Rerun column'))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and start' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        action: 'rerun-field',
        tableId: 'table',
        fieldId: 'field',
        itemIds: ['paper'],
        expectedRevision: table.revision,
        expectedSources: [{ itemId: 'paper', sourceKey: 'source' }]
      })
    )
  })
  it('exports evidence through the shared file save boundary', async () => {
    const table = fixture()
    const command = vi
      .fn()
      .mockResolvedValue({ tables: [table], csv: 'item,evidence\npaper,42 adults' })
    page(table, command)
    chooseTableAction('Export')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Export matrix CSV' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Export evidence CSV' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export {{count}} CSV files' }))
    await waitFor(() =>
      expect(saveBlobFile).toHaveBeenCalledWith(
        expect.objectContaining({
          suggestedName: 'Evidence-evidence.csv',
          mimeType: 'text/csv;charset=utf-8'
        })
      )
    )
    expect(command).toHaveBeenCalledWith({
      action: 'export',
      tableId: 'table',
      kind: 'evidence',
      releaseOnComplete: true
    })
  })
  it('keeps machine values separate from manual drafts and binds machine confirmation to its attempt', async () => {
    const table = fixture()
    const command = vi.fn().mockResolvedValue({ tables: [table] })
    render(
      <ComparisonCellReview
        tableId="table"
        sourceKey="source"
        cell={table.cells[0]}
        field={table.fields[0]}
        onClose={vi.fn()}
        onOpenItem={vi.fn()}
        command={command}
      />
    )
    expect(screen.queryByRole('textbox', { name: 'Manual value' })).toBeNull()
    fireEvent.click(
      screen.getByRole('button', {
        name: /^(Confirm value|Confirm result|Confirm revision)$/
      })
    )
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'edit-cell',
          value: '42 adults',
          confirmed: true,
          expectedAttemptId: 'attempt',
          expectedFieldVersion: 1,
          expectedSourceKey: 'source'
        })
      )
    )
  })
  it.each(['first draft', 'source change', 'rerun', 'rule change'] as const)(
    'explains manual review without inventing a rule change after %s',
    (reason) => {
      const table = fixture()
      table.cells[0].manual = {
        value: 'Manual correction',
        confirmed: false,
        fieldVersion: 1,
        sourceKey: reason === 'source change' ? 'old-source' : 'source',
        ...(reason === 'first draft'
          ? {}
          : { attemptId: reason === 'rerun' ? 'old-attempt' : 'attempt' }),
        updatedAt: '2026-11-06'
      }
      if (reason === 'source change') table.cells[0].history[0].sourceKey = 'old-source'
      if (reason === 'rule change') table.fields[0].version = 2
      render(
        <ComparisonCellReview
          tableId={table.id}
          sourceKey="source"
          cell={table.cells[0]}
          field={table.fields[0]}
          onClose={vi.fn()}
          onOpenItem={vi.fn()}
          command={vi.fn()}
        />
      )
      const ruleWarning = 'Rule changed. Review the saved manual value again.'
      if (reason === 'rule change') {
        expect(screen.getByText(ruleWarning)).toBeTruthy()
        expect(screen.queryByText('Needs review')).toBeNull()
      } else {
        expect(screen.queryByText(ruleWarning)).toBeNull()
        expect(screen.getByText('Needs review')).toBeTruthy()
      }
      expect(
        (screen.getByRole('textbox', { name: 'Manual value' }) as HTMLTextAreaElement).value
      ).toBe('Manual correction')
      expect(
        (screen.getByRole('button', { name: 'Confirm value' }) as HTMLButtonElement).disabled
      ).toBe(reason === 'source change' || reason === 'rule change')
    }
  )
  it('rebinds a saved manual confirmation to the latest attempt after a same-value rerun', async () => {
    const table = fixture()
    table.cells[0].manual = {
      value: '42 adults',
      confirmed: false,
      fieldVersion: 1,
      sourceKey: 'source',
      attemptId: 'old-attempt',
      updatedAt: '2026-11-06'
    }
    const command = vi.fn().mockResolvedValue({ tables: [table] })
    render(
      <ComparisonCellReview
        tableId="table"
        sourceKey="source"
        cell={table.cells[0]}
        field={table.fields[0]}
        onClose={vi.fn()}
        onOpenItem={vi.fn()}
        command={command}
      />
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: /^(Confirm value|Confirm result|Confirm revision)$/
      })
    )
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({
          value: '42 adults',
          confirmed: true,
          expectedAttemptId: 'attempt'
        })
      )
    )
  })
  it('blocks export and review dismissal until all queued manual drafts are saved', async () => {
    const table = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const command = vi.fn(async () => {
      await gate
      return { tables: [table] }
    })
    page(table, command)
    fireEvent.click(screen.getByRole('button', { name: /42 adults/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
    const input = screen.getByRole('textbox', { name: 'Manual value' })
    for (const value of ['A', 'AB', 'ABC']) fireEvent.change(input, { target: { value } })
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull()
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      release()
    })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(exportDisabled()).toBe(false)
    expect(command).toHaveBeenCalledTimes(1)
    expect(command).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'edit-cell', value: 'ABC', confirmed: false })
    )
  })
  it.each([
    ['source', 'reject'],
    ['source', 'resolve'],
    ['field', 'reject'],
    ['field', 'resolve']
  ] as const)(
    'retains a queued draft after a %s refresh and %s, then allows recovery and navigation',
    async (revision, outcome) => {
      const table = fixture()
      table.members.push({ ...table.members[0], itemId: 'other', title: 'Other paper' })
      table.itemIds.push('other')
      table.cells.push({
        ...table.cells[0],
        id: 'other-cell',
        itemId: 'other',
        history: [{ ...table.cells[0].history[0], id: 'other-attempt', value: 'Other population' }]
      })
      let resolveSave!: () => void
      let rejectSave!: (error: Error) => void
      const deferred = new Promise<void>((resolve, reject) => {
        resolveSave = resolve
        rejectSave = reject
      })
      const command = vi
        .fn()
        .mockImplementationOnce(async () => {
          await deferred
          return { tables: [table] }
        })
        .mockResolvedValue({ tables: [table], csv: 'item,value', exportToken: 'saved-drafts' })
      const props = {
        command,
        onChooseReferences: vi.fn(),
        onOpenItem: vi.fn(),
        onOpenDiscovery: vi.fn(),
        onOpenComparison: vi.fn()
      }
      const { rerender } = render(<LiteratureComparisonPage table={table} {...props} />)
      chooseTableAction('Table settings')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      fireEvent.click(screen.getByRole('button', { name: /42 adults/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Manual value' }), {
        target: { value: 'Retained clinical correction' }
      })
      await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
      const revised = structuredClone(table)
      if (revision === 'source') revised.members[0].sourceKey = 'source-revised'
      else revised.fields[0].version = 2
      revised.cells[0].status = 'pending'
      rerender(<LiteratureComparisonPage table={revised} {...props} />)
      expect(
        (screen.getByRole('textbox', { name: 'Manual value' }) as HTMLTextAreaElement).value
      ).toBe('Retained clinical correction')
      expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
        true
      )
      expect(screen.queryByRole('button', { name: 'Confirm revision' })).toBeNull()
      expect(
        (screen.getByRole('button', { name: 'Extract this cell' }) as HTMLButtonElement).disabled
      ).toBe(true)
      await act(async () => {
        if (outcome === 'reject') rejectSave(new Error('comparison-review-changed'))
        else resolveSave()
      })
      if (outcome === 'reject') {
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
        expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
          true
        )
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
        expect(command).toHaveBeenLastCalledWith(
          expect.objectContaining({
            action: 'edit-cell',
            value: 'Retained clinical correction',
            confirmed: false,
            expectedFieldVersion: revision === 'field' ? 2 : 1,
            expectedSourceKey: revision === 'source' ? 'source-revised' : 'source'
          })
        )
      }
      await waitFor(() =>
        expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
          false
        )
      )
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
      expect(
        (screen.getByRole('textbox', { name: 'Manual value' }) as HTMLTextAreaElement).value
      ).toBe('Retained clinical correction')
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      fireEvent.click(screen.getByRole('button', { name: /Other population/ }))
      expect(screen.getByRole('dialog', { name: 'Review cell' }).textContent).toContain(
        'Other paper'
      )
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      chooseTableAction('Export')
      fireEvent.click(screen.getByRole('checkbox', { name: 'Export evidence CSV' }))
      fireEvent.click(screen.getByRole('button', { name: 'Export {{count}} CSV files' }))
      await waitFor(() =>
        expect(command).toHaveBeenLastCalledWith({
          action: 'export',
          tableId: 'table',
          kind: 'evidence',
          releaseOnComplete: true,
          exportToken: 'saved-drafts'
        })
      )
    }
  )
  it('keeps queued saves bound to the rule and source present when each edit was made', async () => {
    const table = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const command = vi.fn(async () => {
      await gate
      return { tables: [table] }
    })
    const props = { command, onClose: vi.fn(), onOpenItem: vi.fn(), tableId: table.id }
    const { rerender } = render(
      <ComparisonCellReview
        {...props}
        cell={table.cells[0]}
        field={table.fields[0]}
        sourceKey="source"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual value' }), {
      target: { value: 'A' }
    })
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual value' }), {
      target: { value: 'AB' }
    })
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    rerender(
      <ComparisonCellReview
        {...props}
        cell={table.cells[0]}
        field={{ ...table.fields[0], version: 2 }}
        sourceKey="new-source"
      />
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual value' }), {
      target: { value: 'ABC' }
    })
    await act(async () => {
      release()
    })
    await waitFor(() => expect(command).toHaveBeenCalledTimes(3))
    expect(command).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        value: 'A',
        confirmed: false,
        expectedFieldVersion: 1,
        expectedSourceKey: 'source'
      })
    )
    expect(command).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        value: 'AB',
        confirmed: false,
        expectedFieldVersion: 1,
        expectedSourceKey: 'source'
      })
    )
    expect(command).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        value: 'ABC',
        confirmed: false,
        expectedFieldVersion: 2,
        expectedSourceKey: 'new-source'
      })
    )
  })
  it.each(['abstract', 'full-text', 'passages'] as const)(
    'opens %s evidence using its explicit recorded target rather than sourceKey',
    (coverage) => {
      const table = fixture()
      const attempt = table.cells[0].history[0]
      attempt.coverage = coverage
      attempt.sourceKey = JSON.stringify(['paper', 'unrelated-pdf', 9])
      attempt.attachmentVersionId = 'recorded-version'
      attempt.evidence = [{ quote: 'Evidence', pageStart: 7, pageEnd: 8 }]
      const onOpenItem = vi.fn()
      render(
        <ComparisonCellReview
          tableId={table.id}
          cell={table.cells[0]}
          field={table.fields[0]}
          sourceKey="source"
          command={vi.fn()}
          onClose={vi.fn()}
          onOpenItem={onOpenItem}
        />
      )
      fireEvent.click(
        screen.getByRole('button', {
          name: coverage === 'abstract' ? 'Open reference' : 'Open source page'
        })
      )
      expect(onOpenItem).toHaveBeenCalledWith(
        coverage === 'abstract'
          ? { kind: 'reference', itemId: 'paper' }
          : { kind: 'document', itemId: 'paper', attachmentVersionId: 'recorded-version', page: 7 }
      )
    }
  )
  it('labels legacy full-text evidence as a reference when no attachment version was recorded', () => {
    const table = fixture()
    table.cells[0].history[0].coverage = 'full-text'
    table.cells[0].history[0].sourceKey = JSON.stringify(['paper', 'current-pdf'])
    const onOpenItem = vi.fn()
    render(
      <ComparisonCellReview
        tableId={table.id}
        cell={table.cells[0]}
        field={table.fields[0]}
        sourceKey="source"
        command={vi.fn()}
        onClose={vi.fn()}
        onOpenItem={onOpenItem}
      />
    )
    expect(screen.queryByRole('button', { name: 'Open source page' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open reference' }))
    expect(onOpenItem).toHaveBeenCalledWith({ kind: 'reference', itemId: 'paper' })
  })
  it('invalidates confirmation after source or machine attempt changes', () => {
    const table = fixture()
    table.cells[0].manual = {
      value: '42 adults',
      confirmed: true,
      fieldVersion: 1,
      sourceKey: 'old-source',
      attemptId: 'old-attempt',
      updatedAt: '2026-11-06'
    }
    expect(comparisonCellView(table.cells[0], table.fields[0], 'source')).toMatchObject({
      confirmed: false,
      needsReview: true
    })
    expect(
      comparisonCellView(table.cells[0], { ...table.fields[0], version: 2 }, 'source').stale
    ).toBe(true)
  })
  it('retains a manual value after rule changes while requiring review again', () => {
    const table = fixture()
    table.cells[0].manual = {
      value: 'Manual correction',
      confirmed: true,
      fieldVersion: 1,
      sourceKey: 'source',
      updatedAt: '2026-11-06'
    }
    expect(comparisonCellView(table.cells[0], { ...table.fields[0], version: 2 })).toMatchObject({
      value: 'Manual correction',
      confirmed: false,
      needsReview: true
    })
  })
  it.each([undefined, 'Earlier manual value'])(
    'confirms the authoritative read-cell manual instead of stale parent value %s',
    async (staleValue) => {
      const table = fixture()
      const manual = {
        value: 'Latest saved manual',
        confirmed: false,
        fieldVersion: 1,
        sourceKey: 'source',
        updatedAt: 'now'
      }
      const cell = {
        ...table.cells[0],
        ...(staleValue ? { manual: { ...manual, value: staleValue } } : {})
      }
      const command = vi.fn().mockResolvedValue({ tables: [] })
      render(
        <ComparisonCellReview
          tableId={table.id}
          sourceKey="source"
          cell={cell}
          field={table.fields[0]}
          command={command}
          onClose={vi.fn()}
          onOpenItem={vi.fn()}
          loadCellHistory={vi.fn().mockResolvedValue({ ...cell, manual })}
        />
      )
      await waitFor(() =>
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(manual.value)
      )
      fireEvent.click(
        screen.getByRole('button', {
          name: /^(Confirm value|Confirm result|Confirm revision)$/
        })
      )
      await waitFor(() =>
        expect(command).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'edit-cell',
            value: manual.value,
            confirmed: true,
            expectedAttemptId: 'attempt'
          })
        )
      )
    }
  )
  it.each(['running', 'succeeded'] as const)(
    'uses saved confirmation and status %s returned by read-cell',
    async (status) => {
      const table = fixture()
      const cell = table.cells[0]
      render(
        <ComparisonCellReview
          tableId={table.id}
          sourceKey="source"
          cell={cell}
          field={table.fields[0]}
          command={vi.fn()}
          onClose={vi.fn()}
          onOpenItem={vi.fn()}
          loadCellHistory={vi.fn().mockResolvedValue({
            ...cell,
            status,
            manual: {
              value: 'Saved confirmation',
              confirmed: true,
              fieldVersion: 1,
              sourceKey: 'source',
              attemptId: 'attempt',
              updatedAt: 'now'
            }
          })}
        />
      )
      await waitFor(() =>
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
          'Saved confirmation'
        )
      )
      if (status === 'running') {
        expect(
          (screen.getByRole('button', { name: 'Confirm value' }) as HTMLButtonElement).disabled
        ).toBe(true)
      } else {
        expect(screen.getByRole('status').textContent).toBe('Confirmed')
        expect(screen.queryByRole('button', { name: 'Confirmed' })).toBeNull()
        expect(
          screen.getByRole('button', { name: 'Adopt latest machine value and confirm evidence' })
        ).toBeTruthy()
      }
    }
  )
  it('revalidates a changed persisted base and hydrates the still pristine draft', async () => {
    const table = fixture()
    const initial = {
      ...table.cells[0],
      status: 'running' as const,
      manual: {
        value: 'Earlier saved manual',
        confirmed: false,
        fieldVersion: 1,
        sourceKey: 'source',
        updatedAt: 'earlier'
      }
    }
    const updated = {
      ...initial,
      status: 'succeeded' as const,
      manual: { ...initial.manual, value: 'Latest saved manual', updatedAt: 'later' }
    }
    let resolve!: (cell: typeof updated) => void
    const loadCellHistory = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
    const props = {
      tableId: table.id,
      sourceKey: 'source',
      field: table.fields[0],
      command: vi.fn(),
      onClose: vi.fn(),
      onOpenItem: vi.fn(),
      loadCellHistory
    }
    const { rerender } = render(<ComparisonCellReview {...props} cell={initial} />)
    await waitFor(() =>
      expect(screen.getByText('42 adults', { selector: 'blockquote p' })).toBeTruthy()
    )
    rerender(<ComparisonCellReview {...props} cell={updated} />)
    expect(
      (
        screen.getByRole('button', {
          name: /^(Confirm value|Confirm result|Confirm revision)$/
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(loadCellHistory).toHaveBeenCalledTimes(2)
    await act(async () => {
      resolve(updated)
    })
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Latest saved manual')
    expect(
      (
        screen.getByRole('button', {
          name: /^(Confirm value|Confirm result|Confirm revision)$/
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })
  it('preserves newly typed and queued local drafts when read-cell returns an older saved manual', async () => {
    const table = fixture()
    const cell = table.cells[0]
    let resolveHistory!: (value: typeof cell) => void
    let resolveSave!: () => void
    const command = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSave = resolve
          })
      )
      .mockResolvedValue({ tables: [] })
    render(
      <ComparisonCellReview
        tableId={table.id}
        sourceKey="source"
        cell={cell}
        field={table.fields[0]}
        command={command}
        onClose={vi.fn()}
        onOpenItem={vi.fn()}
        loadCellHistory={vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveHistory = resolve
            })
        )}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Typed draft' } })
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Queued newer draft' } })
    await act(async () => {
      resolveHistory({
        ...cell,
        manual: {
          value: 'Older saved manual',
          confirmed: false,
          fieldVersion: 1,
          sourceKey: 'source',
          updatedAt: 'now'
        }
      })
    })
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Queued newer draft')
    expect(
      (
        screen.getByRole('button', {
          name: /^(Confirm value|Confirm result|Confirm revision)$/
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    await act(async () => {
      resolveSave()
    })
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    fireEvent.click(
      screen.getByRole('button', {
        name: /^(Confirm value|Confirm result|Confirm revision)$/
      })
    )
    await waitFor(() =>
      expect(command).toHaveBeenLastCalledWith(
        expect.objectContaining({
          value: 'Queued newer draft',
          confirmed: true
        })
      )
    )
  })
  it('loads full history before confirmation and preserves the draft after projection refresh', async () => {
    const table = fixture()
    const cell = table.cells[0]
    let resolve!: (value: typeof cell) => void
    const loadCellHistory = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      .mockResolvedValue(cell)
    const command = vi.fn().mockResolvedValue({ tables: [table] })
    const props = {
      tableId: table.id,
      sourceKey: 'source',
      field: table.fields[0],
      command,
      onClose: vi.fn(),
      onOpenItem: vi.fn(),
      loadCellHistory
    }
    const { rerender } = render(
      <ComparisonCellReview
        {...props}
        cell={{ ...cell, history: [{ ...cell.history[0], evidence: [] }] }}
      />
    )
    expect(
      (
        screen.getByRole('button', {
          name: /^(Confirm value|Confirm result|Confirm revision)$/
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My draft' } })
    await act(async () => {
      resolve(cell)
    })
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: /^(Confirm value|Confirm result|Confirm revision)$/
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    )
    expect(screen.getByText('42 adults', { selector: 'blockquote p' })).toBeTruthy()
    rerender(
      <ComparisonCellReview
        {...props}
        cell={{
          ...cell,
          manual: {
            value: 'Earlier server draft',
            confirmed: false,
            fieldVersion: 1,
            sourceKey: 'source',
            updatedAt: 'now'
          }
        }}
      />
    )
    expect(loadCellHistory).toHaveBeenCalledTimes(1)
    expect(screen.getByText('42 adults', { selector: 'blockquote p' })).toBeTruthy()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('My draft')
  })
  it('blocks confirmation when a new machine attempt invalidates loaded evidence', async () => {
    const table = fixture()
    const loadCellHistory = vi
      .fn()
      .mockResolvedValueOnce(table.cells[0])
      .mockImplementation(() => new Promise(() => {}))
    const props = {
      tableId: table.id,
      sourceKey: 'source',
      field: table.fields[0],
      command: vi.fn(),
      onClose: vi.fn(),
      onOpenItem: vi.fn(),
      loadCellHistory
    }
    const { rerender } = render(<ComparisonCellReview {...props} cell={table.cells[0]} />)
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: /^(Confirm value|Confirm result|Confirm revision)$/
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    )
    rerender(
      <ComparisonCellReview
        {...props}
        cell={{
          ...table.cells[0],
          history: [{ ...table.cells[0].history[0], id: 'new-attempt', evidence: [] }]
        }}
      />
    )
    expect(
      (
        screen.getByRole('button', {
          name: /^(Confirm value|Confirm result|Confirm revision)$/
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(screen.queryByText('42 adults', { selector: 'blockquote p' })).toBeNull()
  })
  it('offers retry after history failure and blocks confirmation until recovery', async () => {
    const table = fixture()
    const loadCellHistory = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(table.cells[0])
    render(
      <ComparisonCellReview
        tableId={table.id}
        sourceKey="source"
        cell={table.cells[0]}
        field={table.fields[0]}
        command={vi.fn()}
        onClose={vi.fn()}
        onOpenItem={vi.fn()}
        loadCellHistory={loadCellHistory}
      />
    )
    expect(await screen.findByText('Evidence history could not be loaded.')).toBeTruthy()
    expect(
      (
        screen.getByRole('button', {
          name: /^(Confirm value|Confirm result|Confirm revision)$/
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: /^(Confirm value|Confirm result|Confirm revision)$/
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    )
  })
  it('exports only the matrix by default and restores focus after saving', async () => {
    const command = page(
      fixture(),
      vi.fn().mockResolvedValue({ tables: [], csv: 'matrix', exportToken: 'shared' })
    )
    const trigger = screen.getByRole('button', { name: 'More actions' })
    chooseTableAction('Export')
    expect(
      (screen.getByRole('checkbox', { name: 'Export matrix CSV' }) as HTMLInputElement).checked
    ).toBe(true)
    expect(
      (screen.getByRole('checkbox', { name: 'Export evidence CSV' }) as HTMLInputElement).checked
    ).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Export {{count}} CSV files' }))
    await waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce())
    expect(command).toHaveBeenCalledExactlyOnceWith({
      action: 'export',
      tableId: 'table',
      kind: 'matrix',
      releaseOnComplete: true
    })
    expect(saveBlobFile.mock.calls[0][0].suggestedName).toBe('Evidence-matrix.csv')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('protects an active export from dismissal and conflicting page commands, then keeps cancelled choices', async () => {
    const table = fixture()
    let release!: (result: ComparisonResult) => void
    const command = vi.fn(
      () =>
        new Promise<ComparisonResult>((resolve) => {
          release = resolve
        })
    )
    const status = vi.fn()
    render(
      <LiteratureComparisonPage
        table={table}
        command={command}
        onDraftStatusChange={status}
        onChooseReferences={vi.fn()}
        onOpenItem={vi.fn()}
        onOpenDiscovery={vi.fn()}
        onOpenComparison={vi.fn()}
      />
    )
    const trigger = screen.getByRole('button', { name: 'More actions' })
    const moreActions = screen.getByRole('button', { name: 'More actions' }) as HTMLButtonElement
    chooseTableAction('Export')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Export evidence CSV' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export {{count}} CSV files' }))
    expect(status).toHaveBeenLastCalledWith({ pending: true, failed: false })
    const dialog = screen.getByRole('dialog')
    expect(
      (within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(moreActions.disabled).toBe(true)
    fireEvent.click(moreActions)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(command).toHaveBeenCalledOnce()
    saveBlobFile.mockResolvedValueOnce({ saved: false })
    await act(async () => release({ tables: [], csv: 'first', exportToken: 'shared' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    await act(async () => release({ tables: [], csv: 'second', exportToken: 'shared' }))
    await waitFor(() => expect(status).toHaveBeenLastCalledWith({ pending: false, failed: false }))
    expect(
      (screen.getByRole('checkbox', { name: 'Export evidence CSV' }) as HTMLInputElement).checked
    ).toBe(true)
    expect(moreActions.disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('requires the review drawer to close before opening export', () => {
    page(fixture())
    fireEvent.click(screen.getByRole('button', { name: /42 adults/ }))
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    chooseTableAction('Export')
    expect(screen.getByRole('dialog', { name: 'Export comparison results' })).toBeTruthy()
  })
  it('exports both selected files from the same snapshot and reports the selected file count', async () => {
    const command = page(
      fixture(),
      vi.fn().mockResolvedValue({ tables: [], csv: 'same snapshot', exportToken: 'shared' })
    )
    chooseTableAction('Export')
    expect(screen.getByRole('heading', { name: 'Export comparison results' })).toBeTruthy()
    expect(translate).toHaveBeenCalledWith(
      '{{references}} references, {{fields}} fields. CSV (UTF-8).',
      { references: 1, fields: 1 }
    )
    expect(translate).toHaveBeenCalledWith('Export {{count}} CSV files', {
      count: 1,
      defaultValue_one: 'Export {{count}} CSV file'
    })
    expect(
      (screen.getByRole('checkbox', { name: 'Export matrix CSV' }) as HTMLInputElement).checked
    ).toBe(true)
    expect(
      (screen.getByRole('checkbox', { name: 'Export evidence CSV' }) as HTMLInputElement).checked
    ).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Export evidence CSV' }))
    expect(translate).toHaveBeenCalledWith('Export {{count}} CSV files', {
      count: 2,
      defaultValue_one: 'Export {{count}} CSV file'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Export {{count}} CSV files' }))
    await waitFor(() => expect(saveBlobFile).toHaveBeenCalledTimes(2))
    expect(command.mock.calls.map(([request]) => request)).toEqual([
      { action: 'export', tableId: 'table', kind: 'matrix' },
      {
        action: 'export',
        tableId: 'table',
        kind: 'evidence',
        releaseOnComplete: true,
        exportToken: 'shared'
      }
    ])
  })

  it('does not save either CSV when preparing the second CSV fails', async () => {
    const command = page(
      fixture(),
      vi
        .fn()
        .mockResolvedValueOnce({ tables: [], csv: 'matrix', exportToken: 'shared' })
        .mockRejectedValueOnce(new Error('expired'))
    )
    chooseTableAction('Export')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Export evidence CSV' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export {{count}} CSV files' }))
    expect(await screen.findByText('Could not export comparison results. Try again.')).toBeTruthy()
    expect(command).toHaveBeenCalledTimes(2)
    expect(saveBlobFile).not.toHaveBeenCalled()
  })

  it.each([1, 2])(
    'stops saving and reports partial progress when save %s is cancelled',
    async (cancelAt) => {
      if (cancelAt === 2) saveBlobFile.mockResolvedValueOnce({ saved: true })
      saveBlobFile.mockResolvedValueOnce({ saved: false })
      page(
        fixture(),
        vi.fn().mockResolvedValue({ tables: [], csv: 'snapshot', exportToken: 'shared' })
      )
      chooseTableAction('Export')
      fireEvent.click(screen.getByRole('checkbox', { name: 'Export evidence CSV' }))
      fireEvent.click(screen.getByRole('button', { name: 'Export {{count}} CSV files' }))
      await waitFor(() => expect(saveBlobFile).toHaveBeenCalledTimes(cancelAt))
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'Export {{count}} CSV files' }) as HTMLButtonElement)
            .disabled
        ).toBe(false)
      )
      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(translate).toHaveBeenCalledWith('Saved {{saved}} of {{total}} CSV files.', {
        saved: cancelAt - 1,
        total: 2
      })
    }
  )

  it('keeps partial save progress and selected files after the second save fails', async () => {
    saveBlobFile
      .mockResolvedValueOnce({ saved: true })
      .mockRejectedValueOnce(new Error('disk full'))
    page(
      fixture(),
      vi.fn().mockResolvedValue({ tables: [], csv: 'snapshot', exportToken: 'shared' })
    )
    chooseTableAction('Export')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Export evidence CSV' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export {{count}} CSV files' }))
    expect(await screen.findByText('Could not export comparison results. Try again.')).toBeTruthy()
    expect(translate).toHaveBeenCalledWith('Saved {{saved}} of {{total}} CSV files.', {
      saved: 1,
      total: 2
    })
    expect(
      (screen.getByRole('checkbox', { name: 'Export evidence CSV' }) as HTMLInputElement).checked
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Export {{count}} CSV files' }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })

  it('joins immutable export chunks before saving and never saves a failed partial export', async () => {
    const table = fixture()
    const command = vi
      .fn()
      .mockResolvedValueOnce({
        tables: [],
        csv: 'header\n',
        exportToken: 'snapshot',
        nextOffset: 7
      })
      .mockResolvedValueOnce({ tables: [], csv: 'row\n', exportToken: 'snapshot' })
    page(table, command)
    chooseTableAction('Export')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Export matrix CSV' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Export evidence CSV' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export {{count}} CSV files' }))
    await waitFor(() => expect(saveBlobFile).toHaveBeenCalledTimes(1))
    expect(command.mock.calls[1][0]).toEqual({
      action: 'export',
      tableId: 'table',
      kind: 'evidence',
      releaseOnComplete: true,
      offset: 7,
      exportToken: 'snapshot'
    })
    expect(new TextDecoder().decode(saveBlobFile.mock.calls[0][0].data)).toBe('header\nrow\n')
    saveBlobFile.mockClear()
    command
      .mockResolvedValueOnce({ tables: [], csv: 'partial', exportToken: 'next', nextOffset: 7 })
      .mockRejectedValueOnce(new Error('expired'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    chooseTableAction('Export')
    fireEvent.click(screen.getByRole('button', { name: 'Export {{count}} CSV files' }))
    expect(await screen.findByText('Could not export comparison results. Try again.')).toBeTruthy()
    expect(saveBlobFile).not.toHaveBeenCalled()
  })
  it.each([
    [
      'abstract-unavailable',
      'abstract',
      'Add an abstract to the reference, or change the source policy to require full text. Then retry this cell.'
    ],
    [
      'source-unavailable',
      'full-text',
      'Restore the source or check the reference, then retry this cell.'
    ],
    ['source-changed', 'abstract', 'The source changed. Rerun this cell and review its evidence.'],
    [
      'full-text-insufficient',
      'full-text',
      'The source has too little readable text. Check the source, then retry this cell.'
    ]
  ] as const)('explains unavailable source %s accurately', (issue, policy, message) => {
    const table = fixture()
    table.sourcePolicy = policy
    table.cells[0].status = 'unavailable'
    table.cells[0].history[0].issue = issue
    page(table)
    expect(screen.getByText(message)).toBeTruthy()
    expect(
      screen.queryByText('Full text is required. Add a PDF to the reference, then retry this cell.')
    ).toBeNull()
  })
})

describe('pending comparison candidates', () => {
  it('filters later candidates and submits a first-extraction batch after source confirmation', async () => {
    const table = fixture()
    table.cells[0].manual = {
      value: '42 adults',
      confirmed: true,
      fieldVersion: 1,
      sourceKey: 'source',
      attemptId: 'attempt',
      updatedAt: 'saved'
    }
    table.itemIds.push('reviewed')
    table.members.push({ ...table.members[0], itemId: 'reviewed', title: 'Reviewed report' })
    table.cells.push({ ...table.cells[0], id: 'reviewed-cell', itemId: 'reviewed' })
    const command = vi.fn().mockResolvedValue({
      tables: [table],
      sourceChecks: ['paper', 'reviewed', 'candidate', 'mixed'].map((itemId) => ({
        itemId,
        sourceKey: 'source',
        status: 'available'
      }))
    })
    const props = {
      command,
      onChooseReferences: vi.fn(),
      onOpenItem: vi.fn(),
      onOpenDiscovery: vi.fn(),
      onOpenComparison: vi.fn()
    }
    const { rerender } = render(<LiteratureComparisonPage table={table} {...props} />)
    selectFilter('pending')
    expect(screen.getByText('No references awaiting extraction.')).toBeTruthy()
    const updated = structuredClone(table)
    updated.revision++
    updated.itemIds.push('candidate')
    updated.members.push({ ...table.members[0], itemId: 'candidate', title: 'Later candidate' })
    updated.cells.push({
      id: 'candidate-cell',
      itemId: 'candidate',
      fieldId: 'field',
      status: 'pending',
      history: []
    })
    updated.fields.push({ id: 'outcome', name: 'Outcome', rule: 'Report outcome', version: 1 })
    for (const itemId of table.itemIds)
      updated.cells.push({
        ...structuredClone(table.cells[0]),
        id: `${itemId}-outcome`,
        itemId,
        fieldId: 'outcome'
      })
    updated.cells.push({
      id: 'candidate-outcome',
      itemId: 'candidate',
      fieldId: 'outcome',
      status: 'pending',
      history: []
    })
    updated.itemIds.push('mixed')
    updated.members.push({ ...table.members[0], itemId: 'mixed', title: 'Mixed report' })
    updated.cells.push(
      { ...structuredClone(table.cells[0]), id: 'mixed-field', itemId: 'mixed' },
      {
        id: 'mixed-outcome',
        itemId: 'mixed',
        fieldId: 'outcome',
        status: 'pending',
        history: []
      }
    )
    rerender(<LiteratureComparisonPage table={updated} {...props} />)
    expect(screen.getByText('Later candidate')).toBeTruthy()
    expect(screen.getByText('Mixed report')).toBeTruthy()
    expect(screen.queryByText('Reviewed report')).toBeNull()
    expect(screen.queryByText('No references awaiting extraction.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Extract pending references/ }))
    const start = await screen.findByRole('button', { name: 'Confirm and start' })
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByText(/Ready cells:/).textContent).toContain('Ready cells: 3')
    const scope = within(screen.getByRole('dialog'))
    expect(scope.getAllByRole('definition').map((el) => el.textContent)).toEqual(['2', '2', '3'])
    fireEvent.click(start)
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        action: 'run',
        tableId: 'table',
        itemIds: ['candidate', 'mixed'],
        expectedRevision: updated.revision,
        expectedSources: ['paper', 'reviewed', 'candidate', 'mixed'].map((itemId) => ({
          itemId,
          sourceKey: 'source'
        }))
      })
    )
  })
  it('lets a reopened completed sample select the confirmed reference before bulk preflight', async () => {
    const table = fixture()
    table.state = 'completed'
    table.taskId = 'one-reference-sample'
    table.taskSources = [{ cellId: 'cell', sourceKey: 'source', fieldVersion: 1 }]
    table.cells[0].manual = {
      value: '42 adults',
      confirmed: true,
      fieldVersion: 1,
      sourceKey: 'source',
      attemptId: 'attempt',
      updatedAt: '2026-11-10'
    }
    table.members.push({
      itemId: 'repaired',
      title: 'Source now repaired',
      abstract: '42 adults',
      sourceKey: 'source'
    })
    table.itemIds.push('repaired')
    table.cells.push({
      id: 'repaired-cell',
      itemId: 'repaired',
      fieldId: 'field',
      status: 'pending',
      history: []
    })
    const command = page(
      table,
      vi.fn().mockResolvedValue({
        tables: [],
        sourceChecks: table.members.map(({ itemId, sourceKey }) => ({
          itemId,
          sourceKey,
          status: 'available'
        }))
      })
    )
    expect(screen.queryByRole('button', { name: /Extract pending references/ })).toBeNull()
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select {{title}}' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Use selection as sample' }))
    const bulk = screen.getByRole('button', {
      name: /Extract pending references/
    }) as HTMLButtonElement
    expect(bulk.disabled).toBe(false)
    fireEvent.click(bulk)
    const start = (await screen.findByRole('button', {
      name: 'Confirm and start'
    })) as HTMLButtonElement
    await waitFor(() => expect(start.disabled).toBe(false))
    expect(command).toHaveBeenCalledExactlyOnceWith({ action: 'check-sources', tableId: 'table' })
    fireEvent.click(start)
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        action: 'run',
        tableId: 'table',
        itemIds: ['repaired'],
        expectedRevision: 1,
        expectedSources: table.members.map(({ itemId, sourceKey }) => ({ itemId, sourceKey }))
      })
    )
  })

  it.each(['source', 'rule'] as const)(
    'preflights historical pending cells after a %s change even when the completed sample stays confirmed',
    async (change) => {
      const table = fixture()
      table.state = 'completed'
      table.taskId = 'finished-original-scope'
      const version = change === 'rule' ? 2 : 1
      table.fields[0].version = version
      table.fields.push({ id: 'outcome', name: 'Outcome', rule: 'Report outcome', version })
      const base = structuredClone(table.cells[0])
      table.members = ['paper', 'paper2', 'paper3', 'failed', 'unavailable', 'saved'].map(
        (itemId) => ({
          itemId,
          title: itemId,
          abstract: '42 adults',
          sourceKey: itemId === 'paper3' && change === 'source' ? 'new-source' : 'source'
        })
      )
      table.itemIds = table.members.map(({ itemId }) => itemId)
      table.cells = table.members.flatMap((member) =>
        table.fields.map((field) => ({
          ...structuredClone(base),
          id: `${member.itemId}-${field.id}`,
          itemId: member.itemId,
          fieldId: field.id,
          status:
            member.itemId === 'paper3'
              ? ('pending' as const)
              : member.itemId === 'failed'
                ? ('failed' as const)
                : member.itemId === 'unavailable'
                  ? ('unavailable' as const)
                  : ('succeeded' as const),
          history: [
            {
              ...structuredClone(base.history[0]),
              fieldVersion: member.itemId === 'paper3' ? 1 : version,
              ...(member.itemId === 'failed' ? { status: 'failed' as const, value: null } : {})
            }
          ],
          manual: {
            value: '42 adults',
            confirmed: member.itemId !== 'paper3',
            fieldVersion: member.itemId === 'paper3' ? 1 : version,
            sourceKey: 'source',
            attemptId: 'attempt',
            updatedAt: '2026-11-10'
          }
        }))
      )
      table.taskSources = table.cells.map((cell) => ({
        cellId: cell.id,
        sourceKey: 'source',
        fieldVersion: 1
      }))
      const before = structuredClone(table)
      const checks = table.members.map(({ itemId, sourceKey }) => ({
        itemId,
        sourceKey,
        status: 'available'
      }))
      const command = page(table, vi.fn().mockResolvedValue({ tables: [], sourceChecks: checks }))
      expect(screen.queryByRole('button', { name: 'Extract sample' })).toBeNull()
      const bulk = screen.getByRole('button', {
        name: 'Extract pending references (1)'
      }) as HTMLButtonElement
      expect(bulk.disabled).toBe(false)
      expect(translate).toHaveBeenCalledWith('Pending extraction: {{pending}}', { pending: 2 })
      expect(
        (screen.getByRole('button', { name: 'Extract remaining' }) as HTMLButtonElement).disabled
      ).toBe(false)
      selectFilter('pending')
      const matrix = screen.getByRole('table', { name: 'Comparison matrix' })
      expect(within(matrix).getByText('paper3')).toBeTruthy()
      for (const title of ['paper', 'paper2', 'failed', 'unavailable', 'saved'])
        expect(within(matrix).queryByText(title)).toBeNull()
      expect(command).not.toHaveBeenCalled()
      fireEvent.click(bulk)
      const confirm = (await screen.findByRole('button', {
        name: 'Confirm and start'
      })) as HTMLButtonElement
      await waitFor(() => expect(confirm.disabled).toBe(false))
      expect(command).toHaveBeenCalledExactlyOnceWith({ action: 'check-sources', tableId: 'table' })
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).toContain('Ready cells: 2')
      expect(
        within(dialog)
          .getAllByRole('definition')
          .map((el) => el.textContent)
      ).toEqual(['1', '2', '2'])
      expect(within(dialog).getByText('paper3')).toBeTruthy()
      expect(within(dialog).queryByText('paper')).toBeNull()
      expect(within(dialog).queryByText('paper2')).toBeNull()
      fireEvent.click(confirm)
      await waitFor(() =>
        expect(command).toHaveBeenLastCalledWith({
          action: 'run',
          tableId: 'table',
          itemIds: ['paper3'],
          expectedRevision: 1,
          expectedSources: table.members.map(({ itemId, sourceKey }) => ({ itemId, sourceKey }))
        })
      )
      expect(table).toEqual(before)
    }
  )

  it.each(['running', 'paused', 'interrupted'] as const)(
    'keeps a new remaining extraction unavailable during an existing %s task',
    (state) => {
      const table = fixture()
      table.state = state
      table.remainingCellIds = ['pending-cell']
      table.cells.push({
        id: 'pending-cell',
        itemId: 'paper',
        fieldId: 'field',
        status: 'pending',
        history: []
      })
      const command = page(table)
      expect(screen.queryByRole('button', { name: 'Extract remaining' })).toBeNull()
      expect(command).not.toHaveBeenCalled()
    }
  )

  it('keeps remaining extraction disabled while a manual sample correction is pending or failed', async () => {
    const table = fixture()
    table.cells[0].manual = {
      value: '42 adults',
      confirmed: true,
      fieldVersion: 1,
      sourceKey: 'source',
      attemptId: 'attempt',
      updatedAt: '2026-11-10'
    }
    table.itemIds.push('pending-paper')
    table.members.push({
      itemId: 'pending-paper',
      title: 'Pending paper',
      abstract: '42 adults',
      sourceKey: 'source'
    })
    table.cells.push({
      id: 'pending-cell',
      itemId: 'pending-paper',
      fieldId: 'field',
      status: 'pending',
      history: []
    })
    let reject!: (error: Error) => void
    const command = page(
      table,
      vi.fn(
        () =>
          new Promise<ComparisonResult>((_, fail) => {
            reject = fail
          })
      )
    )
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select {{title}}' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Use selection as sample' }))
    const remaining = screen.getByRole('button', { name: 'Extract remaining' }) as HTMLButtonElement
    expect(remaining.disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /42 adults/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual value' }), {
      target: { value: 'Protected correction' }
    })
    expect(remaining.disabled).toBe(true)
    await waitFor(() => expect(command).toHaveBeenCalledOnce())
    fireEvent.click(remaining)
    await act(async () => reject(new Error('offline')))
    expect(remaining.disabled).toBe(true)
    fireEvent.click(remaining)
    expect(command.mock.calls.every(([request]) => request.action === 'edit-cell')).toBe(true)
  })

  it('marks a previous source machine value for review in the main matrix without dropping it', () => {
    const table = fixture()
    table.members[0].sourceKey = 'new-source'
    table.cells[0].status = 'pending'
    page(table)
    const value = screen.getByRole('button', { name: /42 adults/ })
    expect(value.textContent).toContain('42 adults')
    expect(value.textContent).toContain('Needs review')
    expect(value.textContent).not.toContain('Machine result')
  })

  it('keeps first-extraction bulk disabled until the independent sample is reviewed', () => {
    const table = fixture()
    table.cells.push({
      id: 'new-field-cell',
      itemId: 'paper',
      fieldId: 'new-field',
      status: 'pending',
      history: []
    })
    table.fields.push({ id: 'new-field', name: 'Outcome', rule: 'Report outcome', version: 1 })
    const command = page(table)
    selectFilter('pending')
    expect(screen.getByText('Paper')).toBeTruthy()
    const bulk = screen.getByRole('button', {
      name: /Extract pending references/
    }) as HTMLButtonElement
    expect(bulk.disabled).toBe(true)
    fireEvent.click(bulk)
    expect(command).not.toHaveBeenCalled()
  })
  it('keeps candidates visible but preserves resume while a prior queue is paused', () => {
    const table = fixture()
    table.state = 'paused'
    table.remainingCellIds = ['cell']
    table.cells[0].status = 'pending'
    table.cells[0].history = []
    page(table)
    selectFilter('pending')
    expect(screen.getByText('Paper')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: /Extract pending references/ }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Continue {{count}} cells' }) as HTMLButtonElement)
        .disabled
    ).toBe(false)
  })
})

describe('comparison confirmation eligibility', () => {
  it.each(['pending', 'running', 'unavailable', 'failed'] as const)(
    'keeps %s cells editable but cannot confirm them without a current successful result',
    (status) => {
      const table = fixture()
      const cell = table.cells[0]
      cell.status = status
      cell.history =
        status === 'failed'
          ? [
              {
                ...cell.history[0],
                status: 'failed',
                value: null,
                evidence: [],
                issue: 'extraction-failed'
              }
            ]
          : []
      const command = vi.fn()
      render(
        <ComparisonCellReview
          tableId={table.id}
          sourceKey="source"
          cell={cell}
          field={table.fields[0]}
          command={command}
          onClose={vi.fn()}
          onOpenItem={vi.fn()}
        />
      )
      const confirm = screen.getByRole('button', { name: 'Confirm value' }) as HTMLButtonElement
      expect(confirm.disabled).toBe(true)
      fireEvent.click(confirm)
      expect(command).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
      expect(
        (screen.getByRole('textbox', { name: 'Manual value' }) as HTMLTextAreaElement).disabled
      ).toBe(false)
      expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    }
  )

  it('does not create a failed-save guard from confirming an untouched unavailable cell', async () => {
    const table = fixture()
    const cell = { ...table.cells[0], status: 'unavailable' as const, history: [] }
    const command = vi.fn().mockRejectedValue(new Error('source-unavailable'))
    const status = vi.fn()
    render(
      <ComparisonCellReview
        tableId={table.id}
        sourceKey="source"
        cell={cell}
        field={table.fields[0]}
        command={command}
        onClose={vi.fn()}
        onOpenItem={vi.fn()}
        onDraftStatusChange={status}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Confirm value' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(command).not.toHaveBeenCalled()
    expect(status.mock.calls.every(([value]) => !value.pending && !value.failed)).toBe(true)
    expect(screen.queryByText('Draft could not be saved.')).toBeNull()
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
      false
    )
  })

  it('still saves a manual draft before extraction without claiming confirmation', async () => {
    const table = fixture()
    const cell = { ...table.cells[0], status: 'pending' as const, history: [] }
    const command = vi.fn().mockResolvedValue({ tables: [table] })
    render(
      <ComparisonCellReview
        tableId={table.id}
        sourceKey="source"
        cell={cell}
        field={table.fields[0]}
        command={command}
        onClose={vi.fn()}
        onOpenItem={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual value' }), {
      target: { value: 'Human draft' }
    })
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        action: 'edit-cell',
        tableId: table.id,
        cellId: cell.id,
        value: 'Human draft',
        confirmed: false,
        expectedFieldVersion: 1,
        expectedSourceKey: 'source'
      })
    )
    expect(
      (screen.getByRole('button', { name: 'Confirm value' }) as HTMLButtonElement).disabled
    ).toBe(true)
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
  })

  it('allows evidence review of a successful attempt that explicitly reports insufficient evidence', async () => {
    const table = fixture()
    const cell = {
      ...table.cells[0],
      history: [{ ...table.cells[0].history[0], value: null, evidence: [] }]
    }
    const command = vi.fn().mockResolvedValue({ tables: [table] })
    render(
      <ComparisonCellReview
        tableId={table.id}
        sourceKey="source"
        cell={cell}
        field={table.fields[0]}
        command={command}
        onClose={vi.fn()}
        onOpenItem={vi.fn()}
      />
    )
    const confirm = screen.getByRole('button', { name: 'Confirm value' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        action: 'edit-cell',
        tableId: table.id,
        cellId: cell.id,
        value: '',
        confirmed: true,
        expectedFieldVersion: 1,
        expectedSourceKey: 'source',
        expectedAttemptId: 'attempt'
      })
    )
  })
})

describe('comparison value preservation', () => {
  it('keeps the insufficient-evidence explanation after confirming an empty result', () => {
    const table = fixture()
    table.cells[0].history[0] = { ...table.cells[0].history[0], value: null, evidence: [] }
    table.cells[0].manual = {
      value: '',
      confirmed: true,
      fieldVersion: 1,
      sourceKey: 'source',
      attemptId: 'attempt',
      updatedAt: '2026-11-10'
    }
    page(table)
    expect(screen.getByText('Insufficient evidence')).toBeTruthy()
    expect(screen.getByText('Confirmed')).toBeTruthy()
    expect(screen.queryByText('Pending')).toBeNull()
  })

  it.each(['machine', 'manual'] as const)(
    'retries the submitted %s value after confirmation fails',
    async (mode) => {
      const table = fixture()
      const cell = table.cells[0]
      const expected = mode === 'machine' ? '42 adults' : 'Human correction'
      if (mode === 'manual')
        cell.manual = {
          value: expected,
          confirmed: false,
          fieldVersion: 1,
          sourceKey: 'source',
          attemptId: 'attempt',
          updatedAt: '2026-11-10'
        }
      const command = vi
        .fn()
        .mockRejectedValueOnce(new Error('checkpoint-failed'))
        .mockResolvedValue({ tables: [table] })
      render(
        <ComparisonCellReview
          tableId={table.id}
          sourceKey="source"
          cell={cell}
          field={table.fields[0]}
          command={command}
          onClose={vi.fn()}
          onOpenItem={vi.fn()}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Confirm value' }))
      await waitFor(() =>
        expect(command).toHaveBeenCalledWith(
          expect.objectContaining({ value: expected, confirmed: true })
        )
      )
      const retry = await screen.findByRole('button', { name: 'Retry' })
      expect(
        (screen.getByRole('textbox', { name: 'Manual value' }) as HTMLTextAreaElement).value
      ).toBe(expected)
      fireEvent.click(retry)
      await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
      expect(command.mock.calls[1][0]).toEqual(
        expect.objectContaining({ action: 'edit-cell', value: expected, confirmed: false })
      )
    }
  )

  it('retries the latest local edit rather than restoring an earlier failed confirmation value', async () => {
    const table = fixture()
    let rejectConfirmation!: (error: Error) => void
    const confirmation = new Promise<ComparisonResult>((_resolve, reject) => {
      rejectConfirmation = reject
    })
    const command = vi
      .fn()
      .mockImplementationOnce(() => confirmation)
      .mockRejectedValueOnce(new Error('draft-offline'))
      .mockResolvedValue({ tables: [table] })
    render(
      <ComparisonCellReview
        tableId={table.id}
        sourceKey="source"
        cell={table.cells[0]}
        field={table.fields[0]}
        command={command}
        onClose={vi.fn()}
        onOpenItem={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Confirm value' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual value' }), {
      target: { value: 'Later human correction' }
    })
    await act(async () => {
      rejectConfirmation(new Error('confirmation-offline'))
    })
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(3))
    expect(command.mock.calls[0][0]).toEqual(
      expect.objectContaining({ value: '42 adults', confirmed: true })
    )
    for (const [request] of command.mock.calls.slice(1))
      expect(request).toEqual(
        expect.objectContaining({ value: 'Later human correction', confirmed: false })
      )
    expect(
      (screen.getByRole('textbox', { name: 'Manual value' }) as HTMLTextAreaElement).value
    ).toBe('Later human correction')
  })

  it.each([true, false])(
    'preserves an empty manual value without marking it pending (confirmed=%s)',
    (confirmed) => {
      const table = fixture()
      table.cells[0].manual = {
        value: '',
        confirmed,
        fieldVersion: 1,
        sourceKey: 'source',
        attemptId: 'attempt',
        updatedAt: '2026-11-10'
      }
      const command = page(table)
      expect(comparisonCellView(table.cells[0], table.fields[0], 'source')).toMatchObject({
        value: '',
        confirmed
      })
      expect(screen.getByText(confirmed ? 'Confirmed' : 'Manual draft')).toBeTruthy()
      expect(screen.queryByText('Pending')).toBeNull()
      expect(table.cells[0].history[0].value).toBe('42 adults')
      expect(command).not.toHaveBeenCalled()
    }
  )
})

describe('comparison matrix selection and review navigation', () => {
  function expandedFixture(): ComparisonTable {
    const table = fixture()
    table.fields.push({ id: 'outcome', name: 'Outcome', rule: 'Report outcome', version: 1 })
    const template = structuredClone(table.cells[0])
    for (const [id, status] of [
      ['second', 'succeeded'],
      ['third', 'failed']
    ] as const) {
      table.itemIds.push(id)
      table.members.push({ itemId: id, title: id, abstract: '', sourceKey: 'source' })
      table.cells.push({
        ...structuredClone(template),
        id,
        itemId: id,
        status,
        history:
          status === 'succeeded'
            ? [{ ...template.history[0], id: id + '-attempt', value: id + ' value' }]
            : []
      })
    }
    table.cells.push({
      ...structuredClone(template),
      id: 'outcome-cell',
      fieldId: 'outcome',
      history: [{ ...template.history[0], id: 'outcome-attempt', value: 'Outcome value' }],
      manual: {
        value: 'Reviewed outcome',
        confirmed: true,
        fieldVersion: 1,
        sourceKey: 'source',
        attemptId: 'outcome-attempt',
        updatedAt: 'now'
      }
    })
    table.cells.push({
      id: 'not-started',
      itemId: 'second',
      fieldId: 'outcome',
      status: 'pending',
      history: []
    })
    table.cells.push({
      id: 'missing-source',
      itemId: 'third',
      fieldId: 'outcome',
      status: 'unavailable',
      history: []
    })
    return table
  }

  it('opens a cell on click and restores keyboard navigation on close', async () => {
    page(expandedFixture())
    const first = screen.getByRole('button', { name: /42 adults/ })
    fireEvent.click(first)
    expect(screen.getByRole('dialog', { name: 'Review cell' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(document.activeElement).toBe(first))
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    const outcome = screen.getByRole('button', { name: /Reviewed outcome/ })
    expect(outcome.getAttribute('aria-current')).toBe('true')
    expect(document.activeElement).toBe(outcome)
    fireEvent.keyDown(outcome, { key: 'Enter' })
    expect(screen.getByRole('dialog', { name: 'Review cell' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(document.activeElement).toBe(outcome))
    fireEvent.click(first)
    expect(screen.getByRole('dialog', { name: 'Review cell' }).textContent).toContain('Population')
  })

  it('disables starting review when a filter hides all reviewable cells', () => {
    page(expandedFixture())
    selectFilter('failed')
    expect(screen.queryByRole('dialog', { name: 'Review cell' })).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Start review ({{count}} cells)' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })

  it('finds only successful unconfirmed cells in the current filter, using stable matrix order after confirmation', async () => {
    let table = expandedFixture()
    const props = {
      command: vi.fn().mockResolvedValue({ tables: [table] }),
      onChooseReferences: vi.fn(),
      onOpenItem: vi.fn(),
      onOpenDiscovery: vi.fn(),
      onOpenComparison: vi.fn()
    }
    const { rerender } = render(<LiteratureComparisonPage table={table} {...props} />)
    selectFilter('review')
    fireEvent.click(screen.getByRole('button', { name: 'Start review ({{count}} cells)' }))
    expect(screen.getByRole('dialog', { name: 'Review cell' }).textContent).toContain('42 adults')
    const confirm = (id: string): void => {
      table = structuredClone(table)
      const cell = table.cells.find((entry) => entry.id === id)!
      cell.manual = {
        value: cell.history.at(-1)!.value ?? '',
        confirmed: true,
        fieldVersion: 1,
        sourceKey: 'source',
        attemptId: cell.history.at(-1)!.id,
        updatedAt: 'now'
      }
      rerender(<LiteratureComparisonPage table={table} {...props} />)
    }
    confirm('cell')
    expect(screen.getByRole('dialog', { name: 'Review cell' }).textContent).toContain('42 adults')
    fireEvent.click(screen.getByRole('button', { name: 'Next cell awaiting review' }))
    expect(screen.getByRole('dialog', { name: 'Review cell' }).textContent).toContain(
      'second value'
    )
    confirm('second')
    expect(screen.queryByRole('button', { name: 'Next cell awaiting review' })).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Adopt latest machine value and confirm evidence' })
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    selectFilter('failed')
    expect(screen.queryByRole('button', { name: 'Start review ({{count}} cells)' })).toBeNull()
  })

  it('wraps to another awaiting cell and excludes successful results outside the filter', () => {
    const table = expandedFixture()
    page(table)
    fireEvent.click(screen.getByRole('button', { name: /second value/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Next cell awaiting review' }))
    expect(screen.getByRole('dialog', { name: 'Review cell' }).textContent).toContain('42 adults')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    selectFilter('pending')
    fireEvent.click(screen.getByRole('button', { name: 'Start review ({{count}} cells)' }))
    expect(screen.getByRole('dialog', { name: 'Review cell' }).textContent).toContain(
      'second value'
    )
    expect(
      (screen.getByRole('button', { name: 'Next cell awaiting review' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })

  it('protects saving and failed drafts from selection, keyboard opening, and awaiting navigation until retry', async () => {
    const table = expandedFixture()
    let rejectSave!: (error: Error) => void
    const command = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectSave = reject
          })
      )
      .mockResolvedValue({ tables: [table] })
    page(table, command)
    const first = screen.getByRole('button', { name: /42 adults/ })
    const second = screen.getByRole('button', { name: /second value/ })
    fireEvent.click(first)
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
    const input = screen.getByRole('textbox', { name: 'Manual value' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'Protected local draft' } })
    const attemptNavigation = (): void => {
      fireEvent.click(second)
      fireEvent.keyDown(first, { key: 'ArrowDown' })
      fireEvent.keyDown(second, { key: 'Enter' })
      fireEvent.click(screen.getByRole('button', { name: 'Next cell awaiting review' }))
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.getByRole('textbox', { name: 'Manual value' })).toBe(input)
      expect(input.value).toBe('Protected local draft')
      expect(first.getAttribute('aria-current')).toBe('true')
    }
    attemptNavigation()
    await waitFor(() => expect(command).toHaveBeenCalledOnce())
    await act(async () => rejectSave(new Error('offline')))
    attemptNavigation()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Next cell awaiting review' }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    )
    expect(command.mock.calls.every(([request]) => request.confirmed === false)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Next cell awaiting review' }))
    expect(screen.getByRole('dialog', { name: 'Review cell' }).textContent).toContain(
      'second value'
    )
  })

  it('adopts the latest machine value independently of a saved manual value with version checks', async () => {
    const table = fixture()
    table.cells[0].manual = {
      value: 'Human interpretation',
      confirmed: false,
      fieldVersion: 1,
      sourceKey: 'source',
      updatedAt: 'now'
    }
    const command = page(table)
    fireEvent.click(screen.getByRole('button', { name: /Human interpretation/ }))
    expect(
      (screen.getByRole('textbox', { name: 'Manual value' }) as HTMLTextAreaElement).value
    ).toBe('Human interpretation')
    expect(screen.getByRole('button', { name: 'Confirm revision' })).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: 'Adopt latest machine value and confirm evidence' })
    )
    expect(
      screen.queryByRole('button', { name: 'Adopt latest machine value and confirm evidence' })
    ).toBeNull()
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        action: 'edit-cell',
        tableId: 'table',
        cellId: 'cell',
        value: '42 adults',
        confirmed: true,
        expectedFieldVersion: 1,
        expectedSourceKey: 'source',
        expectedAttemptId: 'attempt'
      })
    )
    expect(
      (screen.getByRole('textbox', { name: 'Manual value' }) as HTMLTextAreaElement).value
    ).toBe('42 adults')
    expect(screen.getByRole('dialog', { name: 'Review cell' })).toBeTruthy()
  })
})

describe('comparison field draft owner navigation', () => {
  function renderWithOutsideNavigation(
    table: ComparisonTable,
    command: React.ComponentProps<typeof LiteratureComparisonPage>['command']
  ): void {
    function Owner(): React.JSX.Element {
      const [open, setOpen] = useState(true)
      const blocked = useRef(false)
      return (
        <>
          <button onClick={() => !blocked.current && setOpen(false)}>
            Navigate outside comparison
          </button>
          {open && (
            <LiteratureComparisonPage
              table={table}
              command={command}
              onChooseReferences={vi.fn()}
              onOpenItem={vi.fn()}
              onOpenDiscovery={vi.fn()}
              onOpenComparison={vi.fn()}
              onDraftStatusChange={(status) => {
                blocked.current = status.pending || status.failed
              }}
            />
          )}
        </>
      )
    }
    render(<Owner />)
  }

  it.each(['cancel', 'save'] as const)(
    'blocks outer navigation for dirty, saving and failed rules until %s',
    async (exit) => {
      const table = fixture()
      let resolveSave!: (result: ComparisonResult) => void
      let rejectSave!: (error: Error) => void
      const command = vi.fn(
        () =>
          new Promise<ComparisonResult>((resolve, reject) => {
            resolveSave = resolve
            rejectSave = reject
          })
      )
      renderWithOutsideNavigation(table, command)
      fireEvent.click(screen.getByRole('button', { name: 'Edit field' }))
      const editor = screen.getByRole('dialog', { name: 'Edit {{field}}' })
      const rule = within(editor).getByRole('textbox', {
        name: 'Extraction requirements'
      }) as HTMLTextAreaElement
      const navigate = screen.getByRole('button', { name: 'Navigate outside comparison' })
      const expectNavigationBlocked = (): void => {
        fireEvent.pointerDown(navigate)
        fireEvent.click(navigate)
        expect(screen.getByRole('table', { name: 'Comparison matrix' })).toBeTruthy()
        expect(screen.getByRole('dialog', { name: 'Edit {{field}}' })).toBe(editor)
        expect(rule.value).toBe('Protected rule revision')
      }
      fireEvent.change(rule, { target: { value: 'Protected rule revision' } })
      expectNavigationBlocked()
      fireEvent.click(within(editor).getByRole('button', { name: 'Save rule revision' }))
      expectNavigationBlocked()
      expect(
        (within(editor).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled
      ).toBe(true)
      await act(async () => rejectSave(new Error('write-failed')))
      expect(within(editor).getByText('Comparison table could not be updated.')).toBeTruthy()
      expectNavigationBlocked()
      if (exit === 'save') {
        fireEvent.click(within(editor).getByRole('button', { name: 'Save rule revision' }))
        expectNavigationBlocked()
        await act(async () => resolveSave({ tables: [table] }))
        expect(command).toHaveBeenCalledTimes(2)
        expect(command.mock.calls[1]).toEqual(command.mock.calls[0])
      } else {
        fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }))
        expect(command).toHaveBeenCalledOnce()
      }
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      fireEvent.click(navigate)
      expect(screen.queryByRole('table', { name: 'Comparison matrix' })).toBeNull()
    }
  )

  it('allows outer navigation after reverting an unsaved rule to its original value', () => {
    const table = fixture()
    const command = vi.fn()
    renderWithOutsideNavigation(table, command)
    fireEvent.click(screen.getByRole('button', { name: 'Edit field' }))
    const rule = screen.getByRole('textbox', { name: 'Extraction requirements' })
    fireEvent.change(rule, { target: { value: 'Changed rule' } })
    fireEvent.change(rule, { target: { value: table.fields[0].rule } })
    fireEvent.click(screen.getByRole('button', { name: 'Navigate outside comparison' }))
    expect(screen.queryByRole('table', { name: 'Comparison matrix' })).toBeNull()
    expect(command).not.toHaveBeenCalled()
  })
})

describe('comparison filtered review focus restoration', () => {
  it.each(['close', 'escape'] as const)(
    'returns focus to the active filter after confirming its final cell and using %s',
    async (exit) => {
      const table = fixture()
      const props = {
        command: vi.fn().mockResolvedValue({ tables: [table] }),
        onChooseReferences: vi.fn(),
        onOpenItem: vi.fn(),
        onOpenDiscovery: vi.fn(),
        onOpenComparison: vi.fn()
      }
      const { rerender } = render(<LiteratureComparisonPage table={table} {...props} />)
      const filter = screen.getByRole('combobox', { name: 'Filters' }) as HTMLButtonElement
      selectFilter('review')
      fireEvent.click(screen.getByRole('button', { name: /42 adults/ }))
      const confirmed = structuredClone(table)
      confirmed.cells[0].manual = {
        value: '42 adults',
        confirmed: true,
        fieldVersion: 1,
        sourceKey: 'source',
        attemptId: 'attempt',
        updatedAt: 'now'
      }
      rerender(<LiteratureComparisonPage table={confirmed} {...props} />)
      expect(screen.getByRole('dialog', { name: 'Review cell' }).textContent).toContain('42 adults')
      if (exit === 'close') fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      else fireEvent.keyDown(screen.getByRole('dialog', { name: 'Review cell' }), { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Review cell' })).toBeNull())
      expect(screen.queryByRole('button', { name: /42 adults/ })).toBeNull()
      await waitFor(() => expect(document.activeElement).toBe(filter))
      expect(filter.textContent).toContain('Ready for review')
    }
  )
})
