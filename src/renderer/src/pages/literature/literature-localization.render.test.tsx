// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { LiteratureCitationStyleLibrary } from '../../../../main/literature/citation-style-library'
import {
  toApplicationCommandErrorEnvelope,
  unwrapApplicationCommandOutcome
} from '../../../../shared/application-command-contract'
import {
  LITERATURE_COLLECTION_NAME_CONFLICT,
  LITERATURE_ITEM_TYPES,
  literatureItemInputSchema,
  type LiteratureItemType,
  type LiteratureItemView
} from '../../../../shared/literature'
import { CollectionEditorDialog, type CollectionEditorDialogHandle } from './CollectionEditorDialog'
import { CitationStylesView } from './CitationStylesView'
import { LiteratureMergeReview } from './LiteratureMergeReview'
import { LiteratureMetadataEditor } from './LiteratureMetadataEditor'

const previousApi = window.api
const roots: string[] = []
const locales = ['de', 'es', 'fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'ru'] as const
const switchLanguage = async (language: string): Promise<void> => {
  await act(async () => {
    await i18next.changeLanguage(language)
  })
}

afterEach(async () => {
  cleanup()
  window.api = previousApi
  await switchLanguage('en')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([
  ['create', 'offline', 'Collection could not be created.'],
  ['edit', 'offline', 'Collection could not be updated.'],
  [
    'create',
    LITERATURE_COLLECTION_NAME_CONFLICT,
    'A collection with this name already exists at this level. Choose another name.'
  ]
] as const)(
  'retranslates an existing %s error (%s) without losing the draft or retry target',
  async (mode, cause, message) => {
    const transact = vi.fn().mockRejectedValueOnce(new Error(cause)).mockResolvedValue({})
    window.api = { literature: { transact } } as unknown as Window['api']
    const ref = createRef<CollectionEditorDialogHandle>()
    const onSaved = vi.fn()
    render(<CollectionEditorDialog ref={ref} onSaved={onSaved} />)
    act(() => {
      if (mode === 'create') ref.current!.openCreate()
      else
        ref.current!.openEdit({
          id: 'collection-a',
          name: 'Existing',
          description: '',
          itemCount: 0,
          createdAt: 1,
          updatedAt: 1
        })
    })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Research 北京' } })
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Draft description' }
    })
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: mode === 'create' ? 'Create collection' : 'Save changes'
        })
      )
    })
    expect(screen.getByRole('alert').textContent).toBe(message)
    const dialog = screen.getByRole('dialog')
    await switchLanguage('zh-Hans')
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(
      screen.getByRole('heading', {
        name: i18next.t(mode === 'create' ? 'New collection' : 'Edit collection')
      })
    ).toBeTruthy()
    expect((screen.getByLabelText(i18next.t('Name')) as HTMLInputElement).value).toBe(
      'Research 北京'
    )
    expect((screen.getByLabelText(i18next.t('Description')) as HTMLTextAreaElement).value).toBe(
      'Draft description'
    )
    const retry = screen.getByRole('button', {
      name: i18next.t(mode === 'create' ? 'Create collection' : 'Save changes')
    })
    expect(i18next.t(message)).not.toBe(message)
    expect.soft(screen.getByRole('alert').textContent).toBe(i18next.t(message))
    await act(async () => {
      fireEvent.click(retry)
    })
    expect(transact).toHaveBeenCalledTimes(2)
    expect(transact.mock.calls[1]).toEqual(transact.mock.calls[0])
    expect(onSaved).toHaveBeenCalledWith({
      id: mode === 'edit' ? 'collection-a' : undefined,
      name: 'Research 北京',
      description: 'Draft description'
    })
  }
)

const importInvalidStyle = async (
  content: string,
  transport: 'electron' | 'web' = 'electron'
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'literature-i18n-'))
  roots.push(root)
  const library = new LiteratureCitationStyleLibrary(join(root, 'styles'))
  const citationStyles = vi.fn(async (request: { kind: string; content: string }) => {
    expect(request.kind).toBe('import')
    try {
      await library.import(request.content)
      return { styles: [] }
    } catch (cause) {
      const error = JSON.parse(JSON.stringify(toApplicationCommandErrorEnvelope(cause)))
      // Electron copies plain rejections; Web reconstructs errors in the renderer realm.
      if (transport === 'electron') throw error
      return unwrapApplicationCommandOutcome({ ok: false, error })
    }
  })
  window.api = { literature: { citationStyles } } as unknown as Window['api']
  const onStylesChange = vi.fn()
  render(<CitationStylesView styles={[]} onBack={vi.fn()} onStylesChange={onStylesChange} />)
  expect(screen.getByRole('button', { name: i18next.t('Import CSL') })).toBeTruthy()
  const file = new File([content], 'invalid.csl', { type: 'application/xml' })
  Object.defineProperty(file, 'text', { value: async () => content })
  await act(async () => {
    fireEvent.change(screen.getByLabelText(i18next.t('Import CSL'), { selector: 'input' }), {
      target: { files: [file] }
    })
  })
  expect(citationStyles).toHaveBeenCalledExactlyOnceWith({ kind: 'import', content })
  expect(onStylesChange).not.toHaveBeenCalled()
  return screen.getByRole('alert').textContent ?? ''
}

it.each(locales)('localizes real invalid CSL XML in %s', async (locale) => {
  await switchLanguage(locale)
  const message = await importInvalidStyle('<', 'web')
  expect(message).not.toBe('The selected file is not valid CSL XML.')
  expect(message).toBe(i18next.t('The selected file is not valid CSL XML.'))
  await switchLanguage('en')
  expect(screen.getByRole('alert').textContent).toBe('The selected file is not valid CSL XML.')
  await switchLanguage(locale)
  expect(screen.getByRole('alert').textContent).toBe(message)
})

const csl = (info: string, citation = '<text variable="title"/>'): string =>
  `<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0"><info>${info}</info><citation><layout>${citation}</layout></citation><bibliography><layout><text variable="title"/></layout></bibliography></style>`
it.each([
  [
    'missing title',
    csl('<id>https://example.test/style</id>'),
    'The CSL style must include a title and an id.'
  ],
  [
    'missing id',
    csl('<title>Original title</title>'),
    'The CSL style must include a title and an id.'
  ],
  [
    'dependent style',
    csl(
      '<title>Original title</title><id>https://example.test/style</id><link rel="independent-parent" href="https://example.test/parent"/>'
    ),
    'Dependent CSL styles are not supported yet. Import an independent style.'
  ]
])('localizes a real %s validation error', async (_name, content, english) => {
  await switchLanguage('zh-Hans')
  const message = await importInvalidStyle(content)
  expect(message).not.toBe(english)
  expect(message).toBe(i18next.t(english))
})

it('localizes an undefined CSL macro while preserving its exact name', async () => {
  await switchLanguage('zh-Hans')
  const macro = 'author-原名'
  const message = await importInvalidStyle(
    csl(
      '<title>Original title</title><id>https://example.test/style</id>',
      `<text macro="${macro}"/>`
    )
  )
  expect.soft(message).toContain(macro)
  expect(message).not.toBe(`The CSL style references an undefined macro: ${macro}`)
  expect(message).toBe(
    i18next.t('The CSL style references an undefined macro: {{macro}}', { macro })
  )
})

it.each(locales)(
  'uses the editor Place label in merge headings and choices in %s',
  async (locale) => {
    await switchLanguage(locale)
    const entries: LiteratureItemView[] = ['北京', 'Paris'].map((place, index) => ({
      id: `reference-${index}`,
      item: literatureItemInputSchema.parse({
        itemType: 'book',
        title: index === 0 ? '原书名' : 'Original title',
        typeFields: { publisherPlace: place }
      }),
      metadataRevision: 1,
      createdAt: 1,
      updatedAt: 1,
      attachments: [],
      collectionIds: [],
      projectIds: []
    }))
    const editor = render(
      <LiteratureMetadataEditor
        item={entries[0].item}
        saving={false}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    const label = i18next.t('Place')
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('北京')
    editor.unmount()
    const onSourceChange = vi.fn()
    render(
      <LiteratureMergeReview
        entries={entries}
        survivorId={entries[0].id}
        onSurvivorChange={vi.fn()}
        sources={{}}
        onSourceChange={onSourceChange}
        fieldLabel={(field) => field}
        creatorLabel={() => ''}
        itemTypeLabels={
          Object.fromEntries(LITERATURE_ITEM_TYPES.map((type) => [type, type])) as Record<
            LiteratureItemType,
            string
          >
        }
        disabled={false}
      />
    )
    expect(screen.getAllByText('原书名').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Original title').length).toBeGreaterThan(0)
    expect(screen.getByText('北京')).toBeTruthy()
    expect(screen.getByText('Paris')).toBeTruthy()
    expect.soft(screen.queryByText('publisherPlace')).toBeNull()
    expect.soft(screen.queryByText(label)).not.toBeNull()
    const choice = screen.getByRole('radio', {
      name: i18next.t('Use {{field}} from reference {{number}}', { field: label, number: 2 })
    })
    fireEvent.click(choice)
    expect(onSourceChange).toHaveBeenCalledWith('type:publisherPlace', entries[1].id)
  }
)

it.each([
  ['list', 'Citation styles could not be loaded. Please try again.'],
  ['import', 'The CSL style could not be imported. Please try again.'],
  ['delete', 'The CSL style could not be deleted. Please try again.']
] as const)(
  'localizes unknown %s errors without exposing raw diagnostics',
  async (kind, message) => {
    await switchLanguage('zh-Hans')
    const citationStyles = vi.fn().mockRejectedValue(new Error('EACCES: /private/style.csl'))
    window.api = { literature: { citationStyles } } as unknown as Window['api']
    await act(async () => {
      render(
        <CitationStylesView
          styles={
            kind === 'list'
              ? undefined
              : [{ id: 'custom:style', title: 'Original title', source: 'custom' }]
          }
          onBack={vi.fn()}
          onStylesChange={vi.fn()}
        />
      )
    })
    if (kind === 'delete') {
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', {
            name: i18next.t('Delete {{style}}', { style: 'Original title' })
          })
        )
      })
    } else if (kind === 'import') {
      const file = new File(['<'], 'invalid.csl')
      Object.defineProperty(file, 'text', { value: async () => '<' })
      await act(async () => {
        fireEvent.change(screen.getByLabelText(i18next.t('Import CSL'), { selector: 'input' }), {
          target: { files: [file] }
        })
      })
    }
    expect(screen.getByRole('alert').textContent).toBe(i18next.t(message))
    expect(screen.getByRole('alert').textContent).not.toContain('/private')
    await switchLanguage('en')
    expect(screen.getByRole('alert').textContent).toBe(message)
  }
)
