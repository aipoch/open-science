import { createContext, useContext, type ComponentType } from 'react'
import type { UploadStagingApi } from '@/lib/upload-transfer'
import type { OpenScienceAPI } from '../../../../shared/renderer-contract-catalog'
import type { useNavigationStore } from '@/stores/navigation-store'
import type { useProjectStore } from '@/stores/project-store'
import type { useTagStore } from '@/stores/tag-store'
import type { useSettingsStore } from '@/stores/settings-store'
import type { useProjectFormDialog } from '@/hooks/useProjectFormDialog'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type {
  createBookmarkPreviewItem,
  requestPdfAnnotationReveal
} from '../workspace/annotations/annotation-reveal'
import type { resolvePdfContextTarget } from '../workspace/use-pdf-context-action'

export type LiteratureRendererApi = Pick<
  OpenScienceAPI,
  'literature' | 'saveBlobFile' | 'platform'
> & {
  uploads: UploadStagingApi & Pick<OpenScienceAPI['uploads'], 'claimLocalFile'>
  previewResources: Pick<OpenScienceAPI['previewResources'], 'acquire' | 'release'>
  sessions: Pick<OpenScienceAPI['sessions'], 'openRecoveryFolder' | 'filterPdfContextCandidates'>
  projects: Pick<OpenScienceAPI['projects'], 'onDeleted' | 'onDeletionCleanupChanged'>
  pdfAnnotations: Pick<OpenScienceAPI['pdfAnnotations'], 'onImportProgress'>
}

type SelectorStore<State> = {
  <Value>(selector: (state: State) => Value): Value
  getState(): State
}

export type LiteratureRendererHost = {
  readonly api: LiteratureRendererApi
  useNavigationStore: SelectorStore<
    Pick<
      ReturnType<typeof useNavigationStore.getState>,
      | 'activeProjectId'
      | 'startLiteratureReviewConversation'
      | 'pendingLiteratureItemId'
      | 'pendingLiteratureAnnotation'
      | 'pendingLiteratureLibrarySection'
      | 'consumeLiteratureLibrarySection'
      | 'consumeLiteratureItem'
      | 'pendingLiteratureProjectId'
      | 'consumeLiteratureProject'
      | 'pendingLiteratureCollectionId'
      | 'consumeLiteratureCollection'
      | 'openProject'
      | 'pendingLiteraturePdfImport'
      | 'consumeLiteraturePdfImport'
      | 'openSession'
      | 'openLiteratureItem'
      | 'returnFromLibrary'
      | 'startPdfReadingConversation'
      | 'startPdfReadingConversations'
    >
  >
  useProjectStore: SelectorStore<
    Pick<ReturnType<typeof useProjectStore.getState>, 'projects' | 'isLoaded' | 'loadProjects'>
  >
  useTagStore: SelectorStore<
    Pick<ReturnType<typeof useTagStore.getState>, 'load' | 'listen' | 'revision' | 'status'>
  >
  useSettingsStore: SelectorStore<
    Pick<
      ReturnType<typeof useSettingsStore.getState>,
      | 'ncbi'
      | 'openAlex'
      | 'encryptionAvailable'
      | 'loadConnectors'
      | 'validateOpenAlexCredential'
      | 'setOpenAlexCredential'
      | 'isSettingsOpen'
      | 'openSettingsToClassification'
    >
  >
  useProjectFormDialog: typeof useProjectFormDialog
  FilePreviewDialog: ComponentType<{
    item: PreviewFileItem | undefined
    onClose: (skipGuard?: boolean) => void
    allowReadingContext?: boolean
    onReadWithAgent?: (item: PreviewFileItem) => void
    onFocusFallback?: () => void
  }>
  ProjectFormDialog: ComponentType<ReturnType<typeof useProjectFormDialog>['dialogProps']>
  createBookmarkPreviewItem: typeof createBookmarkPreviewItem
  requestPdfAnnotationReveal: typeof requestPdfAnnotationReveal
  resolvePdfContextTarget: typeof resolvePdfContextTarget
}

export const LiteratureHostContext = createContext<LiteratureRendererHost | undefined>(undefined)

export function useLiteratureHost(): LiteratureRendererHost {
  const host = useContext(LiteratureHostContext)
  if (!host) throw new Error('LiteratureRendererProvider is required.')
  return host
}
