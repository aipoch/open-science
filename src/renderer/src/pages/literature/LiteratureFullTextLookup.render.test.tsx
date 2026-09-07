// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literatureItemInputSchema, type LiteratureItemView } from '../../../../shared/literature'
import { LiteratureFullTextLookup } from './LiteratureFullTextLookup'
import { useSettingsStore } from '@/stores/settings-store'

const fullText = vi.fn()
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
      value: { literature: { fullText } }
    })
  })
  afterEach(cleanup)
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
    expect(fullText).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove email' }))
    await screen.findByRole('button', { name: 'Configure Unpaywall' })
    expect(saveEmail).toHaveBeenLastCalledWith({ contactEmail: '' })
    expect(fullText).toHaveBeenCalledTimes(3)
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
        if (request.mode === 'attach')
          return new Promise((resolve) => {
            finish = resolve
          })
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
      await screen.findByText('Restart Open Science to enable full-text search.')
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
    expect(fullText).toHaveBeenCalledTimes(2)
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
