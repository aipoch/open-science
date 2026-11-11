import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
const npmFiles = {
  'package.json': '{"name":"npm","version":"10.9.9"}',
  LICENSE: 'npm-license',
  'bin/npm-cli.js': 'npm-entry',
  'bin/npm': 'npm-shell',
  'bin/npx': 'npx-shell',
  'bin/npm.cmd': 'npm-cmd',
  'bin/npx.cmd': 'npx-cmd',
  'bin/npx-cli.js': 'npx-entry',
  'lib/cli.js': 'runtime-code',
  'node_modules/dependency/index.js': 'dependency-code',
  'node_modules/dependency/LICENSE': 'dependency-license',
  'node_modules/dependency/README.md': 'omit-readme',
  'node_modules/dependency/CHANGELOG.md': 'omit-history',
  'node_modules/dependency/template.txt': 'keep-template',
  '.npmrc': '',
  'docs/content/commands/npm.md': 'omit-docs',
  'man/man1/npm.1': 'omit-man',
  'README.md': 'omit-readme'
}
const npmZipFiles = (name: string): Record<string, Uint8Array> =>
  Object.fromEntries(
    Object.entries(npmFiles).map(([file, text]) => [
      `${name}/node_modules/npm/${file}`,
      strToU8(text)
    ])
  )
async function writeNpmFixture(root: string): Promise<void> {
  for (const [file, text] of Object.entries(npmFiles)) {
    const path = join(root, 'lib/node_modules/npm', file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
  }
}
async function assertNpmFixture(output: string): Promise<void> {
  for (const [file, text] of Object.entries(npmFiles)) {
    const path = join(output, 'node_modules/npm', file)
    if (/README|CHANGELOG|^docs\/|^man\//.test(file))
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(await readFile(path, 'utf8')).toBe(text)
  }
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
// Unix launchers require file symlinks, which ordinary Windows accounts cannot create.
it.skipIf(process.platform === 'win32')(
  'extracts Unix Node and trimmed npm while retaining runtime data and licenses',
  async () => {
    const directory = await temporary()
    const name = `node-v${nodeRuntime.version}-darwin-arm64`
    await mkdir(join(directory, name, 'bin'), { recursive: true })
    await writeFile(join(directory, name, 'bin/node'), 'node-fixture')
    await writeFile(join(directory, name, 'bin/npm'), 'not-shipped')
    await writeFile(join(directory, name, 'LICENSE'), 'license')
    await writeNpmFixture(join(directory, name))
    const archive = join(directory, 'node.tar.gz')
    await createTar({ cwd: directory, file: archive, gzip: true }, [name])
    const output = join(directory, 'output')
    await extractNodeRuntime(archive, output, 'darwin', 'arm64')
    expect(await readFile(join(output, 'node'), 'utf8')).toBe('node-fixture')
    await assertNpmFixture(output)
    expect(await readFile(join(output, 'LICENSE'), 'utf8')).toBe('license')
    await expect(readFile(join(output, 'bin/npm'))).rejects.toMatchObject({ code: 'ENOENT' })
    // Launcher links must stay inside the runtime root: absolute targets dangle once the
    // archive moves off the staging machine, breaking the bundled npm fallback.
    for (const [name, entry] of [
      ['npm', 'npm-entry'],
      ['npx', 'npx-entry']
    ]) {
      const target = await readlink(join(output, name))
      expect(target.startsWith('/')).toBe(false)
      expect(await readFile(join(output, target), 'utf8')).toBe(entry)
    }
  }
)
it('extracts the Windows executable and license and rejects incomplete archives', async () => {
  const directory = await temporary()
  const name = `node-v${nodeRuntime.version}-win-x64`
  const archive = join(directory, 'node.zip')
  await writeFile(
    archive,
    zipSync({
      [`${name}/node.exe`]: strToU8('node-fixture'),
      [`${name}/LICENSE`]: strToU8('license'),
      [`${name}/npm.cmd`]: strToU8('not-shipped'),
      ...npmZipFiles(name)
    })
  )
  const output = join(directory, 'output')
  await extractNodeRuntime(archive, output, 'win32', 'x64')
  expect(await readFile(join(output, 'node.exe'), 'utf8')).toBe('node-fixture')
  await assertNpmFixture(output)
  expect(await readFile(join(output, 'npm.cmd'), 'utf8')).toBe('npm-cmd')
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

it.for(['darwin', 'win32'])(
  'reuses verified %s output and repairs stale or corrupt staging',
  async (platform, { skip }) => {
    if (platform === 'darwin' && process.platform === 'win32')
      skip('Unix runtime launchers require file symlink privileges on Windows.')
    const directory = await temporary()
    const arch = 'x64'
    const key = `${platform}-${arch}`
    const original = nodeRuntime.archives[key]
    const name = `node-v${nodeRuntime.version}-${platform === 'win32' ? 'win' : platform}-${arch}`
    const archive = join(directory, original.file)
    if (platform === 'win32') {
      await writeFile(
        archive,
        zipSync({
          [`${name}/node.exe`]: strToU8('executable'),
          [`${name}/LICENSE`]: strToU8('license'),
          ...npmZipFiles(name)
        })
      )
    } else {
      await mkdir(join(directory, name, 'bin'), { recursive: true })
      await writeFile(join(directory, name, 'bin/node'), 'executable')
      await writeFile(join(directory, name, 'LICENSE'), 'license')
      await writeNpmFixture(join(directory, name))
      await createTar({ cwd: directory, file: archive, gzip: true }, [name])
    }
    // A locally generated archive exercises the real verification/extraction/reuse path offline.
    nodeRuntime.archives[key] = {
      ...original,
      sha256: createHash('sha256')
        .update(await readFile(archive))
        .digest('hex')
    }
    const output = join(directory, 'output')
    const options = { platform, arch, cache: directory, output, reuse: true }
    const marker = join(output, 'unchanged-output')
    const executable = join(output, platform === 'win32' ? 'node.exe' : 'node')
    try {
      await stageNodeRuntime(options)
      await writeFile(marker, 'kept')
      await stageNodeRuntime(options)
      expect(await readFile(marker, 'utf8')).toBe('kept')
      for (const target of [
        executable,
        join(output, 'LICENSE'),
        join(output, 'node_modules/npm/bin/npx-cli.js'),
        join(output, 'node_modules/npm/node_modules/dependency/index.js')
      ]) {
        await writeFile(target, 'corrupt')
        await stageNodeRuntime(options)
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(executable, 'utf8')).toBe('executable')
        expect(await readFile(join(output, 'LICENSE'), 'utf8')).toBe('license')
        await writeFile(marker, 'kept')
      }
      const receiptPath = join(output, 'version.json')
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
      for (const stale of [
        null,
        {},
        { ...receipt, version: 'old' },
        { ...receipt, arch: 'old' },
        { ...receipt, platform: 'old' },
        { ...receipt, sha256: 'old' },
        { ...receipt, files: undefined },
        { ...receipt, stagingVersion: undefined }
      ]) {
        await writeFile(receiptPath, JSON.stringify(stale))
        await stageNodeRuntime(options)
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
        await writeFile(marker, 'kept')
      }
      await rm(join(output, 'node_modules/npm/bin/npx-cli.js'))
      await stageNodeRuntime(options)
      await assertNpmFixture(output)
      await rm(executable)
      await stageNodeRuntime(options)
      expect(await readFile(executable, 'utf8')).toBe('executable')
      await writeFile(marker, 'kept')
      // Release staging remains a fresh extraction, even when the receipt matches.
      await stageNodeRuntime({ ...options, reuse: false })
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(archive, 'corrupt archive')
      await expect(stageNodeRuntime(options)).rejects.toThrow('checksum mismatch')
    } finally {
      nodeRuntime.archives[key] = original
    }
  }
)
