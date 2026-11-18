// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LabView } from '../../../../shared/lab'
import type {
  OrgCaseDetail,
  OrgCaseDownloadSnapshot,
  OrgCaseItem
} from '../../../../shared/org-cases'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../shared/web-caller-location'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../../shared/web-event-connection'
import { useSettingsStore } from '@/stores/settings-store'
import { useOrgCaseStore } from '@/stores/org-cases-store'
import { UseCaseCarousel } from './UseCaseCarousel'

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
    useSettingsStore.setState({
      lab: {
        state: 'authenticated',
        serverUrl: 'https://lab.example.com',
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

  it('shows explicit notice for STORAGE_NOT_CONFIGURED instead of empty list and supports Lab settings CTA when signed out', async () => {
    const openSettingsToPanel = vi.fn()
    useSettingsStore.setState({ openSettingsToPanel } as never)

    const orgCasesList = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'storage-not-configured' as const
    }))
    setupWindowApi({ orgCasesList })

    render(<UseCaseCarousel variant="marketplace" />)
    fireEvent.click(screen.getByTestId('use-case-source-organization'))

    await waitFor(() => expect(screen.getByText('Case sharing is not configured')).toBeTruthy())
    expect(screen.queryByText('No organization cases yet')).toBeNull()

    // Signing out immediately clears error/results and renders Open Lab Settings button
    await act(async () => {
      useSettingsStore.setState({
        lab: { state: 'signedOut', serverUrl: 'https://lab.example.com' } as LabView
      })
    })
    await waitFor(() => expect(screen.getByText('Sign in to Lab')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Open Lab Settings' }))
    expect(openSettingsToPanel).toHaveBeenCalledWith('lab')
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

  it('discards stale search results and clears items when switching Lab organizations', async () => {
    let resolveOldList:
      | ((value: {
          ok: true
          page: { items: OrgCaseItem[]; total: number; page: number; page_size: number }
        }) => void)
      | undefined
    const orgCasesList = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldList = resolve
          })
      )
      .mockResolvedValueOnce({
        ok: true as const,
        page: {
          items: [makeOrgCase({ id: 'case_org_b', name: 'Org B Study', code: 'B2B2B2B2' })],
          total: 1,
          page: 1,
          page_size: 20
        }
      })

    setupWindowApi({ orgCasesList })

    render(<UseCaseCarousel variant="marketplace" />)
    fireEvent.click(screen.getByTestId('use-case-source-organization'))

    await waitFor(() => expect(orgCasesList).toHaveBeenCalledTimes(1))

    // Switch organization before old request resolves
    await act(async () => {
      useSettingsStore.setState({
        lab: {
          state: 'authenticated',
          serverUrl: 'https://lab.example.com',
          accountName: 'Bob',
          orgId: 'org_b'
        } as LabView
      })
    })

    // Old request resolves late -> must be discarded!
    await act(async () => {
      resolveOldList?.({
        ok: true,
        page: {
          items: [makeOrgCase({ id: 'case_org_a', name: 'Old Org A Study', code: 'A1A1A1A1' })],
          total: 1,
          page: 1,
          page_size: 20
        }
      })
    })

    await waitFor(() => expect(screen.getByText('Org B Study')).toBeTruthy())
    expect(screen.queryByText('Old Org A Study')).toBeNull()
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

  it('keeps home carousel header visible when Lab is signedOut or expired even without official items', () => {
    useSettingsStore.setState({
      lab: { state: 'expired', serverUrl: 'https://lab.example.com' } as LabView
    })
    setupWindowApi({ useCaseCatalog: vi.fn(async () => []) })

    render(<UseCaseCarousel variant="home" />)
    expect(screen.getByTestId('use-case-source-organization')).toBeTruthy()
  })

  it('hides Organization tab on Remote Web, omits Lab Settings CTA on Local Web, and scopes detail selection per mount', async () => {
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

    // Local Web hides Open Lab Settings CTA because LabPanel is unavailable in Web mode
    document.documentElement.setAttribute(WEB_CALLER_LOCATION_ATTRIBUTE, 'local')
    useSettingsStore.setState({
      lab: { state: 'signedOut', serverUrl: 'https://lab.example.com' } as LabView
    })
    const localRender = render(<UseCaseCarousel variant="home" />)
    expect(screen.getByText('Sign in to Lab')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Lab Settings' })).toBeNull()
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
