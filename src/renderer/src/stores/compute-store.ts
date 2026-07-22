import { create } from 'zustand'

import type {
  ComputeApprovalDecision,
  ComputeApprovalRequest,
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
  // Pending compute approval requests, oldest first. Answered one at a time.
  pendingApprovals: ComputeApprovalRequest[]
}

type ComputeStore = ComputeStoreData & {
  loadHosts: () => Promise<void>
  loadSshAliases: () => Promise<void>
  createHost: (request: CreateComputeHostRequest) => Promise<ComputeHost>
  deleteHost: (providerId: string) => Promise<void>
  // Runs the probe bundle and updates the cached host with the returned probeResult.
  probeHost: (providerId: string) => Promise<ProbeResult>
  // Saves the details document (full replace with old_text guard). Author is always 'user' from UI.
  saveDetails: (providerId: string, text: string, oldText: string) => Promise<void>
  // Sets the scratch root path and marks the host as pinned.
  setScratch: (providerId: string, path: string) => Promise<void>
  // Sets the concurrent job limit (1..500). Phase 1 stores but does not enforce.
  setConcurrency: (providerId: string, limit: number) => Promise<void>
  // Queues an incoming approval request (from the main-process compute gate).
  enqueueApproval: (request: ComputeApprovalRequest) => void
  // Sends the user's approval decision back to main and removes the request from the queue.
  respondApproval: (id: string, decision: ComputeApprovalDecision) => Promise<void>
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
  probingIds: new Set(),
  pendingApprovals: []
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
  },

  // Saves the details document via full replace (old_text guard prevents concurrent collisions).
  // The UI always writes with author='user'; issue 06 agent paths will call the same IPC directly.
  saveDetails: async (providerId, text, oldText) => {
    await window.api.compute.detailsSave(providerId, text, oldText, 'user')
    // Re-fetch so detailsUpdatedAt/detailsUpdatedBy are reflected in the cache.
    const updatedHost = await window.api.compute.get(providerId)
    if (updatedHost) {
      set((state) => ({
        hosts: state.hosts.map((h) => (h.providerId === providerId ? updatedHost : h))
      }))
    }
  },

  // Sets the scratch root path and marks the host as pinned. Merges the updated host into cache.
  setScratch: async (providerId, path) => {
    await window.api.compute.scratchSet(providerId, path)
    const updatedHost = await window.api.compute.get(providerId)
    if (updatedHost) {
      set((state) => ({
        hosts: state.hosts.map((h) => (h.providerId === providerId ? updatedHost : h))
      }))
    }
  },

  // Stores the concurrent job limit. Merges the updated host into cache.
  setConcurrency: async (providerId, limit) => {
    await window.api.compute.concurrencySet(providerId, limit)
    const updatedHost = await window.api.compute.get(providerId)
    if (updatedHost) {
      set((state) => ({
        hosts: state.hosts.map((h) => (h.providerId === providerId ? updatedHost : h))
      }))
    }
  },

  // Queues an incoming compute approval request (pushed from main before each SSH call).
  enqueueApproval: (request) => {
    set((state) => ({ pendingApprovals: [...state.pendingApprovals, request] }))
  },

  // Sends the user's scoped decision back to main and removes the head request from the queue.
  respondApproval: async (id, decision) => {
    await window.api.compute.respondApproval({ id, decision })
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((r) => r.id !== id)
    }))
  }
}))
