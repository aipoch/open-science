import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { vi } from 'vitest'

import type { ComputeHost, JobStatusResult } from '../../shared/compute'
import type { Logger } from '../logger'
import type { ManagedFileSoftDeleteToken } from '../project-files/repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import {
  SessionPersistenceCoordinator,
  type SessionFileIndex,
  type SessionMutationRepository
} from '../session-persistence/coordinator'
import type { ProjectSessionDeletionState } from '../session-persistence/repository'
import { ComputeService } from './compute-service'
import type { ComputeConnectionBrokerAcquirer } from './connection-broker'
import { createComputeJobDeletionOwner } from './job-deletion-owner'
import { ComputeJobRepository } from './job-repository'
import { JobPoller } from './job-poller'
import type { ComputeHostRepository } from './repository'
import type { SshRunner } from './ssh-runner'

const NONCE = 'DELETION_ISOLATION_'
const providerId = 'ssh:cluster'

const host: ComputeHost = {
  id: 'host-1',
  providerId,
  displayName: 'Cluster',
  shape: 'direct_ssh',
  sshAlias: 'cluster',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1
}

const createSessionRepository = (): SessionMutationRepository & {
  authorityCommitted: boolean
} => {
  const repository = {
    authorityCommitted: false,
    loadAllWithDiagnostics: vi.fn(async () => ({
      result: { sessions: [], manifest: { version: 1 as const } },
      isComplete: true
    })),
    loadProjectWithDiagnostics: vi.fn(async () => ({ sessions: [], isComplete: true })),
    loadCommittedProjectWithDiagnostics: vi.fn(async () => ({
      sessions: [],
      isComplete: true
    })),
    loadSessionWithDiagnostics: vi.fn(async () => ({ status: 'missing' as const })),
    assertSessionIdentityOwnership: vi.fn(async () => undefined),
    saveSession: vi.fn(async () => undefined),
    saveCommittedProjectSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => {
      repository.authorityCommitted = true
    }),
    deleteProjectSessions: vi.fn(async () => {
      repository.authorityCommitted = true
    }),
    getProjectSessionDeletionState: vi.fn(async (): Promise<ProjectSessionDeletionState> =>
      repository.authorityCommitted ? 'prepared' : 'live'
    ),
    markCommittedProjectSessionsPrepared: vi.fn(async () => undefined),
    completeProjectSessionDeletion: vi.fn(async () => undefined),
    listLegacyProjectSessionTombstones: vi.fn(async () => []),
    saveManifest: vi.fn(async () => undefined)
  }
  return repository
}

const createFileIndex = (): SessionFileIndex => ({
  syncSession: vi.fn(async () => []),
  softDeleteSession: vi.fn(async (): Promise<ManagedFileSoftDeleteToken> => 'session-delete'),
  restoreSession: vi.fn(async () => undefined),
  softDeleteProject: vi.fn(async (): Promise<ManagedFileSoftDeleteToken> => 'project-delete'),
  reconcileProjectSessions: vi.fn(async () => undefined),
  reconcileActiveSessions: vi.fn(async () => undefined),
  markReconciliationIncomplete: vi.fn()
})

const createSilentLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
})

const pollSuccessOutput = (): string =>
  [
    `${NONCE}JOB_START:survivor-job`,
    `${NONCE}alive:0`,
    `${NONCE}exit:0`,
    'completed',
    `${NONCE}STDOUT_END:survivor-job`,
    '',
    `${NONCE}STDERR_END:survivor-job`
  ].join('\n')

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

type DeletionCase = {
  name: string
  deletedProjectId: string
  survivorProjectId: string
  deleteOwner(coordinator: SessionPersistenceCoordinator): Promise<unknown>
}

const deletionCases: DeletionCase[] = [
  {
    name: 'Session',
    deletedProjectId: 'project-1',
    survivorProjectId: 'project-1',
    deleteOwner: (coordinator) => coordinator.deleteSession('project-1', 'deleted-session')
  },
  {
    name: 'Project',
    deletedProjectId: 'project-1',
    survivorProjectId: 'project-2',
    deleteOwner: (coordinator) => coordinator.deleteProjectSessions('project-1')
  }
]

const createDeletionRuntimeHarness = async (
  deletionCase: DeletionCase,
  options: { holdCleanupPlanning?: boolean; holdRemoteCleanup?: boolean } = {}
): Promise<{
  authorityCommitted(): boolean
  cleanupPlanningStarted: Promise<void>
  cleanupStarted: Promise<void>
  deleteOwner(): Promise<unknown>
  releaseCleanupPlanning(): void
  releaseRemoteCleanup(): void
  runScheduledPoll(): Promise<void>
  survivorStatus(): Promise<JobStatusResult>
  deletedStatus(): Promise<JobStatusResult>
  dispose(): Promise<void>
}> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-deletion-isolation-'))
  const client = createProjectDbClient(storageRoot)
  await migrateApplicationDatabase(client)

  const jobRepository = new ComputeJobRepository(() => Promise.resolve(client))
  const cleanupPlanningStarted = deferred()
  const releaseCleanupPlanning = deferred()
  const hostRepository = {
    get: vi.fn(async () => {
      cleanupPlanningStarted.resolve()
      if (options.holdCleanupPlanning) await releaseCleanupPlanning.promise
      return host
    })
  } as unknown as ComputeHostRepository
  const cleanupStarted = deferred()
  const releaseRemoteCleanup = deferred()
  const connectionBroker: ComputeConnectionBrokerAcquirer = {
    acquire: vi.fn(async (_requestedProviderId, request) => ({
      run: vi.fn(async () => {
        if (request.intent === 'job_cleanup') {
          cleanupStarted.resolve()
          if (options.holdRemoteCleanup) await releaseRemoteCleanup.promise
          return {
            exitCode: 255,
            stdout: '',
            stderr: 'offline',
            truncated: false,
            timedOut: false
          }
        }
        return {
          exitCode: 0,
          stdout: pollSuccessOutput(),
          stderr: '',
          truncated: false,
          timedOut: false
        }
      }),
      upload: vi.fn(async () => undefined),
      download: vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        bytesWritten: 0,
        exceeded: false
      }))
    }))
  }
  const jobDeletionOwner = createComputeJobDeletionOwner({
    jobRepository,
    hostRepository,
    connectionBroker
  })

  let scheduledTick: (() => void) | undefined
  const initialTick = deferred()
  const survivorUpdated = deferred()
  const pollerRepository = Object.create(jobRepository) as ComputeJobRepository
  pollerRepository.findNonTerminal = async () => {
    const jobs = await jobRepository.findNonTerminal()
    initialTick.resolve()
    return jobs
  }
  const poller = new JobPoller({
    connectionBroker,
    hostRepository,
    jobRepository: pollerRepository,
    onJobUpdated: (job) => {
      if (job.job_id === 'survivor-job') survivorUpdated.resolve()
    },
    makeNonce: () => NONCE,
    setInterval: (callback) => {
      scheduledTick = callback
      return 1 as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: vi.fn()
  })
  const unbindRuntime = jobDeletionOwner.bindRuntime(poller)
  poller.start()
  await initialTick.promise
  await Promise.resolve()

  await jobRepository.create({
    id: 'deleted-job',
    providerId,
    shape: 'direct_ssh',
    sessionId: 'deleted-session',
    projectId: deletionCase.deletedProjectId,
    intent: 'deleted work',
    command: 'echo deleted',
    commandHash: 'deleted-hash',
    remoteWorkdir: '~/.openscience/jobs/deleted-job',
    initialStatus: 'success',
    allowUnencryptedPersistence: true
  })
  await jobRepository.create({
    id: 'survivor-job',
    providerId,
    shape: 'direct_ssh',
    sessionId: 'survivor-session',
    projectId: deletionCase.survivorProjectId,
    intent: 'surviving work',
    command: 'echo completed',
    commandHash: 'survivor-hash',
    remoteWorkdir: '~/.openscience/jobs/survivor-job',
    initialStatus: 'running',
    allowUnencryptedPersistence: true
  })
  await jobRepository.update('survivor-job', {
    remoteHandle: JSON.stringify({
      pid: 456,
      exit_code_path: '~/.openscience/jobs/survivor-job/exit_code',
      stdout_path: '~/.openscience/jobs/survivor-job/stdout',
      stderr_path: '~/.openscience/jobs/survivor-job/stderr',
      workdir: '~/.openscience/jobs/survivor-job'
    })
  })

  const sessionRepository = createSessionRepository()
  const coordinator = new SessionPersistenceCoordinator(
    sessionRepository,
    createFileIndex(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createSilentLogger(),
    jobDeletionOwner
  )
  const computeService = new ComputeService({
    runner: {} as SshRunner,
    repository: hostRepository,
    jobRepository
  })
  const readStatus = (
    jobId: string,
    projectId: string,
    sessionId: string
  ): Promise<JobStatusResult> =>
    computeService.getJobStatus(jobId, { projectId, sessionId, providerId })

  return {
    authorityCommitted: () => sessionRepository.authorityCommitted,
    cleanupPlanningStarted: cleanupPlanningStarted.promise,
    cleanupStarted: cleanupStarted.promise,
    deleteOwner: () => deletionCase.deleteOwner(coordinator),
    releaseCleanupPlanning: releaseCleanupPlanning.resolve,
    releaseRemoteCleanup: releaseRemoteCleanup.resolve,
    runScheduledPoll: async () => {
      if (!scheduledTick) throw new Error('Job poller did not install its scheduled tick.')
      scheduledTick()
      await survivorUpdated.promise
    },
    survivorStatus: () =>
      readStatus('survivor-job', deletionCase.survivorProjectId, 'survivor-session'),
    deletedStatus: () =>
      readStatus('deleted-job', deletionCase.deletedProjectId, 'deleted-session'),
    dispose: async () => {
      releaseCleanupPlanning.resolve()
      releaseRemoteCleanup.resolve()
      unbindRuntime()
      await poller.stop()
      await client.$disconnect()
      await rm(storageRoot, { recursive: true, force: true })
    }
  }
}

export { createDeletionRuntimeHarness, deletionCases }
export type { DeletionCase }
