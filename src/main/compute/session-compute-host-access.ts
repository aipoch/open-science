type SessionComputeHostAccess = Readonly<{
  enabledProviderIds: readonly string[]
  selectedProviderIds: readonly string[]
}>

type SessionComputeHostAccessPruneSnapshot = Readonly<{
  projectId: string
  sessionId: string
  providerIds: string[]
  selectedProviderIds: string[]
}>

type SessionComputeHostAccessMutation =
  | Readonly<{
      kind: 'set-host-enabled'
      providerId: string
      enabled: boolean
    }>
  | Readonly<{
      kind: 'set-host-selected'
      providerId: string
      selected: boolean
    }>
  | Readonly<{
      kind: 'select-explicit'
      providerIds: readonly string[]
    }>
  | Readonly<{
      kind: 'replace-access'
      access: SessionComputeHostAccess
    }>

const sessionComputeHostAccess = (session: {
  enabledComputeHosts?: readonly string[]
  selectedComputeHosts?: readonly string[]
}): SessionComputeHostAccess => {
  const enabledProviderIds = [...new Set(session.enabledComputeHosts ?? [])]
  const enabledProviderIdSet = new Set(enabledProviderIds)
  const selectedProviderIds = [
    ...new Set(session.selectedComputeHosts ?? session.enabledComputeHosts ?? [])
  ].filter((providerId) => enabledProviderIdSet.has(providerId))
  return { enabledProviderIds, selectedProviderIds }
}

const transitionSessionComputeHostAccess = (
  access: SessionComputeHostAccess,
  mutation: SessionComputeHostAccessMutation
): SessionComputeHostAccess => {
  if (mutation.kind === 'replace-access') {
    const enabledProviderIds = [...new Set(mutation.access.enabledProviderIds)]
    const enabledProviderIdSet = new Set(enabledProviderIds)
    return {
      enabledProviderIds,
      selectedProviderIds: [...new Set(mutation.access.selectedProviderIds)].filter((providerId) =>
        enabledProviderIdSet.has(providerId)
      )
    }
  }
  if (mutation.kind === 'select-explicit') {
    const selectedProviderIds = [...new Set(mutation.providerIds)]
    return {
      enabledProviderIds: [...new Set([...access.enabledProviderIds, ...selectedProviderIds])],
      selectedProviderIds
    }
  }
  if (mutation.kind === 'set-host-selected') {
    return {
      enabledProviderIds: mutation.selected
        ? [...new Set([...access.enabledProviderIds, mutation.providerId])]
        : [...access.enabledProviderIds],
      selectedProviderIds: mutation.selected
        ? [...new Set([...access.selectedProviderIds, mutation.providerId])]
        : access.selectedProviderIds.filter((providerId) => providerId !== mutation.providerId)
    }
  }
  if (mutation.enabled) {
    return {
      enabledProviderIds: [...new Set([...access.enabledProviderIds, mutation.providerId])],
      selectedProviderIds: [...access.selectedProviderIds]
    }
  }
  return {
    enabledProviderIds: access.enabledProviderIds.filter(
      (providerId) => providerId !== mutation.providerId
    ),
    selectedProviderIds: access.selectedProviderIds.filter(
      (providerId) => providerId !== mutation.providerId
    )
  }
}

const computeHostAccessPruneSnapshot = (
  session: {
    id: string
    projectId: string
    enabledComputeHosts?: readonly string[]
    selectedComputeHosts?: readonly string[]
  },
  validProviderIds: ReadonlySet<string>
): SessionComputeHostAccessPruneSnapshot | undefined => {
  const access = sessionComputeHostAccess(session)
  if (
    [...access.enabledProviderIds, ...access.selectedProviderIds].every((providerId) =>
      validProviderIds.has(providerId)
    )
  ) {
    return undefined
  }
  return {
    projectId: session.projectId,
    sessionId: session.id,
    providerIds: [...access.enabledProviderIds],
    selectedProviderIds: [...access.selectedProviderIds]
  }
}

const computeHostAccessPruneSnapshots = <
  Session extends Parameters<typeof computeHostAccessPruneSnapshot>[0]
>(
  sessions: readonly Session[],
  validProviderIds: ReadonlySet<string>
): SessionComputeHostAccessPruneSnapshot[] =>
  sessions.flatMap((session) => {
    const snapshot = computeHostAccessPruneSnapshot(session, validProviderIds)
    return snapshot ? [snapshot] : []
  })

const resolveSessionComputeHostAccessUpdate = (
  session: Parameters<typeof sessionComputeHostAccess>[0],
  providerIdsOrMutation: readonly string[] | SessionComputeHostAccessMutation
): SessionComputeHostAccess =>
  Array.isArray(providerIdsOrMutation)
    ? {
        enabledProviderIds: [...providerIdsOrMutation],
        selectedProviderIds: [...providerIdsOrMutation]
      }
    : transitionSessionComputeHostAccess(
        sessionComputeHostAccess(session),
        providerIdsOrMutation as SessionComputeHostAccessMutation
      )

const pruneSessionComputeHostAccess = (
  session: Parameters<typeof sessionComputeHostAccess>[0],
  validProviderIds: ReadonlySet<string>
): SessionComputeHostAccess | undefined => {
  const current = sessionComputeHostAccess(session)
  const access = {
    enabledProviderIds: current.enabledProviderIds.filter((id) => validProviderIds.has(id)),
    selectedProviderIds: current.selectedProviderIds.filter((id) => validProviderIds.has(id))
  }
  return access.enabledProviderIds.length === current.enabledProviderIds.length &&
    access.selectedProviderIds.length === current.selectedProviderIds.length
    ? undefined
    : access
}

const persistedSessionComputeHostAccess = (
  access: SessionComputeHostAccess
): Readonly<{ enabledComputeHosts: string[]; selectedComputeHosts: string[] }> => ({
  enabledComputeHosts: [...access.enabledProviderIds],
  selectedComputeHosts: [...access.selectedProviderIds]
})

const sessionComputeHostAccessPolicy = Object.freeze({
  persisted: persistedSessionComputeHostAccess,
  prune: pruneSessionComputeHostAccess,
  resolveUpdate: resolveSessionComputeHostAccessUpdate
})

export {
  computeHostAccessPruneSnapshots,
  sessionComputeHostAccessPolicy,
  sessionComputeHostAccess,
  transitionSessionComputeHostAccess
}
export type {
  SessionComputeHostAccess,
  SessionComputeHostAccessMutation,
  SessionComputeHostAccessPruneSnapshot
}
