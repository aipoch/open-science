import { normalizeNetworkHostname } from '@aipoch/notebook-network-sandbox/network-address'

export type NetworkDestination = Readonly<{
  hostname: string
  port: number
  protocol?: 'http' | 'https'
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

export const destinationGrantAllows = (
  grant: NetworkDestinationGrant,
  projectId: string,
  hostname: string,
  port: number,
  addresses: readonly string[],
  protocol: 'http' | 'https' = 'https'
): boolean => {
  void addresses
  const normalizedHostname = normalizeNetworkHostname(hostname)
  return (
    grant.revokedAt === undefined &&
    (grant.scope === 'global' || grant.projectId === projectId) &&
    normalizedHostname !== undefined &&
    grant.hostname === normalizedHostname &&
    grant.port === port &&
    (grant.protocol ?? 'https') === protocol
  )
}

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
      (entry.protocol !== undefined && entry.protocol !== 'http' && entry.protocol !== 'https') ||
      typeof entry.hostname !== 'string' ||
      normalizeNetworkHostname(entry.hostname) === undefined ||
      !Number.isInteger(entry.port) ||
      entry.port < 1 ||
      entry.port > 65535 ||
      !Array.isArray(entry.approvedAddresses) ||
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
      hostname: normalizeNetworkHostname(entry.hostname)!,
      port: entry.port,
      approvedAddresses: [...new Set<string>(entry.approvedAddresses)].sort(),
      ...(entry.protocol === 'http' || entry.protocol === 'https'
        ? { protocol: entry.protocol }
        : {}),
      scope: entry.scope,
      projectId: entry.projectId,
      sessionId: entry.sessionId,
      recordId: entry.recordId,
      createdAt: entry.createdAt
    })
  }
  return result
}
