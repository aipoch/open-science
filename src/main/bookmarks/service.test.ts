import { describe, expect, it, vi } from 'vitest'

import type { CreateBookmarkRequest } from '../../shared/bookmarks'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { BookmarkService, type PdfVersionAuthority } from './service'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger')>()),
  createLogger: () => ({ warn })
}))

const request = (): CreateBookmarkRequest => ({
  id: 'bookmark-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  target: {
    kind: 'text',
    source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' },
    quote: 'Saved quote'
  },
  note: ''
})

const session = (): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  createdAt: 1,
  updatedAt: 2,
  messages: []
})

describe('BookmarkService', () => {
  it('rejects a source that is not owned by the requested durable Session', async () => {
    const repository = {
      recoverCreate: vi.fn(async () => undefined),
      create: vi.fn(),
      list: vi.fn(),
      updateNote: vi.fn(),
      delete: vi.fn(),
      deleteSession: vi.fn(),
      deleteProject: vi.fn()
    }
    const service = new BookmarkService({
      repository,
      runWithSessionAuthority: (_projectId, _sessionId, operation) => operation(),
      sessions: {
        loadSessionWithDiagnostics: vi.fn(async () => ({
          status: 'found' as const,
          session: {
            id: 'session-1',
            projectId: 'project-1',
            title: 'Session',
            cwd: '/workspace',
            status: 'idle' as const,
            createdAt: 1,
            updatedAt: 2,
            messages: [
              {
                id: 'message-1',
                role: 'user' as const,
                content: 'User text',
                status: 'complete' as const,
                eventIds: [],
                createdAt: 1,
                updatedAt: 1
              }
            ]
          }
        }))
      }
    })

    await expect(service.create(request())).rejects.toThrow('Bookmark source is not available.')
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('recovers a committed create retry without requiring the source to remain available', async () => {
    const saved = {
      ...request(),
      version: 1 as const,
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z'
    }
    const repository = {
      recoverCreate: vi.fn(async () => saved),
      create: vi.fn(),
      list: vi.fn(),
      updateNote: vi.fn(),
      delete: vi.fn(),
      deleteSession: vi.fn(),
      deleteProject: vi.fn()
    }
    const loadSessionWithDiagnostics = vi.fn(async () => ({ status: 'missing' as const }))
    const runWithSessionAuthority = vi.fn((_projectId, _sessionId, operation) => operation())
    const service = new BookmarkService({
      repository,
      sessions: { loadSessionWithDiagnostics },
      runWithSessionAuthority
    })

    await expect(service.create(request())).resolves.toEqual(saved)
    expect(loadSessionWithDiagnostics).not.toHaveBeenCalled()
    expect(repository.create).not.toHaveBeenCalled()
    expect(runWithSessionAuthority).toHaveBeenCalledOnce()
  })

  it.each(['session-recovery', 'session-load', 'source-validation', 'persist'])(
    'records %s failures without leaking source details or replacing the error',
    async (stage) => {
      warn.mockReset()
      const secret = Object.assign(new Error('SECRET /private/path'), { code: 'EACCES' })
      const repository = {
        recoverCreate: vi.fn(async () => {
          if (stage === 'session-recovery') throw secret
          return undefined
        }),
        create: vi.fn(async () => {
          throw secret
        }),
        list: vi.fn(),
        updateNote: vi.fn(),
        delete: vi.fn(),
        deleteSession: vi.fn(),
        deleteProject: vi.fn()
      }
      const service = new BookmarkService({
        repository,
        sessions: {
          loadSessionWithDiagnostics: vi.fn(async () => {
            if (stage === 'session-load') throw secret
            return {
              status: 'found' as const,
              session: session()
            }
          })
        },
        validateProjectFile: vi.fn(async () => {
          if (stage === 'source-validation') throw secret
          return true
        }),
        runWithSessionAuthority: (_projectId, _sessionId, operation) => operation()
      })

      const input: CreateBookmarkRequest = {
        ...request(),
        target: {
          kind: 'text',
          quote: 'Saved quote',
          source: {
            kind: 'project-file',
            projectId: 'project-1',
            path: '/private/path',
            name: 'SECRET'
          }
        }
      }
      await expect(service.create(input)).rejects.toBe(secret)
      expect(warn).toHaveBeenCalledExactlyOnceWith('Bookmark creation failed', {
        stage,
        errorCategory: 'permission'
      })
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SECRET|private|project|sessionId/u)
      warn.mockImplementationOnce(() => {
        throw new Error('Logger unavailable')
      })
      await expect(service.create(input)).rejects.toBe(secret)
    }
  )

  it.each([
    'valid',
    'missing',
    'file-mismatch',
    'version-mismatch',
    'session-mismatch',
    'no-authority',
    'wrong-project'
  ])(
    'checks managed file authority before persisting a cross-session bookmark: %s',
    async (scenario) => {
      warn.mockReset()
      const input: CreateBookmarkRequest = {
        ...request(),
        target: {
          kind: 'text',
          quote: 'Saved quote',
          source: {
            kind: 'project-file',
            projectId: scenario === 'wrong-project' ? 'other-project' : 'project-1',
            path: '/managed/report.md',
            name: 'report.md',
            fileSource: 'artifact',
            sourceFileId: 'file-1',
            versionId: 'version-1',
            sessionId: 'source-session'
          }
        }
      }
      const saved = {
        ...input,
        version: 1 as const,
        createdAt: '2026-10-05T00:00:00.000Z',
        updatedAt: '2026-10-05T00:00:00.000Z'
      }
      const repository = {
        recoverCreate: vi.fn(async () => undefined),
        create: vi.fn(async () => saved),
        list: vi.fn(),
        updateNote: vi.fn(),
        delete: vi.fn()
      }
      const resolveVersion = vi.fn<PdfVersionAuthority['resolveVersion']>(async () =>
        scenario === 'missing'
          ? undefined
          : {
              sourceKind: 'artifact-version',
              sourceFileId: scenario === 'file-mismatch' ? 'other-file' : 'file-1',
              sourceVersionId: scenario === 'version-mismatch' ? 'other-version' : 'version-1',
              sourceSessionId: scenario === 'session-mismatch' ? 'other-session' : 'source-session',
              filename: 'report.md',
              sizeBytes: 42,
              checksum: 'a'.repeat(64),
              path: '/managed/report.md'
            }
      )
      const service = new BookmarkService({
        repository,
        sessions: {
          loadSessionWithDiagnostics: vi.fn(async () => ({
            status: 'found' as const,
            session: session()
          }))
        },
        pdfVersions: scenario === 'no-authority' ? undefined : { resolveVersion },
        runWithSessionAuthority: (_projectId, _sessionId, operation) => operation()
      })
      if (scenario === 'valid') {
        await expect(service.create(input)).resolves.toEqual(saved)
        expect(resolveVersion).toHaveBeenCalledExactlyOnceWith({
          projectId: 'project-1',
          sourceKind: 'artifact-version',
          sourceVersionId: 'version-1',
          expectedSourceFileId: 'file-1'
        })
        expect(repository.create).toHaveBeenCalledExactlyOnceWith(input)
        expect(warn).not.toHaveBeenCalled()
      } else {
        await expect(service.create(input)).rejects.toThrow('Bookmark source is not available.')
        expect(repository.create).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledExactlyOnceWith('Bookmark creation failed', {
          stage: 'source-validation',
          errorCategory: 'error'
        })
      }
    }
  )

  it('edits and deletes a saved Bookmark without revalidating a vanished source', async () => {
    const saved = {
      ...request(),
      note: 'updated',
      version: 1 as const,
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:01.000Z'
    }
    const repository = {
      recoverCreate: vi.fn(),
      create: vi.fn(),
      list: vi.fn(),
      updateNote: vi.fn(async () => saved),
      delete: vi.fn(async () => true),
      deleteSession: vi.fn(),
      deleteProject: vi.fn()
    }
    const loadSessionWithDiagnostics = vi.fn(async () => ({ status: 'missing' as const }))
    const service = new BookmarkService({
      repository,
      sessions: { loadSessionWithDiagnostics },
      runWithSessionAuthority: (_projectId, _sessionId, operation) => operation()
    })

    await expect(
      service.updateNote({
        projectId: 'project-1',
        sessionId: 'session-1',
        id: 'bookmark-1',
        note: 'updated'
      })
    ).resolves.toEqual(saved)
    await expect(
      service.delete({ projectId: 'project-1', sessionId: 'session-1', id: 'bookmark-1' })
    ).resolves.toEqual({ deleted: true })
    expect(loadSessionWithDiagnostics).not.toHaveBeenCalled()
  })

  it('resolves an exact readable PDF Version to a canonical preview locator', async () => {
    const verifyUnchanged = vi.fn(async () => undefined)
    const close = vi.fn(async () => undefined)
    const resolveVersion = vi.fn(async () => ({
      sourceKind: 'artifact-version' as const,
      sourceFileId: 'artifact-1',
      sourceVersionId: 'version-1',
      sourceSessionId: 'source-session',
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      sizeBytes: 42,
      checksum: 'a'.repeat(64),
      path: 'private/storage/key',
      openContent: async () => ({
        path: '/managed/paper.pdf',
        size: 42,
        readRange: vi.fn(),
        verifyUnchanged,
        close
      })
    }))
    const service = new BookmarkService({
      repository: {} as never,
      sessions: {
        loadSessionWithDiagnostics: vi.fn(async () => ({
          status: 'found' as const,
          session: session()
        }))
      },
      pdfVersions: { resolveVersion },
      runWithSessionAuthority: (_projectId, _sessionId, operation) => operation()
    })

    await expect(
      service.resolvePdfSource({
        projectId: 'project-1',
        sessionId: 'session-1',
        sourceKind: 'artifact-version',
        sourceFileId: 'artifact-1',
        versionId: 'version-1'
      })
    ).resolves.toEqual({
      ok: true,
      source: {
        kind: 'artifact-version',
        projectId: 'project-1',
        sourceFileId: 'artifact-1',
        versionId: 'version-1',
        sessionId: 'source-session',
        checksum: 'a'.repeat(64),
        name: 'paper.pdf',
        path: 'artifact-version:project-1/source-session/artifact-1/version-1'
      }
    })
    expect(resolveVersion).toHaveBeenCalledWith({
      projectId: 'project-1',
      sourceKind: 'artifact-version',
      sourceVersionId: 'version-1',
      expectedSourceFileId: 'artifact-1'
    })
    expect(verifyUnchanged).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects a PDF Bookmark whose client path is not the canonical exact-Version locator', async () => {
    const repository = {
      recoverCreate: vi.fn(async () => undefined),
      create: vi.fn(),
      list: vi.fn(),
      updateNote: vi.fn(),
      delete: vi.fn(),
      deleteSession: vi.fn(),
      deleteProject: vi.fn()
    }
    const service = new BookmarkService({
      repository,
      sessions: {
        loadSessionWithDiagnostics: vi.fn(async () => ({
          status: 'found' as const,
          session: session()
        }))
      },
      pdfVersions: {
        resolveVersion: vi.fn(async () => ({
          sourceKind: 'artifact-version' as const,
          sourceFileId: 'artifact-1',
          sourceVersionId: 'version-1',
          sourceSessionId: 'source-session',
          filename: 'paper.pdf',
          contentType: 'application/pdf',
          sizeBytes: 42,
          checksum: 'a'.repeat(64),
          path: 'private/storage/key',
          openContent: async () => ({
            path: '/managed/paper.pdf',
            size: 42,
            readRange: vi.fn(),
            verifyUnchanged: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined)
          })
        }))
      },
      runWithSessionAuthority: (_projectId, _sessionId, operation) => operation()
    })

    await expect(
      service.create({
        id: 'bookmark-pdf',
        projectId: 'project-1',
        sessionId: 'session-1',
        target: {
          kind: 'pdf',
          source: {
            kind: 'artifact-version',
            projectId: 'project-1',
            sourceFileId: 'artifact-1',
            versionId: 'version-1',
            sessionId: 'source-session',
            checksum: 'a'.repeat(64),
            name: 'paper.pdf',
            path: 'file:///client-controlled.pdf'
          },
          selector: {
            kind: 'region',
            pageNumber: 1,
            rect: { x: 0, y: 0, width: 0.5, height: 0.5 },
            pageRotation: 0,
            coordinateVersion: 1
          }
        },
        note: ''
      })
    ).rejects.toThrow('Bookmark source is not available.')
    expect(repository.create).not.toHaveBeenCalled()
  })
})
