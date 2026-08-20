import { create, type StoreApi } from 'zustand'
import type {
  SpecialistListItem,
  SpecialistDocumentIntegrity,
  SpecialistProfileView,
  CreateSpecialistInput,
  UpdateSpecialistInput
} from '../../../shared/specialist'
import type {
  SpecialistPackageCandidatePreview,
  SpecialistPackageInstallResult,
  SpecialistExportPreview,
  SpecialistExportSaveResult,
  SpecialistDeletePreview,
  SpecialistDeleteResult,
  SpecialistPackageInstallRequest
} from '../../../shared/specialist-package'

// Draft key for the create-specialist form; edit drafts are keyed by specialist id.
export const CREATE_SPECIALIST_DRAFT_KEY = '__create__'

// One snapshot of the specialist editor's form state, kept while the editor is unmounted so a
// round trip through Settings (e.g. opening a capability's detail page) loses nothing.
export type SpecialistEditorFormDraft = {
  id: string
  name: string
  packageVersion: string
  description: string
  systemPrompt: string
  iconKey: string
  colorKey: string
  capabilityMode: 'full' | 'selected'
  excludedSkillIds: string[]
  selectedSkillIds: string[]
  excludedConnectorIds: string[]
  connectorIds: string[]
  baseRevision: number
}

export type SpecialistEditorDraft = {
  form: SpecialistEditorFormDraft
  idTouched: boolean
  activeCapTab: 'skills' | 'connectors'
}

type SpecialistStoreData = {
  items: SpecialistListItem[]
  isLoaded: boolean
  loadError: string | undefined
  integrity: SpecialistDocumentIntegrity
  packagePreview?: SpecialistPackageCandidatePreview
  exportPreview?: SpecialistExportPreview
  editorDrafts: Record<string, SpecialistEditorDraft>
}

type SpecialistStoreActions = {
  load: () => Promise<void>
  create: (input: CreateSpecialistInput) => Promise<SpecialistProfileView>
  update: (input: UpdateSpecialistInput) => Promise<SpecialistProfileView>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  previewDelete: (id: string) => Promise<SpecialistDeletePreview>
  delete: (
    id: string,
    expectedRevision: number,
    deleteSkillIds: readonly string[]
  ) => Promise<SpecialistDeleteResult>
  duplicate: (id: string) => Promise<CreateSpecialistInput>
  selectPackage: () => Promise<{ cancelled: true } | SpecialistPackageCandidatePreview>
  installPackage: (
    options?: Omit<SpecialistPackageInstallRequest, 'candidateToken'>
  ) => Promise<SpecialistPackageInstallResult>
  cancelPackage: () => Promise<void>
  previewExport: (specialistId: string) => Promise<SpecialistExportPreview>
  exportSpecialist: (
    preview: SpecialistExportPreview,
    includedSkillIds: readonly string[]
  ) => Promise<SpecialistExportSaveResult>
  clearExport: () => void
  saveEditorDraft: (key: string, draft: SpecialistEditorDraft) => void
  clearEditorDraft: (key: string) => void
}

type SpecialistStore = SpecialistStoreData & SpecialistStoreActions

const SAFE_SPECIALIST_LOAD_ERROR = 'Open Science could not load Specialists. Retry to continue.'
const SPECIALIST_DOCUMENT_READ_ONLY_ERROR =
  'Specialist data must be repaired before changes can be saved.'

let latestCatalogRequest = 0
let latestExportPreviewRequest = 0
let removeCatalogChangedListener: (() => void) | undefined
let catalogLoadRequest: Promise<void> | undefined

const refreshCatalog = async (set: StoreApi<SpecialistStore>['setState']): Promise<void> => {
  const requestId = ++latestCatalogRequest
  set({ loadError: undefined })
  try {
    const snapshot = await window.api.specialist.list()
    if (requestId === latestCatalogRequest) {
      set({
        items: snapshot.items,
        integrity: snapshot.integrity,
        isLoaded: true,
        loadError: undefined
      })
    }
  } catch (error) {
    if (requestId === latestCatalogRequest) {
      console.warn('Specialist catalog loading failed', error)
      set({ loadError: SAFE_SPECIALIST_LOAD_ERROR })
    }
    throw error
  }
}

const useSpecialistStore = create<SpecialistStore>((set) => ({
  items: [],
  isLoaded: false,
  loadError: undefined,
  integrity: { status: 'ok' },
  packagePreview: undefined,
  exportPreview: undefined,
  editorDrafts: {},

  load: () => {
    // Guard: specialist.list is Electron-only and unavailable in the web gateway.
    if (typeof window.api?.specialist?.list !== 'function') {
      latestCatalogRequest += 1
      set({ items: [], integrity: { status: 'ok' }, isLoaded: true, loadError: undefined })
      return Promise.resolve()
    }
    removeCatalogChangedListener ??= window.api.specialist.onCatalogChanged?.(() => {
      void refreshCatalog(set).catch(() => undefined)
    })
    if (useSpecialistStore.getState().isLoaded) return Promise.resolve()
    if (catalogLoadRequest) return catalogLoadRequest
    const request = refreshCatalog(set)
    const trackedRequest = request.finally(() => {
      if (catalogLoadRequest === trackedRequest) catalogLoadRequest = undefined
    })
    catalogLoadRequest = trackedRequest
    // Keep ignored startup/event refreshes handled while preserving rejection for
    // callers that await load() before consuming the catalog.
    void trackedRequest.catch(() => undefined)
    return trackedRequest
  },

  create: async (input: CreateSpecialistInput) => {
    if (useSpecialistStore.getState().integrity.status === 'degraded') {
      throw new Error(SPECIALIST_DOCUMENT_READ_ONLY_ERROR)
    }
    const view = await window.api.specialist.create(input)
    // Reload the full list so Reviewer and ordering stay consistent.
    await refreshCatalog(set)
    return view
  },

  update: async (input: UpdateSpecialistInput) => {
    if (useSpecialistStore.getState().integrity.status === 'degraded') {
      throw new Error(SPECIALIST_DOCUMENT_READ_ONLY_ERROR)
    }
    const view = await window.api.specialist.update(input)
    // The mutation result is authoritative for this custom Specialist. Apply it immediately so a
    // slow catalog enrichment cannot leave an already-saved appearance stuck in its loading state.
    set((state) => ({
      items: state.items.map((item) =>
        item.kind === 'custom' && item.id === view.id ? { ...item, ...view, kind: 'custom' } : item
      )
    }))
    // Keep derived catalog fields and ordering synchronized without making mutation completion depend
    // on the broader catalog read. Catalog-change events may race this refresh; request IDs ensure
    // only the newest response is applied.
    void refreshCatalog(set).catch(() => undefined)
    return view
  },

  setEnabled: async (id: string, enabled: boolean) => {
    if (useSpecialistStore.getState().integrity.status === 'degraded') {
      throw new Error(SPECIALIST_DOCUMENT_READ_ONLY_ERROR)
    }
    await window.api.specialist.setEnabled({ id, enabled })
    await refreshCatalog(set)
  },

  previewDelete: async (id: string) => window.api.specialist.previewDelete({ id }),

  delete: async (id: string, expectedRevision: number, deleteSkillIds: readonly string[]) => {
    if (useSpecialistStore.getState().integrity.status === 'degraded') {
      throw new Error(SPECIALIST_DOCUMENT_READ_ONLY_ERROR)
    }
    const result = await window.api.specialist.delete({ id, expectedRevision, deleteSkillIds })
    if (result.status === 'deleted') {
      await refreshCatalog(set)
    }
    return result
  },

  duplicate: async (id: string) => window.api.specialist.duplicate({ id }),

  selectPackage: async () => {
    if (useSpecialistStore.getState().integrity.status === 'degraded') {
      throw new Error(SPECIALIST_DOCUMENT_READ_ONLY_ERROR)
    }
    const result = await window.api.specialist.selectPackage()
    set({ packagePreview: 'cancelled' in result ? undefined : result })
    return result
  },

  installPackage: async (options = {}) => {
    if (useSpecialistStore.getState().integrity.status === 'degraded') {
      throw new Error(SPECIALIST_DOCUMENT_READ_ONLY_ERROR)
    }
    const preview = useSpecialistStore.getState().packagePreview
    if (!preview) return { status: 'failed', code: 'candidate-invalid' }
    const result = await window.api.specialist.installPackage({
      candidateToken: preview.candidateToken,
      ...options
    })
    if (result.status === 'installed') {
      await refreshCatalog(set)
      set({ packagePreview: undefined })
    }
    return result
  },

  cancelPackage: async () => {
    const preview = useSpecialistStore.getState().packagePreview
    if (preview) {
      await window.api.specialist.cancelPackage({ candidateToken: preview.candidateToken })
    }
    set({ packagePreview: undefined })
  },

  previewExport: async (specialistId: string) => {
    const requestId = ++latestExportPreviewRequest
    const preview = await window.api.specialist.previewExport({ specialistId })
    if (requestId === latestExportPreviewRequest) set({ exportPreview: preview })
    return preview
  },

  exportSpecialist: async (
    preview: SpecialistExportPreview,
    includedSkillIds: readonly string[]
  ) => {
    return window.api.specialist.exportSpecialist({
      specialistId: preview.specialistId,
      expectedRevision: preview.expectedRevision,
      includedSkillIds
    })
  },

  clearExport: () => {
    latestExportPreviewRequest += 1
    set({ exportPreview: undefined })
  },

  saveEditorDraft: (key, draft) => {
    set((state) => ({ editorDrafts: { ...state.editorDrafts, [key]: draft } }))
  },

  clearEditorDraft: (key) => {
    set((state) => {
      if (!(key in state.editorDrafts)) return state
      const editorDrafts = { ...state.editorDrafts }
      delete editorDrafts[key]
      return { editorDrafts }
    })
  }
}))

export { useSpecialistStore }
