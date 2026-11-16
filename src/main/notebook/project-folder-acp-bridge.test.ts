import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProjectFolderChange } from '../../shared/project-folder-changes'
import {
  acceptMissingDataRoot,
  clearMigrationPending,
  initializeDataRootWriteAvailability
} from '../storage/migration-state'
import { NotebookLocalRpcServer } from './local-rpc-server'

const change: ProjectFolderChange = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: 'project',
  sessionId: 'session',
  runId: 'turn',
  relativePath: 'raw.csv',
  operation: 'replace',
  requiresConfirmation: true,
  state: 'prepared'
}
const input = {
  projectId: 'project',
  sessionId: 'session',
  runId: 'turn',
  cwd: '/managed',
  path: '/Research/raw.csv',
  content: 'PREPARED',
  permissionPrompts: 'none' as const
}
beforeEach(() => {
  initializeDataRootWriteAvailability(false)
  acceptMissingDataRoot()
})
afterEach(() => {
  clearMigrationPending()
  initializeDataRootWriteAvailability(false)
})

it('delegates prepared exact changes to the D3 service and forwards unattended policy', async () => {
  const prepare = vi.fn().mockResolvedValue(change)
  const apply = vi.fn().mockResolvedValue({ ...change, state: 'applied' })
  const service = { prepareAcpProjectFolderChange: prepare, applyProjectFolderChange: apply }
  const server = new NotebookLocalRpcServer(service as never)
  const signal = new AbortController().signal
  expect(await server.writeAcpProjectFolderFile(input, signal)).toBe(true)
  expect(prepare).toHaveBeenCalledWith({ ...input, operation: 'write' })
  expect(apply).toHaveBeenCalledWith(input, change.id, signal, 'none')
})

it('never reports a rejected original change as a successful write', async () => {
  const server = new NotebookLocalRpcServer({
    prepareAcpProjectFolderChange: vi.fn().mockResolvedValue(change),
    applyProjectFolderChange: vi.fn().mockResolvedValue({ ...change, state: 'rejected' })
  } as never)
  await expect(server.writeAcpProjectFolderFile(input)).rejects.toThrow(
    'original file was not changed'
  )
})

it('returns unhandled for other grant roots without applying a project receipt', async () => {
  const apply = vi.fn()
  const server = new NotebookLocalRpcServer({
    prepareAcpProjectFolderChange: vi.fn().mockResolvedValue(undefined),
    applyProjectFolderChange: apply
  } as never)
  expect(await server.writeAcpProjectFolderFile(input)).toBe(false)
  expect(apply).not.toHaveBeenCalled()
})

it('does not prepare or apply a cancelled turn, and root resolution stays host-only', async () => {
  const prepare = vi.fn()
  const resolve = vi.fn().mockResolvedValue('/Research')
  const server = new NotebookLocalRpcServer({
    resolveProjectFolderRoot: resolve,
    prepareAcpProjectFolderChange: prepare,
    applyProjectFolderChange: vi.fn()
  } as never)
  expect(await server.resolveProjectFolderRoot('project')).toBe('/Research')
  const abort = new AbortController()
  abort.abort()
  await expect(server.writeAcpProjectFolderFile(input, abort.signal)).rejects.toThrow()
  expect(prepare).not.toHaveBeenCalled()
})

it('treats an unchanged bound proposal as handled without direct-write fallback', async () => {
  const apply = vi.fn()
  const server = new NotebookLocalRpcServer({
    resolveProjectFolderRoot: vi.fn().mockResolvedValue('/Research'),
    prepareAcpProjectFolderChange: vi.fn().mockResolvedValue(undefined),
    applyProjectFolderChange: apply
  } as never)
  expect(await server.writeAcpProjectFolderFile(input)).toBe(true)
  expect(apply).not.toHaveBeenCalled()
})
