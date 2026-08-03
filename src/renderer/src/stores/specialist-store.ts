import { create } from 'zustand'
import type {
  SpecialistListItem,
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
  SpecialistDeleteResult
} from '../../../shared/specialist-package'

type SpecialistStoreData = {
  items: SpecialistListItem[]
  isLoaded: boolean
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
  installPackage: (confirmOverwrite?: boolean) => Promise<SpecialistPackageInstallResult>
  cancelPackage: () => Promise<void>
  previewExport: (specialistId: string) => Promise<SpecialistExportPreview>
  exportSpecialist: (includedSkillIds: readonly string[]) => Promise<SpecialistExportSaveResult>
  clearExport: () => void
}

type SpecialistStore = SpecialistStoreData & SpecialistStoreActions

const useSpecialistStore = create<SpecialistStore>((set) => ({
  items: [],
  isLoaded: false,
  packagePreview: undefined,
  exportPreview: undefined,

  load: async () => {
    const items = await window.api.specialist.list()
    set({ items, isLoaded: true })
  },

  create: async (input: CreateSpecialistInput) => {
    const view = await window.api.specialist.create(input)
    // Reload the full list so Reviewer and ordering stay consistent.
    const items = await window.api.specialist.list()
    set({ items })
    return view
  },

  update: async (input: UpdateSpecialistInput) => {
    const view = await window.api.specialist.update(input)
    // Reload the full list so Reviewer and ordering stay consistent.
    const items = await window.api.specialist.list()
    set({ items })
    return view
  },

  setEnabled: async (id: string, enabled: boolean) => {
    await window.api.specialist.setEnabled({ id, enabled })
    const items = await window.api.specialist.list()
    set({ items })
  },

  previewDelete: async (id: string) => window.api.specialist.previewDelete({ id }),

  delete: async (id: string, expectedRevision: number, deleteSkillIds: readonly string[]) => {
    const result = await window.api.specialist.delete({ id, expectedRevision, deleteSkillIds })
    if (result.status === 'deleted') {
      const items = await window.api.specialist.list()
      set({ items })
    }
    return result
  },

  duplicate: async (id: string) => window.api.specialist.duplicate({ id }),

  selectPackage: async () => {
    const result = await window.api.specialist.selectPackage()
    set({ packagePreview: 'cancelled' in result ? undefined : result })
    return result
  },

  installPackage: async (confirmOverwrite = false) => {
    const preview = useSpecialistStore.getState().packagePreview
    if (!preview) return { status: 'failed', code: 'candidate-invalid' }
    const result = await window.api.specialist.installPackage({
      candidateToken: preview.candidateToken,
      ...(confirmOverwrite ? { confirmOverwrite: true as const } : {})
    })
    if (result.status === 'installed') {
      const items = await window.api.specialist.list()
      set({ items, packagePreview: undefined })
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
    const preview = await window.api.specialist.previewExport({ specialistId })
    set({ exportPreview: preview })
    return preview
  },

  exportSpecialist: async (includedSkillIds: readonly string[]) => {
    const preview = useSpecialistStore.getState().exportPreview
    if (!preview) throw new Error('Preview the Specialist export before saving.')
    return window.api.specialist.exportSpecialist({
      specialistId: preview.specialistId,
      expectedRevision: preview.expectedRevision,
      includedSkillIds
    })
  },

  clearExport: () => set({ exportPreview: undefined })
}))

export { useSpecialistStore }
