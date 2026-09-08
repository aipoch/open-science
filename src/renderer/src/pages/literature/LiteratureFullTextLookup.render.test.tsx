// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  literatureItemInputSchema,
  type LiteratureFullTextRequest,
  type LiteratureItemView
} from '../../../../shared/literature'
import { LiteratureFullTextFinder } from '../../../../main/literature/full-text-finder'
import { LiteratureFullTextLookup } from './LiteratureFullTextLookup'
import { useSettingsStore } from '@/stores/settings-store'

const fullText = vi.fn()
const transfer = vi.fn()
const item: LiteratureItemView = {
  id: 'reference-1',
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  attachments: [],
  collectionIds: [],
  projectIds: [],
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Example paper',
    identifiers: [{ scheme: 'doi', value: '10.1234/example' }]
  })
}
const onUpload = vi.fn()
const props = { item, onUpload, onAdded: vi.fn(), onCompleteMetadata: vi.fn() }
const validate = vi.fn()
const save = vi.fn()
const saveEmail = vi.fn()

describe('LiteratureFullTextLookup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fullText.mockReset()
    transfer.mockReset().mockResolvedValue({ mode: 'transfer' })
    validate.mockResolvedValue({ valid: true })
    save.mockImplementation(async () =>
      useSettingsStore.setState({ openAlex: { hasApiKey: true } })
    )
    useSettingsStore.setState({
      ncbi: { hasApiKey: true },
      setNcbiCredentials: saveEmail.mockImplementation(async ({ contactEmail }) => {
        useSettingsStore.setState({ ncbi: { hasApiKey: true, contactEmail } })
      }),
      openAlex: { hasApiKey: false },
      encryptionAvailable: true,
      loadConnectors: vi.fn().mockResolvedValue(undefined),
      validateOpenAlexCredential: validate,
      setOpenAlexCredential: save
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        literature: {
          fullText: (request: LiteratureFullTextRequest) =>
            request.mode === 'transfer' ? transfer(request) : fullText(request)
        }
      }
    })
  })
  afterEach(cleanup)
  it.each(['attached', 'reopened'])(
    'retries item refresh after a successful %s transfer without reporting download failure',
    async (entry) => {
      const candidate = {
        id: 'candidate',
        provider: 'pmc',
        source: 'PubMed Central',
        url: 'https://pmc.ncbi.nlm.nih.gov/paper.pdf'
      }
      const receipt = {
        mode: 'transfer',
        transfer: {
          id: 'task',
          itemId: item.id,
          status: 'succeeded',
          candidate,
          attachmentId: 'attachment',
          versionId: 'version',
          progress: { phase: 'saving', receivedBytes: 100, totalBytes: 100, bytesPerSecond: 0 }
        }
      }
      fullText.mockResolvedValue({ mode: 'search', candidates: [candidate], notices: [] })
      if (entry === 'reopened') transfer.mockResolvedValue(receipt)
      render(<LiteratureFullTextLookup {...props} />)
      if (entry === 'attached') {
        const add = await screen.findByRole('button', { name: 'Add attachment' })
        fullText.mockResolvedValue(receipt)
        transfer.mockResolvedValue(receipt)
        fireEvent.click(add)
      }
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'Adding PDF…' }) as HTMLButtonElement).disabled
        ).toBe(true)
      )
      const polls = transfer.mock.calls.length
      await waitFor(() => expect(transfer.mock.calls.length).toBeGreaterThan(polls))
      expect(screen.queryByText('PDF could not be added')).toBeNull()
      expect(props.onAdded).not.toHaveBeenCalled()
      transfer.mockResolvedValue({ ...receipt, item })
      await waitFor(() => expect(props.onAdded).toHaveBeenCalledOnce())
      expect(transfer).toHaveBeenCalledWith({
        mode: 'transfer',
        itemId: item.id,
        acknowledgeId: 'task'
      })
    }
  )
  it('reconnects to the running PDF transfer after the lookup is unmounted and reopened', async () => {
    let release!: (bytes: Buffer) => void
    const attachContent = vi.fn(async () => ({ attachmentId: 'attachment', versionId: 'version' }))
    const finder = new LiteratureFullTextFinder({
      catalog: { get: async () => item, attachContent },
      content: {
        publish: async () => ({
          id: 'blob',
          path: 'unused',
          storageKey: 'blob',
          sizeBytes: 10n,
          checksum: 'a'.repeat(64),
          contentType: 'application/pdf'
        })
      },
      openAlexKey: async () => undefined,
      fetch: async (input) =>
        new URL(String(input)).hostname === 'pmc.ncbi.nlm.nih.gov'
          ? Response.json({ records: [] })
          : Response.json({
              resultList: {
                result: [
                  {
                    doi: '10.1234/example',
                    fullTextUrlList: {
                      fullTextUrl: [
                        {
                          availabilityCode: 'OA',
                          documentStyle: 'pdf',
                          site: 'Europe PMC',
                          url: 'https://europepmc.org/paper.pdf'
                        }
                      ]
                    }
                  }
                ]
              }
            }),
      download: async (_url, _limit, report) => {
        report?.({
          receivedBytes: 512,
          totalBytes: 1024,
          bytesPerSecond: 256,
          phase: 'downloading'
        })
        return new Promise<Buffer>((resolve) => {
          release = resolve
        })
      },
      pageCount: async () => 2
    })
    const attached: Promise<unknown>[] = []
    const candidateIds: string[] = []
    fullText.mockImplementation((request) => {
      const result = finder.run(request)
      if (request.mode === 'attach') attached.push(result.catch(() => undefined))
      if (request.mode === 'search')
        void result.then((response) => {
          if (response.mode === 'search') candidateIds.push(response.candidates[0].id)
        })
      return result
    })
    window.api.literature.fullText = fullText
    const first = render(<LiteratureFullTextLookup {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add attachment' }))
    await screen.findByText('512 B of 1.0 KB · 256 B/s')
    first.unmount()
    const reopened = render(<LiteratureFullTextLookup {...props} />)
    try {
      // Re-search must not disconnect the UI from the original download owner.
      await expect
        .soft(
          waitFor(() => {
            expect(screen.queryByRole('progressbar')).not.toBeNull()
          })
        )
        .resolves.toBeUndefined()
      const add = screen.queryByRole('button', { name: 'Add attachment' })
      if (add && !(add as HTMLButtonElement).disabled) {
        fireEvent.click(add)
        await waitFor(() => expect(attached).toHaveLength(2))
        await act(async () => {
          await attached[1]
        })
      }
      expect
        .soft(
          screen.queryByText(
            'PDF could not be added. The link may have expired, require sign-in, or exceed 50 MB. Search again or upload a PDF.'
          )
        )
        .toBeNull()
      // These observations establish that the old transfer still exists and no duplicate commits.
      await expect(
        finder.run({ mode: 'progress', itemId: item.id, candidateId: candidateIds[0] })
      ).resolves.toMatchObject({ progress: { receivedBytes: 512 } })
    } finally {
      await act(async () => {
        release(Buffer.from('%PDF-1.7\n'))
        await Promise.all(attached)
      })
      await waitFor(() => expect(props.onAdded).toHaveBeenCalledTimes(1))
      reopened.unmount()
    }
    expect(attachContent).toHaveBeenCalledTimes(1)
  })

  it('uses a single error surface when full-text search fails', async () => {
    fullText.mockRejectedValue(new Error('offline'))
    render(<LiteratureFullTextLookup {...props} />)
    const alert = await screen.findByRole('alert')
    const surface = within(alert).getByRole('heading').closest('section')!
    expect(surface.classList.contains('border')).toBe(true)
    expect(alert.classList.contains('border')).toBe(false)
  })

  it('configures Unpaywall inline using shared contact email while preserving the NCBI key', async () => {
    fullText.mockResolvedValue({
      mode: 'search',
      candidates: [],
      notices: ['unpaywall-not-configured']
    })
    render(<LiteratureFullTextLookup {...props} />)
    await screen.findByText('No freely accessible full-text PDF was found.')
    fireEvent.click(screen.getByText('Search sources'))
    fireEvent.click(screen.getByRole('button', { name: 'Configure Unpaywall' }))
    fireEvent.change(screen.getByLabelText('Contact email'), {
      target: { value: 'research@lab.org' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Configured')).not.toBeNull()
    expect(saveEmail).toHaveBeenCalledWith({ contactEmail: 'research@lab.org' })
    expect(screen.queryByLabelText('Contact email')).toBeNull()
    // Credential UI can update before the lookup effect starts the new search.
    await waitFor(() => expect(fullText).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove email' }))
    await screen.findByRole('button', { name: 'Configure Unpaywall' })
    expect(saveEmail).toHaveBeenLastCalledWith({ contactEmail: '' })
    await waitFor(() => expect(fullText).toHaveBeenCalledTimes(3))
  })

  it.each(['pmc-unavailable', 'unpaywall-unavailable'])(
    'reports incomplete results for %s',
    async (notice) => {
      fullText.mockResolvedValue({ mode: 'search', candidates: [], notices: [notice] })
      render(<LiteratureFullTextLookup {...props} />)
      expect(await screen.findByRole('alert')).not.toBeNull()
      expect(screen.queryByText('No freely accessible full-text PDF was found.')).toBeNull()
    }
  )
  it.each([true, false])(
    'collapses sources and shows transfer progress with known size: %s',
    async (known) => {
      let finish!: (value: unknown) => void
      fullText.mockImplementation(async (request) => {
        if (request.mode === 'progress')
          return {
            mode: 'progress',
            progress: {
              receivedBytes: 512,
              totalBytes: known ? 1024 : undefined,
              bytesPerSecond: 256,
              phase: 'downloading'
            }
          }
        if (request.mode === 'attach') {
          transfer.mockResolvedValue({
            mode: 'transfer',
            transfer: {
              id: 'task',
              itemId: item.id,
              candidate: {
                id: 'pdf-1',
                provider: 'europe-pmc',
                source: 'Europe PMC',
                url: 'https://europepmc.org/paper.pdf'
              },
              status: 'running',
              progress: {
                receivedBytes: 512,
                totalBytes: known ? 1024 : undefined,
                bytesPerSecond: 256,
                phase: 'downloading'
              }
            }
          })
          return new Promise((resolve) => {
            finish = resolve
          })
        }
        return {
          mode: 'search',
          notices: [],
          candidates: [
            {
              id: 'pdf-1',
              provider: 'europe-pmc',
              source: 'Europe PMC',
              url: 'https://europepmc.org/paper.pdf'
            }
          ]
        }
      })
      const view = render(<LiteratureFullTextLookup {...props} />)
      expect(view.container.querySelector('details')?.open).toBe(false)
      fireEvent.click(await screen.findByRole('button', { name: 'Add attachment' }))
      expect(
        await screen.findByText(known ? '512 B of 1.0 KB · 256 B/s' : '512 B downloaded · 256 B/s')
      ).not.toBeNull()
      expect(screen.getByRole('progressbar').getAttribute('value')).toBe(known ? '50' : null)
      await act(async () => finish({ mode: 'attach', item }))
      expect(screen.queryByRole('progressbar')).toBeNull()
      expect(props.onAdded).toHaveBeenCalledWith(item)
    }
  )

  it('explains a missing main-process handler instead of suggesting provider retries', async () => {
    fullText.mockRejectedValue(new Error("No handler registered for 'literature:full-text'"))
    render(<LiteratureFullTextLookup {...props} />)
    expect(
      await screen.findByText('Restart Open-Science to enable full-text search.')
    ).not.toBeNull()
    expect(screen.queryByText('Full-text search failed. Try again.')).toBeNull()
    fireEvent.click(screen.getByText('Search sources'))
    fireEvent.click(screen.getByRole('button', { name: 'Configure OpenAlex' }))
    expect(screen.getByLabelText('OpenAlex API key')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Add PDF' })).toHaveProperty('disabled', false)
  })

  it('reports provider failures without also claiming no PDF exists', async () => {
    fullText.mockResolvedValue({
      mode: 'search',
      candidates: [],
      notices: ['europe-pmc-unavailable', 'openalex-not-configured']
    })
    render(<LiteratureFullTextLookup {...props} />)
    expect(await screen.findByRole('alert')).not.toBeNull()
    expect(screen.queryByText('No freely accessible full-text PDF was found.')).toBeNull()
    fireEvent.click(screen.getByText('Search sources'))
    fireEvent.click(screen.getByRole('button', { name: 'Configure OpenAlex' }))
    expect(screen.getByLabelText('OpenAlex API key')).not.toBeNull()
  })

  it('validates and saves credentials inline, then refreshes sources without leaving the lookup', async () => {
    fullText.mockResolvedValue({
      mode: 'search',
      candidates: [],
      notices: ['openalex-not-configured']
    })
    render(<LiteratureFullTextLookup {...props} />)
    await screen.findByText('No freely accessible full-text PDF was found.')
    fireEvent.click(screen.getByText('Search sources'))
    fireEvent.click(screen.getByRole('button', { name: 'Configure OpenAlex' }))
    fireEvent.paste(screen.getByLabelText('OpenAlex API key'), {
      clipboardData: { getData: () => 'test-key' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByText('Configured')).not.toBeNull()
    expect(validate).toHaveBeenCalledWith({ apiKey: 'test-key' })
    expect(save).toHaveBeenCalledWith({ apiKey: 'test-key' })
    expect(screen.queryByLabelText('OpenAlex API key')).toBeNull()
    await waitFor(() => expect(fullText).toHaveBeenCalledTimes(2))
  })

  it('keeps a rejected key editable and does not save or restart the search', async () => {
    validate.mockResolvedValue({ valid: false, reason: 'rejected' })
    fullText.mockResolvedValue({ mode: 'search', candidates: [], notices: [] })
    render(<LiteratureFullTextLookup {...props} />)
    await screen.findByText('No freely accessible full-text PDF was found.')
    fireEvent.click(screen.getByText('Search sources'))
    fireEvent.click(screen.getByRole('button', { name: 'Configure OpenAlex' }))
    fireEvent.paste(screen.getByLabelText('OpenAlex API key'), {
      clipboardData: { getData: () => 'bad-key' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByText('OpenAlex rejected this API key.')).not.toBeNull()
    expect(save).not.toHaveBeenCalled()
    expect(fullText).toHaveBeenCalledTimes(1)
  })

  it('shows a source rate limit and prevents another download during the cooldown', async () => {
    fullText.mockImplementation(async (request) =>
      request.mode === 'attach'
        ? { mode: 'attach-error', reason: 'rate-limited', retryAt: Date.now() + 120_000 }
        : {
            mode: 'search',
            notices: [],
            candidates: [
              {
                id: 'pdf',
                source: 'Europe PMC',
                provider: 'europe-pmc',
                url: 'https://europepmc.org/paper.pdf'
              }
            ]
          }
    )
    render(<LiteratureFullTextLookup {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add attachment' }))
    expect(
      await screen.findByText(
        'This source is limiting downloads (HTTP 429). Wait before trying again, choose another source, or upload a PDF.'
      )
    ).not.toBeNull()
    const button = screen.getByRole('button', { name: /Retry in/ })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    expect(fullText.mock.calls.filter(([request]) => request.mode === 'attach')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Open source' }).getAttribute('href')).toBe(
      'https://europepmc.org'
    )
  })

  it('shows source status and retries a transient failure', async () => {
    fullText
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ mode: 'search', candidates: [], notices: ['openalex-not-configured'] })
    render(<LiteratureFullTextLookup {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No freely accessible full-text PDF was found.')).not.toBeNull()
    expect(
      within(screen.getByRole('region', { name: 'Search sources' })).getByText('API key required')
    ).not.toBeNull()
    expect(fullText).toHaveBeenCalledTimes(2)
  })
  it('offers an arXiv-only PDF with accurate source applicability and attaches only after selection', async () => {
    const arxivItem = {
      ...item,
      item: {
        ...item.item,
        identifiers: [{ scheme: 'arxiv' as const, value: '2401.12345', isPrimary: true }]
      }
    }
    fullText.mockImplementation(async (request) =>
      request.mode === 'attach'
        ? { mode: 'attach', item: arxivItem }
        : {
            mode: 'search',
            notices: [],
            candidates: [
              {
                id: 'arxiv-pdf',
                provider: 'arxiv',
                source: 'arXiv',
                url: 'https://arxiv.org/pdf/2401.12345',
                sourceUrl: 'https://arxiv.org/abs/2401.12345'
              }
            ]
          }
    )
    const onAdded = vi.fn()
    render(<LiteratureFullTextLookup {...props} item={arxivItem} onAdded={onAdded} />)
    const add = await screen.findByRole('button', { name: 'Add attachment' })
    expect(fullText.mock.calls.every(([request]) => request.mode === 'search')).toBe(true)
    expect(screen.getByRole('link', { name: 'Open source' }).getAttribute('href')).toBe(
      'https://arxiv.org/abs/2401.12345'
    )
    fireEvent.click(screen.getByText('Search sources'))
    const sources = within(screen.getByRole('region', { name: 'Search sources' }))
    expect(sources.getByText('Direct PDF link')).not.toBeNull()
    expect(sources.queryByText('Search completed')).toBeNull()
    fireEvent.click(add)
    await vi.waitFor(() => expect(onAdded).toHaveBeenCalledWith(arxivItem))
  })
})
