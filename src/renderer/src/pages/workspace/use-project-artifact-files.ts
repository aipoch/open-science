import { useEffect, useState } from 'react'

import type { ArtifactFile } from '../../../../shared/artifacts'
import { useSessionStore } from '@/stores/session-store'

// Loads every on-disk artifact for a project (the storage project name matches the durable project id)
// so the file library can surface files whose owning session was deleted. Re-fetches when the project
// changes or when the set of sessions in it changes — the only events that can create or clear an
// orphan (a delete removes the metadata that was keeping a file "owned"). Failures resolve to an empty
// list: orphan recovery is additive, so a scan error must never blank out the session-derived library.
export const useProjectArtifactFiles = (projectId: string | undefined): ArtifactFile[] => {
  const sessions = useSessionStore((state) => state.sessions)
  const [diskArtifacts, setDiskArtifacts] = useState<ArtifactFile[]>([])

  // A stable signature of the project's session ids: changes on create/delete, not on every keystroke.
  const sessionSignature = sessions
    .filter((session) => session.projectId === projectId)
    .map((session) => session.id)
    .sort()
    .join(',')

  useEffect(() => {
    if (!projectId) {
      setDiskArtifacts([])
      return
    }

    let cancelled = false

    void window.api.artifacts
      .listProjectFiles({ projectName: projectId })
      .then((files) => {
        if (!cancelled) setDiskArtifacts(files)
      })
      .catch(() => {
        if (!cancelled) setDiskArtifacts([])
      })

    return () => {
      cancelled = true
    }
  }, [projectId, sessionSignature])

  return diskArtifacts
}
