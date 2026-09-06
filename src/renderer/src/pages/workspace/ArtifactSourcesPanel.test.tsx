// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactLiteratureManifest } from '../../../../shared/artifact-literature'
import { literatureFormatDocumentRequestSchema } from '../../../../shared/literature'
import { useNavigationStore } from '@/stores/navigation-store'
import { ArtifactSourcesPanel } from './ArtifactSourcesPanel'

const literature: ArtifactLiteratureManifest = {
  schemaVersion: 1,
  styleId: 'apa',
  locale: 'en-US',
  references: [
    {
      itemId: 'item-1',
      metadataRevision: 2,
      item: {
        itemType: 'journalArticle',
        title: 'Corrective Retrieval Augmented Generation',
        abstract: '',
        issuedText: '2024',
        issuedYear: 2024,
        containerTitle: 'arXiv',
        shortTitle: 'CRAG',
        language: 'en',
        rights: '',
        url: '',
        extra: '',
        typeFields: {},
        creators: [
          {
            nameMode: 'person',
            givenName: 'Shi-Qi',
            familyName: 'Yan',
            creatorType: 'author'
          }
        ],
        identifiers: [{ scheme: 'arxiv', value: '2401.15884', isPrimary: true }]
      }
    }
  ],
  corpus: {
    items: [{ itemId: 'item-1', metadataRevision: 2 }],
    retrievals: [
      {
        scope: 'project',
        query: 'corrective retrieval',
        resultCount: 10,
        totalCount: 24,
        complete: false
      }
    ],
    coverage: {
      searchedCount: 10,
      candidateCount: 3,
      fullTextCount: 0,
      abstractOnlyCount: 1,
      unprocessedCount: 7
    },
    capturedAt: '2026-09-02T12:00:00.000Z'
  },
  citations: [
    {
      citationId: 'citation-1',
      itemId: 'item-1',
      metadataRevision: 2,
      locator: { label: 'page', value: '7' }
    }
  ]
}

const get = vi.fn()
const formatDocument = vi.fn()

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  get.mockResolvedValue({
    id: 'item-1',
    metadataRevision: 2,
    item: literature.references[0]!.item,
    projectIds: [],
    collectionIds: [],
    attachments: [],
    lifecycle: 'active',
    createdAt: 1,
    updatedAt: 2
  })
  formatDocument.mockImplementation(async (input: unknown) => {
    const request = literatureFormatDocumentRequestSchema.parse(input)
    return request.mode === 'preview'
      ? {
          mode: 'preview',
          references: [
            {
              itemId: 'item-1',
              inText: '[1]',
              reference: '1. Corrective Retrieval Augmented Generation.'
            }
          ]
        }
      : { mode: 'save', versionId: 'version-2', versionNumber: 2 }
  })
  window.api = {
    literature: {
      get,
      citationStyles: vi.fn().mockResolvedValue({
        styles: [
          { id: 'apa', title: 'APA', source: 'built-in' },
          { id: 'vancouver', title: 'Vancouver', source: 'built-in' }
        ]
      }),
      formatDocument
    }
  } as unknown as Window['api']
})

afterEach(() => {
  document.body.replaceChildren()
  useNavigationStore.setState({ view: 'home', pendingLiteratureItemId: undefined })
  vi.clearAllMocks()
})

describe('ArtifactSourcesPanel', () => {
  it('presents frozen bibliographic snapshots without exposing manifest JSON', async () => {
    render(<ArtifactSourcesPanel literature={literature} />)

    expect(screen.getByRole('heading', { name: 'Literature' })).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Frozen review corpus' })).not.toBeNull()
    expect(screen.getByText('1 reference')).not.toBeNull()
    expect(await screen.findByText('APA')).not.toBeNull()
    expect(screen.getByText(/This project/)).not.toBeNull()
    expect(screen.getByText(/corrective retrieval/)).not.toBeNull()
    expect(screen.getByText(/10 \/ 24/)).not.toBeNull()
    for (const label of [
      'Searched',
      'Candidates',
      'Included',
      'Full text',
      'Abstract only',
      'Unprocessed'
    ]) {
      expect(screen.getByText(label)).not.toBeNull()
    }
    expect(screen.getByText('Corrective Retrieval Augmented Generation')).not.toBeNull()
    expect(screen.getByText('Yan, Shi-Qi')).not.toBeNull()
    expect(screen.getByText('2024 · arXiv')).not.toBeNull()
    expect(document.body.textContent).not.toContain('item-1')
  })

  it('opens the matching reference in a modal without leaving the Artifact', async () => {
    render(<ArtifactSourcesPanel literature={literature} />)

    fireEvent.click(
      screen.getByRole('button', {
        name: `View details: ${literature.references[0]!.item.title}`
      })
    )

    const dialog = screen.getByRole('dialog')
    expect(
      within(dialog).getByRole('heading', { name: literature.references[0]!.item.title })
    ).not.toBeNull()
    await waitFor(() => expect(get).toHaveBeenCalledWith('item-1'))
    expect(useNavigationStore.getState()).toMatchObject({ view: 'home' })
  })

  it('keeps the frozen reference visible when it no longer exists in the Library', async () => {
    get.mockResolvedValueOnce(undefined)
    render(<ArtifactSourcesPanel literature={literature} />)

    fireEvent.click(
      screen.getByRole('button', {
        name: `View details: ${literature.references[0]!.item.title}`
      })
    )

    const dialog = screen.getByRole('dialog')
    expect(
      await within(dialog).findByText('This reference is no longer in your Library.')
    ).not.toBeNull()
    expect(
      within(dialog).getByRole('heading', { name: literature.references[0]!.item.title })
    ).not.toBeNull()
    expect(useNavigationStore.getState()).toMatchObject({ view: 'home' })
  })

  it('formats organization creators without inventing person-name punctuation', () => {
    render(
      <ArtifactSourcesPanel
        literature={{
          ...literature,
          references: [
            {
              ...literature.references[0]!,
              item: {
                ...literature.references[0]!.item,
                creators: [
                  {
                    nameMode: 'organization',
                    literalName: 'Open Science Consortium',
                    creatorType: 'author'
                  }
                ]
              }
            }
          ]
        }}
      />
    )
    expect(screen.getByText('Open Science Consortium')).not.toBeNull()
    expect(screen.getByText('2024 · arXiv')).not.toBeNull()
  })

  it('previews a selected style before saving it as a new Artifact Version', async () => {
    render(
      <ArtifactSourcesPanel
        literature={literature}
        formatContext={{
          projectId: 'project-1',
          sessionId: 'session-1',
          artifactId: 'artifact-1',
          versionId: 'version-1',
          expectedHeadVersionId: 'version-1'
        }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Format citations' }))
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Citation style' }).textContent).toContain('APA')
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Citation style' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Vancouver' }))

    expect(await screen.findByText('1. Corrective Retrieval Augmented Generation.')).not.toBeNull()
    expect(formatDocument).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'preview', styleId: 'vancouver' })
    )
    expect(formatDocument).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'save' }))

    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }))
    await waitFor(() =>
      expect(formatDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'save',
          styleId: 'vancouver',
          expectedHeadVersionId: 'version-1'
        })
      )
    )
    expect(await screen.findByText('Saved as version 2.')).not.toBeNull()
  })

  it('locks the style selection while a new Artifact Version is being saved', async () => {
    let resolveSave!: (value: { mode: 'save'; versionId: string; versionNumber: number }) => void
    const saveResult = new Promise<{ mode: 'save'; versionId: string; versionNumber: number }>(
      (resolve) => {
        resolveSave = resolve
      }
    )
    formatDocument.mockImplementation(async (request: { mode: 'preview' | 'save' }) =>
      request.mode === 'preview'
        ? {
            mode: 'preview',
            references: [
              {
                itemId: 'item-1',
                inText: '[1]',
                reference: '1. Corrective Retrieval Augmented Generation.'
              }
            ]
          }
        : saveResult
    )
    render(
      <ArtifactSourcesPanel
        literature={literature}
        formatContext={{
          projectId: 'project-1',
          sessionId: 'session-1',
          artifactId: 'artifact-1',
          versionId: 'version-1',
          expectedHeadVersionId: 'version-1'
        }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Format citations' }))
    fireEvent.click(await screen.findByRole('combobox', { name: 'Citation style' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Vancouver' }))
    await screen.findByText('1. Corrective Retrieval Augmented Generation.')
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }))

    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: 'Citation style' }).hasAttribute('disabled')
      ).toBe(true)
    )
    resolveSave({ mode: 'save', versionId: 'version-2', versionNumber: 2 })
    expect(await screen.findByText('Saved as version 2.')).not.toBeNull()
  })
})
