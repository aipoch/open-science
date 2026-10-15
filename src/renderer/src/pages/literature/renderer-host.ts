import { createContext, useContext, type ComponentType } from 'react'
import type { UploadStagingApi } from '@/lib/upload-transfer'
import type { OpenScienceAPI } from '../../../../shared/renderer-contract-catalog'
import type { ReactNode } from 'react'
import type { PDFDocumentLoadingTask } from 'pdfjs-dist'
import type { Project } from '../../../../shared/projects'
import type { PdfAnnotation, PdfAnnotationSource } from '../../../../shared/pdf-annotations'
import type {
  LiteratureScopeReference,
  SessionPdfContextSource
} from '../../../../shared/session-persistence'
import type { ManagedPreviewResource } from '../../../../shared/preview-resources'
import type {
  NcbiCredentialsView,
  OpenAlexCredentialView,
  OpenAlexCredentialValidation,
  SetOpenAlexCredentialRequest,
  ValidateOpenAlexCredentialRequest
} from '../../../../shared/settings'

export type LiteratureProject = Project
/** Only PDF preview data crosses the feature boundary; workbench state stays in the host. */
export type LiteraturePreviewItem = {
  id: string
  projectId?: string
  sessionId: string
  title: string
  type: 'file'
  format: 'pdf'
  source?: 'artifact' | 'upload' | 'notebook-input' | 'literature' | 'local'
  path: string
  name: string
  mimeType?: string
  size?: number
  managedFileId?: string
  artifactId?: string
  selectedVersionId?: string
  versionNumber?: number
}
export type LiteratureReadingDocument = Readonly<{
  item: LiteraturePreviewItem
  source: SessionPdfContextSource
}>
export type LiteratureProjectCreation = {
  openCreateDialog(): void
  isOpen: boolean
  dialog: ReactNode
}
export type LiteratureNavigation = {
  activeProjectId: string | undefined
  pendingLiteratureItemId: string | undefined
  pendingLiteratureAnnotation: PdfAnnotation | undefined
  pendingLiteratureLibrarySection: 'library' | undefined
  pendingLiteratureProjectId: string | undefined
  pendingLiteratureCollectionId: string | undefined
  pendingLiteraturePdfImport: PdfAnnotationSource | undefined
  consumeLiteratureItem(expectedItemId?: string): string | undefined
  consumeLiteratureLibrarySection(): 'library' | undefined
  consumeLiteratureProject(expectedProjectId?: string): string | undefined
  consumeLiteratureCollection(expectedCollectionId?: string): string | undefined
  consumeLiteraturePdfImport(source: PdfAnnotationSource): PdfAnnotationSource | undefined
  openProject(projectId: string, origin: 'user', afterNavigate?: () => void): boolean
  openSession(
    projectId: string,
    sessionId: string,
    origin: 'user',
    afterNavigate?: () => void
  ): boolean
  openLiteratureItem(
    itemId: string,
    origin: 'user',
    annotation?: PdfAnnotation,
    afterNavigate?: () => void
  ): void
  returnFromLibrary(origin: 'user'): void
  startLiteratureReviewConversation(
    projectId: string,
    scope: LiteratureScopeReference,
    prompt: string
  ): boolean
  startPdfReadingConversation(
    projectId: string,
    item: LiteraturePreviewItem,
    source: SessionPdfContextSource
  ): boolean
  startPdfReadingConversations(
    projectId: string,
    documents: readonly LiteratureReadingDocument[]
  ): boolean
}

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
  onRecovered(listener: () => void): () => void
  useNavigationStore: SelectorStore<LiteratureNavigation>
  useProjectStore: SelectorStore<{
    projects: LiteratureProject[]
    isLoaded: boolean
    loadProjects(): Promise<void>
  }>
  useTagStore: SelectorStore<{
    load(): Promise<void>
    listen(): () => void
    revision: number
    status: 'idle' | 'loading' | 'ready' | 'error'
  }>
  useSettingsStore: SelectorStore<{
    ncbi: NcbiCredentialsView
    openAlex: OpenAlexCredentialView
    encryptionAvailable: boolean
    loadConnectors(): Promise<void>
    validateOpenAlexCredential(
      request: ValidateOpenAlexCredentialRequest
    ): Promise<OpenAlexCredentialValidation>
    setOpenAlexCredential(request: SetOpenAlexCredentialRequest): Promise<void>
    isSettingsOpen: boolean
    openSettingsToClassification(): void
  }>
  useProjectFormDialog(options?: {
    onCreated?: (project: LiteratureProject) => void
    onCreateCancelled?: () => void
  }): LiteratureProjectCreation
  FilePreviewDialog: ComponentType<{
    item: LiteraturePreviewItem | undefined
    onClose: (skipGuard?: boolean) => void
    allowReadingContext?: boolean
    onReadWithAgent?: (item: LiteraturePreviewItem) => void
    onFocusFallback?: () => void
  }>
  createBookmarkPreviewItem(
    target: { id: string; kind: 'pdf' } & PdfAnnotation['target']
  ): LiteraturePreviewItem | undefined
  requestPdfAnnotationReveal(
    annotation: PdfAnnotation,
    options?: { activatePreview: boolean; signal?: AbortSignal }
  ): Promise<'revealed' | 'source-unavailable' | 'locator-unsupported'>
  resolvePdfContextTarget(item: LiteraturePreviewItem): SessionPdfContextSource | undefined
  loadPdf(
    input: { resource: ManagedPreviewResource } | { data: Uint8Array }
  ): Promise<PDFDocumentLoadingTask>
}

export const LiteratureHostContext = createContext<LiteratureRendererHost | undefined>(undefined)

export function useLiteratureHost(): LiteratureRendererHost {
  const host = useContext(LiteratureHostContext)
  if (!host) throw new Error('LiteratureRendererProvider is required.')
  return host
}
