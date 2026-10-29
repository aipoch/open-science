export type NetworkDestination = Readonly<{
  hostname: string
  port: number
  approvedAddresses: readonly string[]
}>

export type NetworkDestinationGrant = NetworkDestination &
  Readonly<{
    id: string
    revokedAt?: number
    scope: 'project' | 'global'
    projectId: string
    sessionId: string
    recordId: string
    createdAt: number
  }>

export type NetworkBlockEvidence = Readonly<{
  recordId: string
  revision: number
  addresses: readonly string[]
  risks: readonly string[]
  blockReason: string
}>

export const addressesApproved = (
  addresses: readonly string[],
  approved: readonly string[]
): boolean => addresses.length > 0 && addresses.every((address) => approved.includes(address))

export const destinationGrantAllows = (
  grant: NetworkDestinationGrant,
  projectId: string,
  hostname: string,
  port: number,
  addresses: readonly string[]
): boolean =>
  grant.revokedAt === undefined &&
  (grant.scope === 'global' || grant.projectId === projectId) &&
  grant.hostname === hostname &&
  grant.port === port &&
  addressesApproved(addresses, grant.approvedAddresses)

export const normalizeNetworkDestinationGrants = (value: unknown): NetworkDestinationGrant[] => {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const result: NetworkDestinationGrant[] = []
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !['id', 'hostname', 'projectId', 'sessionId', 'recordId'].every(
        (key) => typeof entry[key] === 'string' && entry[key].length > 0 && entry[key].length <= 256
      ) ||
      (entry.revokedAt !== undefined &&
        (!Number.isSafeInteger(entry.revokedAt) || entry.revokedAt < 0)) ||
      !['project', 'global'].includes(entry.scope) ||
      !Number.isInteger(entry.port) ||
      entry.port < 1 ||
      entry.port > 65535 ||
      !Array.isArray(entry.approvedAddresses) ||
      !entry.approvedAddresses.length ||
      entry.approvedAddresses.length > 128 ||
      !entry.approvedAddresses.every(
        (address: unknown) =>
          typeof address === 'string' && /^[0-9a-f:.]+$/i.test(address) && address.length <= 45
      ) ||
      !Number.isSafeInteger(entry.createdAt) ||
      entry.createdAt < 0 ||
      ids.has(entry.id)
    )
      return []
    ids.add(entry.id)
    result.push({
      ...(entry.revokedAt !== undefined ? { revokedAt: entry.revokedAt } : {}),
      id: entry.id,
      hostname: entry.hostname,
      port: entry.port,
      approvedAddresses: [...new Set<string>(entry.approvedAddresses)].sort(),
      scope: entry.scope,
      projectId: entry.projectId,
      sessionId: entry.sessionId,
      recordId: entry.recordId,
      createdAt: entry.createdAt
    })
  }
  return result
}
