import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { c as createTar } from 'tar'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, expect, it } from 'vitest'
import {
  extractNodeRuntime,
  nodeRuntime,
  verifyNodeArchive,
  stageNodeRuntime
} from './stage-node-runtime.mjs'

const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'node-runtime-test-'))
  directories.push(path)
  return path
}
it('pins all supported platform/architecture pairs to official release checksums', () => {
  expect(Object.keys(nodeRuntime.archives).sort()).toEqual([
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
    'win32-arm64',
    'win32-x64'
  ])
  for (const record of Object.values(nodeRuntime.archives) as { file: string; sha256: string }[]) {
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(record.file).toContain(`node-v${nodeRuntime.version}-`)
  }
})
it('rejects a corrupted cache rather than executing or silently replacing it', async () => {
  const directory = await temporary()
  const archive = join(directory, nodeRuntime.archives['darwin-arm64'].file)
  await writeFile(archive, 'tampered')
  await expect(
    stageNodeRuntime({
      platform: 'darwin',
      arch: 'arm64',
      cache: directory,
      output: join(directory, 'output')
    })
  ).rejects.toThrow('checksum mismatch')
  const sha = createHash('sha256').update('tampered').digest('hex')
  await expect(verifyNodeArchive(archive, sha)).resolves.toBeUndefined()
})
it('extracts only the Unix executable and license, without shipping npm or headers', async () => {
  const directory = await temporary()
  const name = `node-v${nodeRuntime.version}-darwin-arm64`
  await mkdir(join(directory, name, 'bin'), { recursive: true })
  await writeFile(join(directory, name, 'bin/node'), 'node-fixture')
  await writeFile(join(directory, name, 'bin/npm'), 'not-shipped')
  await writeFile(join(directory, name, 'LICENSE'), 'license')
  const archive = join(directory, 'node.tar.gz')
  await createTar({ cwd: directory, file: archive, gzip: true }, [name])
  const output = join(directory, 'output')
  await extractNodeRuntime(archive, output, 'darwin', 'arm64')
  expect(await readFile(join(output, 'node'), 'utf8')).toBe('node-fixture')
  expect(await readFile(join(output, 'LICENSE'), 'utf8')).toBe('license')
  await expect(readFile(join(output, 'bin/npm'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('extracts the Windows executable and license and rejects incomplete archives', async () => {
  const directory = await temporary()
  const name = `node-v${nodeRuntime.version}-win-x64`
  const archive = join(directory, 'node.zip')
  await writeFile(
    archive,
    zipSync({
      [`${name}/node.exe`]: strToU8('node-fixture'),
      [`${name}/LICENSE`]: strToU8('license'),
      [`${name}/npm.cmd`]: strToU8('not-shipped')
    })
  )
  const output = join(directory, 'output')
  await extractNodeRuntime(archive, output, 'win32', 'x64')
  expect(await readFile(join(output, 'node.exe'), 'utf8')).toBe('node-fixture')
  await expect(readFile(join(output, 'npm.cmd'))).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(archive, zipSync({ [`${name}/LICENSE`]: strToU8('license') }))
  await expect(
    extractNodeRuntime(archive, join(directory, 'incomplete'), 'win32', 'x64')
  ).rejects.toThrow('missing')
})
it('rejects unsupported targets before downloading', async () => {
  await expect(stageNodeRuntime({ platform: 'freebsd', arch: 'arm64' })).rejects.toThrow(
    'No pinned'
  )
})
