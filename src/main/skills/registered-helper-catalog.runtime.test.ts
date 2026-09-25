import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const validateNotebookHelperExports = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('../notebook/python-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notebook/python-command')>()),
  validateNotebookHelperExports
}))

import { envPrefix, pythonBin } from '../notebook/runtime-paths'
import {
  RegisteredSkillHelperCatalog,
  type RegisteredSkillPackage
} from './registered-helper-catalog'
import { inspectSkillPackage } from './skill-package-inspection'

const roots: string[] = []

afterEach(async () => {
  validateNotebookHelperExports.mockClear()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('RegisteredSkillHelperCatalog managed Python validation', () => {
  it('uses the app-managed Python runtime when validating a non-built-in helper', async () => {
    vi.stubEnv('OPEN_SCIENCE_HELPER_VALIDATION_SECRET', 'must-not-reach-helper')
    const storageRoot = await mkdtemp(join(tmpdir(), 'managed-helper-runtime-'))
    const packageRoot = await mkdtemp(join(tmpdir(), 'managed-helper-package-'))
    roots.push(storageRoot, packageRoot)
    await writeFile(join(packageRoot, 'kernel.py'), 'def public_value():\n    return 1\n')

    const prefix = envPrefix(join(storageRoot, 'runtime'), 'default-python')
    const managedPython = pythonBin(prefix)
    await mkdir(join(prefix, 'bin'), { recursive: true })
    await writeFile(managedPython, '')

    const entry: RegisteredSkillPackage = {
      skillId: 'managed-helper',
      origin: 'personal',
      packageRoot,
      helpers: [
        {
          id: 'managed-helper-function',
          language: 'python',
          interfaceRevision: 1,
          implementation: 'kernel.py',
          exports: ['public_value'],
          dependencies: []
        }
      ]
    }
    const catalog = new RegisteredSkillHelperCatalog({
      storageRoot,
      packages: async () => [entry]
    })

    await expect(catalog.resolve('managed-helper-function')).resolves.toBeDefined()
    expect(validateNotebookHelperExports).toHaveBeenCalledWith(
      'managed-helper-function',
      'def public_value():\n    return 1\n',
      ['public_value'],
      expect.objectContaining({
        python: { command: managedPython, baseArgs: [] }
      })
    )
    const validation = validateNotebookHelperExports.mock.calls[0]?.[3]
    expect(validation?.env).toHaveProperty('PATH')
    expect(validation?.env).not.toHaveProperty('OPEN_SCIENCE_HELPER_VALIDATION_SECRET')
  })

  it('uses the managed runtime when inspecting a staged helper package', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'managed-inspection-runtime-'))
    const packageRoot = await mkdtemp(join(tmpdir(), 'managed-inspection-package-'))
    roots.push(storageRoot, packageRoot)
    await writeFile(join(packageRoot, 'SKILL.md'), '# Managed helper\n')
    await writeFile(join(packageRoot, 'kernel.py'), 'def public_value():\n    return 1\n')
    await writeFile(
      join(packageRoot, 'open-science.json'),
      JSON.stringify({
        schemaVersion: 1,
        helpers: [
          {
            id: 'managed-helper-function',
            language: 'python',
            interfaceRevision: 1,
            implementation: 'kernel.py',
            exports: ['public_value'],
            dependencies: []
          }
        ]
      })
    )

    const prefix = envPrefix(join(storageRoot, 'runtime'), 'default-python')
    const managedPython = pythonBin(prefix)
    await mkdir(join(prefix, 'bin'), { recursive: true })
    await writeFile(managedPython, '')

    await expect(inspectSkillPackage(packageRoot, { storageRoot })).resolves.toHaveLength(3)
    expect(validateNotebookHelperExports).toHaveBeenCalledWith(
      'managed-helper-function',
      'def public_value():\n    return 1\n',
      ['public_value'],
      expect.objectContaining({
        python: { command: managedPython, baseArgs: [] }
      })
    )
  })

  it('rejects helper implementations hidden behind ignored package paths', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'hidden-helper-runtime-'))
    const packageRoot = await mkdtemp(join(tmpdir(), 'hidden-helper-package-'))
    roots.push(storageRoot, packageRoot)
    await mkdir(join(packageRoot, '.hidden'), { recursive: true })
    await writeFile(
      join(packageRoot, '.hidden', 'kernel.py'),
      'def public_value():\n    return 1\n'
    )

    const catalog = new RegisteredSkillHelperCatalog({
      storageRoot,
      packages: async () => [
        {
          skillId: 'hidden-helper',
          origin: 'personal',
          packageRoot,
          helpers: [
            {
              id: 'hidden-helper-function',
              language: 'python',
              interfaceRevision: 1,
              implementation: '.hidden/kernel.py',
              exports: ['public_value'],
              dependencies: []
            }
          ]
        }
      ]
    })

    await expect(catalog.resolve('hidden-helper-function')).rejects.toThrow('must not be hidden')
  })
})
