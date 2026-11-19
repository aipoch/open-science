// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LabView } from '../../../../shared/lab'
import type {
  OrgCaseDetail,
  OrgCaseDownloadSnapshot,
  OrgCaseItem,
  OrgCasesPage
} from '../../../../shared/org-cases'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../shared/web-caller-location'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../../shared/web-event-connection'
import { useSettingsStore } from '@/stores/settings-store'
import { useOrgCaseStore } from '@/stores/org-cases-store'
import { UseCaseCarousel } from './UseCaseCarousel'
import { useUseCaseGalleryStore } from './use-case-gallery-store'

function makeOrgCase(overrides: Partial<OrgCaseItem> = {}): OrgCaseItem {
  return {
    id: 'case_1',
    name: 'RNA-seq Differential Expression',
    code: '7Q2M9X4B',
    description: 'Replace sample sheet before rerunning the notebook.',
    size_bytes: 2048,
    sha256: 'a'.repeat(64),
    created_at: '2026-11-17T00:00:00Z',
    owner: { id: 'usr_1', display_name: 'Alice' },
    can_delete: false,
    summary: {
      schema_version: 1,
      features: ['content-dedupe'],
      file_count: 12,
      total_bytes: 900_000,
      excluded_files: 2,
      omission_count: 3,
      omissions: [{ kind: 'missing', description: 'raw fastq excluded from bundle' }]
    },
    ...overrides
  }
}

describe('UseCaseCarousel organization cases source', () => {
  let downloadListeners: Set<(snapshot: OrgCaseDownloadSnapshot | null) => void>

  const setupWindowApi = (
    overrides: Record<string, unknown> = {}
  ): Record<string, ReturnType<typeof vi.fn>> => {
    downloadListeners = new Set()
    const sessions = {
      useCaseCatalog: vi.fn(async () => [
        {
          slug: 'official-1',
          title: 'Official Case',
          imageUrl: 'https://example.test/cover.png',
          packageUrl: 'https://example.test/official.science',
          sha256: 'b'.repeat(64),
          sizeBytes: 100
        }
      ]),
      useCaseIntroduction: vi.fn(async () => null),
      importPackage: vi.fn(async () => null),
      packageOperation: vi.fn(async () => null),
      onPackageOperation: vi.fn(() => () => undefined),
      orgCasesList: vi.fn(async () => ({
        ok: true as const,
        page: { items: [makeOrgCase()], total: 1, page: 1, page_size: 20 }
      })),
      orgCaseDetail: vi.fn(async (id: string) => ({
        ok: true as const,
        case: {
          ...makeOrgCase({ id }),
          original_filename: 'rnaseq.science'
        } satisfies OrgCaseDetail
      })),
      orgCaseImport: vi.fn(async (id: string) => ({ status: 'handed-off' as const, caseId: id })),
      orgCaseCancelImport: vi.fn(async () => ({ cancelled: true })),
      onOrgCaseDownload: vi.fn((listener: (snapshot: OrgCaseDownloadSnapshot | null) => void) => {
        downloadListeners.add(listener)
        return () => {
          downloadListeners.delete(listener)
        }
      }),
      ...overrides
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { sessions }
    })
    return sessions
  }

  beforeEach(() => {
    useOrgCaseStore.getState().reset()
    useUseCaseGalleryStore.setState(useUseCaseGalleryStore.getInitialState(), true)
    useSettingsStore.setState({
      lab: {
        state: 'authenticated',
        serverUrl: 'https://lab.example.com',
        accountId: 'usr_1',
        accountName: 'Alice',
        orgId: 'org_1'
      } as LabView
    })
  })

  afterEach(() => {
    cleanup()
    document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
    document.documentElement.removeAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)
    useOrgCaseStore.getState().reset()
    vi.restoreAllMocks()
  })

  it('switches to Organization source, searches by name/code, paginates, and opens details dialog on home', async () => {
    const firstItem = makeOrgCase({ id: 'case_1', name: 'Proteomics Run', code: '7Q2M9X4B' })
    const secondItem = makeOrgCase({ id: 'case_2', name: 'Metabolomics Run', code: '9K4P2W8Z' })
    const orgCasesList = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        page: { items: [firstItem], total: 2, page: 1, page_size: 1 }
      })
      .mockResolvedValueOnce({
        ok: true as const,
        page: { items: [secondItem], total: 2, page: 2, page_size: 1 }
      })
      .mockResolvedValueOnce({
        ok: true as const,
        page: { items: [firstItem], total: 1, page: 1, page_size: 20 }
      })

    const sessions = setupWindowApi({ orgCasesList })

    render(<UseCaseCarousel variant="marketplace" />)

    fireEvent.click(screen.getByTestId('use-case-source-organization'))

    await waitFor(() => expect(screen.getByText('Proteomics Run')).toBeTruthy())
    expect(screen.getByText('7Q2M9X4B')).toBeTruthy()
    expect(screen.getByText('Showing 1 of 2 organization cases')).toBeTruthy()

    // Pagination
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(screen.getByText('Metabolomics Run')).toBeTruthy())

    // Explicit search submit by share code
    const searchInput = screen.getByRole('textbox', { name: 'Search organization cases' })
    fireEvent.change(searchInput, { target: { value: '7Q2M9X4B' } })
    fireEvent.keyDown(searchInput, { key: 'Enter' })

    await waitFor(() =>
      expect(orgCasesList).toHaveBeenCalledWith({
        q: '7Q2M9X4B',
        page: 1,
        pageSize: 20
      })
    )

    // View details dialog/page (variant="marketplace" without compact opens dialog)
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0])
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(sessions.orgCaseDetail).toHaveBeenCalledWith('case_1'))
    expect(within(dialog).getByText('rnaseq.science')).toBeTruthy()
    expect(within(dialog).getByText('raw fastq excluded from bundle')).toBeTruthy()
    expect(within(dialog).getByText('+2 additional omissions')).toBeTruthy()
  })

  it('shows the storage configuration notice until sign-out returns to the official cases', async () => {
    const orgCasesList = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'storage-not-configured' as const
    }))
    setupWindowApi({ orgCasesList })

    render(<UseCaseCarousel variant="marketplace" />)
    fireEvent.click(screen.getByTestId('use-case-source-organization'))

    await waitFor(() => expect(screen.getByText('Case sharing is not configured')).toBeTruthy())
    expect(screen.queryByText('No organization cases yet')).toBeNull()

    await act(async () => {
      useSettingsStore.setState({
        lab: { state: 'signedOut', serverUrl: 'https://lab.example.com' } as LabView
      })
    })
    expect(screen.queryByRole('tablist', { name: 'Case source' })).toBeNull()
    expect(screen.queryByText('Case sharing is not configured')).toBeNull()
    expect(screen.getByRole('article', { name: 'Official Case' })).toBeTruthy()
  })

  it('streams download progress, allows cancelling, and displays verification errors without closing detail dialog on failure', async () => {
    let resolveImport:
      | ((value: { status: 'failed'; caseId: string; errorCode: 'verification-failed' }) => void)
      | undefined
    const orgCaseImport = vi.fn(
      () =>
        new Promise<{ status: 'failed'; caseId: string; errorCode: 'verification-failed' }>(
          (resolve) => {
            resolveImport = resolve
          }
        )
    )
    const sessions = setupWindowApi({ orgCaseImport })

    render(<UseCaseCarousel variant="home" />)
    fireEvent.click(screen.getByTestId('use-case-source-organization'))
    await waitFor(() => expect(screen.getByText('RNA-seq Differential Expression')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(orgCaseImport).toHaveBeenCalledWith('case_1'))

    await act(async () => {
      for (const listener of downloadListeners) {
        listener({
          caseId: 'case_1',
          name: 'RNA-seq Differential Expression',
          code: '7Q2M9X4B',
          state: 'downloading',
          completedBytes: 1024,
          totalBytes: 2048
        })
      }
    })
    expect(screen.getByText('Downloading 50%')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(sessions.orgCaseCancelImport).toHaveBeenCalledWith('case_1')

    await act(async () => {
      resolveImport?.({ status: 'failed', caseId: 'case_1', errorCode: 'verification-failed' })
    })
    await waitFor(() => expect(screen.getByText('Package verification failed')).toBeTruthy())
  })

  it.each([
    { scope: 'organization switch', change: { orgId: 'org_2' } },
    { scope: 'same-name account switch', change: { accountId: 'usr_2' } }
  ])('clears old Lab cases and ignores late results on $scope', async ({ change }) => {
    const oldCase = makeOrgCase({ name: 'Previous Account Study' })
    const oldRequest = Promise.withResolvers<{ ok: true; page: OrgCasesPage }>()
    const orgCasesList = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        page: { items: [oldCase], total: 1, page: 1, page_size: 20 }
      })
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({
        ok: true as const,
        page: {
          items: [makeOrgCase({ id: 'case_current', name: 'Current Account Study' })],
          total: 1,
          page: 1,
          page_size: 20
        }
      })

    setupWindowApi({ orgCasesList })

    render(<UseCaseCarousel variant="marketplace" />)
    fireEvent.click(screen.getByTestId('use-case-source-organization'))
    expect(await screen.findByText(oldCase.name)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh organization cases' }))
    expect(orgCasesList).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('rnaseq.science')).toBeTruthy()

    const refreshedLab = {
      ...useSettingsStore.getState().lab!,
      accountName: 'Alice Chen',
      modelCount: 2
    }
    act(() => useSettingsStore.setState({ lab: refreshedLab }))
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(orgCasesList).toHaveBeenCalledTimes(2)

    act(() => useSettingsStore.setState({ lab: { ...refreshedLab, ...change } }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText(oldCase.name)).toBeNull()

    await act(async () => {
      oldRequest.resolve({
        ok: true,
        page: {
          items: [makeOrgCase({ id: 'case_stale', name: 'Late Result' })],
          total: 1,
          page: 1,
          page_size: 20
        }
      })
    })

    expect(await screen.findByText('Current Account Study')).toBeTruthy()
    expect(screen.queryByText('Late Result')).toBeNull()
  })

  it('supports compact marketplace inline OrgCaseDetailsPage navigation and handoff import', async () => {
    const sessions = setupWindowApi()

    render(<UseCaseCarousel variant="marketplace" compact />)
    fireEvent.click(screen.getByTestId('use-case-source-organization'))

    await waitFor(() => expect(screen.getByText('RNA-seq Differential Expression')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    const detailsRegion = await screen.findByRole('region', { name: 'Organization case details' })
    expect(within(detailsRegion).getByText('Package summary')).toBeTruthy()
    await waitFor(() => expect(sessions.orgCaseDetail).toHaveBeenCalledWith('case_1'))

    fireEvent.click(within(detailsRegion).getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(sessions.orgCaseImport).toHaveBeenCalledWith('case_1'))

    fireEvent.click(within(detailsRegion).getByRole('button', { name: 'Back to list' }))
    expect(screen.queryByRole('region', { name: 'Organization case details' })).toBeNull()
  })

  it('deduplicates debounced Marketplace search, clears query on org switch, guards double-import, and closes details before Lab Settings', async () => {
    const openSettingsToPanel = vi.fn()
    useSettingsStore.setState({ openSettingsToPanel })

    let resolveImport: ((value: { status: 'handed-off'; caseId: string }) => void) | undefined
    const orgCaseImport = vi.fn(
      () =>
        new Promise<{ status: 'handed-off'; caseId: string }>((resolve) => {
          resolveImport = resolve
        })
    )
    const orgCasesList = vi.fn(async () => ({
      ok: true as const,
      page: { items: [makeOrgCase()], total: 1, page: 1, page_size: 20 }
    }))
    const orgCaseDetail = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'forbidden' as const
    }))

    setupWindowApi({ orgCasesList, orgCaseDetail, orgCaseImport })

    render(<UseCaseCarousel variant="marketplace" />)
    fireEvent.click(screen.getByTestId('use-case-source-organization'))
    await waitFor(() => expect(orgCasesList).toHaveBeenCalledTimes(1))

    // Debounced Marketplace search should fire once (not duplicated by OrgCaseSectionContent).
    const searchInput = screen.getByRole('textbox', { name: 'Search organization cases' })
    fireEvent.change(searchInput, { target: { value: 'RNA' } })
    await waitFor(() =>
      expect(orgCasesList).toHaveBeenCalledWith({ q: 'RNA', page: 1, pageSize: 20 })
    )
    expect(orgCasesList).toHaveBeenCalledTimes(2)

    // Rapid double-click on Import should only invoke orgCaseImport once while active.
    const importBtn = screen.getByRole('button', { name: 'Import' })
    fireEvent.click(importBtn)
    fireEvent.click(importBtn)
    await waitFor(() => expect(orgCaseImport).toHaveBeenCalledTimes(1))
    await act(async () => {
      resolveImport?.({ status: 'handed-off', caseId: 'case_1' })
    })

    // Opening details with forbidden detail error shows Open Lab Settings and closes dialog on click.
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    const dialog = await screen.findByRole('dialog')
    const settingsBtn = await within(dialog).findByRole('button', { name: 'Open Lab Settings' })
    fireEvent.click(settingsBtn)
    expect(openSettingsToPanel).toHaveBeenCalledWith('lab')
    expect(screen.queryByRole('dialog')).toBeNull()

    // Switching organization resets stale search query text.
    await act(async () => {
      useSettingsStore.setState({
        lab: {
          state: 'authenticated',
          serverUrl: 'https://lab.example.com',
          accountName: 'Alice',
          orgId: 'org_2'
        } as LabView
      })
    })
    await waitFor(() =>
      expect(
        (screen.getByRole('textbox', { name: 'Search organization cases' }) as HTMLInputElement)
          .value
      ).toBe('')
    )
  })

  it('keeps the original compact case library layout when signed out or expired', async () => {
    const authenticatedLab = useSettingsStore.getState().lab
    useSettingsStore.setState({ lab: { state: 'signedOut' } })
    const { orgCasesList } = setupWindowApi()
    render(<UseCaseCarousel variant="marketplace" compact />)

    expect(await screen.findByRole('article', { name: 'Official Case' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View in case library' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh examples' })).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: 'Case source' })).toBeNull()
    expect(orgCasesList).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search examples' }), {
      target: { value: 'Official' }
    })

    act(() => useSettingsStore.setState({ lab: authenticatedLab }))
    expect(screen.getByRole('tab', { name: 'Official', selected: true })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Organization' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Details' }))
    expect(await screen.findByRole('region', { name: 'Organization case details' })).toBeTruthy()

    act(() => useSettingsStore.setState({ lab: { state: 'expired' } }))
    expect(screen.queryByRole('tablist', { name: 'Case source' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Organization case details' })).toBeNull()
    expect(screen.getByRole('article', { name: 'Official Case' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Search examples' })).toHaveProperty(
      'value',
      'Official'
    )

    act(() => useSettingsStore.setState({ lab: authenticatedLab }))
    expect(screen.getByRole('tab', { name: 'Official', selected: true })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Organization' }))
    expect(
      await screen.findByRole('article', { name: 'RNA-seq Differential Expression' })
    ).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Organization case details' })).toBeNull()
  })

  it('keeps the home carousel hidden when signed out and the official catalog is empty', async () => {
    useSettingsStore.setState({ lab: { state: 'signedOut' } })
    setupWindowApi({ useCaseCatalog: vi.fn(async () => []) })

    const { container } = render(<UseCaseCarousel variant="home" />)
    await waitFor(() => expect(useUseCaseGalleryStore.getState().items).toEqual([]))
    expect(container.firstChild).toBeNull()
  })

  it('hides the source switch on Remote Web and signed-out Local Web and scopes detail selection per mount', async () => {
    const orgCasesList = vi.fn(async () => ({
      ok: true as const,
      page: { items: [makeOrgCase()], total: 1, page: 1, page_size: 20 }
    }))
    setupWindowApi({ orgCasesList })
    useOrgCaseStore.setState({ source: 'organization' })

    // Remote Web must hide Organization source and avoid LOCAL IPC calls
    document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
    document.documentElement.setAttribute(WEB_CALLER_LOCATION_ATTRIBUTE, 'remote')
    const remoteRender = render(<UseCaseCarousel variant="marketplace" />)
    expect(screen.queryByTestId('use-case-source-organization')).toBeNull()
    expect(orgCasesList).not.toHaveBeenCalled()
    remoteRender.unmount()

    // Signed-out Local Web shows the original home carousel.
    document.documentElement.setAttribute(WEB_CALLER_LOCATION_ATTRIBUTE, 'local')
    useSettingsStore.setState({
      lab: { state: 'signedOut', serverUrl: 'https://lab.example.com' } as LabView
    })
    const localRender = render(<UseCaseCarousel variant="home" />)
    expect(await screen.findByRole('article', { name: 'Official Case' })).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: 'Case source' })).toBeNull()
    localRender.unmount()

    // Switching from compact Marketplace detail view back to Home does not leak open details dialog
    document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
    document.documentElement.removeAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)
    useSettingsStore.setState({
      lab: {
        state: 'authenticated',
        serverUrl: 'https://lab.example.com',
        accountName: 'Alice',
        orgId: 'org_1'
      } as LabView
    })
    const compactView = render(<UseCaseCarousel variant="marketplace" compact />)
    fireEvent.click(screen.getByRole('tab', { name: 'Organization' }))
    await waitFor(() => expect(screen.getByText('RNA-seq Differential Expression')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(await screen.findByRole('region', { name: 'Organization case details' })).toBeTruthy()
    compactView.unmount()

    render(<UseCaseCarousel variant="home" />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('retries failed pagination append against page 2, shows Open Lab Settings when non-empty list fails with forbidden, and clears items on non-append catch', async () => {
    const firstItem = makeOrgCase({ id: 'case_1', name: 'Page 1 Item', code: '7Q2M9X4B' })
    const secondItem = makeOrgCase({ id: 'case_2', name: 'Page 2 Item', code: '9K4P2W8Z' })
    const orgCasesList = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        page: { items: [firstItem], total: 2, page: 1, page_size: 1 }
      })
      .mockResolvedValueOnce({ ok: false as const, errorCode: 'network' as const })
      .mockResolvedValueOnce({
        ok: true as const,
        page: { items: [secondItem], total: 2, page: 2, page_size: 1 }
      })
      .mockResolvedValueOnce({ ok: false as const, errorCode: 'forbidden' as const })
      .mockRejectedValueOnce(new Error('unexpected ipc error'))

    setupWindowApi({ orgCasesList })
    render(<UseCaseCarousel variant="marketplace" />)
    fireEvent.click(screen.getByTestId('use-case-source-organization'))
    await waitFor(() => expect(screen.getByText('Page 1 Item')).toBeTruthy())

    // Fail append on page 2 -> Retry must request page: 2 (not reset to page 1)
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(screen.getByText('Could not connect to Lab')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(orgCasesList).toHaveBeenNthCalledWith(3, { page: 2, pageSize: 20 }))
    await waitFor(() => expect(screen.getByText('Page 2 Item')).toBeTruthy())

    // Non-empty list error with forbidden exposes Open Lab Settings CTA
    const refreshBtn = screen.getByRole('button', { name: 'Refresh organization cases' })
    fireEvent.click(refreshBtn)
    await waitFor(() => expect(screen.getByText('Permission denied')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Open Lab Settings' })).toBeTruthy()

    // Non-append catch rejection clears stale items cleanly
    fireEvent.click(screen.getByRole('button', { name: 'Refresh organization cases' }))
    await waitFor(() => expect(screen.getByText('Could not load organization cases')).toBeTruthy())
    expect(screen.queryByText('Page 1 Item')).toBeNull()
  })
})
