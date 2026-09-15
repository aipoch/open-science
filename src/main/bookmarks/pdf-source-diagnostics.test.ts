import { describe, expect, it, vi } from 'vitest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { BookmarkService } from './service'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger')>()),
  createLogger: () => ({ warn })
}))

const session: PersistedChatSession = {
  id: 'session',
  projectId: 'project',
  title: 'Private',
  cwd: '/private/path',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messages: []
}
const request = {
  projectId: 'project',
  sessionId: 'session',
  sourceKind: 'upload-version' as const,
  sourceFileId: 'private-file',
  versionId: 'private-version'
}

class PdfSourceHarness {
  constructor() {
    warn.mockReset()
  }
  lease = {
    path: '/private/document.pdf',
    size: 1,
    readRange: vi.fn(),
    verifyUnchanged: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  }
  version = {
    sourceKind: 'upload-version' as const,
    sourceSessionId: 'session',
    sourceFileId: request.sourceFileId,
    sourceVersionId: request.versionId,
    filename: 'private.pdf',
    sizeBytes: 1,
    checksum: 'a'.repeat(64),
    path: '/private/document.pdf',
    openContent: vi.fn(async () => this.lease)
  }
  load = vi.fn(
    async (): Promise<
      { status: 'found'; session: PersistedChatSession } | { status: 'missing' | 'unreadable' }
    > => ({ status: 'found', session })
  )
  resolveVersion = vi.fn(async () => this.version)
  service = new BookmarkService({
    repository: {
      recoverCreate: vi.fn(),
      create: vi.fn(),
      list: vi.fn(),
      updateNote: vi.fn(),
      delete: vi.fn()
    },
    sessions: { loadSessionWithDiagnostics: this.load },
    pdfVersions: { resolveVersion: this.resolveVersion },
    runWithSessionAuthority: (_project, _session, operation) => operation()
  })
}

describe('PDF bookmark source diagnostics', () => {
  it.each(['missing', 'unreadable'] as const)(
    'identifies a %s session without source data',
    async (status) => {
      const { service, load, resolveVersion } = new PdfSourceHarness()
      load.mockResolvedValue({ status })
      await expect(service.resolvePdfSource(request)).rejects.toThrow()
      expect(resolveVersion).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledExactlyOnceWith('PDF bookmark source verification failed', {
        stage: status === 'missing' ? 'session-unavailable' : 'session-unreadable',
        errorCategory: 'error'
      })
    }
  )
  it.each([
    'session-load',
    'version-resolution',
    'content-open',
    'content-verification',
    'content-close'
  ] as const)('preserves the exact %s rejection and records only safe fields', async (stage) => {
    const { service, load, resolveVersion, version, lease } = new PdfSourceHarness()
    const error = Object.assign(new Error('SECRET /private/path'), { code: 'EACCES' })
    const operations = {
      'session-load': load,
      'version-resolution': resolveVersion,
      'content-open': version.openContent,
      'content-verification': lease.verifyUnchanged,
      'content-close': lease.close
    }
    operations[stage].mockRejectedValue(error)
    await expect(service.resolvePdfSource(request)).rejects.toBe(error)
    expect(warn).toHaveBeenCalledExactlyOnceWith('PDF bookmark source verification failed', {
      stage,
      errorCategory: 'permission'
    })
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SECRET|private|project|sessionId/u)
    if (stage === 'content-verification') expect(lease.close).toHaveBeenCalledOnce()
  })
  it.each(['read-only', 'wrong-project'] as const)(
    'identifies a %s session before resolving content',
    async (condition) => {
      const { service, load, resolveVersion } = new PdfSourceHarness()
      load.mockResolvedValue({
        status: 'found',
        session: {
          ...session,
          ...(condition === 'wrong-project'
            ? { projectId: 'another-project' }
            : {
                packageOrigin: {
                  importId: 'import',
                  sourceProjectId: 'source-project',
                  sourceSessionId: 'source-session',
                  importedAt: 1,
                  manifestChecksum: 'a'.repeat(64)
                }
              })
        }
      })
      await expect(service.resolvePdfSource(request)).rejects.toThrow()
      expect(resolveVersion).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledExactlyOnceWith('PDF bookmark source verification failed', {
        stage: condition === 'read-only' ? 'session-read-only' : 'session-unavailable',
        errorCategory: 'error'
      })
    }
  )

  it('does not replace the rejection when logging fails', async () => {
    const { service, load } = new PdfSourceHarness()
    const error = new Error('private error')
    load.mockRejectedValue(error)
    warn.mockImplementation(() => {
      throw new Error('logger failed')
    })
    await expect(service.resolvePdfSource(request)).rejects.toBe(error)
  })
  it('does not log successful resolution', async () => {
    const { service } = new PdfSourceHarness()
    await expect(service.resolvePdfSource(request)).resolves.toMatchObject({ ok: true })
    expect(warn).not.toHaveBeenCalled()
  })
})
