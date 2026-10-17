import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { ResearchDemoSource } from '../../../shared/research-demo'

export type ResearchDemoCarrier = { sessionId: string; source: ResearchDemoSource }
const pending = new Map<string, Promise<void>>()

/** Main's explicit owner index is the only authority for grouping a Session as a demo.
 * Never infer ownership from its title, research membership, artifacts or old launch receipts. */
export const useResearchDemoStore = create<{
  carriersByProject: Record<string, readonly ResearchDemoCarrier[]>
}>()(() => ({ carriersByProject: {} }))

export const refreshResearchDemoCarriers = (projectId: string): Promise<void> => {
  if (!projectId || typeof window.api?.researchDemos?.carriers !== 'function')
    return Promise.resolve()
  const existing = pending.get(projectId)
  if (existing) return existing
  const work = window.api.researchDemos
    .carriers({ projectId })
    .then((carriers) => {
      useResearchDemoStore.setState((state) => ({
        carriersByProject: {
          ...state.carriersByProject,
          [projectId]: carriers.filter((carrier) => carrier.source.projectId === projectId)
        }
      }))
    })
    .catch(() => {
      // Failed discovery must not make an ordinary Session inaccessible.
      useResearchDemoStore.setState((state) => ({
        carriersByProject: { ...state.carriersByProject, [projectId]: [] }
      }))
    })
    .finally(() => pending.delete(projectId))
  pending.set(projectId, work)
  return work
}

export const isResearchDemoCarrier = (projectId: string, sessionId: string): boolean =>
  Boolean(
    useResearchDemoStore
      .getState()
      .carriersByProject[projectId]?.some((carrier) => carrier.sessionId === sessionId)
  )

export const useResearchDemoCarriers = (
  projectIds: readonly string[],
  catalogIdentity?: string
): Record<string, readonly ResearchDemoCarrier[]> => {
  const key = JSON.stringify([...new Set(projectIds)].sort())
  const stableIds = useMemo(() => JSON.parse(key) as string[], [key])
  useEffect(() => {
    void Promise.all(stableIds.map(refreshResearchDemoCarriers))
  }, [stableIds, catalogIdentity])
  return useResearchDemoStore((state) => state.carriersByProject)
}
