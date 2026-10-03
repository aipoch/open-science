import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPackArchive } from './pack-archive.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

it('creates the same archive when source mtimes change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'open-science-pack-'))
  temporaryDirectories.push(directory)
  const source = join(directory, 'runtime')
  const first = join(directory, 'first.tar.zst')
  const second = join(directory, 'second.tar.zst')
  const file = join(source, 'nested', 'runtime.dll')
  await mkdir(join(source, 'nested'), { recursive: true })
  await writeFile(file, 'signed runtime bytes')

  await utimes(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'))
  await createPackArchive(source, first)
  await utimes(file, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
  await createPackArchive(source, second)

  expect(await readFile(second)).toEqual(await readFile(first))
})
