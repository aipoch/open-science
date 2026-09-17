import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Session path decoding reads the Electron data root even for an absolute legacy cwd. Match the
// repository test boundary without starting Electron or reading user data.
vi.mock('electron', () => ({ app: { getPath: () => '/synthetic/home', isPackaged: true } }))

import {
  sanitizeSessionRuntimeContext,
  type SessionRuntimeContext
} from '../../shared/session-persistence'
import type { ActivePlanProjection, PlanDocumentV1 } from '../../shared/session-plan/contract'
import { SessionRepository } from '../session-persistence/repository'
import { PlanContextFileStore } from './plan-context-file'
import { PlanService, type PlanServiceDependencies } from './plan-service'
import { SessionPlanInteractionOwner } from './session-plan-interaction-owner'

const roots: string[] = []

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'plan-legacy-compatibility-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// Baseline provenance: the field shape and optional embedded-document behavior below were checked
// against f37fb9b66bc07ea6c10d3861eed68d2312e2fdd7 with `git show` for
// src/shared/session-plan/contract.ts and src/shared/session-persistence.ts. Values are synthetic,
// fixed legacy data: this fixture deliberately does not pass through the current Plan generator.
const legacyDocument: PlanDocumentV1 = {
  schema_version: 1,
  task_summary: 'Summarize the archived measurements',
  phases: [
    {
      name: 'Prepare and summarize',
      delegations: [
        {
          name: 'Legacy primary agent',
          steps: [
            { title: 'Open the CSV', description: 'Open the archived CSV file.' },
            { title: 'Read the headers', description: 'List the column headers.' },
            { title: 'Write the summary', description: 'Write a short summary.' }
          ]
        }
      ]
    }
  ],
  desired_outputs: ['A short measurement summary'],
  feasibility: { confidence: 'high', rationale: 'The archived CSV is available.' }
}

const legacyDocumentBytes = JSON.stringify(legacyDocument, null, 2)
const legacyChecksum = createHash('sha256').update(legacyDocumentBytes).digest('hex')

const legacyRuntimeContextInput = {
  version: 1,
  revision: 17,
  plan: {
    artifactId: 'legacy-plan-artifact',
    artifactVersionId: 'legacy-plan-version-4',
    artifactChecksum: legacyChecksum,
    document: legacyDocument,
    originatingPromptMessageId: 'legacy-prompt-message',
    materializedAt: 1_700_000_000_000,
    approval: 'approved',
    stepStatuses: {
      'Open the CSV': {
        status: 'completed',
        updatedAt: 1_700_000_000_100,
        notes: 'The file opened successfully.'
      },
      'Read the headers': {
        status: 'skipped',
        updatedAt: 1_700_000_000_200,
        notes: 'Headers were already recorded in the archive.'
      }
    }
  }
} as const

type Harness = Readonly<{
  service: PlanService
  context: () => SessionRuntimeContext
  dependencies: PlanServiceDependencies
}>

const createLegacyHarness = (
  input: unknown,
  artifact = { content: legacyDocumentBytes, checksum: legacyChecksum }
): Harness => {
  const sanitized = sanitizeSessionRuntimeContext(structuredClone(input))
  if (!sanitized) throw new Error('Legacy fixture must pass the real persistence sanitizer.')
  let context: SessionRuntimeContext = sanitized

  const dependencies: PlanServiceDependencies = {
    interactions: new SessionPlanInteractionOwner(),
    writeArtifactForExecution: vi.fn(async () => {
      throw new Error('A legacy compatibility read must not rewrite the Plan Artifact.')
    }),
    readArtifactVersion: vi.fn(async () => artifact),
    readRuntimeContext: vi.fn(async () => structuredClone(context)),
    patchRuntimeContext: vi.fn(async ({ expectedRevision, plan }) => {
      if (expectedRevision !== context.revision) throw new Error('revision conflict')
      const next = sanitizeSessionRuntimeContext({
        ...context,
        revision: expectedRevision + 1,
        ...(plan ? { plan } : {})
      })
      if (!next) throw new Error('Updated legacy context did not pass the real sanitizer.')
      context = next
      return structuredClone(context)
    }),
    persistUserMessage: vi.fn(async () => {
      throw new Error('Legacy compatibility does not persist review messages.')
    }),
    isRevisionConflict: (error) => error instanceof Error && error.message === 'revision conflict',
    now: () => 1_700_000_000_300
  }

  return {
    service: new PlanService(dependencies),
    context: () => structuredClone(context),
    dependencies
  }
}

const readContextFile = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>

describe('legacy Session Plan compatibility', () => {
  it('rebuilds legacy context across restart and continues the approved remaining step', async () => {
    const sanitized = sanitizeSessionRuntimeContext(structuredClone(legacyRuntimeContextInput))
    expect(sanitized).toEqual(legacyRuntimeContextInput)

    const harness = createLegacyHarness(legacyRuntimeContextInput)
    const initial = await harness.service.getProjection('legacy-project', 'legacy-session')

    expect(initial).toMatchObject({
      artifactId: 'legacy-plan-artifact',
      artifactVersionId: 'legacy-plan-version-4',
      artifactChecksum: legacyChecksum,
      revision: 17,
      approval: 'approved',
      lifecycle: 'approved',
      document: legacyDocument,
      stepStates: {
        'Open the CSV': { status: 'completed', notes: 'The file opened successfully.' },
        'Read the headers': {
          status: 'skipped',
          notes: 'Headers were already recorded in the archive.'
        },
        'Write the summary': { status: 'not_started' }
      }
    })
    expect(initial?.document.phases[0].delegations[0].steps.map(({ title }) => title)).toEqual([
      'Open the CSV',
      'Read the headers',
      'Write the summary'
    ])

    const storageRoot = await temporaryRoot()
    const readCurrent = async (): Promise<ActivePlanProjection | undefined> =>
      (await harness.service.getProjection('legacy-project', 'legacy-session')) ?? undefined
    const firstProcess = new PlanContextFileStore({ storageRoot, readCurrent })
    const firstReference = await firstProcess.refresh('legacy-project', 'legacy-session')
    expect(firstReference).toMatchObject({
      artifactVersionId: 'legacy-plan-version-4',
      revision: 17
    })
    expect(await readContextFile(firstReference!.path)).toMatchObject({
      active: true,
      revision: 17,
      document: legacyDocument,
      stepStates: {
        'Open the CSV': { status: 'completed' },
        'Read the headers': { status: 'skipped' },
        'Write the summary': { status: 'not_started' }
      }
    })

    const restartedProcess = new PlanContextFileStore({ storageRoot, readCurrent })
    await expect(restartedProcess.refresh('legacy-project', 'legacy-session')).resolves.toEqual(
      firstReference
    )
    expect(harness.dependencies.patchRuntimeContext).not.toHaveBeenCalled()
    expect(harness.dependencies.writeArtifactForExecution).not.toHaveBeenCalled()
    expect(harness.dependencies.readArtifactVersion).not.toHaveBeenCalled()

    const identity = {
      projectId: 'legacy-project',
      sessionId: 'legacy-session',
      artifactVersionId: 'legacy-plan-version-4'
    }
    const started = await harness.service.updateStepStatus({
      ...identity,
      expectedRevision: 17,
      title: 'Write the summary',
      status: 'in_progress'
    })
    const completed = await harness.service.updateStepStatus({
      ...identity,
      expectedRevision: started.projection.revision,
      title: 'Write the summary',
      status: 'completed',
      notes: 'Summary saved.'
    })

    expect(completed.projection).toMatchObject({
      artifactId: 'legacy-plan-artifact',
      artifactVersionId: 'legacy-plan-version-4',
      artifactChecksum: legacyChecksum,
      revision: 19,
      approval: 'approved',
      lifecycle: 'completed',
      document: legacyDocument,
      stepStates: {
        'Open the CSV': { status: 'completed', notes: 'The file opened successfully.' },
        'Read the headers': {
          status: 'skipped',
          notes: 'Headers were already recorded in the archive.'
        },
        'Write the summary': { status: 'completed', notes: 'Summary saved.' }
      }
    })
    expect(harness.context()).toMatchObject({
      revision: 19,
      plan: {
        artifactId: 'legacy-plan-artifact',
        artifactVersionId: 'legacy-plan-version-4',
        artifactChecksum: legacyChecksum,
        document: legacyDocument,
        approval: 'approved'
      }
    })
    expect(harness.dependencies.patchRuntimeContext).toHaveBeenCalledTimes(2)
    expect(harness.dependencies.writeArtifactForExecution).not.toHaveBeenCalled()

    const terminalReference = await restartedProcess.refresh('legacy-project', 'legacy-session')
    expect(terminalReference).toMatchObject({
      artifactVersionId: 'legacy-plan-version-4',
      revision: 19
    })
    expect(await readContextFile(terminalReference!.path)).toMatchObject({
      active: false,
      revision: 19,
      lifecycle: 'completed',
      document: legacyDocument,
      stepStates: {
        'Open the CSV': { status: 'completed' },
        'Read the headers': { status: 'skipped' },
        'Write the summary': { status: 'completed' }
      }
    })
  })

  it('reads a base-format artifact-only legacy context without migrating either authority', async () => {
    const artifactOnlyInput = structuredClone(legacyRuntimeContextInput) as {
      plan: { document?: PlanDocumentV1 }
    }
    delete artifactOnlyInput.plan.document
    const harness = createLegacyHarness(artifactOnlyInput)

    await expect(
      harness.service.getProjection('legacy-project', 'legacy-session')
    ).resolves.toMatchObject({
      artifactId: 'legacy-plan-artifact',
      artifactVersionId: 'legacy-plan-version-4',
      artifactChecksum: legacyChecksum,
      revision: 17,
      approval: 'approved',
      document: legacyDocument,
      stepStates: {
        'Open the CSV': { status: 'completed' },
        'Read the headers': { status: 'skipped' },
        'Write the summary': { status: 'not_started' }
      }
    })
    expect(harness.dependencies.readArtifactVersion).toHaveBeenCalledOnce()
    expect(harness.dependencies.patchRuntimeContext).not.toHaveBeenCalled()
    expect(harness.dependencies.writeArtifactForExecution).not.toHaveBeenCalled()
    expect(harness.context()).toEqual(sanitizeSessionRuntimeContext(artifactOnlyInput))
  })

  it.each([
    { fixture: 'embedded document', artifactOnly: false },
    { fixture: 'artifact-only document', artifactOnly: true }
  ])(
    'loads a version 2 disk Session with an $fixture and derives context without rewriting it',
    async ({ artifactOnly }) => {
      const storageRoot = await temporaryRoot()
      const projectId = 'legacy-disk-project'
      const sessionId = 'legacy-disk-session'
      const sessionDirectory = join(storageRoot, 'sessions', projectId)
      const sessionPath = join(sessionDirectory, `${sessionId}.json`)
      const runtimeContext = structuredClone(legacyRuntimeContextInput) as {
        plan: { document?: PlanDocumentV1 }
      }
      if (artifactOnly) delete runtimeContext.plan.document

      // This is a fixed base-format v2 envelope, written as historical bytes instead of through
      // SessionRepository.saveSession/current serializers. Its minimal Session fields match the
      // createSession fixture in the base repository.test.ts.
      const legacyEnvelope = {
        version: 2,
        session: {
          id: sessionId,
          projectId,
          revision: 6,
          title: 'Legacy disk Session',
          cwd: '/synthetic/legacy-workspace',
          status: 'idle',
          messages: [
            {
              id: 'legacy-prompt-message',
              role: 'user',
              content: 'Summarize the archived measurements',
              status: 'complete',
              eventIds: [],
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_000_000
            }
          ],
          runtimeContext,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_200
        }
      }
      const sourceBytes = `${JSON.stringify(legacyEnvelope, null, 2)}\n`
      await mkdir(sessionDirectory, { recursive: true })
      await writeFile(sessionPath, sourceBytes, 'utf8')

      const repository = new SessionRepository(storageRoot)
      const readArtifactVersion = vi.fn(async () => ({
        content: legacyDocumentBytes,
        checksum: legacyChecksum
      }))
      const patchRuntimeContext = vi.fn(async () => {
        throw new Error('A derived context refresh must not rewrite the Session authority.')
      })
      const writeArtifactForExecution = vi.fn(async () => {
        throw new Error('A legacy disk read must not rewrite the Plan Artifact.')
      })
      const dependencies: PlanServiceDependencies = {
        interactions: new SessionPlanInteractionOwner(),
        writeArtifactForExecution,
        readArtifactVersion,
        readRuntimeContext: async (requestedProjectId, requestedSessionId) => {
          const loaded = await repository.loadSession(requestedProjectId, requestedSessionId)
          if (!loaded?.runtimeContext)
            throw new Error('Legacy disk runtime context was not loaded.')
          return loaded.runtimeContext
        },
        patchRuntimeContext,
        persistUserMessage: vi.fn(async () => {
          throw new Error('Legacy disk compatibility does not persist review messages.')
        }),
        isRevisionConflict: () => false
      }
      const service = new PlanService(dependencies)
      const store = new PlanContextFileStore({
        storageRoot,
        readCurrent: async (requestedProjectId, requestedSessionId) =>
          (await service.getProjection(requestedProjectId, requestedSessionId)) ?? undefined
      })

      const loaded = await repository.loadSession(projectId, sessionId)
      expect(loaded).toMatchObject({
        id: sessionId,
        projectId,
        revision: 6,
        title: 'Legacy disk Session',
        runtimeContext: {
          revision: 17,
          plan: {
            artifactId: 'legacy-plan-artifact',
            artifactVersionId: 'legacy-plan-version-4',
            artifactChecksum: legacyChecksum,
            approval: 'approved',
            stepStatuses: legacyRuntimeContextInput.plan.stepStatuses
          }
        }
      })

      const reference = await store.refresh(projectId, sessionId)
      expect(reference).toMatchObject({
        artifactVersionId: 'legacy-plan-version-4',
        revision: 17
      })
      expect(await readContextFile(reference!.path)).toEqual({
        schemaVersion: 1,
        active: true,
        artifactVersionId: 'legacy-plan-version-4',
        artifactChecksum: legacyChecksum,
        revision: 17,
        approval: 'approved',
        lifecycle: 'approved',
        document: legacyDocument,
        stepStates: {
          'Open the CSV': { status: 'completed', notes: 'The file opened successfully.' },
          'Read the headers': {
            status: 'skipped',
            notes: 'Headers were already recorded in the archive.'
          },
          'Write the summary': { status: 'not_started' }
        }
      })
      await expect(readFile(sessionPath, 'utf8')).resolves.toBe(sourceBytes)
      expect(patchRuntimeContext).not.toHaveBeenCalled()
      expect(writeArtifactForExecution).not.toHaveBeenCalled()
      expect(readArtifactVersion).toHaveBeenCalledTimes(artifactOnly ? 1 : 0)
    }
  )
})
