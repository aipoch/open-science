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

type SpecialistStoreData = {
  items: SpecialistListItem[]
  isLoaded: boolean
  loadError: string | undefined
  integrity: SpecialistDocumentIntegrity
  packagePreview?: SpecialistPackageCandidatePreview
  exportPreview?: SpecialistExportPreview
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
}

type SpecialistStore = SpecialistStoreData & SpecialistStoreActions

const SAFE_SPECIALIST_LOAD_ERROR = 'Open Science could not load Specialists. Retry to continue.'
const SPECIALIST_DOCUMENT_READ_ONLY_ERROR =
  'Specialist data must be repaired before changes can be saved.'

let latestCatalogRequest = 0
let latestExportPreviewRequest = 0

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

  load: () => {
    // Guard: specialist.list is Electron-only and unavailable in the web gateway.
    if (typeof window.api?.specialist?.list !== 'function') {
      latestCatalogRequest += 1
      set({ items: [], integrity: { status: 'ok' }, isLoaded: true, loadError: undefined })
      return Promise.resolve()
    }
    const request = refreshCatalog(set)
    // Keep ignored startup/event refreshes handled while preserving rejection for
    // callers that await load() before consuming the catalog.
    void request.catch(() => undefined)
    return request
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
    // Reload the full list so Reviewer and ordering stay consistent.
    await refreshCatalog(set)
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
  }
}))

export { useSpecialistStore }
