import { useCallback, useEffect, useRef } from 'react'
import { create } from 'zustand'
import type { LabView } from '../../../shared/lab'
import {
  buildLabConnectionKey,
  normalizeOrgCaseSearchQuery,
  ORG_CASE_DEFAULT_PAGE_SIZE,
  type OrgCaseDetail,
  type OrgCaseDownloadSnapshot,
  type OrgCaseErrorCode,
  type OrgCaseItem
} from '../../../shared/org-cases'
import { useSettingsStore } from '@/stores/settings-store'

export type UseCaseSourceKind = 'official' | 'organization'

const CLEAR_ITEMS_ON_LIST_ERROR = new Set<OrgCaseErrorCode>([
  'unconfigured',
  'signed-out',
  'expired',
  'storage-not-configured',
  'license-inactive',
  'seat-required',
  'org-inactive',
  'account-disabled',
  'no-organization'
])

type OrgCaseStoreState = {
  source: UseCaseSourceKind
  connectionKey: string
  epoch: number
  listRequestSeq: number
  detailRequestSeq: number
  query: string
  committedQuery: string
  items: OrgCaseItem[]
  total: number
  page: number
  pageSize: number
  loading: boolean
  loadingMore: boolean
  hasLoadedOnce: boolean
  listError: OrgCaseErrorCode | null
  lastListRequestFailedAppend: boolean
  detailById: Record<string, OrgCaseDetail>
  detailLoadingId: string | null
  detailError: { caseId: string; errorCode: OrgCaseErrorCode } | null
  download: OrgCaseDownloadSnapshot | null
  downloadError: { caseId: string; errorCode: OrgCaseErrorCode } | null
  setSource: (source: UseCaseSourceKind) => void
  setQuery: (query: string) => void
  dismissDownloadError: () => void
  syncLabConnection: (lab: LabView | undefined) => boolean
  applyDownloadSnapshot: (snapshot: OrgCaseDownloadSnapshot | null) => void
  loadCases: (options?: { q?: string; page?: number; append?: boolean }) => Promise<void>
  loadCaseDetail: (caseId: string) => Promise<void>
  importCase: (caseId: string, onHandedOff?: () => void) => Promise<void>
  cancelImport: (caseId?: string) => Promise<void>
  reset: () => void
}

function createEmptyOrgData(): {
  query: string
  committedQuery: string
  items: OrgCaseItem[]
  total: number
  page: number
  pageSize: number
  loading: boolean
  loadingMore: boolean
  hasLoadedOnce: boolean
  listError: OrgCaseErrorCode | null
  lastListRequestFailedAppend: boolean
  detailById: Record<string, OrgCaseDetail>
  detailLoadingId: string | null
  detailError: { caseId: string; errorCode: OrgCaseErrorCode } | null
  download: OrgCaseDownloadSnapshot | null
  downloadError: { caseId: string; errorCode: OrgCaseErrorCode } | null
} {
  return {
    query: '',
    committedQuery: '',
    items: [] as OrgCaseItem[],
    total: 0,
    page: 1,
    pageSize: ORG_CASE_DEFAULT_PAGE_SIZE,
    loading: false,
    loadingMore: false,
    hasLoadedOnce: false,
    listError: null as OrgCaseErrorCode | null,
    lastListRequestFailedAppend: false,
    detailById: {} as Record<string, OrgCaseDetail>,
    detailLoadingId: null as string | null,
    detailError: null as { caseId: string; errorCode: OrgCaseErrorCode } | null,
    download: null as OrgCaseDownloadSnapshot | null,
    downloadError: null as { caseId: string; errorCode: OrgCaseErrorCode } | null
  }
}

export const useOrgCaseStore = create<OrgCaseStoreState>((set, get) => ({
  source: 'official',
  connectionKey: 'none',
  epoch: 0,
  listRequestSeq: 0,
  detailRequestSeq: 0,
  ...createEmptyOrgData(),

  setSource: (source) => {
    set({ source })
  },

  setQuery: (query) => {
    set({ query })
  },

  dismissDownloadError: () => {
    set({ downloadError: null })
  },

  syncLabConnection: (lab) => {
    const nextKey = buildLabConnectionKey(lab)
    const current = get()
    if (nextKey === current.connectionKey) return false
    set({
      source: lab?.state === 'authenticated' ? current.source : 'official',
      connectionKey: nextKey,
      epoch: current.epoch + 1,
      listRequestSeq: current.listRequestSeq + 1,
      detailRequestSeq: current.detailRequestSeq + 1,
      ...createEmptyOrgData()
    })
    return true
  },

  applyDownloadSnapshot: (snapshot) => {
    if (!snapshot) {
      set({ download: null })
      return
    }
    if (snapshot.state === 'handed-off' || snapshot.state === 'cancelled') {
      set((state) => ({
        download: state.download?.caseId === snapshot.caseId ? null : state.download
      }))
      return
    }
    if (snapshot.state === 'failed') {
      set({
        download: null,
        downloadError: snapshot.errorCode
          ? { caseId: snapshot.caseId, errorCode: snapshot.errorCode }
          : null
      })
      return
    }
    set({ download: snapshot, downloadError: null })
  },

  loadCases: async (options = {}) => {
    const current = get()
    const append = options.append === true
    const targetQuery = normalizeOrgCaseSearchQuery(
      options.q !== undefined ? options.q : current.query
    )
    const targetPage = options.page ?? (append ? current.page + 1 : 1)
    const seq = current.listRequestSeq + 1
    const epoch = current.epoch

    const orgCasesList = window.api?.sessions?.orgCasesList
    if (!orgCasesList) {
      set((state) => ({
        loading: false,
        loadingMore: false,
        hasLoadedOnce: true,
        listError: 'unknown',
        lastListRequestFailedAppend: append,
        items: !append ? [] : state.items,
        total: !append ? 0 : state.total
      }))
      return
    }

    set({
      listRequestSeq: seq,
      loading: !append,
      loadingMore: append,
      listError: null,
      lastListRequestFailedAppend: false
    })

    try {
      const result = await orgCasesList({
        ...(targetQuery ? { q: targetQuery } : {}),
        page: targetPage,
        pageSize: ORG_CASE_DEFAULT_PAGE_SIZE
      })
      const latest = get()
      if (latest.epoch !== epoch || latest.listRequestSeq !== seq) return

      if (!result.ok) {
        if (result.errorCode === 'cancelled') {
          set({ loading: false, loadingMore: false })
          return
        }
        set((state) => ({
          loading: false,
          loadingMore: false,
          hasLoadedOnce: true,
          listError: result.errorCode,
          lastListRequestFailedAppend: append,
          items: !append || CLEAR_ITEMS_ON_LIST_ERROR.has(result.errorCode) ? [] : state.items,
          total: !append || CLEAR_ITEMS_ON_LIST_ERROR.has(result.errorCode) ? 0 : state.total
        }))
        return
      }

      const incoming = result.page.items
      set((state) => {
        if (!append || result.page.page <= 1) {
          return {
            items: incoming,
            total: result.page.total,
            page: result.page.page,
            pageSize: result.page.page_size,
            committedQuery: targetQuery,
            loading: false,
            loadingMore: false,
            hasLoadedOnce: true,
            listError: null,
            lastListRequestFailedAppend: false
          }
        }
        const seen = new Set(state.items.map((item) => item.id))
        const merged = [...state.items, ...incoming.filter((item) => !seen.has(item.id))]
        return {
          items: merged,
          total: result.page.total,
          page: result.page.page,
          pageSize: result.page.page_size,
          committedQuery: targetQuery,
          loading: false,
          loadingMore: false,
          hasLoadedOnce: true,
          listError: null,
          lastListRequestFailedAppend: false
        }
      })
    } catch {
      const latest = get()
      if (latest.epoch !== epoch || latest.listRequestSeq !== seq) return
      set((state) => ({
        loading: false,
        loadingMore: false,
        hasLoadedOnce: true,
        listError: 'unknown',
        lastListRequestFailedAppend: append,
        items: !append ? [] : state.items,
        total: !append ? 0 : state.total
      }))
    }
  },

  loadCaseDetail: async (caseId) => {
    const orgCaseDetail = window.api?.sessions?.orgCaseDetail
    if (!orgCaseDetail) return

    const current = get()
    const seq = current.detailRequestSeq + 1
    const epoch = current.epoch
    set({ detailRequestSeq: seq, detailLoadingId: caseId, detailError: null })

    try {
      const result = await orgCaseDetail(caseId)
      const latest = get()
      if (latest.epoch !== epoch || latest.detailRequestSeq !== seq) return
      if (!result.ok) {
        if (result.errorCode === 'cancelled') {
          set({ detailLoadingId: null })
          return
        }
        set({
          detailLoadingId: null,
          detailError: { caseId, errorCode: result.errorCode }
        })
        return
      }
      set((state) => ({
        detailLoadingId: null,
        detailError: null,
        detailById: { ...state.detailById, [caseId]: result.case }
      }))
    } catch {
      const latest = get()
      if (latest.epoch !== epoch || latest.detailRequestSeq !== seq) return
      set({
        detailLoadingId: null,
        detailError: { caseId, errorCode: 'unknown' }
      })
    }
  },

  importCase: async (caseId, onHandedOff) => {
    const orgCaseImport = window.api?.sessions?.orgCaseImport
    if (!orgCaseImport) return
    if (get().download) return
    const epoch = get().epoch
    const existingItem = get().detailById[caseId] ?? get().items.find((item) => item.id === caseId)
    set({
      downloadError: null,
      download: {
        caseId,
        name: existingItem?.name ?? caseId,
        code: existingItem?.code ?? '',
        state: 'preparing',
        completedBytes: 0,
        ...(existingItem ? { totalBytes: existingItem.size_bytes } : {})
      }
    })
    try {
      const result = await orgCaseImport(caseId)
      if (get().epoch !== epoch) return
      if (result.status === 'handed-off') {
        set((state) => ({
          download: state.download?.caseId === caseId ? null : state.download,
          downloadError: null
        }))
        onHandedOff?.()
        return
      }
      if (result.status === 'cancelled') {
        set((state) => ({
          download: state.download?.caseId === caseId ? null : state.download
        }))
        return
      }
      set((state) => ({
        download: state.download?.caseId === caseId ? null : state.download,
        downloadError: { caseId, errorCode: result.errorCode }
      }))
    } catch {
      if (get().epoch !== epoch) return
      set((state) => ({
        download: state.download?.caseId === caseId ? null : state.download,
        downloadError: { caseId, errorCode: 'unknown' }
      }))
    }
  },

  cancelImport: async (caseId) => {
    await window.api?.sessions?.orgCaseCancelImport?.(caseId).catch(() => undefined)
  },

  reset: () => {
    set({
      source: 'official',
      connectionKey: 'none',
      epoch: 0,
      listRequestSeq: 0,
      detailRequestSeq: 0,
      ...createEmptyOrgData()
    })
  }
}))

export function useOrgCaseLabSync(enabled: boolean): void {
  const lab = useSettingsStore((state) => state.lab)
  const source = useOrgCaseStore((state) => state.source)
  const hasLoadedOnce = useOrgCaseStore((state) => state.hasLoadedOnce)
  const loading = useOrgCaseStore((state) => state.loading)
  const syncLabConnection = useOrgCaseStore((state) => state.syncLabConnection)
  const loadCases = useOrgCaseStore((state) => state.loadCases)
  const applyDownloadSnapshot = useOrgCaseStore((state) => state.applyDownloadSnapshot)

  useEffect(() => {
    const changed = syncLabConnection(lab)
    if (!enabled) return
    if (
      source === 'organization' &&
      lab?.state === 'authenticated' &&
      (changed || (!hasLoadedOnce && !loading))
    ) {
      void loadCases({ page: 1 })
    }
  }, [enabled, hasLoadedOnce, lab, loadCases, loading, source, syncLabConnection])

  useEffect(() => {
    if (!enabled) return
    const subscribe = window.api?.sessions?.onOrgCaseDownload
    if (!subscribe) return
    return subscribe((snapshot) => {
      applyDownloadSnapshot(snapshot)
    })
  }, [applyDownloadSnapshot, enabled])
}

export function useOrgCaseSearchActions(active: boolean): {
  query: string
  committedQuery: string
  setQuery: (query: string) => void
  submitSearch: (overrideQuery?: string) => void
  refresh: () => void
} {
  const lab = useSettingsStore((state) => state.lab)
  const query = useOrgCaseStore((state) => state.query)
  const committedQuery = useOrgCaseStore((state) => state.committedQuery)
  const hasLoadedOnce = useOrgCaseStore((state) => state.hasLoadedOnce)
  const setQuery = useOrgCaseStore((state) => state.setQuery)
  const loadCases = useOrgCaseStore((state) => state.loadCases)
  const timerRef = useRef<number | null>(null)

  const clearPendingDebounce = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => clearPendingDebounce, [clearPendingDebounce])

  useEffect(() => {
    if (!active || lab?.state !== 'authenticated') return
    const normalized = query.trim()
    if (!hasLoadedOnce) return
    if (normalized === committedQuery) return

    clearPendingDebounce()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void loadCases({ q: normalized, page: 1 })
    }, 250)

    return clearPendingDebounce
  }, [active, clearPendingDebounce, committedQuery, hasLoadedOnce, lab?.state, loadCases, query])

  const submitSearch = useCallback(
    (overrideQuery?: string) => {
      clearPendingDebounce()
      const currentQuery = useOrgCaseStore.getState().query
      const next = overrideQuery !== undefined ? overrideQuery : currentQuery
      if (overrideQuery !== undefined) {
        setQuery(overrideQuery)
      }
      if (useSettingsStore.getState().lab?.state !== 'authenticated') return
      void loadCases({ q: next.trim(), page: 1 })
    },
    [clearPendingDebounce, loadCases, setQuery]
  )

  return {
    query,
    committedQuery,
    setQuery,
    submitSearch,
    refresh: () => submitSearch()
  }
}
