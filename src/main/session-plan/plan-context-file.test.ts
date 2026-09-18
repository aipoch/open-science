import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  derivePlanLifecycle,
  projectPlanStepStates,
  type ActivePlanProjection
} from '../../shared/session-plan/contract'
import { getNotebookInputRoot } from '../notebook/input-staging'
import { PlanContextFileStore } from './plan-context-file'
import {
  SESSION_PLAN_FILE_DOCUMENT_FIELDS,
  SESSION_PLAN_FILE_ROOT_FIELDS,
  SESSION_PLAN_FILE_SYSTEM_PROMPT_APPEND,
  SESSION_PLAN_FILE_WORK_PATH
} from './plan-context-guidance'

const roots: string[] = []

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'plan-context-file-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const projection = (revision = 1): ActivePlanProjection => ({
  artifactId: 'plan-artifact',
  artifactVersionId: `plan-version-${revision}`,
  artifactChecksum: `checksum-${revision}`,
  originatingPromptMessageId: 'prompt-message',
  materializedAt: 123,
  revision,
  approval: 'approved',
  lifecycle: 'in_progress',
  document: {
    schema_version: 1,
    task_summary: 'Analyze the complete dataset without losing detailed instructions.',
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Primary work',
            steps: [
              {
                title: 'Inspect every sample',
                description: 'Retain this complete, deliberately detailed instruction in the file.'
              }
            ]
          }
        ]
      }
    ],
    desired_outputs: ['A complete report'],
    feasibility: { confidence: 'high', rationale: 'All inputs are available.' }
  },
  stepStatuses: {
    'Inspect every sample': { status: 'in_progress', updatedAt: 123, notes: 'Working' }
  },
  stepStates: { 'Inspect every sample': { status: 'in_progress', notes: 'Working' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 1 }
})

const contextPath = (root: string, projectId: string, sessionId: string): string =>
  join(getNotebookInputRoot(root, projectId, sessionId), 'session-plan', 'current.json')

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>

describe('PlanContextFileStore', () => {
  it('writes the complete selected projection as pretty, read-only JSON', async () => {
    const root = await temporaryRoot()
    const current = projection()
    const store = new PlanContextFileStore({ storageRoot: root, readCurrent: async () => current })

    const result = await store.refresh('project-1', 'session-1')
    const path = contextPath(root, 'project-1', 'session-1')
    const contents = await readFile(path, 'utf8')

    expect(result).toEqual({
      path,
      artifactVersionId: current.artifactVersionId,
      revision: current.revision
    })
    expect(contents).toContain('\n  "document": {\n')
    expect(JSON.parse(contents)).toEqual({
      schemaVersion: 1,
      active: true,
      artifactVersionId: current.artifactVersionId,
      artifactChecksum: current.artifactChecksum,
      revision: current.revision,
      approval: current.approval,
      lifecycle: current.lifecycle,
      document: current.document,
      stepStates: current.stepStates
    })
    expect((await stat(path)).mode & 0o777).toBe(0o444)
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
  })

  it('marks a blocked Plan active while a started peer delegation still has work', async () => {
    const root = await temporaryRoot()
    const document = {
      schema_version: 1 as const,
      task_summary: 'Analyze two work tracks in parallel',
      phases: [
        {
          name: 'Analysis',
          delegations: [
            {
              name: 'Cohorts',
              steps: [
                { title: 'Validate cohorts', description: 'Validate the cohort boundaries.' },
                { title: 'Compare cohorts', description: 'Compare the validated cohorts.' }
              ]
            },
            {
              name: 'Evidence',
              steps: [
                { title: 'Find evidence', description: 'Find the relevant evidence.' },
                { title: 'Review evidence', description: 'Review the collected evidence.' }
              ]
            }
          ]
        }
      ],
      desired_outputs: ['Analysis result'],
      feasibility: { confidence: 'high' as const, rationale: 'Inputs are available.' }
    }
    const stepStatuses = {
      'Validate cohorts': { status: 'blocked' as const, updatedAt: 40 },
      'Find evidence': { status: 'completed' as const, updatedAt: 41 }
    }
    let current: ActivePlanProjection = {
      ...projection(8),
      lifecycle: derivePlanLifecycle(document, 'approved', stepStatuses),
      document,
      stepStatuses,
      stepStates: projectPlanStepStates(document, stepStatuses),
      counts: { phases: 1, delegations: 2, steps: 4, completed: 1, inProgress: 0 }
    }
    const store = new PlanContextFileStore({ storageRoot: root, readCurrent: async () => current })

    const result = await store.refresh('project-1', 'session-1')

    expect(current.lifecycle).toBe('in_progress')
    await expect(readJson(result!.path)).resolves.toMatchObject({
      active: true,
      lifecycle: 'in_progress',
      stepStates: {
        'Validate cohorts': { status: 'blocked' },
        'Compare cohorts': { status: 'not_run' },
        'Find evidence': { status: 'completed' },
        'Review evidence': { status: 'not_started' }
      }
    })

    const terminalStatuses = {
      ...stepStatuses,
      'Review evidence': { status: 'completed' as const, updatedAt: 42 }
    }
    current = {
      ...current,
      revision: 9,
      lifecycle: derivePlanLifecycle(document, 'approved', terminalStatuses),
      stepStatuses: terminalStatuses,
      stepStates: projectPlanStepStates(document, terminalStatuses),
      counts: { ...current.counts, completed: 2 }
    }

    await store.refresh('project-1', 'session-1')

    expect(current.lifecycle).toBe('blocked')
    await expect(readJson(result!.path)).resolves.toMatchObject({
      active: false,
      lifecycle: 'blocked',
      revision: 9,
      stepStates: {
        'Validate cohorts': { status: 'blocked' },
        'Compare cohorts': { status: 'not_run' },
        'Find evidence': { status: 'completed' },
        'Review evidence': { status: 'completed' }
      }
    })
  })

  it('keeps the guided field paths aligned with the serialized Plan context', async () => {
    const root = await temporaryRoot()
    const current = projection()
    const store = new PlanContextFileStore({ storageRoot: root, readCurrent: async () => current })
    await store.refresh('project-1', 'session-1')

    const serialized = await readJson(contextPath(root, 'project-1', 'session-1'))
    for (const field of SESSION_PLAN_FILE_ROOT_FIELDS) {
      expect(serialized).toHaveProperty(field)
    }

    const document = serialized.document as Record<string, unknown>
    for (const field of SESSION_PLAN_FILE_DOCUMENT_FIELDS) {
      expect(document).toHaveProperty(field)
    }

    const phases = document.phases as Array<Record<string, unknown>>
    const stepStates = serialized.stepStates as Record<string, unknown>
    for (const phase of phases) {
      expect(phase.name).toBeTypeOf('string')
      const delegations = phase.delegations as Array<Record<string, unknown>>
      expect(Array.isArray(delegations)).toBe(true)
      for (const delegation of delegations) {
        expect(delegation.name).toBeTypeOf('string')
        const steps = delegation.steps as Array<Record<string, unknown>>
        expect(Array.isArray(steps)).toBe(true)
        for (const step of steps) {
          expect(step.title).toBeTypeOf('string')
          expect(step.description).toBeTypeOf('string')
          expect(Object.hasOwn(stepStates, step.title as string)).toBe(true)
        }
      }
    }

    expect(SESSION_PLAN_FILE_SYSTEM_PROMPT_APPEND).toContain(
      `Top-level fields are ${SESSION_PLAN_FILE_ROOT_FIELDS.join(', ')}`
    )
    expect(SESSION_PLAN_FILE_SYSTEM_PROMPT_APPEND).toContain(
      SESSION_PLAN_FILE_DOCUMENT_FIELDS.map((field) => `document.${field}`).join(', ')
    )
    expect(SESSION_PLAN_FILE_SYSTEM_PROMPT_APPEND).toContain(SESSION_PLAN_FILE_WORK_PATH)
    expect(SESSION_PLAN_FILE_SYSTEM_PROMPT_APPEND).toContain(
      'phases and delegations use name, while steps use title and description'
    )
    expect(SESSION_PLAN_FILE_SYSTEM_PROMPT_APPEND).toContain(
      "stepStates, keyed by each step's exact title"
    )
  })

  it('refreshes the same stable path with the latest revision', async () => {
    const root = await temporaryRoot()
    let current = projection(1)
    const store = new PlanContextFileStore({ storageRoot: root, readCurrent: async () => current })

    const first = await store.refresh('project-1', 'session-1')
    current = projection(2)
    const second = await store.refresh('project-1', 'session-1')

    expect(second).toEqual({
      path: first?.path,
      artifactVersionId: 'plan-version-2',
      revision: 2
    })
    expect(await readJson(first!.path)).toMatchObject({
      revision: 2,
      artifactVersionId: 'plan-version-2'
    })
  })

  it.each([
    [
      'corrupted',
      async (path: string) => {
        await rm(path)
        await writeFile(path, '{not valid json')
      }
    ],
    ['deleted', async (path: string) => rm(path)]
  ])('rebuilds a %s derived file from authority without mutating it', async (_state, damage) => {
    const root = await temporaryRoot()
    const current = projection(3)
    const authoritySnapshot = structuredClone(current)
    const readCurrent = vi.fn(async () => current)
    const store = new PlanContextFileStore({ storageRoot: root, readCurrent })
    const path = contextPath(root, 'project-1', 'session-1')

    await store.refresh('project-1', 'session-1')
    await damage(path)
    await expect(store.refresh('project-1', 'session-1')).resolves.toEqual({
      path,
      artifactVersionId: current.artifactVersionId,
      revision: current.revision
    })

    await expect(readJson(path)).resolves.toMatchObject({
      active: true,
      artifactVersionId: current.artifactVersionId,
      revision: current.revision,
      document: current.document,
      stepStates: current.stepStates
    })
    expect(current).toEqual(authoritySnapshot)
    expect(readCurrent).toHaveBeenCalledTimes(2)
  })

  it('defaults to the host platform and keeps the Windows projection replaceable', async () => {
    const root = await temporaryRoot()
    let current = projection(1)
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const store = new PlanContextFileStore({
        storageRoot: root,
        readCurrent: async () => current
      })

      const first = await store.refresh('project-1', 'session-1')
      current = projection(2)
      await expect(store.refresh('project-1', 'session-1')).resolves.toEqual({
        path: first?.path,
        artifactVersionId: 'plan-version-2',
        revision: 2
      })

      expect((await stat(first!.path)).mode & 0o777).toBe(0o600)
      expect(await readJson(first!.path)).toMatchObject({ revision: 2 })
    } finally {
      platform.mockRestore()
    }
  })

  it('serializes authority reads and writes per Session so a later refresh cannot regress', async () => {
    const root = await temporaryRoot()
    let releaseFirst!: (value: ActivePlanProjection) => void
    const firstProjection = new Promise<ActivePlanProjection>((resolve) => {
      releaseFirst = resolve
    })
    const readCurrent = vi
      .fn<() => Promise<ActivePlanProjection>>()
      .mockImplementationOnce(() => firstProjection)
      .mockResolvedValueOnce(projection(2))
    const store = new PlanContextFileStore({ storageRoot: root, readCurrent })

    const first = store.refresh('project-1', 'session-1')
    const second = store.refresh('project-1', 'session-1')
    await vi.waitFor(() => expect(readCurrent).toHaveBeenCalledTimes(1))

    releaseFirst(projection(1))
    await Promise.all([first, second])

    expect(readCurrent).toHaveBeenCalledTimes(2)
    expect(await readJson(contextPath(root, 'project-1', 'session-1'))).toMatchObject({
      revision: 2
    })
  })

  it('isolates concurrent projections across Sessions', async () => {
    const root = await temporaryRoot()
    const store = new PlanContextFileStore({
      storageRoot: root,
      readCurrent: async (_projectId, sessionId) => projection(sessionId === 'session-1' ? 1 : 2)
    })

    await Promise.all([
      store.refresh('project-1', 'session-1'),
      store.refresh('project-1', 'session-2')
    ])

    expect(await readJson(contextPath(root, 'project-1', 'session-1'))).toMatchObject({
      revision: 1
    })
    expect(await readJson(contextPath(root, 'project-1', 'session-2'))).toMatchObject({
      revision: 2
    })
  })

  it('writes a tombstone and returns no reference when no current Plan exists', async () => {
    const root = await temporaryRoot()
    const store = new PlanContextFileStore({
      storageRoot: root,
      readCurrent: async () => undefined
    })

    await expect(store.refresh('project-1', 'session-1')).resolves.toBeUndefined()
    await expect(readJson(contextPath(root, 'project-1', 'session-1'))).resolves.toEqual({
      schemaVersion: 1,
      active: false
    })
  })

  it.each(['awaiting_approval', 'blocked', 'completed', 'rejected'] as const)(
    'returns a readable %s Plan record but marks it inactive',
    async (lifecycle) => {
      const root = await temporaryRoot()
      const current = {
        ...projection(),
        lifecycle,
        approval:
          lifecycle === 'awaiting_approval'
            ? ('pending' as const)
            : lifecycle === 'rejected'
              ? ('rejected' as const)
              : ('approved' as const)
      }
      const store = new PlanContextFileStore({
        storageRoot: root,
        readCurrent: async () => current
      })

      const path = contextPath(root, 'project-1', 'session-1')
      await expect(store.refresh('project-1', 'session-1')).resolves.toEqual({
        path,
        artifactVersionId: current.artifactVersionId,
        revision: current.revision
      })
      await expect(readJson(path)).resolves.toMatchObject({
        active: false,
        approval: current.approval,
        lifecycle,
        document: current.document,
        stepStates: current.stepStates
      })
    }
  )

  it('invalidates an old active projection when the authority read fails', async () => {
    const root = await temporaryRoot()
    let fail = false
    const store = new PlanContextFileStore({
      storageRoot: root,
      readCurrent: async () => {
        if (fail) throw new Error('authority unavailable')
        return projection()
      }
    })
    await store.refresh('project-1', 'session-1')

    fail = true
    await expect(store.refresh('project-1', 'session-1')).rejects.toThrow('authority unavailable')
    await expect(readJson(contextPath(root, 'project-1', 'session-1'))).resolves.toEqual({
      schemaVersion: 1,
      active: false
    })
  })

  it('invalidates an old active projection when serialization fails', async () => {
    const root = await temporaryRoot()
    let current = projection()
    const store = new PlanContextFileStore({ storageRoot: root, readCurrent: async () => current })
    await store.refresh('project-1', 'session-1')

    current = { ...projection(2), revision: BigInt(2) as unknown as number }
    await expect(store.refresh('project-1', 'session-1')).rejects.toThrow()
    await expect(readJson(contextPath(root, 'project-1', 'session-1'))).resolves.toEqual({
      schemaVersion: 1,
      active: false
    })
  })

  it('removes an old active projection when publishing both the refresh and tombstone fails', async () => {
    const root = await temporaryRoot()
    let current = projection()
    let failRename = false
    const store = new PlanContextFileStore({
      storageRoot: root,
      readCurrent: async () => current,
      platform: 'win32',
      renameFile: async (source, destination) => {
        if (failRename) throw new Error('disk publication failed')
        await rename(source, destination)
      }
    })
    const first = await store.refresh('project-1', 'session-1')
    current = projection(2)
    failRename = true

    await expect(store.refresh('project-1', 'session-1')).rejects.toThrow('disk publication failed')
    await expect(readFile(first!.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans failed temporary files and lets a queued refresh publish after invalidation', async () => {
    const root = await temporaryRoot()
    let current = projection(1)
    let failedReplacements = 0
    const store = new PlanContextFileStore({
      storageRoot: root,
      readCurrent: async () => current,
      platform: 'win32',
      renameFile: async (source, destination) => {
        if (failedReplacements < 2 && current.revision === 2) {
          failedReplacements += 1
          throw new Error('disk publication failed')
        }
        await rename(source, destination)
      }
    })
    const first = await store.refresh('project-1', 'session-1')
    current = projection(2)

    const failed = store.refresh('project-1', 'session-1')
    const recovered = store.refresh('project-1', 'session-1')

    await expect(failed).rejects.toThrow('disk publication failed')
    await expect(recovered).resolves.toEqual({
      path: first!.path,
      artifactVersionId: 'plan-version-2',
      revision: 2
    })
    await expect(readJson(first!.path)).resolves.toMatchObject({
      active: true,
      artifactVersionId: 'plan-version-2',
      revision: 2
    })
    expect(await readdir(dirname(first!.path))).toEqual(['current.json'])
  })

  it('preserves the publication error when invalidation cannot safely replace or remove the target', async () => {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    let current = projection(1)
    let sabotage = false
    const outsideFile = join(outside, 'outside.json')
    await writeFile(outsideFile, 'keep me')
    const store = new PlanContextFileStore({
      storageRoot: root,
      readCurrent: async () => current,
      platform: 'win32',
      renameFile: async (source, destination) => {
        if (!sabotage) {
          await rename(source, destination)
          return
        }
        await rm(destination, { force: true })
        await symlink(outsideFile, destination)
        throw new Error('original publication failure')
      }
    })
    const first = await store.refresh('project-1', 'session-1')
    current = projection(2)
    sabotage = true

    await expect(store.refresh('project-1', 'session-1')).rejects.toThrow(
      'original publication failure'
    )
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('keep me')
    expect((await stat(first!.path)).isFile()).toBe(true)
    expect((await readdir(dirname(first!.path))).filter((name) => name.endsWith('.tmp'))).toEqual(
      []
    )
  })

  it('rejects a symlinked context directory without writing outside the input root', async () => {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    const inputRoot = getNotebookInputRoot(root, 'project-1', 'session-1')
    await mkdir(inputRoot, { recursive: true })
    await symlink(outside, join(inputRoot, 'session-plan'), 'dir')
    const outsideFile = join(outside, 'current.json')
    await writeFile(outsideFile, 'keep me')
    const store = new PlanContextFileStore({
      storageRoot: root,
      readCurrent: async () => projection()
    })

    await expect(store.refresh('project-1', 'session-1')).rejects.toThrow('real directory')
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('keep me')
  })

  it('rejects a symlinked destination file without overwriting its target', async () => {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    const path = contextPath(root, 'project-1', 'session-1')
    await mkdir(dirname(path), { recursive: true })
    const outsideFile = join(outside, 'outside.json')
    await writeFile(outsideFile, 'keep me')
    await symlink(outsideFile, path)
    const store = new PlanContextFileStore({
      storageRoot: root,
      readCurrent: async () => projection()
    })

    await expect(store.refresh('project-1', 'session-1')).rejects.toThrow('regular file')
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('keep me')
  })
})
