import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  RegisteredSkillHelperCatalog,
  type RegisteredSkillPackage
} from './registered-helper-catalog'
import { NotebookHelperModuleHost } from '../notebook/helper-module-host'
import { NotebookKernelExecutor } from '../notebook/kernel-executor'
import { resolvePythonCommand } from '../notebook/python-command'

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
  it('normalizes all three supported origins through one catalog port and materializes app-owned generations', async () => {
    const packages = await Promise.all(
      (['builtin', 'personal', 'imported'] as const).map((origin) => packageFixture(origin, origin))
    )
    const catalog = await createCatalog(async () => packages)

    for (const entry of packages) {
      const helper = await catalog.resolve(`${entry.skillId}-helper`, {
        projectId: 'project-1',
        sessionId: 'session-1'
      })
      expect(helper).toMatchObject({
        id: `${entry.skillId}-helper`,
        skillId: entry.skillId,
        origin: entry.origin,
        language: 'python',
        interfaceRevision: 1,
        exports: ['public_value'],
        dependencies: []
      })
      expect(helper?.source).toContain('return "v1"')
      expect(helper?.generation).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(helper?.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(JSON.stringify(helper)).not.toContain(entry.packageRoot)
    }
  })

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
      expect(result).toMatchObject({ status: 'completed', stdout: '42\n' })
    } finally {
      await executor.shutdown()
    }
  })

  it('assigns every helper in one package the same immutable package generation', async () => {
    const entry = await packageFixture('builtin', 'multi')
    entry.helpers.push({ ...entry.helpers[0]!, id: 'multi-second-helper' })
    const catalog = await createCatalog(async () => [entry])

    const first = await catalog.resolve('multi-helper')
    const second = await catalog.resolve('multi-second-helper')
    expect(first?.generation).toBe(second?.generation)
    const root = catalog.generationRoot(first!.generation)
    await expect(readFile(join(root, 'multi-helper', 'source.py'), 'utf8')).resolves.toContain(
      'public_value'
    )
    await expect(
      readFile(join(root, 'multi-second-helper', 'source.py'), 'utf8')
    ).resolves.toContain('public_value')
  })

  it.each(['builtin', 'personal', 'imported'] as const)(
    'keeps the old immutable %s generation after replacement and never rereads its source',
    async (origin) => {
      const entry = await packageFixture(origin, 'plot')
      let current = entry
      const catalog = await createCatalog(async () => [current])
      const first = await catalog.resolve('plot-helper')
      expect(first?.source).toContain('"v1"')

      await writeFile(
        join(entry.packageRoot, 'kernel.py'),
        'def public_value():\n    return "v2"\n'
      )
      expect((await catalog.resolve('plot-helper'))?.source).toContain('"v1"')

      const replacement = await packageFixture(
        origin,
        'plot',
        'def public_value():\n    return "v2"\n'
      )
      current = replacement
      await catalog.refresh()
      const second = await catalog.resolve('plot-helper')
      expect(second?.source).toContain('"v2"')
      expect(second?.generation).not.toBe(first?.generation)

      const generationRoot = catalog.generationRoot(first!.generation)
      await expect(
        readFile(join(generationRoot, 'plot-helper', 'source.py'), 'utf8')
      ).resolves.toContain('"v1"')
    }
  )

  it.each(['personal', 'imported'] as const)(
    'restores the durable %s binding on cold start without trusting directly edited source',
    async (origin) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'registered-cold-start-'))
      roots.push(storageRoot)
      const entry = await packageFixture(origin, `durable-${origin}`)
      const firstCatalog = new RegisteredSkillHelperCatalog({
        storageRoot,
        packages: async () => [entry]
      })
      const first = await firstCatalog.resolve(`durable-${origin}-helper`)

      let sourceReads = 0
      await writeFile(
        join(entry.packageRoot, 'kernel.py'),
        'def public_value():\n    return "v2"\n'
      )
      const restartedCatalog = new RegisteredSkillHelperCatalog({
        storageRoot,
        packages: async () => {
          sourceReads += 1
          return [entry]
        }
      })

      const restarted = await restartedCatalog.resolve(`durable-${origin}-helper`)
      expect(restarted).toMatchObject({
        origin,
        generation: first?.generation,
        source: expect.stringContaining('return "v1"')
      })
      expect(sourceReads).toBe(0)

      await restartedCatalog.refresh()
      const refreshed = await restartedCatalog.resolve(`durable-${origin}-helper`)
      expect(refreshed).toMatchObject({
        origin,
        source: expect.stringContaining('return "v2"')
      })
      expect(refreshed?.generation).not.toBe(first?.generation)
      expect(sourceReads).toBe(1)
    }
  )

  it('advances changed Built-ins on cold start and reuses an unchanged generation', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'registered-builtin-upgrade-'))
    roots.push(storageRoot)
    const builtin = await packageFixture('builtin', 'bundled')
    const firstCatalog = new RegisteredSkillHelperCatalog({
      storageRoot,
      packages: async () => [builtin],
      trustedBuiltinPackages: async () => [builtin]
    })
    const first = await firstCatalog.resolve('bundled-helper')

    const unchangedCatalog = new RegisteredSkillHelperCatalog({
      storageRoot,
      packages: async () => {
        throw new Error('full mutable catalog must not be read during cold start')
      },
      trustedBuiltinPackages: async () => [builtin]
    })
    const unchanged = await unchangedCatalog.resolve('bundled-helper')
    expect(unchanged).toMatchObject({
      generation: first?.generation,
      source: expect.stringContaining('return "v1"')
    })

    await writeFile(
      join(builtin.packageRoot, 'kernel.py'),
      'def public_value():\n    return "v2"\n'
    )
    const upgradedCatalog = new RegisteredSkillHelperCatalog({
      storageRoot,
      packages: async () => {
        throw new Error('full mutable catalog must not be read during cold start')
      },
      trustedBuiltinPackages: async () => [builtin]
    })
    const upgraded = await upgradedCatalog.resolve('bundled-helper')
    expect(upgraded).toMatchObject({
      origin: 'builtin',
      source: expect.stringContaining('return "v2"')
    })
    expect(upgraded?.generation).not.toBe(first?.generation)
  })

  it('reconciles a mixed snapshot from trusted Built-ins only and removes retired Built-ins', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'registered-mixed-upgrade-'))
    roots.push(storageRoot)
    const builtin = await packageFixture('builtin', 'bundled')
    const retired = await packageFixture('builtin', 'retired')
    const personal = await packageFixture('personal', 'personal')
    const imported = await packageFixture('imported', 'imported')
    const firstCatalog = new RegisteredSkillHelperCatalog({
      storageRoot,
      packages: async () => [builtin, retired, personal, imported],
      trustedBuiltinPackages: async () => [builtin, retired]
    })
    await firstCatalog.resolve('bundled-helper')

    await Promise.all([
      writeFile(join(builtin.packageRoot, 'kernel.py'), 'def public_value():\n    return "v2"\n'),
      writeFile(join(personal.packageRoot, 'kernel.py'), 'def public_value():\n    return "v2"\n'),
      writeFile(join(imported.packageRoot, 'kernel.py'), 'def public_value():\n    return "v2"\n')
    ])
    let fullCatalogReads = 0
    const restartedCatalog = new RegisteredSkillHelperCatalog({
      storageRoot,
      packages: async () => {
        fullCatalogReads += 1
        return [builtin, personal, imported]
      },
      trustedBuiltinPackages: async () => [builtin]
    })

    await expect(restartedCatalog.resolve('bundled-helper')).resolves.toMatchObject({
      source: expect.stringContaining('return "v2"')
    })
    await expect(restartedCatalog.resolve('retired-helper')).resolves.toBeUndefined()
    await expect(restartedCatalog.resolve('personal-helper')).resolves.toMatchObject({
      source: expect.stringContaining('return "v1"')
    })
    await expect(restartedCatalog.resolve('imported-helper')).resolves.toMatchObject({
      source: expect.stringContaining('return "v1"')
    })
    expect(fullCatalogReads).toBe(0)
  })

  it('fails closed instead of removing a Built-in required by a restored user helper', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'registered-builtin-removal-'))
    roots.push(storageRoot)
    const builtin = await packageFixture('builtin', 'dependency')
    const personal = await packageFixture('personal', 'dependent')
    personal.helpers[0] = {
      ...personal.helpers[0]!,
      dependencies: ['dependency-helper']
    }
    const firstCatalog = new RegisteredSkillHelperCatalog({
      storageRoot,
      packages: async () => [builtin, personal],
      trustedBuiltinPackages: async () => [builtin]
    })
    await firstCatalog.resolve('dependent-helper')

    const removedCatalog = new RegisteredSkillHelperCatalog({
      storageRoot,
      packages: async () => {
        throw new Error('full mutable catalog must not be read during cold start')
      },
      trustedBuiltinPackages: async () => []
    })
    await expect(removedCatalog.resolve('dependent-helper')).rejects.toThrow('unknown dependency')

    // The rejected reconciliation does not replace the durable binding.
    const recoveredCatalog = new RegisteredSkillHelperCatalog({
      storageRoot,
      packages: async () => [],
      trustedBuiltinPackages: async () => [builtin]
    })
    await expect(recoveredCatalog.resolve('dependent-helper')).resolves.toBeDefined()
  })

  it.each(['missing', 'corrupt'] as const)(
    'fails closed when a persisted immutable generation is %s',
    async (damage) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'registered-cold-damage-'))
      roots.push(storageRoot)
      const entry = await packageFixture('personal', 'durable')
      const firstCatalog = new RegisteredSkillHelperCatalog({
        storageRoot,
        packages: async () => [entry]
      })
      const first = await firstCatalog.resolve('durable-helper')
      const sourcePath = join(
        firstCatalog.generationRoot(first!.generation),
        'durable-helper',
        'source.py'
      )
      if (damage === 'missing') await rm(sourcePath)
      else {
        await chmod(sourcePath, 0o600)
        await writeFile(sourcePath, 'def public_value():\n    return "tampered"\n')
      }

      let sourceReads = 0
      const restartedCatalog = new RegisteredSkillHelperCatalog({
        storageRoot,
        packages: async () => {
          sourceReads += 1
          return [entry]
        },
        trustedBuiltinPackages: async () => {
          sourceReads += 1
          return []
        }
      })

      await expect(restartedCatalog.resolve('durable-helper')).rejects.toThrow(
        'immutable generation mismatch'
      )
      expect(sourceReads).toBe(0)
    }
  )

  it.each([
    ['/absolute.py', 'implementation locator'],
    ['../escape.py', 'implementation locator'],
    ['nested\\kernel.py', 'implementation locator']
  ])('rejects unsafe locator %s', async (implementation, message) => {
    const entry = await packageFixture('imported', 'unsafe')
    entry.helpers[0] = { ...entry.helpers[0]!, implementation }
    const catalog = await createCatalog(async () => [entry])
    await expect(catalog.resolve('unsafe-helper')).rejects.toThrow(message)
  })

  it('rejects symlinks, invalid UTF-8, oversized source, missing exports, and duplicate exports', async () => {
    const cases: Array<{
      mutate: (entry: RegisteredSkillPackage) => Promise<void>
      error: string
    }> = [
      {
        mutate: async (entry) => {
          await writeFile(
            join(entry.packageRoot, 'target.py'),
            'def public_value():\n    return 1\n'
          )
          await rm(join(entry.packageRoot, 'kernel.py'))
          await symlink('target.py', join(entry.packageRoot, 'kernel.py'))
        },
        error: 'symbolic link'
      },
      {
        mutate: (entry) =>
          writeFile(join(entry.packageRoot, 'kernel.py'), Buffer.from([0xff, 0xfe])),
        error: 'UTF-8'
      },
      {
        mutate: (entry) => writeFile(join(entry.packageRoot, 'kernel.py'), 'x'.repeat(1_048_577)),
        error: 'size limit'
      },
      {
        mutate: (entry) => writeFile(join(entry.packageRoot, 'kernel.py'), 'VALUE = 1\n'),
        error: 'callable export'
      },
      {
        mutate: async (entry) => {
          entry.helpers[0] = { ...entry.helpers[0]!, exports: ['public_value', 'public_value'] }
        },
        error: 'duplicate export'
      }
    ]

    for (const [index, testCase] of cases.entries()) {
      const entry = await packageFixture('imported', `bad-${index}`)
      await testCase.mutate(entry)
      const catalog = await createCatalog(async () => [entry])
      await expect(catalog.resolve(`bad-${index}-helper`)).rejects.toThrow(testCase.error)
    }
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

  it('rejects Connector registered-helper packages as unsupported', async () => {
    const entry = await packageFixture('imported', 'unsupported-connector')
    const unsupported = { ...entry, origin: 'connector' } as unknown as RegisteredSkillPackage
    const catalog = await createCatalog(async () => [unsupported])

    await expect(catalog.resolve('unsupported-connector-helper')).rejects.toThrow('invalid origin')
  })

  it('fails closed on duplicate IDs, missing dependencies, cycles, and non-callable dependencies', async () => {
    const first = await packageFixture('builtin', 'first')
    const duplicate = await packageFixture('personal', 'second')
    duplicate.helpers[0] = { ...duplicate.helpers[0]!, id: 'first-helper' }
    await expect(
      (await createCatalog(async () => [first, duplicate])).resolve('first-helper')
    ).rejects.toThrow('duplicate helper ID')

    const missing = await packageFixture('imported', 'missing')
    missing.helpers[0] = { ...missing.helpers[0]!, dependencies: ['absent-helper'] }
    await expect(
      (await createCatalog(async () => [missing])).resolve('missing-helper')
    ).rejects.toThrow('unknown dependency')

    const left = await packageFixture('builtin', 'left')
    const right = await packageFixture('imported', 'right')
    left.helpers[0] = { ...left.helpers[0]!, dependencies: ['right-helper'] }
    right.helpers[0] = { ...right.helpers[0]!, dependencies: ['left-helper'] }
    await expect(
      (await createCatalog(async () => [left, right])).resolve('left-helper')
    ).rejects.toThrow('dependency cycle')
  })

  it('rejects a registered generation whose combined helper sources exceed the total limit', async () => {
    const packages = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        packageFixture(
          'builtin',
          `large-${index}`,
          `def public_value():\n    return ${index}\n#${'x'.repeat(900_000)}`
        )
      )
    )
    const catalog = await createCatalog(async () => packages)

    await expect(catalog.resolve('large-0-helper')).rejects.toThrow('total source size limit')
  })

  it('enforces trusted scope authorization without accepting scope claims in helper IDs', async () => {
    const allowed = await packageFixture('builtin', 'allowed')
    const denied = await packageFixture('personal', 'denied')
    const catalog = await createCatalog(
      async () => [allowed, denied],
      ({ skillId }, scope) => scope?.sessionId === 'session-1' && skillId === 'allowed'
    )

    await expect(
      catalog.resolve('allowed-helper', { projectId: 'project-1', sessionId: 'session-1' })
    ).resolves.toBeDefined()
    await expect(
      catalog.resolve('denied-helper', { projectId: 'project-1', sessionId: 'session-1' })
    ).rejects.toThrow('not authorized')
    await expect(catalog.resolve('/tmp/kernel.py')).resolves.toBeUndefined()
    await expect(catalog.resolve('sha256:' + 'a'.repeat(64))).resolves.toBeUndefined()
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

    const { inspectSkillPackage } = await import('./skill-package-inspection')
    await expect(inspectSkillPackage(root)).rejects.toThrow('callable export')
  })
})
