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
  // Tag the loaded scan with the project it belongs to so a not-yet-refreshed result from the previous
  // project is never returned for the current one.
  const [scan, setScan] = useState<{ projectId: string | undefined; files: ArtifactFile[] }>({
    projectId: undefined,
    files: []
  })

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
      if (!cancelled) setScan({ projectId, files })
    })

    return () => {
      cancelled = true
    }
  }, [projectId, sessionSignature])

  // Until the scan for the CURRENT project resolves, return [] rather than the previous project's
  // files — otherwise, on a project switch, they would briefly surface as this project's "Orphaned"
  // artifacts in the Files panel and the @ picker, and could even be selected.
  return scan.projectId === projectId ? scan.files : []
}
