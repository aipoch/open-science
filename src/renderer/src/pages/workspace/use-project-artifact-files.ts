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
    let cancelled = false

    // Resolve to [] when there is no project rather than calling setState synchronously in the effect
    // body; setState only ever runs inside this async callback. The try/catch tolerates both a missing
    // bridge method (e.g. an older/web preload without listProjectFiles) and a scan failure, so orphan
    // recovery never crashes the panel or composer that mounts this hook.
    const load = async (): Promise<ArtifactFile[]> => {
      if (!projectId) return []
      try {
        return await window.api.artifacts.listProjectFiles({ projectName: projectId })
      } catch {
        return []
      }
    }

    void load().then((files) => {
      if (!cancelled) setDiskArtifacts(files)
    })

    return () => {
      cancelled = true
    }
  }, [projectId, sessionSignature])

  return diskArtifacts
}
