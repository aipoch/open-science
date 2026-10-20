import { validateSkillHelper } from './helper-validation'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RegisteredSkillHelperCatalog } from './registered-helper-catalog'
import type { RegisteredSkillPackage } from '@aipoch/skills'
import { NotebookHelperModuleHost } from '../notebook/helper-module-host'
import { NotebookKernelExecutor } from '../notebook/kernel-executor'
import { resolvePythonCommand } from '@aipoch/environment'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const packageFixture = async (
  origin: RegisteredSkillPackage['origin'],
  skillId: string,
  source = 'def public_value():\n    return "v1"\n'
): Promise<RegisteredSkillPackage> => {
  const packageRoot = await mkdtemp(join(tmpdir(), `registered-${origin}-`))
  roots.push(packageRoot)
  await writeFile(join(packageRoot, 'kernel.py'), source)
  return {
    skillId,
    origin,
    packageRoot,
    helpers: [
      {
        id: `${skillId}-helper`,
        language: 'python',
        interfaceRevision: 1,
        implementation: 'kernel.py',
        exports: ['public_value'],
        dependencies: []
      }
    ]
  }
}

const createCatalog = async (
  packages: () => Promise<readonly RegisteredSkillPackage[]>,
  authorize?: ConstructorParameters<typeof RegisteredSkillHelperCatalog>[0]['authorize']
): Promise<RegisteredSkillHelperCatalog> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'registered-generations-'))
  roots.push(storageRoot)
  return new RegisteredSkillHelperCatalog({ storageRoot, packages, authorize })
}

describe('RegisteredSkillHelperCatalog', () => {
  it('carries registered descriptor identity, origin, revision, generation, and dependencies into evidence', async () => {
    const root = await packageFixture('personal', 'root')
    const dependency = await packageFixture('builtin', 'dependency')
    root.helpers[0] = { ...root.helpers[0]!, dependencies: ['dependency-helper'] }
    const catalog = await createCatalog(async () => [root, dependency])
    const host = new NotebookHelperModuleHost(catalog)
    const epoch = { id: 'evidence-epoch', processKey: 'python:default-python' }
    const plan = await host.plan(epoch, await host.preflight('python', ['root-helper']))
    host.commitInitialized(
      epoch,
      plan.injections.map(({ id }) => id)
    )

    expect(plan.injections.find(({ id }) => id === 'root-helper')).toMatchObject({
      skillId: 'root',
      origin: 'personal',
      interfaceRevision: 1,
      dependencies: ['dependency-helper']
    })
    expect(host.loadedEvidence(epoch).helperModules).toContainEqual(
      expect.objectContaining({
        helperId: 'root-helper',
        skillIdentity: 'root',
        packageOrigin: 'personal',
        interfaceRevision: '1',
        registeredGeneration: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        dependencies: ['dependency-helper']
      })
    )
  })

  it('executes an immutable generation through the real Python loop after source loss', async () => {
    const entry = await packageFixture('personal', 'plot', 'def plotted_value():\n    return 42\n')
    entry.helpers[0] = { ...entry.helpers[0]!, exports: ['plotted_value'] }
    const catalog = await createCatalog(async () => [entry])
    const host = new NotebookHelperModuleHost(catalog)
    const request = await host.preflight('python', ['plot-helper'])
    const injections = (
      await host.plan({ id: 'plot-epoch', processKey: 'python:default-python' }, request)
    ).injections
    await writeFile(join(entry.packageRoot, 'kernel.py'), 'raise RuntimeError("source reread")\n')

    const root = await mkdtemp(join(tmpdir(), 'registered-real-loop-'))
    roots.push(root)
    await mkdir(join(root, 'nb', 'data'), { recursive: true })
    const python = await resolvePythonCommand()
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: join(__dirname, '../../../resources/notebook/python_loop.py')
    })
    try {
      const result = await executor.execute({
        cwd: root,
        notebookSessionRoot: join(root, 'nb'),
        dataRoot: join(root, 'nb', 'data'),
        runtimeRoot: join(root, 'runtime'),
        language: 'python',
        resolvedInterpreter: python,
        helperModules: injections,
        code: 'print(plotted_value())'
      })
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed', stdout: '42\n' })
    } finally {
      await executor.shutdown()
    }
  })

  it('rejects a helper whose advertised export is not callable through the Python adapter', async () => {
    const entry = await packageFixture('imported', 'missing-export', 'VALUE = 1\n')
    const catalog = await createCatalog(async () => [entry])
    await expect(catalog.resolve('missing-export-helper')).rejects.toThrow('callable export')
  })

  it.each([
    ['def public_value(:\n    return 1\n', 'SyntaxError'],
    ['public_value = 1\n', 'non-callable exports'],
    ['def another_value():\n    return 1\n', 'missing or non-callable exports'],
    [
      'open("forbidden", "w").write("bad")\ndef public_value():\n    return 1\n',
      "name 'open' is not defined"
    ]
  ])('fails closed when isolated Python rejects an export candidate', async (source, message) => {
    const entry = await packageFixture('personal', 'isolated', source)
    const catalog = await createCatalog(async () => [entry])

    await expect(catalog.resolve('isolated-helper')).rejects.toThrow(message)
  })

  it('allows definition-oriented math and json stdlib imports during callable validation', async () => {
    const entry = await packageFixture(
      'builtin',
      'stdlib',
      [
        'import json',
        'import math',
        'def public_value(value=4):',
        '    return json.dumps({"root": math.sqrt(value)})'
      ].join('\n')
    )
    const catalog = await createCatalog(async () => [entry])

    await expect(catalog.resolve('stdlib-helper')).resolves.toMatchObject({
      exports: ['public_value']
    })
  })

  it.each([
    ['os', 'import os\ndef public_value():\n    return os.getcwd()\n'],
    [
      'pathlib file access',
      'from pathlib import Path\nPath("forbidden").read_text()\ndef public_value():\n    return 1\n'
    ],
    ['socket', 'import socket\ndef public_value():\n    return socket.socket()\n'],
    ['subprocess', 'import subprocess\ndef public_value():\n    return subprocess.run([])\n'],
    ['third-party', 'import definitely_not_a_real_package\ndef public_value():\n    return 1\n']
  ])('rejects %s imports during callable validation', async (_caseName, source) => {
    const entry = await packageFixture('imported', 'unsafe-import', source)
    const catalog = await createCatalog(async () => [entry])

    await expect(catalog.resolve('unsafe-import-helper')).rejects.toThrow(
      /host access|not allowed|No module named/
    )
  })

  it('validates Personal and Imported descriptors before a staged package is promoted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'staged-helper-'))
    roots.push(root)
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'kernel.py'), 'def public_value():\n    return 1\n')
    const descriptor = {
      schemaVersion: 1,
      helpers: [
        {
          id: 'staged-helper',
          language: 'python',
          interfaceRevision: 1,
          implementation: 'kernel.py',
          exports: ['missing'],
          dependencies: []
        }
      ]
    }
    await writeFile(join(root, 'open-science.json'), JSON.stringify(descriptor))

    const { inspectSkillPackage } = await import('@aipoch/skills/sources')
    await expect(
      inspectSkillPackage(root, { validateHelper: validateSkillHelper })
    ).rejects.toThrow('callable export')
  })
})

configureTestRuntimeMetadata()
