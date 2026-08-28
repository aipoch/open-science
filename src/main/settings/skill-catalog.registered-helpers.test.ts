import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { SkillRegistry, type BundledSkill } from '../skills/registry'
import type { UserSkillRepository } from '../skills/user-skill-repository'
import { NotebookHelperModuleHost } from '../notebook/helper-module-host'
import { NotebookKernelExecutor } from '../notebook/kernel-executor'
import { NotebookRuntimeService, type NotebookExecutionRequest } from '../notebook/runtime-service'
import { NotebookRunRepository } from '../notebook/repository'
import { SettingsRepository } from './repository'
import { SkillCatalogModule } from './skill-catalog'

const roots: string[] = []
const python3 = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(
  existsSync
)
const pythonGate = python3 ? describe : describe.skip

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const skill = async (source: BundledSkill['source'], id: string): Promise<BundledSkill> => {
  const sourceDir = await mkdtemp(join(tmpdir(), `${id}-`))
  roots.push(sourceDir)
  await writeFile(join(sourceDir, 'kernel.py'), `def ${id.replaceAll('-', '_')}():\n    return 1\n`)
  return {
    id,
    name: id,
    displayName: id,
    description: id,
    source,
    updatedAt: '2026-08-26T00:00:00.000Z',
    sourceDir,
    helpers: [
      {
        id: `${id}-helper`,
        language: 'python',
        interfaceRevision: 1,
        implementation: 'kernel.py',
        exports: [id.replaceAll('-', '_')],
        dependencies: []
      }
    ]
  }
}

describe('SkillCatalogModule registered helper projection', () => {
  pythonGate('production bundled helpers', () => {
    it('materializes and executes the three bundled helpers from stable IDs outside the resource cwd', async () => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'bundled-helper-catalog-'))
      const executionRoot = await mkdtemp(join(tmpdir(), 'bundled-helper-execution-'))
      roots.push(storageRoot, executionRoot)
      const skillsRoot = resolve(__dirname, '../../../resources/skills')
      const pythonLoopPath = resolve(__dirname, '../../../resources/notebook/python_loop.py')
      const skillRegistry = new SkillRegistry(skillsRoot)
      const catalog = new SkillCatalogModule({
        repository: new SettingsRepository(storageRoot),
        storageRoot,
        skillRegistry
      })
      const registered = catalog.registeredHelperCatalog()
      const helperIds = ['figure-style', 'figure-composer', 'paper-narrative'] as const
      const publicSkills = await catalog.listSkills()

      for (const id of helperIds) {
        const publicSkill = publicSkills.find((entry) => entry.id === id)
        expect(publicSkill).toBeDefined()
        expect(publicSkill).not.toHaveProperty('helpers')
        expect(publicSkill).not.toHaveProperty('sourceDir')
        expect(JSON.stringify(publicSkill)).not.toContain('kernel.py')
      }

      for (const id of helperIds) {
        const helper = await registered.resolve(id)
        expect(helper).toMatchObject({
          id,
          skillId: id,
          origin: 'builtin',
          language: 'python',
          interfaceRevision: expect.any(Number),
          exports: expect.any(Array),
          dependencies: [],
          digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          generation: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
        })
        expect(helper?.exports.length).toBeGreaterThan(0)
      }

      const helperHost = new NotebookHelperModuleHost(registered)
      const epoch = { id: 'bundled-helpers', processKey: 'python:system-python' }
      const request = await helperHost.preflight('python', helperIds, epoch)
      const plan = await helperHost.plan(epoch, request)
      helperHost.commitInitialized(
        epoch,
        plan.injections.map(({ id }) => id)
      )
      const executor = new NotebookKernelExecutor({ pythonLoopPath, platform: process.platform })
      try {
        const result = await executor.execute({
          cwd: executionRoot,
          notebookSessionRoot: join(executionRoot, 'notebook'),
          dataRoot: join(executionRoot, 'notebook', 'data'),
          runtimeRoot: join(executionRoot, 'runtime'),
          language: 'python',
          resolvedInterpreter: { command: python3 as string },
          helperModules: plan.injections,
          code: [
            'import json',
            'result = {',
            '  "style": two_tier_label("Accuracy", "n=6"),',
            '  "composer": figure_outline_schema()["required"],',
            '  "narrative": paper_brief_schema()["required"],',
            '}',
            'print(json.dumps(result))'
          ].join('\n')
        })
        expect(result.status, result.traceback).toBe('completed')
        expect(JSON.parse(result.stdout.trim())).toEqual({
          style: 'Accuracy\nn=6',
          composer: ['claim', 'width_mm', 'ncol', 'row_heights_mm', 'panels'],
          narrative: ['pitch', 'vision', 'figures']
        })
      } finally {
        await executor.shutdown()
      }
    }, 30_000)
  })

  it('derives Built-in, Personal and Imported helpers from one catalog', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'helper-skill-catalog-'))
    roots.push(storageRoot)
    await mkdir(storageRoot, { recursive: true })
    const builtin = await skill('featured', 'builtin-skill')
    const personal = await skill('personal', 'personal-skill')
    const imported = await skill('imported', 'imported-skill')
    const repository = new SettingsRepository(storageRoot)
    const catalog = new SkillCatalogModule({
      repository,
      storageRoot,
      skillRegistry: { list: async () => [builtin] } as unknown as SkillRegistry,
      userSkills: { list: async () => [personal, imported] } as unknown as UserSkillRepository
    })
    const registry = catalog.registeredHelperCatalog()

    await expect(registry.resolve('builtin-skill-helper')).resolves.toMatchObject({
      skillId: 'builtin-skill',
      origin: 'builtin'
    })
    await expect(registry.resolve('personal-skill-helper')).resolves.toMatchObject({
      skillId: 'personal-skill',
      origin: 'personal'
    })
    await expect(registry.resolve('imported-skill-helper')).resolves.toMatchObject({
      skillId: 'imported-skill',
      origin: 'imported'
    })

    const executions: NotebookExecutionRequest[] = []
    const notebook = new NotebookRuntimeService({
      configRoot: storageRoot,
      dataRoot: storageRoot,
      projectId: 'project-1',
      repository: new NotebookRunRepository(storageRoot),
      helperModuleCatalog: registry,
      executorFactory: () => ({
        execute: async (request) => {
          executions.push(request)
          return {
            status: 'completed' as const,
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })
    for (const helperId of [
      'builtin-skill-helper',
      'personal-skill-helper',
      'imported-skill-helper'
    ]) {
      await notebook.execute({
        projectId: 'project-1',
        sessionId: 'session-1',
        workspaceCwd: storageRoot,
        code: 'result = 1',
        cellId: `cell-${helperId}`,
        helperModules: [helperId]
      })
    }
    expect(executions.map((request) => request.helperModules?.[0]?.origin)).toEqual([
      'builtin',
      'personal',
      'imported'
    ])

    await repository.setSkillEnabled('personal-skill', false)
    await expect(registry.resolve('personal-skill-helper')).rejects.toThrow('not authorized')
    await expect(
      registry.resolve('personal-skill-helper', {
        sessionId: 'specialist-session',
        allowedSkillIds: ['personal-skill']
      })
    ).resolves.toBeDefined()
    await expect(
      registry.resolve('builtin-skill-helper', {
        sessionId: 'specialist-session',
        allowedSkillIds: ['personal-skill']
      })
    ).rejects.toThrow('not authorized')
  })

  it('refreshes direct helper edits for new epochs while an active epoch stays pinned', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'helper-direct-refresh-'))
    roots.push(storageRoot)
    const personal = await skill('personal', 'editable-skill')
    const catalog = new SkillCatalogModule({
      repository: new SettingsRepository(storageRoot),
      storageRoot,
      skillRegistry: { list: async () => [] } as unknown as SkillRegistry,
      userSkills: { list: async () => [personal] } as unknown as UserSkillRepository
    })
    const registry = catalog.registeredHelperCatalog()
    const host = new NotebookHelperModuleHost(registry)
    const activeEpoch = { id: 'active', processKey: 'python:system-python' }
    const first = await host.plan(
      activeEpoch,
      await host.preflight('python', ['editable-skill-helper'], activeEpoch)
    )
    host.commitInitialized(activeEpoch, ['editable-skill-helper'])

    await writeFile(join(personal.sourceDir, 'kernel.py'), 'def editable_skill():\n    return 2\n')
    await registry.refresh()

    const pinned = await host.plan(
      activeEpoch,
      await host.preflight('python', ['editable-skill-helper'], activeEpoch)
    )
    const nextEpoch = { id: 'next', processKey: 'python:system-python' }
    const replacement = await host.plan(
      nextEpoch,
      await host.preflight('python', ['editable-skill-helper'], nextEpoch)
    )

    expect(pinned.injections).toEqual([])
    expect(host.loadedEvidence(activeEpoch).helperModules?.[0]).toMatchObject({
      registeredGeneration: first.injections[0]?.registeredGeneration,
      source: expect.stringContaining('return 1')
    })
    expect(replacement.injections[0]?.code).toContain('return 2')
    expect(replacement.injections[0]?.registeredGeneration).not.toBe(
      first.injections[0]?.registeredGeneration
    )
  })

  it('rolls back a promoted Personal candidate that conflicts with the live helper graph', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'helper-promotion-rollback-'))
    roots.push(storageRoot)
    const repository = new SettingsRepository(storageRoot)
    const catalog = new SkillCatalogModule({
      repository,
      storageRoot,
      skillRegistry: { list: async () => [] } as unknown as SkillRegistry
    })
    const packageRoot = async (name: string, value: string): Promise<string> => {
      const root = await mkdtemp(join(tmpdir(), `helper-promote-${name}-`))
      roots.push(root)
      await writeFile(
        join(root, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name}\n---\nbody\n`
      )
      await writeFile(
        join(root, 'kernel.py'),
        `def shared_export():\n    return ${JSON.stringify(value)}\n`
      )
      await writeFile(
        join(root, 'open-science.json'),
        JSON.stringify({
          schemaVersion: 1,
          helpers: [
            {
              id: 'shared-helper',
              language: 'python',
              interfaceRevision: 1,
              implementation: 'kernel.py',
              exports: ['shared_export'],
              dependencies: []
            }
          ]
        })
      )
      return root
    }

    await catalog.publishHostSkill('first', await packageRoot('first', 'old'), false)
    const registry = catalog.registeredHelperCatalog()
    const old = await registry.resolve('shared-helper')
    await expect(
      catalog.publishHostSkill('conflict', await packageRoot('conflict', 'new'), false)
    ).rejects.toThrow('duplicate helper ID')

    const invalidReplacement = await packageRoot('first', 'replacement')
    const replacementManifest = JSON.parse(
      await readFile(join(invalidReplacement, 'open-science.json'), 'utf8')
    ) as { helpers: Array<{ dependencies: string[] }> }
    replacementManifest.helpers[0]!.dependencies = ['missing-helper']
    await writeFile(
      join(invalidReplacement, 'open-science.json'),
      JSON.stringify(replacementManifest)
    )
    await expect(catalog.publishHostSkill('first', invalidReplacement, true)).rejects.toThrow(
      'unknown dependency'
    )

    expect((await catalog.listSkills()).map((entry) => entry.id)).toEqual(['personal-first'])
    await expect(registry.resolve('shared-helper')).resolves.toMatchObject({
      generation: old?.generation,
      source: expect.stringContaining('"old"')
    })
  })
})
