import { create } from 'zustand'

import type {
  ChangeComputeHostAuthenticationRequest,
  ComputeApprovalDecision,
  ComputeApprovalRequest,
  ComputeHost,
  CreateComputeHostRequest,
  CreatePasswordComputeHostRequest,
  ResetPasswordComputeHostRequest,
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
  createPasswordHost: (request: CreatePasswordComputeHostRequest) => Promise<ComputeHost>
  resetPassword: (request: ResetPasswordComputeHostRequest) => Promise<ComputeHost>
  changeAuthentication: (request: ChangeComputeHostAuthenticationRequest) => Promise<ComputeHost>
  deleteHost: (providerId: string) => Promise<void>
  // Runs the probe bundle and updates the cached host with the returned probeResult.
  probeHost: (providerId: string) => Promise<ProbeResult>
  // Saves the details document (full replace with old_text guard). Author is always 'user' from UI.
  saveDetails: (providerId: string, text: string, oldText: string) => Promise<void>
  // Sets the scratch root path and marks the host as pinned.
  setScratch: (providerId: string, path: string) => Promise<void>
  // Sets the enforced concurrent job limit (1..500).
  setConcurrency: (providerId: string, limit: number) => Promise<void>
  // Queues an incoming approval request (from the main-process compute gate).
  enqueueApproval: (request: ComputeApprovalRequest) => void
  // Removes a request after Main reports response, timeout, or cancellation settlement.
  dismissApproval: (id: string) => void
  // Sends the user's approval decision back to main and removes the request from the queue.
  respondApproval: (id: string, decision: ComputeApprovalDecision) => Promise<void>
}

// Surfaces DB/IPC failures as a short message instead of a silent empty list.
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown error'

// Keeps hosts newest-first, matching the repository's list ordering.
const sortByCreatedDesc = (hosts: ComputeHost[]): ComputeHost[] =>
  [...hosts].sort((left, right) => right.createdAt - left.createdAt)

let loadHostsRequest: Promise<void> | undefined
let computePanelPreloadReady = false

export const createInitialComputeState = (): ComputeStoreData => ({
  hosts: [],
  isLoaded: false,
  loadError: undefined,
  sshAliases: [],
  probingIds: new Set(),
  pendingApprovals: []
})

// Renderer cache of the SQLite-backed compute host list; the DB remains the source of truth.
export const useComputeStore = create<ComputeStore>((set, get) => ({
  ...createInitialComputeState(),

  // Loads the full host list. A DB/IPC failure is recorded (not thrown) so the panel can show an
  // error instead of a silent empty list.
  loadHosts: () => {
    if (loadHostsRequest) return loadHostsRequest
    const request = window.api.compute.list().then(
      (hosts) => {
        set({ hosts: sortByCreatedDesc(hosts), isLoaded: true, loadError: undefined })
      },
      (error: unknown) => {
        set({ isLoaded: true, loadError: describeError(error) })
      }
    )
    const trackedRequest = request.finally(() => {
      if (loadHostsRequest === trackedRequest) loadHostsRequest = undefined
    })
    loadHostsRequest = trackedRequest
    return trackedRequest
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

  createPasswordHost: async (request) => {
    const result = await window.api.compute.createPassword(request)
    if (!result.ok) {
      throw Object.assign(new Error(result.errorCode), { code: result.errorCode })
    }
    const host = result.host
    set((state) => ({
      hosts: sortByCreatedDesc([
        host,
        ...state.hosts.filter((candidate) => candidate.providerId !== host.providerId)
      ]),
      loadError: undefined
    }))
    return host
  },

  resetPassword: async (request) => {
    const result = await window.api.compute.resetPassword(request)
    if (!result.ok) {
      throw Object.assign(new Error(result.errorCode), { code: result.errorCode })
    }
    set((state) => ({
      hosts: state.hosts.map((host) =>
        host.providerId === result.host.providerId ? result.host : host
      )
    }))
    // The committed reset clears the persisted probe snapshot (main nulls it because the result
    // belongs to the previous credential revision). Re-probe so the Host's status refreshes on its
    // own instead of sitting at "Not probed". Fire-and-forget, like the Add form's post-create
    // probe: failures become probeResult.ok=false and surface in the detail UI.
    void get()
      .probeHost(result.host.providerId)
      .catch(() => undefined)
    return result.host
  },

  changeAuthentication: async (request) => {
    const result = await window.api.compute.changeAuthentication(request)
    if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode })
    const host = result.host
    set((state) => ({
      hosts: state.hosts.map((candidate) =>
        candidate.providerId === host.providerId ? host : candidate
      ),
      loadError: undefined
    }))
    // Same as resetPassword: the commit clears the persisted probe snapshot, so re-probe in the
    // background. Without this, a successful "Test and save" leaves the Host looking disconnected
    // ("Not probed") even though the candidate connection was just verified.
    void get()
      .probeHost(host.providerId)
      .catch(() => undefined)
    return host
  },

  // Removes a host by provider id and drops it from the cache.
  deleteHost: async (providerId) => {
    const request: DeleteComputeHostRequest = { providerId }
    try {
      await window.api.compute.delete(request)
    } catch (error) {
      let host: ComputeHost | null
      try {
        host = await window.api.compute.get(providerId)
      } catch {
        throw error
      }
      if (host) throw error
    }

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

  // Updates the concurrent job limit. Merges the updated host into cache.
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
    set((state) =>
      state.pendingApprovals.some(({ id }) => id === request.id)
        ? state
        : { pendingApprovals: [...state.pendingApprovals, request] }
    )
  },

  dismissApproval: (id) => {
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((request) => request.id !== id)
    }))
  },

  // Sends the user's scoped decision back to main and removes the head request from the queue.
  respondApproval: async (id, decision) => {
    await window.api.compute.respondApproval({ id, decision })
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((r) => r.id !== id)
    }))
  }
}))

// The lazy Settings boundary waits for the first host read before mounting ComputePanel. Consume
// that one result exactly once so the mount effect does not immediately repeat it; later remounts
// keep the panel's original fresh-read behavior.
export const preloadComputeHosts = async (): Promise<void> => {
  await useComputeStore.getState().loadHosts()
  computePanelPreloadReady = true
}

export const consumeComputeHostsPreload = (): boolean => {
  const ready = computePanelPreloadReady
  computePanelPreloadReady = false
  return ready
}
