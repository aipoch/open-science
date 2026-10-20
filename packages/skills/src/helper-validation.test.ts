import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  RegisteredSkillHelperCatalog,
  type RegisteredSkillPackage
} from './registered-helper-catalog'
import { inspectSkillPackage } from './skill-package-inspection'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = async (): Promise<RegisteredSkillPackage> => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'skill-helper-boundary-'))
  roots.push(packageRoot)
  const helpers = [
    {
      id: 'example-helper',
      language: 'python' as const,
      interfaceRevision: 1,
      implementation: 'helper.py',
      exports: ['value'],
      dependencies: []
    }
  ]
  await writeFile(join(packageRoot, 'helper.py'), 'def value():\n    return 42\n')
  await writeFile(
    join(packageRoot, 'SKILL.md'),
    '---\nname: example\ndescription: Example\n---\nExample'
  )
  await writeFile(
    join(packageRoot, 'open-science.json'),
    JSON.stringify({ schemaVersion: 1, helpers })
  )
  return { skillId: 'example', origin: 'personal', packageRoot, helpers }
}

it('rejects untrusted helper inspection and registration when no validator is supplied', async () => {
  const entry = await fixture()
  await expect(inspectSkillPackage(entry.packageRoot)).rejects.toThrow('no validator was supplied')
  const catalog = new RegisteredSkillHelperCatalog({
    storageRoot: entry.packageRoot,
    packages: async () => [entry]
  })
  await expect(catalog.resolve('example-helper')).rejects.toThrow('no validator was supplied')
})

it('validates exact bytes before publication and restores a durable immutable binding without source access', async () => {
  const entry = await fixture()
  const validateHelper = vi.fn().mockResolvedValue(undefined)
  const catalog = new RegisteredSkillHelperCatalog({
    storageRoot: entry.packageRoot,
    packages: async () => [entry],
    validateHelper
  })
  const first = await catalog.resolve('example-helper')
  expect(validateHelper).toHaveBeenCalledWith(
    'example-helper',
    'def value():\n    return 42\n',
    ['value'],
    entry.packageRoot
  )
  await writeFile(join(entry.packageRoot, 'helper.py'), 'raise RuntimeError("changed")\n')
  const packages = vi.fn().mockRejectedValue(new Error('must not reread mutable sources'))
  const restored = new RegisteredSkillHelperCatalog({ storageRoot: entry.packageRoot, packages })
  expect(await restored.resolve('example-helper')).toEqual(first)
  expect(packages).not.toHaveBeenCalled()
})

it('propagates validator rejection without approving helper content', async () => {
  const entry = await fixture()
  await expect(
    inspectSkillPackage(entry.packageRoot, {
      validateHelper: async () => {
        throw new Error('invalid callable')
      }
    })
  ).rejects.toThrow('invalid callable')
})
