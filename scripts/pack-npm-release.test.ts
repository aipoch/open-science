import { expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packTarball } from './pack-npm-release.mjs'

it('handles npm inventories larger than the subprocess buffer and removes the report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'npm-pack-large-inventory-'))
  try {
    const cli = join(root, 'npm.cjs')
    await writeFile(
      cli,
      `process.stdout.write(JSON.stringify([{filename:'package.tgz',files:['x'.repeat(2*1024*1024)]}]))`
    )
    expect((await packTarball(root, root, cli)).filename).toBe('package.tgz')
    expect(await readdir(root)).toEqual(['npm.cjs'])
    await writeFile(cli, `process.stdout.write('partial'); process.exit(1)`)
    await expect(packTarball(root, root, cli)).rejects.toThrow()
    expect(await readdir(root)).toEqual(['npm.cjs'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
