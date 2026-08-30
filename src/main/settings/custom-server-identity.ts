import { createHmac, randomBytes } from 'node:crypto'

import type { StoredConnectors, StoredCustomMcpServer } from './types'

const stableRecordEntries = (record: Record<string, string> | undefined): [string, string][] =>
  Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right))

const customServerSecurityFingerprintKey = randomBytes(32)

const customServerCredentialFingerprint = (server: StoredCustomMcpServer): string =>
  createHmac('sha256', customServerSecurityFingerprintKey)
    .update(
      JSON.stringify([
        server.transport,
        server.command ?? null,
        server.args ?? [],
        server.url ?? null,
        stableRecordEntries(server.envRefs ?? server.env),
        stableRecordEntries(server.headerRefs ?? server.headers),
        server.oauthClientSecretRef ?? null
      ])
    )
    .digest('hex')

// Process-local fingerprint for compare-and-set writes and live dispatch generations. Secret values
// are authenticated with an ephemeral key instead of being retained in an enumerable digest.
export const customServerSecurityFingerprint = (server: StoredCustomMcpServer): string =>
  JSON.stringify([server.oauth ?? null, customServerCredentialFingerprint(server)])

export class CustomServerIdConflictError extends Error {
  constructor() {
    super('ID is already in use.')
  }
}

export const appendCustomServer = (
  existing: StoredCustomMcpServer[] | undefined,
  server: StoredCustomMcpServer,
  reservedIds: readonly string[] = []
): StoredCustomMcpServer[] => {
  const servers = existing ?? []
  if (
    reservedIds.includes(server.id) ||
    servers.some((candidate) => candidate.id === server.id || candidate.name === server.id)
  ) {
    throw new CustomServerIdConflictError()
  }
  if (servers.some((candidate) => candidate.name === server.name || candidate.id === server.name)) {
    throw new Error(`A custom connector named "${server.name}" already exists`)
  }
  return [...servers, server]
}

export const beginCustomServerDeletion = (connectors: StoredConnectors, id: string): void => {
  const removed = (connectors.customMcpServers ?? []).find((server) => server.id === id)
  if (!removed) return
  connectors.customMcpServers = (connectors.customMcpServers ?? []).filter(
    (server) => server.id !== id
  )
  connectors.pendingCustomServerDeletionIds = [
    ...new Set([...(connectors.pendingCustomServerDeletionIds ?? []), id])
  ]
  connectors.autoAllowIds = connectors.autoAllowIds.filter((entry) => entry !== removed.name)
  const withoutToolAlias = (entries: string[] | undefined): string[] | undefined => {
    const kept = (entries ?? []).filter((entry) => !entry.startsWith(`${removed.name}/`))
    return kept.length > 0 ? kept : undefined
  }
  connectors.blockedToolIds = withoutToolAlias(connectors.blockedToolIds)
  connectors.askToolIds = withoutToolAlias(connectors.askToolIds)
}

export const completeCustomServerDeletion = (connectors: StoredConnectors, id: string): void => {
  const pending = (connectors.pendingCustomServerDeletionIds ?? []).filter(
    (candidate) => candidate !== id
  )
  connectors.pendingCustomServerDeletionIds = pending.length > 0 ? pending : undefined
}
