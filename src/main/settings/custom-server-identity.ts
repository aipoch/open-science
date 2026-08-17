import type { StoredCustomMcpServer } from './types'

export class CustomServerIdConflictError extends Error {
  constructor() {
    super('ID is already in use.')
  }
}

export const appendCustomServer = (
  existing: StoredCustomMcpServer[] | undefined,
  server: StoredCustomMcpServer
): StoredCustomMcpServer[] => {
  const servers = existing ?? []
  if (servers.some((candidate) => candidate.id === server.id || candidate.name === server.id)) {
    throw new CustomServerIdConflictError()
  }
  if (servers.some((candidate) => candidate.name === server.name || candidate.id === server.name)) {
    throw new Error(`A custom connector named "${server.name}" already exists`)
  }
  return [...servers, server]
}
