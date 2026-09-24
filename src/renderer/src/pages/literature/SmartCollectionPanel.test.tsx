import { formatSmartRule } from './smart-rule-fields'
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SmartCollectionPanel as Panel } from './SmartCollectionPanel'
import { useState, type ComponentProps } from 'react'
import { createSmartCollectionState } from './smart-collection-state'
const SmartCollectionPanel = (
  props: Omit<ComponentProps<typeof Panel>, 'state'>
): React.JSX.Element => {
  const [state] = useState(createSmartCollectionState)
  return <Panel {...props} state={state} />
}
import type { SmartCollectionView } from '../../../../shared/literature-smart-collections'

const { configure } = vi.hoisted(() => ({ configure: vi.fn() }))
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: Object.assign(() => false, {
    getState: () => ({ openSettingsToClassification: configure })
  })
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
let view: SmartCollectionView
let notifyChange: () => void
const transact = vi.fn()
beforeEach(() => {
  configure.mockReset()
  view = {
    ruleRevision: 3,
    scope: { kind: 'library' },
    sourceName: '',
    sourceAvailable: true,
    configured: false,
    total: 1,
    matches: 0,
    pending: 1,
    counts: { match: 0, review: 0, 'no-match': 0, pending: 1 },
    overrides: 0,
    rows: [{ id: 'paper', title: 'A trial', verdict: 'pending' }]
  }
  transact
    .mockReset()
    .mockImplementation(async () => ({ kind: 'collection', id: 'smart', smart: view }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        transact,
        onChanged: (callback: () => void) => {
          notifyChange = callback
          return () => undefined
        }
      }
    }
  })
})
it('keeps saving separate from evaluation and opens the configured settings route', async () => {
  render(<SmartCollectionPanel collectionId="smart" name="Trials" description="Adult trials" />)
  await screen.findByText('Choose a classification model to start organizing papers.')
  expect(screen.queryByRole('button', { name: 'Update collection' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Configure classification model' }))
  expect(configure).toHaveBeenCalledOnce()
  expect(transact.mock.calls.every(([command]) => command.action === 'read')).toBe(true)
})
it('collapses rule details by default without hiding configuration or starting inference', async () => {
  render(<SmartCollectionPanel collectionId="smart" name="Trials" description="Adult trials" />)
  await screen.findByText('Collection saved')
  expect(screen.queryByText('Adult trials')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Collection rule' }))
  expect(screen.getByText('Adult trials')).toBeTruthy()
  expect(screen.getByText('All references')).toBeTruthy()
  expect(screen.getByText('#3')).toBeTruthy()
  expect(
    screen.getByRole('button', { name: 'Collection rule' }).getAttribute('aria-expanded')
  ).toBe('true')
  expect(screen.getByRole('button', { name: 'Configure classification model' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Collection rule' }))
  expect(screen.queryByText('Adult trials')).toBeNull()
  expect(transact.mock.calls.every(([command]) => command.action === 'read')).toBe(true)
})
it.each([
  [{ kind: 'library' }, '', 'All references'],
  [{ kind: 'project', id: 'project-1' }, 'Research', 'Project: Research'],
  [{ kind: 'collection', id: 'collection-1' }, 'Research', 'Collection: Research']
] as const)('opens the matching Library scope for %s', async (scope, sourceName, label) => {
  view = { ...view, scope, sourceName }
  const onOpenScope = vi.fn()
  render(
    <SmartCollectionPanel
      collectionId="smart"
      name="Trials"
      description="Adult trials"
      onOpenScope={onOpenScope}
    />
  )
  await screen.findByText('Collection saved')
  fireEvent.click(screen.getByRole('button', { name: 'Collection rule' }))
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(onOpenScope).toHaveBeenCalledWith(scope)
})

it('does not link an unavailable source', async () => {
  view = {
    ...view,
    scope: { kind: 'collection', id: 'removed' },
    sourceName: 'Removed',
    sourceAvailable: false
  }
  render(
    <SmartCollectionPanel
      collectionId="smart"
      name="Trials"
      description="Adult trials"
      onOpenScope={vi.fn()}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Collection rule' }))
  expect(await screen.findByText('Unavailable')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Collection: Removed' })).toBeNull()
})

it('requires the explicit cost confirmation before recomputing', async () => {
  view = { ...view, configured: true }
  const onRunPendingChange = vi.fn()
  render(
    <SmartCollectionPanel
      collectionId="smart"
      name="Trials"
      description="Adult trials"
      onRunPendingChange={onRunPendingChange}
    />
  )
  await screen.findByRole('button', { name: 'Update collection' })
  fireEvent.click(screen.getByRole('button', { name: 'Collection actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Re-evaluate all' }))
  await screen.findByText(
    'Re-evaluating all papers repeats classification requests and may incur additional costs.'
  )
  expect(transact.mock.calls.every(([command]) => command.action === 'read')).toBe(true)
  expect(onRunPendingChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Re-evaluate all' }))
  expect(onRunPendingChange).toHaveBeenNthCalledWith(1, true)
  await waitFor(() =>
    expect(transact).toHaveBeenCalledWith(expect.objectContaining({ action: 'recompute' }))
  )
  await waitFor(() => expect(onRunPendingChange).toHaveBeenLastCalledWith(false))
})

it.each(['completed', 'failed', 'cancelled'] as const)(
  'shows success only when the requested run is %s',
  async (state) => {
    view = { ...view, configured: true }
    const onViewChange = vi.fn()
    render(
      <SmartCollectionPanel
        collectionId="smart"
        name="Trials"
        description="Adult trials"
        onViewChange={onViewChange}
      />
    )
    await screen.findByRole('button', { name: 'Update collection' })
    const run = {
      id: 'new-run',
      kind: 'refresh' as const,
      state: 'running' as const,
      done: 0,
      total: 1,
      inputTokens: 0,
      outputTokens: 0,
      usageIncomplete: false,
      updatedAt: 1
    }
    transact.mockImplementation(async (command) => {
      if (command.action === 'refresh') view = { ...view, run }
      return { kind: 'collection', id: 'smart', smart: view }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Update collection' }))
    await screen.findByText('Updating…')
    expect(screen.queryByRole('progressbar')?.getAttribute('aria-valuenow')).toBe('0')
    await waitFor(() => expect(onViewChange).toHaveBeenLastCalledWith(view, true))
    expect(screen.queryByRole('button', { name: 'Updated' })).toBeNull()
    view = { ...view, run: { ...run, state, done: 1 } }
    notifyChange()
    await waitFor(() => expect(onViewChange).toHaveBeenLastCalledWith(view, false))
    expect(screen.queryByRole('progressbar')).toBeNull()
    if (state === 'completed') {
      await screen.findByRole('button', { name: 'Updated' })
      await waitFor(
        () => expect(screen.getByRole('button', { name: 'Update collection' })).toBeTruthy(),
        { timeout: 3000 }
      )
    } else {
      await screen.findByRole('button', {
        name:
          state === 'failed'
            ? 'Retry'
            : state === 'cancelled'
              ? 'Resume analysis'
              : 'Update collection'
      })
      expect(screen.queryByRole('button', { name: 'Updated' })).toBeNull()
    }
  }
)

it('requires consent for a paid trial and resetting manual decisions', async () => {
  view = { ...view, configured: true, overrides: 3 }
  render(<SmartCollectionPanel collectionId="smart" name="Trials" description="Adult trials" />)
  await screen.findByRole('button', { name: 'Update collection' })
  fireEvent.click(screen.getByRole('button', { name: 'Collection actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Trial run (up to 20 references)' }))
  expect(transact.mock.calls.every(([command]) => command.action === 'read')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Start trial run' }))
  await waitFor(() =>
    expect(transact).toHaveBeenCalledWith(expect.objectContaining({ action: 'preview' }))
  )
  fireEvent.click(screen.getByRole('button', { name: 'Collection actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset manual decisions' }))
  expect(transact.mock.calls.some(([command]) => command.action === 'reset-overrides')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(transact.mock.calls.some(([command]) => command.action === 'reset-overrides')).toBe(false)
})

it('keeps inline progress visible while cancellation waits for active requests', async () => {
  view = {
    ...view,
    configured: true,
    run: {
      id: 'run',
      kind: 'refresh',
      state: 'running',
      done: 2,
      total: 4,
      inputTokens: 0,
      outputTokens: 0,
      usageIncomplete: false,
      updatedAt: 1
    }
  }
  const onOpenProcess = vi.fn()
  const { unmount } = render(
    <SmartCollectionPanel
      collectionId="smart"
      name="Trials"
      description="Adult trials"
      onOpenProcess={onOpenProcess}
    />
  )
  try {
    const stop = await screen.findByRole('button', { name: 'Pause analysis' })
    expect(stop.closest('[data-slot="smart-update-control"]')).toBeTruthy()
    const entry = screen.getByRole('button', { name: 'Screening process' })
    expect(entry.contains(screen.getByRole('progressbar'))).toBe(true)
    expect(entry.contains(stop)).toBe(false)
    fireEvent.click(entry)
    expect(onOpenProcess).toHaveBeenCalledOnce()
    expect(transact.mock.calls.every(([command]) => command.action === 'read')).toBe(true)
    fireEvent.click(stop)
    expect(onOpenProcess).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith(expect.objectContaining({ action: 'cancel' }))
    )
    expect(screen.getByRole('button', { name: 'Pause analysis' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2')
    view = { ...view, run: { ...view.run!, state: 'cancelled' } }
    notifyChange()
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull())
    expect(screen.getByRole('button', { name: 'Screening process' })).toBeTruthy()
  } finally {
    unmount()
  }
})

it('does not cover the table during a single-reference evaluation', async () => {
  view = {
    ...view,
    configured: true,
    run: {
      id: 'run',
      kind: 'refresh',
      state: 'running',
      done: 0,
      total: 1,
      inputTokens: 0,
      outputTokens: 0,
      usageIncomplete: false,
      updatedAt: 1
    }
  }
  render(
    <SmartCollectionPanel
      collectionId="smart"
      name="Trials"
      description="Adult trials"
      singleReevaluation
    />
  )
  await screen.findByRole('button', { name: 'Updating…' })
  expect(screen.queryByRole('progressbar')).toBeNull()
})

it('rejects a pre-command read that arrives after a completed update', async () => {
  view = { ...view, configured: true }
  render(<SmartCollectionPanel collectionId="smart" name="Trials" description="Adult trials" />)
  await screen.findByRole('button', { name: 'Update collection' })
  let resolveOld!: (value: unknown) => void
  transact.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  )
  notifyChange()
  await waitFor(() => expect(resolveOld).toBeTypeOf('function'))
  view = {
    ...view,
    run: {
      id: 'finished',
      kind: 'refresh',
      state: 'completed',
      done: 1,
      total: 1,
      inputTokens: 1,
      outputTokens: 1,
      usageIncomplete: false,
      updatedAt: 1
    }
  }
  fireEvent.click(screen.getByRole('button', { name: 'Update collection' }))
  await screen.findByRole('button', { name: 'Updated' })
  await act(async () =>
    resolveOld({ kind: 'collection', id: 'smart', smart: { ...view, run: undefined } })
  )
  expect(screen.getByRole('button', { name: 'Updated' })).toBeTruthy()
})

it('renders structured criteria as readable sections without stored Markdown headings', async () => {
  const onEdit = vi.fn()
  render(
    <SmartCollectionPanel
      collectionId="smart"
      name="Trials"
      description={formatSmartRule({
        description: 'Clinical evidence',
        inclusion: 'Adult trials',
        exclusion: 'Reviews'
      })}
      onEdit={onEdit}
    />
  )
  await screen.findByText('Collection saved')
  fireEvent.click(screen.getByRole('button', { name: 'Collection rule' }))
  expect(screen.getByText('Clinical evidence')).toBeTruthy()
  expect(screen.getByText('Inclusion criteria')).toBeTruthy()
  expect(screen.getByText('Adult trials')).toBeTruthy()
  expect(screen.getByText('Exclusion criteria')).toBeTruthy()
  expect(screen.getByText('Reviews')).toBeTruthy()
  expect(screen.queryByText(/## Description/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Edit rule' }))
  expect(onEdit).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'keeps historical rules collapsed and removes duplicate current settings (changed=%s)',
  async (changed) => {
    const description = formatSmartRule({
      description: 'Trial screening',
      inclusion: 'Adult trials',
      exclusion: 'Reviews'
    })
    view = {
      ...view,
      configured: true,
      model: 'test-model',
      evidenceMode: 'abstract',
      run: {
        id: 'run',
        kind: 'refresh',
        state: 'completed',
        done: 1,
        total: 1,
        inputTokens: 10,
        outputTokens: 2,
        usageIncomplete: false,
        updatedAt: 1,
        snapshot: {
          description: changed
            ? formatSmartRule({
                description: 'Earlier screening',
                inclusion: 'Older criteria',
                exclusion: ''
              })
            : description,
          model: 'test-model',
          scope: { kind: 'library' },
          evidenceMode: 'abstract',
          action: 'refresh'
        }
      }
    }
    const rendered = render(
      <SmartCollectionPanel collectionId="smart" name="Trials" description={description} />
    )
    await screen.findByRole('button', { name: 'Update collection' })
    fireEvent.click(screen.getByRole('button', { name: 'Collection rule' }))
    if (changed) {
      const summary = screen.getByText('View settings used for this run')
      expect(summary.closest('details')?.hasAttribute('open')).toBe(false)
      expect(screen.getByText('Older criteria')).toBeTruthy()
      expect(screen.queryByText('This run used the current settings.')).toBeNull()
    } else {
      expect(screen.getByText('This run used the current settings.')).toBeTruthy()
      expect(screen.getAllByText('Adult trials')).toHaveLength(1)
      expect(rendered.container.querySelectorAll('details')).toHaveLength(1)
    }
  }
)

it('retries only the read after a committed reset loses its summary', async () => {
  view = { ...view, configured: true, overrides: 1 }
  let committed = false
  transact.mockImplementation(async (command) => {
    if (command.action === 'reset-overrides') {
      committed = true
      return { kind: 'collection', id: 'smart', smartRefreshFailed: true }
    }
    if (committed) throw new Error('offline')
    return { kind: 'collection', id: 'smart', smart: view }
  })
  render(<SmartCollectionPanel collectionId="smart" name="Trials" description="Adult trials" />)
  await screen.findByRole('button', { name: 'Update collection' })
  fireEvent.click(screen.getByRole('button', { name: 'Collection actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset manual decisions' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reset manual decisions' }))
  const warning =
    'Decision saved, but results could not be refreshed. Reload the collection to see the latest results.'
  await screen.findByText(warning)
  expect(screen.queryByRole('button', { name: 'Analysis failed' })).toBeNull()
  committed = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(screen.queryByText(warning)).toBeNull())
  expect(
    transact.mock.calls.filter(([command]) => command.action === 'reset-overrides')
  ).toHaveLength(1)
})

it('shows a persistent automatic pause with an explicit resume action', async () => {
  view = {
    ...view,
    autoUpdate: true,
    configured: true,
    automaticPauseReason: 'run-limit',
    automaticPauseRunId: 'paused-run',
    run: {
      id: 'paused-run',
      kind: 'refresh',
      state: 'interrupted',
      done: 0,
      total: 1,
      inputTokens: 0,
      outputTokens: 0,
      usageIncomplete: false,
      updatedAt: 1
    }
  }
  render(<SmartCollectionPanel collectionId="smart" name="Trials" description="Adult trials" />)
  await screen.findByText('Automatic updates paused')
  expect(transact.mock.calls.every(([command]) => command.action === 'read')).toBe(true)
  expect(screen.queryByText('Analysis failed')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Resume analysis' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Continue in a new run' }))
  await waitFor(() =>
    expect(transact).toHaveBeenCalledWith(expect.objectContaining({ action: 'resume-automatic' }))
  )
})

it('confirms and abandons a paused automatic run', async () => {
  view = {
    ...view,
    autoUpdate: true,
    configured: true,
    automaticPauseReason: 'run-limit',
    automaticPauseRunId: 'paused-run',
    run: {
      id: 'paused-run',
      kind: 'refresh',
      state: 'interrupted',
      done: 0,
      total: 1,
      inputTokens: 0,
      outputTokens: 0,
      usageIncomplete: false,
      updatedAt: 1
    }
  }
  transact.mockImplementation(async (command) => {
    if (command.action === 'abandon') {
      view = {
        ...view,
        automaticPauseReason: undefined,
        run: { ...view.run!, state: 'cancelled' }
      }
    }
    return { kind: 'collection', id: 'smart', smart: view }
  })
  render(<SmartCollectionPanel collectionId="smart" name="Trials" description="Adult trials" />)
  const abandonButtons = await screen.findAllByRole('button', { name: 'Abandon run' })
  fireEvent.click(abandonButtons.at(-1)!)
  await screen.findByRole('alertdialog')
  fireEvent.click(screen.getAllByRole('button', { name: 'Abandon run' }).at(-1)!)
  await waitFor(() =>
    expect(transact).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'abandon', runId: 'paused-run' })
    )
  )
})

it('offers abandon for an interrupted manual run', async () => {
  view = {
    ...view,
    configured: true,
    run: {
      id: 'interrupted-run',
      kind: 'refresh',
      state: 'interrupted',
      done: 1,
      total: 2,
      inputTokens: 0,
      outputTokens: 0,
      usageIncomplete: false,
      updatedAt: 1
    }
  }
  render(<SmartCollectionPanel collectionId="smart" name="Trials" description="Adult trials" />)
  expect(await screen.findByRole('button', { name: 'Abandon run' })).toBeTruthy()
})

it.each(['cancelled', 'interrupted'] as const)(
  'resumes %s analysis and offers re-analysis when its checkpoint is invalid',
  async (state) => {
    view = {
      ...view,
      configured: true,
      run: {
        id: 'same-run',
        kind: 'refresh',
        state,
        done: 1,
        total: 2,
        inputTokens: 0,
        outputTokens: 0,
        usageIncomplete: false,
        updatedAt: 1
      }
    }
    transact.mockImplementation(async (command) => {
      if (command.action === 'resume') throw new Error('SMART_COLLECTION_RESUME_UNAVAILABLE')
      return { kind: 'collection', id: 'smart', smart: view }
    })
    render(<SmartCollectionPanel collectionId="smart" name="Trials" description="Adult trials" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Resume analysis' }))
    await screen.findByText(
      'This run cannot be resumed because its settings, papers, or saved progress have changed.'
    )
    expect(transact).toHaveBeenCalledWith(expect.objectContaining({ action: 'resume' }))
    expect(transact.mock.calls.some(([command]) => command.action === 'refresh')).toBe(false)
    expect(screen.getByRole('button', { name: 'Re-evaluate all' })).toBeTruthy()
  }
)

it.each(['cancelled', 'interrupted'] as const)(
  'opens the process from %s progress without resuming analysis',
  async (state) => {
    view = {
      ...view,
      configured: true,
      run: {
        id: 'paused-run',
        kind: 'refresh',
        state,
        done: 1,
        total: 2,
        inputTokens: 0,
        outputTokens: 0,
        usageIncomplete: false,
        updatedAt: 1
      }
    }
    const openProcess = vi.fn()
    render(
      <SmartCollectionPanel
        collectionId="smart"
        name="Trials"
        description="Adult trials"
        onOpenProcess={openProcess}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Screening process' }))
    expect(openProcess).toHaveBeenCalledOnce()
    expect(transact.mock.calls.every(([command]) => command.action === 'read')).toBe(true)
    expect(screen.getByRole('button', { name: 'Resume analysis' })).toBeTruthy()
  }
)
