import { link, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MAX_REPRODUCIBILITY_OUTPUT_BYTES, readReproducibilityOutputFile } from './output-files'

const roots: string[] = []
const directory = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'reproduced-output-read-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('reads bounded regular output bytes unchanged', async () => {
  const root = await directory()
  const file = join(root, 'output.csv')
  const bytes = Buffer.from('group,n\nCtrl,33\n')
  await writeFile(file, bytes)
  await expect(readReproducibilityOutputFile(file)).resolves.toEqual(bytes)
})

it('rejects final symlinks and multiply linked output files', async () => {
  const root = await directory()
  const file = join(root, 'original.txt')
  await writeFile(file, 'original')
  await symlink(file, join(root, 'symlink.txt'))
  await expect(readReproducibilityOutputFile(join(root, 'symlink.txt'))).rejects.toThrow()
  await link(file, join(root, 'hardlink.txt'))
  await expect(readReproducibilityOutputFile(join(root, 'hardlink.txt'))).rejects.toThrow()
})

it('rejects oversized output before allocating its content', async () => {
  const root = await directory()
  const oversized = join(root, 'large.dat')
  await writeFile(oversized, '')
  await truncate(oversized, MAX_REPRODUCIBILITY_OUTPUT_BYTES + 1)
  await expect(readReproducibilityOutputFile(oversized)).rejects.toThrow('cannot be retained')
})
