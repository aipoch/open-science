import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileWslSetupOperationJournal } from './wsl-setup-operation-journal'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FileWslSetupOperationJournal', () => {
  it('round-trips an interrupted runtime dependency installation marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-wsl-journal-'))
    roots.push(root)
    const journal = new FileWslSetupOperationJournal(root)
    const record = {
      kind: 'install-runtime-dependencies' as const,
      operationReference: 'dependencies1',
      startedAt: 123,
      selection: { distro: 'Ubuntu', user: 'scientist' }
    }

    await journal.save(record)

    const loaded = await journal.load()

    expect(loaded).toEqual(record)
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(
      Object.isFrozen(loaded?.kind === 'install-runtime-dependencies' && loaded.selection)
    ).toBe(true)
  })

  it.each([
    undefined,
    null,
    {},
    { distro: '', user: 'scientist' },
    { distro: 'Ubuntu', user: '' },
    { distro: 'Ubuntu', user: 'root' },
    { distro: 'Ubuntu\nmalformed', user: 'scientist' },
    { distro: 'Ubuntu', user: 'scientist\0malformed' }
  ])('rejects a dependency marker without a valid target: %j', async (selection) => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-wsl-journal-'))
    roots.push(root)
    await writeFile(
      join(root, 'wsl-setup-operation.json'),
      JSON.stringify({
        version: 1,
        operation: {
          kind: 'install-runtime-dependencies',
          operationReference: 'dependencies1',
          startedAt: 123,
          ...(selection === undefined ? {} : { selection })
        }
      })
    )

    const journal = new FileWslSetupOperationJournal(root)

    await expect(journal.load()).rejects.toThrow('invalid operation')
  })
})
