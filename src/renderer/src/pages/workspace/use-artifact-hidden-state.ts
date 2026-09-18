import { useEffect, useState } from 'react'

const EMPTY_IDS: ReadonlySet<string> = new Set()

// Hidden IDs are denial metadata only. Keep them separate from persisted Session evidence so
// visibility changes cannot delete history, and discard reads begun before the latest event.
export const useArtifactHiddenState = (
  projectId: string | undefined
): {
  ready: boolean
  ids: ReadonlySet<string>
} => {
  const [state, setState] = useState<{
    projectId?: string
    ready: boolean
    ids: ReadonlySet<string>
  }>({ ready: false, ids: EMPTY_IDS })
  const supported = typeof window.api?.projectFiles?.getHiddenArtifactIds === 'function'
  useEffect(() => {
    if (!projectId || !supported) return
    let active = true
    let generation = 0
    const refresh = (): void => {
      const requestGeneration = ++generation
      setState({ projectId, ready: false, ids: EMPTY_IDS })
      void window.api.projectFiles
        .getHiddenArtifactIds({ projectId })
        .then((rows) => {
          if (!active || requestGeneration !== generation) return
          setState({
            projectId,
            ready: true,
            ids: new Set(rows.flatMap((row) => [row.fileId, ...row.versionIds]))
          })
        })
        .catch(() => {
          /* Keep the view closed until an authoritative refresh succeeds. */
        })
    }
    refresh()
    const unsubscribe = window.api.projectFiles.onChanged((event) => {
      if (event.projectId === projectId) refresh()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [projectId, supported])
  if (!projectId || !supported) return { ready: true, ids: EMPTY_IDS }
  return state.projectId === projectId ? state : { ready: false, ids: EMPTY_IDS }
}

// Local/legacy previews may have no Project identity. Re-admit their path on every visibility
// event, and remove decoded content while the main-process policy is being checked.
export const usePreviewPathVisibility = (path: string | undefined): boolean => {
  const [state, setState] = useState<{ path?: string; allowed: boolean }>({ allowed: false })
  const supported = typeof window.api?.projectFiles?.getHiddenArtifactIds === 'function'
  useEffect(() => {
    if (!path || !supported) return
    let active = true
    let generation = 0
    const refresh = (): void => {
      const current = ++generation
      setState({ path, allowed: false })
      void window.api.previewResources
        .acquire({ source: 'local', path })
        .then(async (resource) => {
          await window.api.previewResources.release({ resourceId: resource.id })
          if (active && generation === current) setState({ path, allowed: true })
        })
        .catch(() => {
          /* Failed admission leaves decoded content unmounted. */
        })
    }
    refresh()
    const unsubscribe = window.api.projectFiles.onChanged((event) => {
      if (event.artifactVisibilityChanged) refresh()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [path, supported])
  return !path || !supported || (state.path === path && state.allowed)
}
