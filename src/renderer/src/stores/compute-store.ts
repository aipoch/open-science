import { create } from 'zustand'

import type {
  ComputeHost,
  CreateComputeHostRequest,
  DeleteComputeHostRequest,
  ProbeResult
} from '../../../shared/compute'

type ComputeStoreData = {
  hosts: ComputeHost[]
  isLoaded: boolean
  loadError: string | undefined
  // Selectable Host aliases parsed from ~/.ssh/config, loaded lazily when the Add form opens.
  sshAliases: string[]
  // Tracks which hosts are currently being probed so the UI can show a Probing... state.
  probingIds: Set<string>
}

type ComputeStore = ComputeStoreData & {
  loadHosts: () => Promise<void>
  loadSshAliases: () => Promise<void>
  createHost: (request: CreateComputeHostRequest) => Promise<ComputeHost>
  deleteHost: (providerId: string) => Promise<void>
  // Runs the probe bundle and updates the cached host with the returned probeResult.
  probeHost: (providerId: string) => Promise<ProbeResult>
}

// Surfaces DB/IPC failures as a short message instead of a silent empty list.
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown error'

// Keeps hosts newest-first, matching the repository's list ordering.
const sortByCreatedDesc = (hosts: ComputeHost[]): ComputeHost[] =>
  [...hosts].sort((left, right) => right.createdAt - left.createdAt)

export const createInitialComputeState = (): ComputeStoreData => ({
  hosts: [],
  isLoaded: false,
  loadError: undefined,
  sshAliases: [],
  probingIds: new Set()
})

// Renderer cache of the SQLite-backed compute host list; the DB remains the source of truth.
export const useComputeStore = create<ComputeStore>((set) => ({
  ...createInitialComputeState(),

  // Loads the full host list. A DB/IPC failure is recorded (not thrown) so the panel can show an
  // error instead of a silent empty list.
  loadHosts: async () => {
    try {
      const hosts = await window.api.compute.list()

      set({ hosts: sortByCreatedDesc(hosts), isLoaded: true, loadError: undefined })
    } catch (error) {
      set({ isLoaded: true, loadError: describeError(error) })
    }
  },

  // Loads ~/.ssh/config aliases for the Add form dropdown. A failure degrades to an empty list (the
  // user can still type an alias), so this never throws.
  loadSshAliases: async () => {
    try {
      const sshAliases = await window.api.compute.sshConfigAliases()

      set({ sshAliases })
    } catch {
      set({ sshAliases: [] })
    }
  },

  // Creates a host and merges the returned row into the cache. Rejections propagate so the Add form
  // can show the readable error (e.g. duplicate alias) and stay open.
  createHost: async (request) => {
    const host = await window.api.compute.create(request)

    set((state) => ({
      hosts: sortByCreatedDesc([
        host,
        ...state.hosts.filter((h) => h.providerId !== host.providerId)
      ]),
      loadError: undefined
    }))

    return host
  },

  // Removes a host by provider id and drops it from the cache.
  deleteHost: async (providerId) => {
    const request: DeleteComputeHostRequest = { providerId }
    await window.api.compute.delete(request)

    set((state) => ({ hosts: state.hosts.filter((host) => host.providerId !== providerId) }))
  },

  // Triggers a probe for the given host. Marks the host as probing during the call, then merges
  // the returned probeResult back into the cached host. Propagates errors so the UI can show the
  // failed banner; probeResult itself already carries the structured failure.
  probeHost: async (providerId) => {
    set((state) => ({
      probingIds: new Set([...state.probingIds, providerId])
    }))
    try {
      const probeResult = await window.api.compute.probe(providerId)
      // Merge the returned probeResult into the cached host. Re-fetch the full host to pick up
      // shape / scratchRoot changes the probe may have written.
      const updatedHost = await window.api.compute.get(providerId)
      set((state) => ({
        hosts: state.hosts.map((h) =>
          h.providerId === providerId ? (updatedHost ?? { ...h, probeResult }) : h
        )
      }))
      return probeResult
    } finally {
      set((state) => {
        const next = new Set(state.probingIds)
        next.delete(providerId)
        return { probingIds: next }
      })
    }
  }
}))
