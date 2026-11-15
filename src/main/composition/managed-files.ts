import type { ArtifactProducerInputScope } from '../managed-file-versions/read-port'
import { openComputeOutputPreview } from '../compute/job-output-preview'
import { PptxAgentHandler } from '../pptx-edit/agent-handler'
import { PptxDraftReview } from '../pptx-edit/draft-review'
import { PptxDraftStore } from '../pptx-edit/draft-store'
import { PptxEditSessions } from '../pptx-edit/edit-sessions'
import { persistentContentReferences } from '../storage/prisma-content-references'
import type { NotebookDependencyAnalyzer } from '@aipoch/notebook-analysis'
import { createNotebookDependencyAnalyzer } from '../notebook/dependency-analysis-adapter'
import { parseLiteratureAttachmentVersionReference } from '../../shared/literature-attachment-reference'
import type { ManagedPreviewSource } from '../../shared/preview-resources'
import { createDefaultArtifactRepository } from '../artifacts/ipc'
import { ProvenanceMessageSnapshotRepository } from '../artifacts/provenance-message-snapshot'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import type { ReadArtifactLiteratureItems } from '../artifacts/literature-manifest'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { BookmarkRepository } from '../bookmarks/repository'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { LiteratureAttachmentAuthority } from '../literature/attachment-authority'
import { SessionPdfSourceResolver } from '../literature/session-pdf-source-resolver'
import { GrantedLocalRootsRepository } from '../local-fs/granted-roots-repository'
import { LocalFsService } from '../local-fs/service'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { createManagedPreviewOwnerRegistry } from '../managed-preview-owner-registry'
import { ManagedPreviewResources } from '../managed-preview-resources'

import { NotebookInputRegistry } from '../notebook/input-registry'
import type { NotebookNetworkSandboxOwner } from '../notebook/network-sandbox-owner'
import { NotebookRunRepository } from '../notebook/repository'
import { getProjectDbClient } from '../projects/prisma-client'
import { PackageLiteratureReader } from '../session-package/literature-reader'
import { createDefaultSessionRepository } from '../session-persistence/ipc'
import { SettingsService } from '../settings/service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { ContentRepository } from '../storage/content-repository'

export function composeManagedFiles({
  grantedRootsRepositoryRef,
  shutdownNotebooksBeforePolicyChange,
  settingsService,
  managedFileVersionService,
  sessionRepository,
  notebookNetworkSandbox,
  getNotebookInputRegistry,
  captureImageGenerationPreviewScope,
  readLiteratureItems
}: {
  grantedRootsRepositoryRef: { current?: GrantedLocalRootsRepository }
  shutdownNotebooksBeforePolicyChange: (
    trigger: 'ca-bundle' | 'granted-roots'
  ) => Promise<{ reaped: boolean }>
  settingsService: SettingsService
  managedFileVersionService: ManagedFileVersionService
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  notebookNetworkSandbox: NotebookNetworkSandboxOwner
  getNotebookInputRegistry: () => NotebookInputRegistry
  captureImageGenerationPreviewScope?: (request: {
    projectId: string
    sessionId: string
    artifactId: string
    versionId: string
  }) => ArtifactProducerInputScope | undefined
  readLiteratureItems: ReadArtifactLiteratureItems
}): {
  artifactRepository: ReturnType<typeof createDefaultArtifactRepository>
  notebookRepository: NotebookRunRepository
  notebookDependencyAnalyzer: NotebookDependencyAnalyzer
  immutableInputAuthority: ImmutableInputAuthority
  artifactProvenanceRepository: ArtifactProvenanceRepository
  contentRepository: ContentRepository
  literatureAttachmentAuthority: LiteratureAttachmentAuthority
  sessionPdfSourceResolver: SessionPdfSourceResolver
  bookmarkRepository: BookmarkRepository
  provenanceMessageSnapshots: ProvenanceMessageSnapshotRepository
  artifactRunRegistry: ArtifactRunRegistry
  grantedRootsRepository: GrantedLocalRootsRepository
  localFsService: LocalFsService
  resolveManagedFilePath: (
    source: Extract<ManagedPreviewSource, 'literature' | 'local'>,
    request: {
      path: string
      projectId?: string
      sessionId?: string
      fileId?: string
      versionId?: string
    }
  ) => Promise<string>
  previewResources: ManagedPreviewResources
  managedPreviewOwners: ReturnType<typeof createManagedPreviewOwnerRegistry>
  pptxEditSessions: PptxEditSessions
  pptxDrafts: PptxDraftStore
  pptxAgent: PptxAgentHandler
  pptxDraftReview: PptxDraftReview
} {
  // Share one repository and registry so runtime artifact claims and renderer finalization meet.
  const artifactRepository = createDefaultArtifactRepository()
  const notebookRepository = new NotebookRunRepository(resolveDataRoot())
  const notebookDependencyAnalyzer = createNotebookDependencyAnalyzer({
    storageRoot: resolveDataRoot(),
    repository: notebookRepository
  })
  const immutableInputAuthority = new ImmutableInputAuthority({
    storageRoot: resolveDataRoot(),
    managedFileVersions: managedFileVersionService
  })
  const artifactProvenanceRepository = new ArtifactProvenanceRepository({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveConfigRoot()),
    inputAuthority: immutableInputAuthority,
    readLiteratureItems,
    managedFileVersions: managedFileVersionService,
    compatibilityRepository: artifactRepository,
    notebookRepository,
    dependencyAnalyzer: notebookDependencyAnalyzer,
    loadSession: (projectId, appSessionId) => sessionRepository.loadSession(projectId, appSessionId)
  })
  const contentRepository = new ContentRepository({
    references: persistentContentReferences,
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveConfigRoot())
  })
  const literatureAttachmentAuthority = new LiteratureAttachmentAuthority({
    getClient: () => getProjectDbClient(resolveConfigRoot()),
    content: contentRepository,
    packages: new PackageLiteratureReader({
      storageRoot: resolveDataRoot(),
      getClient: () => getProjectDbClient(resolveConfigRoot()),
      files: managedFileVersionService
    })
  })
  const sessionPdfSourceResolver = new SessionPdfSourceResolver({
    inputs: immutableInputAuthority,
    literature: literatureAttachmentAuthority
  })
  const bookmarkRepository = new BookmarkRepository(() => getProjectDbClient(resolveConfigRoot()))
  const provenanceMessageSnapshots = new ProvenanceMessageSnapshotRepository({
    storageRoot: resolveDataRoot(),
    getClient: () => getProjectDbClient(resolveConfigRoot())
  })
  const artifactRunRegistry = new ArtifactRunRegistry()
  // The upload repository above is shared so staging recovery, Session upgrade, prompt finalization,
  // and previews all observe one durable Version authority.
  // Shared local-fs service backs both the "This computer" browser IPC and the managed-preview
  // resolver below, so path validation stays identical across both entry points. Granted folder
  // roots persist in the SQLite project DB behind the local-fs:granted-roots:* channels; the
  // settings service is passed as the legacy store so a pre-existing settings.json
  // grantedLocalRoots field is imported into the DB once on first use.
  const grantedRootsRepository = new GrantedLocalRootsRepository(
    () => getProjectDbClient(resolveConfigRoot()),
    settingsService
  )
  grantedRootsRepositoryRef.current = grantedRootsRepository
  const localFsService = new LocalFsService(
    grantedRootsRepository,
    () => shutdownNotebooksBeforePolicyChange('granted-roots'),
    (path, access, requestedPath) =>
      notebookNetworkSandbox.preflightGrantedRoot(path, access, requestedPath)
  )
  // One source-neutral resolver keeps previews and user-requested exports on identical trust checks.
  const resolveManagedFilePath = (
    source: Extract<ManagedPreviewSource, 'literature' | 'local'>,
    request: {
      path: string
      projectId?: string
      sessionId?: string
      fileId?: string
      versionId?: string
    }
  ): Promise<string> => {
    if (source === 'literature') {
      const versionId = parseLiteratureAttachmentVersionReference(request.path)
      if (!versionId) return Promise.reject(new Error('Invalid Literature attachment reference.'))
      return literatureAttachmentAuthority.resolveVersion(versionId).then((version) => {
        if (!version) throw new Error('Literature attachment Version is unavailable.')
        return version.path
      })
    }
    return localFsService.resolveFilePath(request)
  }
  const pptxEditSessions = new PptxEditSessions(managedFileVersionService)
  const pptxDrafts = new PptxDraftStore()
  const pptxAgent = new PptxAgentHandler(managedFileVersionService, pptxDrafts)
  const pptxDraftReview = new PptxDraftReview(managedFileVersionService, pptxDrafts)
  // One registry owns short-lived capability URLs for both managed artifact repositories.
  const previewResources = new ManagedPreviewResources({
    openStagedEdit: async (key) => pptxEditSessions.openStaged(key),
    resolvePath: resolveManagedFilePath,
    openComputeOutput: openComputeOutputPreview,
    openLiterature: (reference) => literatureAttachmentAuthority.openReference(reference),
    openLatestManagedFile: (source, request) =>
      managedFileVersionService.openLatest({ source, ...request }),
    openManagedFileVersion: async (source, request) => {
      try {
        return await managedFileVersionService.openVersion(
          { source, projectId: request.projectId, fileId: request.fileId },
          request.versionId
        )
      } catch (error) {
        const scope =
          source === 'artifact' && request.imageGenerationSessionId
            ? captureImageGenerationPreviewScope?.({
                projectId: request.projectId,
                sessionId: request.imageGenerationSessionId,
                artifactId: request.fileId,
                versionId: request.versionId
              })
            : undefined
        if (!scope) throw error
        const lease = await managedFileVersionService.openProducerVersion(
          request.projectId,
          request.versionId,
          scope
        )
        if (!lease) throw error
        return lease
      }
    },
    openNotebookInput: (request) => getNotebookInputRegistry().openPreviewKey(request.path)
  })
  const managedPreviewOwners = createManagedPreviewOwnerRegistry(previewResources)
  return {
    artifactRepository,
    notebookRepository,
    notebookDependencyAnalyzer,
    immutableInputAuthority,
    artifactProvenanceRepository,
    contentRepository,
    literatureAttachmentAuthority,
    sessionPdfSourceResolver,
    bookmarkRepository,
    provenanceMessageSnapshots,
    artifactRunRegistry,
    grantedRootsRepository,
    localFsService,
    resolveManagedFilePath,
    previewResources,
    managedPreviewOwners,
    pptxEditSessions,
    pptxDrafts,
    pptxAgent,
    pptxDraftReview
  }
}
