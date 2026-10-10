import { parseLiteratureAttachmentVersionReference } from '../../shared/literature'
import type { ManagedPreviewSource } from '../../shared/preview-resources'
import { createDefaultArtifactRepository } from '../artifacts/ipc'
import { ProvenanceMessageSnapshotRepository } from '../artifacts/provenance-message-snapshot'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
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
import { NotebookDependencyAnalyzer } from '../notebook/dependency-analysis'
import { NotebookInputRegistry } from '../notebook/input-registry'
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
  getNotebookInputRegistry
}: {
  grantedRootsRepositoryRef: { current?: GrantedLocalRootsRepository }
  shutdownNotebooksBeforePolicyChange: (
    trigger: 'ca-bundle' | 'granted-roots'
  ) => Promise<{ reaped: boolean }>
  settingsService: SettingsService
  managedFileVersionService: ManagedFileVersionService
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  getNotebookInputRegistry: () => NotebookInputRegistry
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
} {
  // Share one repository and registry so runtime artifact claims and renderer finalization meet.
  const artifactRepository = createDefaultArtifactRepository()
  const notebookRepository = new NotebookRunRepository(resolveDataRoot())
  const notebookDependencyAnalyzer = new NotebookDependencyAnalyzer({
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
    managedFileVersions: managedFileVersionService,
    compatibilityRepository: artifactRepository,
    notebookRepository,
    dependencyAnalyzer: notebookDependencyAnalyzer,
    loadSession: (projectId, appSessionId) => sessionRepository.loadSession(projectId, appSessionId)
  })
  const contentRepository = new ContentRepository({
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
  const localFsService = new LocalFsService(grantedRootsRepository, () =>
    shutdownNotebooksBeforePolicyChange('granted-roots')
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
  // One registry owns short-lived capability URLs for both managed artifact repositories.
  const previewResources = new ManagedPreviewResources({
    resolvePath: resolveManagedFilePath,
    openLiterature: (reference) => literatureAttachmentAuthority.openReference(reference),
    openLatestManagedFile: (source, request) =>
      managedFileVersionService.openLatest({ source, ...request }),
    openManagedFileVersion: (source, request) =>
      managedFileVersionService.openVersion(
        { source, projectId: request.projectId, fileId: request.fileId },
        request.versionId
      ),
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
    managedPreviewOwners
  }
}
