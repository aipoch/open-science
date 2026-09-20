import { describe, expect, it, vi } from 'vitest'

import { createApplicationCommandRouter } from '../application-command-router'
import { createCallerContext } from '../caller-context'
import {
  bookmarkApplicationCommands,
  registerBookmarkApplicationCommands
} from './application-commands'

const invocation = <Args extends readonly unknown[]>(
  args: Args
): {
  args: Args
  callerContext: ReturnType<typeof createCallerContext>
  callerLease: {
    leaseId: string
    generation: number
    signal: AbortSignal
    isCurrent: () => boolean
  }
} => ({
  args,
  callerContext: createCallerContext({
    clientId: 'renderer-1',
    lifecycleClientId: 'electron:renderer-1',
    leaseId: 'lease',
    surface: 'electron',
    location: 'local',
    principalKind: 'human',
    actionOrigin: 'human'
  }),
  callerLease: {
    leaseId: 'lease',
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true
  }
})

describe('Bookmark application commands', () => {
  it('routes the validated Bookmark command surface to one owner', async () => {
    const router = createApplicationCommandRouter()
    const bookmark = {
      id: 'bookmark-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      version: 1 as const,
      target: {
        kind: 'text' as const,
        source: { kind: 'agent-message' as const, sessionId: 'session-1', messageId: 'message-1' },
        quote: 'quote'
      },
      note: '',
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z'
    }
    const owner = {
      list: vi.fn(async () => ({ items: [bookmark], total: 1 })),
      create: vi.fn(async () => bookmark),
      updateNote: vi.fn(async () => bookmark),
      delete: vi.fn(async () => ({ deleted: true })),
      resolvePdfSource: vi.fn(async () => ({
        ok: false as const,
        reason: 'source-unavailable' as const
      }))
    }
    registerBookmarkApplicationCommands(router.registrar, owner)

    await expect(
      router.dispatcher.invoke(
        bookmarkApplicationCommands.list,
        invocation([{ projectId: 'project-1', sessionId: 'session-1' }])
      )
    ).resolves.toEqual({ items: [bookmark], total: 1 })
    await expect(
      router.dispatcher.invoke(
        bookmarkApplicationCommands.resolvePdfSource,
        invocation([
          {
            projectId: 'project-1',
            sessionId: 'session-1',
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            versionId: 'version-1'
          }
        ])
      )
    ).resolves.toEqual({ ok: false, reason: 'source-unavailable' })
  })
})
