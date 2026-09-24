import { formatSmartRule, parseSmartRule } from './smart-rule-fields'
// @vitest-environment jsdom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CollectionEditorDialog, type CollectionEditorDialogHandle } from './CollectionEditorDialog'
import { LITERATURE_COLLECTION_REVISION_CONFLICT } from '../../../../shared/literature'

afterEach(cleanup)
it('labels project and collection scopes in the menu and selected value', async () => {
  const transact = vi.fn().mockResolvedValue({ kind: 'collection', id: 'created' })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { transact } } })
  const ref = createRef<CollectionEditorDialogHandle>()
  render(
    <CollectionEditorDialog
      ref={ref}
      onSaved={vi.fn()}
      scopes={[
        { kind: 'project', id: 'project-1', name: 'Research' },
        { kind: 'collection', id: 'collection-1', name: 'Research' }
      ]}
    />
  )
  act(() => ref.current!.openCreate())
  fireEvent.click(screen.getByRole('switch', { name: 'Smart collection' }))
  const trigger = screen.getByRole('combobox', { name: 'Scope' })
  fireEvent.click(trigger)
  expect(screen.getByRole('option', { name: 'Project Research' })).not.toBeNull()
  expect(screen.getByRole('option', { name: 'Collection Research' })).not.toBeNull()
  fireEvent.click(screen.getByRole('option', { name: 'Project Research' }))
  expect(trigger.textContent).toContain('ProjectResearch')
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('option', { name: 'Collection Research' }))
  expect(trigger.textContent).toContain('CollectionResearch')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Selected papers' } })
  fireEvent.change(screen.getByLabelText(/Inclusion criteria/), {
    target: { value: 'Research papers' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create collection' }))
  await waitFor(() => expect(transact).toHaveBeenCalledOnce())
  expect(transact.mock.calls[0][0].scope).toEqual({ kind: 'collection', id: 'collection-1' })
})

it('retains a conflicting draft and only submits the loaded latest version after explicit confirmation', async () => {
  const original = {
    id: 'collection',
    name: 'Original',
    description: 'Original description',
    revision: 1,
    itemCount: 0,
    createdAt: 1,
    updatedAt: 1
  }
  const latest = {
    ...original,
    name: 'Renamed by another client',
    description: 'Latest description',
    revision: 2
  }
  const transact = vi
    .fn()
    .mockRejectedValueOnce(new Error(LITERATURE_COLLECTION_REVISION_CONFLICT))
    .mockResolvedValue({ kind: 'collection', id: original.id })
  const search = vi.fn().mockResolvedValue({ entries: [latest] })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { transact, search } }
  })
  const ref = createRef<CollectionEditorDialogHandle>()
  const saved = vi.fn()
  render(<CollectionEditorDialog ref={ref} onSaved={saved} />)
  act(() => ref.current!.openEdit(original))
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: 'My unsaved description' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('Renamed by another client')
  expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
    'My unsaved description'
  )
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Original')
  expect(saved).not.toHaveBeenCalled()
  expect(transact).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Load latest version' }))
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(latest.name)
  expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
    latest.description
  )
  expect(transact).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: 'Reconciled description' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
  expect(transact).toHaveBeenLastCalledWith({
    kind: 'update-collection',
    collectionId: original.id,
    expectedRevision: 2,
    name: latest.name,
    description: 'Reconciled description'
  })
})

it('returns the created identity for navigation without opening settings or starting inference', async () => {
  const transact = vi.fn().mockResolvedValue({ kind: 'collection', id: 'created' })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { transact } } })
  const ref = createRef<CollectionEditorDialogHandle>()
  const saved = vi.fn()
  render(<CollectionEditorDialog ref={ref} onSaved={saved} />)
  act(() => ref.current!.openCreate())
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Trials' } })
  fireEvent.click(screen.getByRole('switch', { name: 'Smart collection' }))
  fireEvent.change(screen.getByLabelText(/Inclusion criteria/), {
    target: { value: 'Adult randomized trials' }
  })
  expect(screen.queryByRole('button', { name: 'Configure classification model' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Create collection' }))
  await waitFor(() =>
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ id: 'created' }))
  )
  expect(transact).toHaveBeenCalledOnce()
  expect(transact).toHaveBeenCalledWith({
    kind: 'create-smart-collection',
    name: 'Trials',
    description: formatSmartRule({
      description: '',
      inclusion: 'Adult randomized trials',
      exclusion: ''
    }),
    scope: { kind: 'library' },
    evidenceMode: 'abstract',
    autoUpdate: false
  })
})

it('debounces opt-in previews, cancels obsolete requests and ignores late responses', async () => {
  vi.useFakeTimers()
  const completions: Array<(value: unknown) => void> = []
  const transact = vi.fn((command) =>
    command.kind === 'preview-smart-collection'
      ? new Promise((resolve) => completions.push(resolve))
      : Promise.resolve({ kind: 'collection', id: command.requestId })
  )
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { transact } } })
  const ref = createRef<CollectionEditorDialogHandle>()
  const view = render(<CollectionEditorDialog ref={ref} onSaved={vi.fn()} />)
  try {
    act(() => ref.current!.openCreate())
    fireEvent.click(screen.getByRole('switch', { name: 'Smart collection' }))
    fireEvent.change(screen.getByLabelText(/Inclusion criteria/), {
      target: { value: 'First rule' }
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(transact).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: 'Live rule preview' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    fireEvent.change(screen.getByLabelText(/Inclusion criteria/), {
      target: { value: 'Second rule' }
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(transact).toHaveBeenCalledTimes(1)
    expect(parseSmartRule(transact.mock.calls[0][0].description)?.inclusion).toBe('Second rule')
    fireEvent.change(screen.getByLabelText(/Inclusion criteria/), {
      target: { value: 'Third rule' }
    })
    expect(transact.mock.calls[1][0]).toMatchObject({
      kind: 'cancel-smart-preview',
      requestId: transact.mock.calls[0][0].requestId
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    await act(async () => {
      completions[1]({
        kind: 'collection',
        id: 'new',
        smartPreview: {
          configured: true,
          inputTokens: 1,
          outputTokens: 0,
          rows: [{ id: 'new', title: 'Current preview', verdict: 'match' }]
        }
      })
      completions[0]({
        kind: 'collection',
        id: 'old',
        smartPreview: {
          configured: true,
          inputTokens: 1,
          outputTokens: 0,
          rows: [{ id: 'old', title: 'Obsolete preview', verdict: 'match' }]
        }
      })
    })
    expect(screen.queryByText('Obsolete preview')).toBeNull()
    expect(screen.getByText('Current preview')).toBeTruthy()
    view.unmount()
    expect(transact.mock.calls.at(-1)?.[0].kind).toBe('cancel-smart-preview')
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

it('edits structured criteria directly and preserves them on reopen', async () => {
  const original = {
    id: 'structured',
    name: 'Trials',
    description: formatSmartRule({
      description: 'Trials',
      inclusion: 'Adult trials',
      exclusion: 'Reviews'
    }),
    revision: 1,
    itemCount: 0,
    createdAt: 1,
    updatedAt: 1,
    smart: true
  }
  const transact = vi.fn().mockResolvedValue({ kind: 'collection', id: 'structured' })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { transact } } })
  const ref = createRef<CollectionEditorDialogHandle>()
  render(<CollectionEditorDialog ref={ref} onSaved={vi.fn()} />)
  act(() => ref.current!.openEdit(original))
  fireEvent.change(screen.getByLabelText(/Inclusion criteria/), {
    target: { value: 'Adult trials' }
  })
  fireEvent.change(screen.getByLabelText(/Exclusion criteria/), { target: { value: 'Reviews' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(transact).toHaveBeenCalledOnce())
  const stored = transact.mock.calls[0][0].description
  act(() => ref.current!.openEdit({ ...original, description: stored }))
  expect((screen.getByLabelText(/Inclusion criteria/) as HTMLTextAreaElement).value).toBe(
    'Adult trials'
  )
  expect((screen.getByLabelText(/Exclusion criteria/) as HTMLTextAreaElement).value).toBe('Reviews')
  fireEvent.change(screen.getByLabelText(/Exclusion criteria/), {
    target: { value: 'x'.repeat(2000) }
  })
  expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('alert').textContent).toContain('2000')
})

it('round-trips structured sections including embedded Markdown headings', () => {
  const fields = {
    description: 'Clinical evidence',
    inclusion: 'Adult trials\nParallel groups',
    exclusion: 'Reviews'
  }
  expect(parseSmartRule(formatSmartRule(fields))).toEqual(fields)
  expect(parseSmartRule('Any free-form rule')).toBeUndefined()
  expect(
    parseSmartRule(
      formatSmartRule({ ...fields, inclusion: '## Exclusion criteria\nQuoted heading' })
    )
  ).toEqual({ ...fields, inclusion: '## Exclusion criteria\nQuoted heading' })
})

it('explains the effect of rule edits before saving without warning for name-only edits', () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { transact: vi.fn() } }
  })
  const ref = createRef<CollectionEditorDialogHandle>()
  render(<CollectionEditorDialog ref={ref} onSaved={vi.fn()} />)
  act(() =>
    ref.current!.openEdit({
      id: 'collection',
      name: 'Trials',
      description: formatSmartRule({
        description: '',
        inclusion: 'Original studies',
        exclusion: ''
      }),
      revision: 1,
      itemCount: 1,
      createdAt: 1,
      updatedAt: 1,
      smart: true,
      smartScope: { kind: 'library' },
      smartEvidenceMode: 'abstract',
      smartAutoUpdate: false
    })
  )
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
  expect(screen.queryByText(/Saving creates a new rule version/)).toBeNull()
  fireEvent.change(screen.getByLabelText(/Inclusion criteria/), {
    target: { value: 'Randomized trials' }
  })
  expect(screen.getByText(/Saving creates a new rule version/)).toBeTruthy()
  expect(
    screen.getByText('Save changes, then update the collection to evaluate the new rule.')
  ).toBeTruthy()
})
