// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { literatureItemInputSchema, type LiteratureItemInput } from '../../../../shared/literature'
import { toCslItem } from '../../../../shared/literature-csl'
import { LiteratureMetadataEditor } from './LiteratureMetadataEditor'

afterEach(cleanup)

describe('LiteratureMetadataEditor', () => {
  it('locks every editable control while saving and retains the draft after failure', () => {
    const item = literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Original',
      typeFields: { volume: '1' },
      creators: [{ nameMode: 'person', givenName: 'A', familyName: 'B', creatorType: 'author' }],
      identifiers: [{ scheme: 'doi', value: '10.1234/example', isPrimary: true }]
    })
    const onSave = vi.fn()
    const props = { item, onSave, onCancel: vi.fn() }
    const { container, rerender } = render(<LiteratureMetadataEditor {...props} saving={false} />)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Draft title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ title: 'Draft title' }))
    rerender(<LiteratureMetadataEditor {...props} saving />)
    const controls = [...container.querySelectorAll('input, textarea, button')]
    expect(controls.length).toBeGreaterThan(15)
    expect(controls.filter((control) => !control.matches(':disabled'))).toEqual([])
    rerender(<LiteratureMetadataEditor {...props} saving={false} error="Save failed" />)
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Draft title')
    expect(screen.getByRole('alert').textContent).toBe('Save failed')
    expect(screen.getByRole('button', { name: /Add (creator|author)/ }).matches(':disabled')).toBe(
      false
    )
    expect(screen.getByRole('combobox', { name: 'Reference type' }).matches(':disabled')).toBe(
      false
    )
  })
})

const editableItem = (): LiteratureItemInput =>
  literatureItemInputSchema.parse({
    itemType: 'book',
    title: 'Manual metadata',
    issuedYear: 2024,
    issuedText: '2024-03-12',
    shortTitle: 'Short',
    language: 'fr',
    rights: 'CC BY',
    citationKey: 'manual2024',
    accessedAt: Date.UTC(2026, 8, 8),
    extra: 'Original provider notes',
    typeFields: { custom: { nested: ['preserve'] } },
    creators: [
      { nameMode: 'person', givenName: 'Ada', familyName: 'Lovelace', creatorType: 'editor' },
      { nameMode: 'organization', literalName: 'Research Council', creatorType: 'author' },
      {
        nameMode: 'person',
        givenName: 'Other',
        familyName: 'Contributor',
        creatorType: 'illustrator'
      }
    ]
  })

it.each(['2024.9', '2e3', '10000', '-1'])(
  'blocks invalid year text before submitting: %s',
  (value) => {
    const onSave = vi.fn()
    render(
      <LiteratureMetadataEditor
        item={editableItem()}
        saving={false}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    )
    const year = screen.getByLabelText('Year')
    fireEvent.change(year, { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(year.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toMatch(/year|9999/i)
  }
)

it('keeps publication filtering and citation dates consistent after editing the year', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createProjectDbClient } = await import('../../../../main/projects/prisma-client')
  const { migrateApplicationDatabase } = await import('../../../../main/database/migration-service')
  const { LiteratureCatalog } = await import('../../../../main/literature/catalog')
  const root = await mkdtemp(join(tmpdir(), 'literature-manual-date-'))
  const client = createProjectDbClient(root)
  try {
    await migrateApplicationDatabase(client)
    const catalog = new LiteratureCatalog(async () => client)
    const receipt = await catalog.transact({ kind: 'create-item', item: editableItem() })
    const original = (await catalog.get(receipt.id))!
    const onSave = vi.fn()
    render(
      <LiteratureMetadataEditor
        item={original.item}
        saving={false}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    )
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2025' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledOnce()
    await catalog.transact({
      kind: 'update-item',
      itemId: original.id,
      expectedMetadataRevision: original.metadataRevision,
      item: onSave.mock.calls[0][0]
    })
    const saved = (await catalog.get(original.id))!
    expect(saved.item.issuedYear).toBe(2025)
    const currentYear = await catalog.search({
      scope: 'library',
      filter: { yearFrom: 2025, yearTo: 2025 }
    })
    const oldYear = await catalog.search({
      scope: 'library',
      filter: { yearFrom: 2024, yearTo: 2024 }
    })
    expect(currentYear.entries.map((entry) => ('id' in entry ? entry.id : undefined))).toEqual([
      saved.id
    ])
    expect(oldYear.entries).toEqual([])
    expect(toCslItem(saved.id, saved.item).issued?.['date-parts'][0][0]).toBe(saved.item.issuedYear)
  } finally {
    cleanup()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})

it('shows existing creator roles and offers creator name modes', () => {
  render(
    <LiteratureMetadataEditor
      item={editableItem()}
      saving={false}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />
  )
  expect(screen.queryAllByRole('combobox', { name: /role/i })).toHaveLength(3)
  expect(screen.getByText('Editor')).not.toBeNull()
  expect(screen.getByText(/illustrator/i)).not.toBeNull()
  expect(screen.getAllByRole('combobox', { name: /name type|name mode/i })).toHaveLength(3)
})

it.each([
  'Short title',
  'Language',
  'Rights',
  'Date accessed',
  'Citation key',
  'Extra',
  'Publication date'
])('provides a manual metadata control for %s', (label) => {
  render(
    <LiteratureMetadataEditor
      item={editableItem()}
      saving={false}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />
  )
  const advanced = screen.getByRole('button', { name: 'Advanced settings' })
  if (advanced.getAttribute('aria-expanded') === 'false') fireEvent.click(advanced)
  expect(screen.queryByLabelText(label)).not.toBeNull()
})

it('preserves stored roles, literal names, and unedited extended metadata', () => {
  const item = editableItem()
  const onSave = vi.fn()
  render(<LiteratureMetadataEditor item={item} saving={false} onSave={onSave} onCancel={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Edited title' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(onSave).toHaveBeenCalledWith({ ...item, title: 'Edited title' })
  const csl = toCslItem('manual', onSave.mock.calls[0][0])
  expect(csl.editor).toEqual([{ given: 'Ada', family: 'Lovelace' }])
  expect(csl.author).toEqual([{ literal: 'Research Council' }])
  expect(csl).toMatchObject({
    language: 'fr',
    'title-short': 'Short',
    accessed: { 'date-parts': [[2026, 9, 8]] }
  })
})

const mountEditor = (overrides: Partial<LiteratureItemInput> = {}): ReturnType<typeof vi.fn> => {
  const onSave = vi.fn()
  render(
    <LiteratureMetadataEditor
      item={{ ...editableItem(), ...overrides }}
      saving={false}
      onSave={onSave}
      onCancel={vi.fn()}
    />
  )
  return onSave
}
const change = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}
const save = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}
const advanced = (): void => {
  const button = screen.getByRole('button', { name: 'Advanced settings' })
  if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button)
}
const choose = (trigger: HTMLElement, value: string): void => {
  fireEvent.keyDown(trigger, { key: 'Enter' })
  fireEvent.click(screen.getByRole('option', { name: value }))
}

it.each(['', '0', '9999'])('accepts an unknown or boundary year: %s', (year) => {
  const onSave = mountEditor({ issuedText: '', issuedYear: undefined })
  change('Year', year)
  save()
  expect(onSave).toHaveBeenCalledOnce()
  expect(literatureItemInputSchema.parse(onSave.mock.calls[0][0]).issuedYear).toBe(
    year ? Number(year) : undefined
  )
})

it.each(['Year', 'Publication date'])(
  'clears both publication values when clearing %s',
  (field) => {
    const onSave = mountEditor()
    change(field, '')
    save()
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ issuedYear: undefined, issuedText: '' })
    )
  }
)

it('requires correction of a leap day after changing to a non-leap year', () => {
  const onSave = mountEditor({ issuedText: '2024-02-29' })
  change('Year', '2025')
  save()
  expect(onSave).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(screen.getByLabelText('Publication date'))
  change('Publication date', '2025-02-28')
  save()
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ issuedText: '2025-02-28', issuedYear: 2025 })
  )
})

it.each(['2025', '2025-04', '2025-04-30'])(
  'derives the year from a publication date: %s',
  (date) => {
    const onSave = mountEditor()
    change('Publication date', date)
    save()
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ issuedText: date, issuedYear: 2025 })
    )
  }
)

it.each(['2025-02-29', '2024-13', '2025-04-31', '2025junk'])(
  'rejects a malformed publication date: %s',
  (date) => {
    const onSave = mountEditor()
    change('Publication date', date)
    save()
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Publication date').getAttribute('aria-invalid')).toBe('true')
  }
)

it.each(['Spring 2024', '2023-03-12'])('preserves an untouched legacy date: %s', (issuedText) => {
  const onSave = mountEditor({ issuedText })
  change('Title', 'Unrelated edit')
  save()
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ issuedText, issuedYear: 2024 }))
})

it('requires an explicit decision before replacing opaque historical date text', () => {
  const onSave = mountEditor({ issuedText: 'Spring 2024' })
  change('Year', '2025')
  save()
  expect(onSave).not.toHaveBeenCalled()
  expect((screen.getByLabelText('Publication date') as HTMLInputElement).value).toBe('Spring 2024')
  change('Publication date', '2025')
  save()
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ issuedText: '2025', issuedYear: 2025 })
  )
})

it('edits extended metadata and projects the selected accessed day in UTC', () => {
  const onSave = mountEditor()
  advanced()
  change('Short title', 'New short title')
  change('Language', 'de')
  change('Rights', 'CC0')
  change('Citation key', 'newKey')
  change('Extra', 'New extra\nSecond line')
  change('Date accessed', '2026-09-09')
  save()
  const item = literatureItemInputSchema.parse(onSave.mock.calls[0][0])
  expect(item).toMatchObject({
    shortTitle: 'New short title',
    language: 'de',
    rights: 'CC0',
    citationKey: 'newKey',
    extra: 'New extra\nSecond line',
    accessedAt: Date.UTC(2026, 8, 9),
    typeFields: { custom: { nested: ['preserve'] } }
  })
  expect(toCslItem('manual', item).accessed).toEqual({ 'date-parts': [[2026, 9, 9]] })
})

it('retains an untouched access timestamp and permits clearing it', () => {
  const accessedAt = Date.UTC(2026, 8, 8, 23, 45)
  const onSave = mountEditor({ accessedAt })
  save()
  expect(onSave.mock.calls[0][0].accessedAt).toBe(accessedAt)
  advanced()
  change('Date accessed', '')
  save()
  expect(onSave.mock.calls[1][0].accessedAt).toBeUndefined()
})

it('blocks access dates outside the existing timestamp contract', () => {
  const onSave = mountEditor()
  advanced()
  change('Date accessed', '1969-12-31')
  save()
  expect(onSave).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(screen.getByLabelText('Date accessed'))
})

it('creates editors and organization translators while restoring inactive names', () => {
  const onSave = mountEditor({ creators: [] })
  fireEvent.click(screen.getByRole('button', { name: /Add (creator|author)/ }))
  choose(screen.getByRole('combobox', { name: 'Creator role' }), 'Editor')
  change('Given name', 'Ada')
  change('Family name', 'Lovelace')
  choose(screen.getByRole('combobox', { name: 'Name type' }), 'Organization')
  change('Organization', 'Research Council')
  choose(screen.getByRole('combobox', { name: 'Name type' }), 'Person')
  expect((screen.getByLabelText('Given name') as HTMLInputElement).value).toBe('Ada')
  save()
  expect(toCslItem('manual', onSave.mock.calls[0][0]).editor).toEqual([
    { given: 'Ada', family: 'Lovelace' }
  ])
  choose(screen.getByRole('combobox', { name: 'Name type' }), 'Organization')
  expect((screen.getByLabelText('Organization') as HTMLInputElement).value).toBe('Research Council')
  choose(screen.getByRole('combobox', { name: 'Creator role' }), 'Translator')
  save()
  const saved = literatureItemInputSchema.parse(onSave.mock.calls[1][0])
  expect(saved.creators).toEqual([
    { nameMode: 'organization', literalName: 'Research Council', creatorType: 'translator' }
  ])
  expect(toCslItem('manual', saved).translator).toEqual([{ literal: 'Research Council' }])
})

it('keeps creator order and inactive names attached to the correct row after deletion', () => {
  const onSave = mountEditor()
  choose(screen.getAllByRole('combobox', { name: 'Name type' })[1], 'Person')
  fireEvent.change(screen.getAllByLabelText('Given name')[1], { target: { value: 'Remember me' } })
  fireEvent.click(screen.getAllByRole('button', { name: /Remove (creator|author)/ })[0])
  choose(screen.getAllByRole('combobox', { name: 'Name type' })[0], 'Organization')
  expect((screen.getByLabelText('Organization') as HTMLInputElement).value).toBe('Research Council')
  save()
  expect(onSave.mock.calls[0][0].creators).toEqual(editableItem().creators.slice(1))
})

it('renders an arbitrary stored role without treating it as an object property', () => {
  const onSave = mountEditor({
    creators: [{ nameMode: 'organization', literalName: 'Archive', creatorType: 'constructor' }]
  })
  expect(screen.getByRole('combobox', { name: 'Creator role' }).textContent).toContain(
    'constructor'
  )
  save()
  expect(onSave.mock.calls[0][0].creators[0].creatorType).toBe('constructor')
})

it('does not treat an incomplete native access-date input as an intentional clear', () => {
  const onSave = mountEditor()
  advanced()
  const input = screen.getByLabelText('Date accessed') as HTMLInputElement
  fireEvent.change(input, { target: { value: '' } })
  // jsdom cannot type into native date segments; Chromium exposes partial input as badInput
  // with an empty value. Keep the probe at that public browser validity boundary.
  Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: true } })
  save()
  expect(onSave).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(input)
})
