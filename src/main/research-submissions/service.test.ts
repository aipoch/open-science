import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type {
  ResearchSubmission,
  ResearchSubmissionPayload
} from '../../shared/research-submission'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import {
  ResearchWorkspaceService,
  type ResearchWorkspaceSessions
} from '../research-workspaces/service'
import { ResearchWorkspaceRepository } from '../research-workspaces/repository'
import { UploadRepository } from '../uploads/repository'
import { stageUploadFixtures } from '../uploads/repository.test-utils'
import { ResearchSubmissionService } from './service'
import { RuntimeWriterOwner } from '../session-persistence/runtime-writer'
import { ArchiveCoordinator } from '../archive/coordinator'
import { createElectronCallerContext } from '../caller-context'
import { createApplicationCommandRouter } from '../application-command-router'
import {
  registerResearchSubmissionCommands,
  researchSubmissionCommands
} from './application-commands'

const scope = { projectId: 'project', sourceSessionId: 'source' }
const payload = (text = 'First question'): ResearchSubmissionPayload => ({
  text,
  attachments: [],
  annotations: [],
  permissionProfile: 'ask',
  agentConfiguration: { providerId: 'codex', reasoningEffort: 'default' },
  forcedSkillIds: []
})
const source: PersistedChatSession = {
  ...scope,
  id: 'source',
  title: 'Research',
  cwd: '',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  packageOrigin: {
    importId: 'import',
    sourceProjectId: 'foreign',
    sourceSessionId: 'foreign-source',
    importedAt: 1,
    manifestChecksum: 'a'.repeat(64)
  }
}

describe('durable research question handoff', () => {
  let root: string
  let client: PrismaClient
  let sessions: Map<string, PersistedChatSession>
  let sessionPorts: ResearchWorkspaceSessions
  let workspaces: ResearchWorkspaceService
  let uploads: UploadRepository
  let service: ResearchSubmissionService
  const makeService = (): ResearchSubmissionService =>
    new ResearchSubmissionService(
      async () => client,
      workspaces,
      sessionPorts,
      async (projectId, ownerId, attachments) => {
        const pending = attachments.filter((item) => !item.versionId)
        const finalized = pending.length
          ? await uploads.finalizePendingSessionUploads(ownerId, pending, projectId)
          : []
        const byId = new Map(finalized.map((item) => [item.id, item]))
        return attachments.map((item) => byId.get(item.id) ?? item)
      },
      async (projectId, operation) => {
        if (
          !(await client.project.findFirst({
            where: { id: projectId, deletedAt: null, archivedAt: null }
          }))
        )
          throw new Error('Project unavailable')
        return operation()
      }
    )
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'research-submissions-'))
    client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project', name: 'Project' } })
    sessions = new Map([[source.id, structuredClone(source)]])
    sessionPorts = {
      read: vi.fn(async (_projectId, id) =>
        sessions.has(id)
          ? { status: 'found' as const, session: structuredClone(sessions.get(id)!) }
          : { status: 'missing' as const }
      ),
      save: vi.fn(async (session) => {
        sessions.set(session.id, structuredClone(session))
        return session
      })
    }
    workspaces = new ResearchWorkspaceService(
      new ResearchWorkspaceRepository(async () => client),
      sessionPorts,
      async (_projectId, operation) => operation()
    )
    uploads = new UploadRepository(root, { getClient: async () => client })
    service = makeService()
  })
  afterEach(async () => {
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })
  const append = (submission: ResearchSubmission): void => {
    const discussion = sessions.get(submission.discussionSessionId!)!
    discussion.messages.push({
      id: submission.messageId,
      role: 'user',
      content: submission.payload.text,
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    })
    discussion.status = 'running'
  }
  const finishTurn = (submission: ResearchSubmission): void => {
    const discussion = sessions.get(submission.discussionSessionId!)!
    discussion.messages.push({
      id: `answer-${submission.id}`,
      role: 'agent',
      responseToMessageId: submission.messageId,
      content: 'Answer',
      status: 'complete',
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    })
    discussion.status = 'idle'
  }
  const confirm = (
    claimed: NonNullable<Awaited<ReturnType<ResearchSubmissionService['claim']>>>
  ): Promise<ResearchSubmission> =>
    service.finish('writer', {
      id: claimed.submission.id,
      claimToken: claimed.submission.claimToken!,
      runtimeWriterToken: 'token',
      disposition: 'accepted'
    })

  it('preserves two windows different first questions and accepts FIFO into one Discussion', async () => {
    const [first, second] = await Promise.all([
      service.enqueue({ ...scope, id: 'window-a', payload: payload('Window A') }),
      service.enqueue({ ...scope, id: 'window-b', payload: payload('Window B') })
    ])
    expect(first.sequence).toBeLessThan(second.sequence)
    const firstClaim = await service.claim('writer')
    expect(firstClaim!.submission.id).toBe(first.id)
    expect(await service.claim('writer')).toBeNull()
    append(firstClaim!.submission)
    expect((await confirm(firstClaim!)).state).toBe('accepted')
    expect(await service.claim('writer')).toBeNull()
    finishTurn(firstClaim!.submission)
    const secondClaim = await service.claim('writer')
    expect(secondClaim!.submission.id).toBe(second.id)
    expect(secondClaim!.session.id).toBe(firstClaim!.session.id)
    append(secondClaim!.submission)
    await confirm(secondClaim!)
    expect(
      sessions
        .get(firstClaim!.session.id)!
        .messages.filter((item) => item.role === 'user')
        .map((item) => item.content)
    ).toEqual(['Window A', 'Window B'])
    expect(await client.researchWorkspace.count()).toBe(1)
    expect(sessions.get(source.id)).toEqual(source)
  })

  it('deduplicates a stable intent and rejects changing its saved payload', async () => {
    const request = { ...scope, id: 'stable', payload: payload() }
    const [first, again] = await Promise.all([service.enqueue(request), service.enqueue(request)])
    expect(again).toEqual(first)
    expect(await client.researchSubmission.count()).toBe(1)
    await expect(service.enqueue({ ...request, payload: payload('Different') })).rejects.toThrow(
      'different draft'
    )
    const claimed = await service.claim('writer')
    append(claimed!.submission)
    await confirm(claimed!)
    expect((await service.enqueue(request)).state).toBe('accepted')
    expect(await service.claim('writer')).toBeNull()
  })

  it('preserves real immutable attachment bytes across creation failure, cleanup and restart', async () => {
    const [attachment] = await stageUploadFixtures(uploads, {
      files: [
        { name: 'evidence.txt', content: Buffer.from('research evidence').toString('base64') }
      ]
    })
    const record = await service.enqueue({
      ...scope,
      id: 'with-file',
      payload: { ...payload(), attachments: [attachment] }
    })
    expect(record.payload.attachments[0].versionId).toBeTruthy()
    vi.mocked(sessionPorts.save).mockRejectedValueOnce(new Error('Creation failed'))
    expect(await service.claim('writer')).toBeNull()
    expect((await service.list(scope))[0].state).toBe('failed')
    uploads = new UploadRepository(root, { getClient: async () => client })
    await uploads.recoverStagingUploads()
    service = makeService()
    const recovered = (await service.list(scope))[0]
    const path = await uploads.resolveManagedUploadPath(
      { path: recovered.payload.attachments[0].path },
      { projectId: 'project', sessionId: recovered.payload.attachments[0].sessionId }
    )
    expect(await readFile(path, 'utf8')).toBe('research evidence')
    await service.act({ ...scope, id: record.id, action: 'retry' })
    expect((await service.claim('writer'))!.submission.payload.attachments[0].versionId).toBe(
      record.payload.attachments[0].versionId
    )
    expect(await client.uploadVersion.count()).toBe(1)
  })

  it('marks an appended-but-unconfirmed send uncertain and never retries it automatically', async () => {
    await service.enqueue({ ...scope, id: 'uncertain', payload: payload() })
    const claimed = await service.claim('writer')
    append(claimed!.submission)
    const record = await service.finish('writer', {
      id: 'uncertain',
      claimToken: claimed!.submission.claimToken!,
      runtimeWriterToken: 'token',
      disposition: 'failed',
      error: 'Transport failed'
    })
    expect(record.state).toBe('uncertain')
    expect(await service.claim('writer')).toBeNull()
    await expect(service.act({ ...scope, id: 'uncertain', action: 'retry' })).rejects.toThrow(
      'confirmed unsent'
    )
    service = makeService()
    expect(await service.claim('new-writer')).toBeNull()
  })

  it('conservatively isolates a claimed send after restart, even without a saved user message', async () => {
    await service.enqueue({ ...scope, id: 'crash', payload: payload() })
    await service.claim('writer')
    service = makeService()
    expect(await service.claim('new-writer')).toBeNull()
    expect((await service.list(scope))[0].state).toBe('uncertain')
  })

  it('allows explicit retry only after a confirmed non-admission, preserving original payload', async () => {
    await service.enqueue({ ...scope, id: 'failed', payload: payload() })
    const claimed = await service.claim('writer')
    expect(
      (
        await service.finish('writer', {
          id: 'failed',
          claimToken: claimed!.submission.claimToken!,
          runtimeWriterToken: 'token',
          disposition: 'failed'
        })
      ).state
    ).toBe('failed')
    expect(await service.claim('writer')).toBeNull()
    await service.act({ ...scope, id: 'failed', action: 'retry' })
    const retried = await service.claim('writer')
    expect(retried!.submission.messageId).toBe(claimed!.submission.messageId)
    expect(retried!.submission.payload).toEqual(claimed!.submission.payload)
  })

  it('retains cancelled questions for recovery and blocks deleted Discussion resurrection', async () => {
    await service.enqueue({ ...scope, id: 'deleted', payload: payload() })
    const claimed = await service.claim('writer')
    await service.finish('writer', {
      id: 'deleted',
      claimToken: claimed!.submission.claimToken!,
      runtimeWriterToken: 'token',
      disposition: 'failed'
    })
    sessions.delete(claimed!.session.id)
    await new ResearchWorkspaceRepository(async () => client).sessionsDeleted([claimed!.session.id])
    await service.act({ ...scope, id: 'deleted', action: 'retry' })
    expect(await service.claim('writer')).toBeNull()
    expect(sessions.has(claimed!.session.id)).toBe(false)
    const cancelled = await service.act({ ...scope, id: 'deleted', action: 'cancel' })
    expect(cancelled.payload.text).toBe('First question')
    expect(cancelled.state).toBe('cancelled')
  })

  it('lets an existing writable Discussion continue after only its source is archived', async () => {
    const discussion = await workspaces.ensureDiscussion(scope)
    sessions.get(source.id)!.archivedAt = 100
    const record = await service.enqueue({ ...scope, id: 'archived-source', payload: payload() })
    expect((await service.claim('writer'))!.session.id).toBe(discussion.discussionSessionId)
    expect(record.state).toBe('queued')
  })

  it('prepares and claims through the real non-reentrant project gate without deadlocking the journal', async () => {
    const project = {
      id: scope.projectId,
      name: 'Project',
      description: '',
      isExample: false,
      createdAt: 1,
      updatedAt: 1
    }
    const coordinator = new ArchiveCoordinator(
      { get: async () => project, updateArchive: async () => project },
      {
        assertProjectArchivable: async () => [],
        assertSessionAvailable: async () => undefined,
        sessionProjectId: async () => scope.projectId,
        updateArchive: async () => source
      },
      {
        isSessionBusy: () => false,
        isProjectBusy: () => false,
        liveSessionProjectId: () => scope.projectId
      }
    )
    const admission = <T>(projectId: string, operation: () => Promise<T>): Promise<T> =>
      coordinator.withProjectAvailable(projectId, operation)
    const gatedWorkspaces = new ResearchWorkspaceService(
      new ResearchWorkspaceRepository(async () => client),
      sessionPorts,
      admission
    )
    const gated = new ResearchSubmissionService(
      async () => client,
      gatedWorkspaces,
      sessionPorts,
      async (_projectId, _ownerId, attachments) => attachments,
      admission
    )
    await gated.enqueue({ ...scope, id: 'gated-first', payload: payload() })
    const [claimed, prepared] = await Promise.all([
      gated.claim('electron:7'),
      gatedWorkspaces.ensureDiscussion(scope)
    ])
    expect(claimed?.session.id).toBe(prepared.discussionSessionId)
    expect((await gated.list(scope))[0].state).toBe('sending')
    expect(sessions.size).toBe(2)
  }, 1500)

  it('uses the lifecycle writer identity through the validated Electron command boundary', async () => {
    const writer = new RuntimeWriterOwner()
    const callerContext = createElectronCallerContext(7)
    const lease = writer.claim(callerContext.lifecycleClientId)
    const router = createApplicationCommandRouter()
    const installation = registerResearchSubmissionCommands(router.registrar, {
      service,
      writer,
      withWrite: (operation) => operation()
    })
    const invocation = {
      callerContext,
      callerLease: {
        leaseId: callerContext.leaseId,
        generation: 1,
        signal: new AbortController().signal,
        isCurrent: () => true
      }
    }
    await service.enqueue({ ...scope, id: 'electron-first', payload: payload() })
    const claimed = await router.dispatcher.invoke(researchSubmissionCommands.claim, {
      ...invocation,
      args: [{ runtimeWriterToken: lease.token! }]
    })
    expect(claimed?.submission.state).toBe('sending')
    const finished = await router.dispatcher.invoke(researchSubmissionCommands.finish, {
      ...invocation,
      args: [
        {
          id: 'electron-first',
          runtimeWriterToken: lease.token!,
          claimToken: claimed!.submission.claimToken!,
          disposition: 'failed'
        }
      ]
    })
    expect(finished.state).toBe('failed')
    installation.uninstall()
  })

  it('fences non-owner windows before a durable claim and preserves both intents', async () => {
    const writer = new RuntimeWriterOwner()
    const lease = writer.claim('window-a')
    await Promise.all([
      service.enqueue({ ...scope, id: 'a', payload: payload('A') }),
      service.enqueue({ ...scope, id: 'b', payload: payload('B') })
    ])
    expect(writer.claim('window-b').token).toBeUndefined()
    await expect(
      writer.commit('window-b', lease.token!, () => service.claim('window-b'))
    ).rejects.toThrow('writer changed')
    const claimed = await writer.commit('window-a', lease.token!, () => service.claim('window-a'))
    expect(claimed!.submission.payload.text).toBe('A')
    expect((await service.list(scope)).map((item) => item.payload.text)).toEqual(['A', 'B'])
  })
})
