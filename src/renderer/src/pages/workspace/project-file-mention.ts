import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import type { ProjectFileItem } from '../../../../shared/project-files'
import { isProjectFileMentionAvailable } from './use-project-file-mention-availability'

// Callers may hold a full project file row (cards, drag transfers) or only the managed identity
// around a preview item (the open artifact header). Both resolve to the same immutable reference.
export type ProjectFileMentionTarget = Pick<
  ProjectFileItem,
  'id' | 'source' | 'sourceFileId' | 'projectId' | 'name' | 'path'
> & { mimeType?: string; versionId?: string }

export type ProjectFileMentionOutcome = 'mentioned' | 'unavailable' | 'version-unresolved'

// Resolves the requested Version or current head through the public inspection surface (same flow the Global
// Search mention uses) and hands the complete immutable reference to the composer owner. The
// Recheck the originating composer after inspection; navigation and capacity can change while
// the immutable Version is being resolved.
export const mentionProjectFile = async (
  file: ProjectFileMentionTarget
): Promise<ProjectFileMentionOutcome> => {
  if (!isProjectFileMentionAvailable(file.projectId)) return 'unavailable'
  const sessionId = useSessionStore.getState().selectedSessionId
  const revision = useNavigationStore.getState().explicitNavigationRevision
  try {
    const response = await window.api.managedFileVersions.inspect({
      source: file.source,
      projectId: file.projectId,
      fileId: file.sourceFileId,
      ...(file.versionId ? { versionId: file.versionId } : {})
    })
    if (!response.ok) return 'unavailable'
    const { selectedVersion, headVersion, headVersionId, versions } = response.value
    const version = file.versionId
      ? [selectedVersion, headVersion, ...versions].find((entry) => entry?.id === file.versionId)
      : (headVersion ?? versions.find((entry) => entry.id === headVersionId))
    if (!version) return 'version-unresolved'
    if (
      useSessionStore.getState().selectedSessionId !== sessionId ||
      useNavigationStore.getState().explicitNavigationRevision !== revision ||
      !isProjectFileMentionAvailable(file.projectId)
    )
      return 'unavailable'
    // The composer only reads the reference fields below; the resolved Version replaces the
    // index-time descriptor for the pending mention.
    useNavigationStore.getState().requestArtifactMention({
      ...(file as ProjectFileItem),
      sourceVersionId: version.id,
      checksum: version.checksum,
      sessionId: response.value.sessionId,
      name: response.value.displayName,
      mimeType: version.contentType ?? file.mimeType,
      size: version.sizeBytes,
      sortAtMs: Date.parse(version.createdAt)
    })
    return 'mentioned'
  } catch {
    return 'unavailable'
  }
}
