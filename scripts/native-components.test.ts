import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { load } from 'js-yaml'
import { publishNativeFiles, verifyNativeSignatures } from './produce-native-components.mjs'
import { rebuildElectronDependencies } from './install-native-components.mjs'
import {
  digest,
  nativeFiles,
  sourceFingerprint,
  spec,
  stageNativeComponents,
  validateNativeRelease,
  verifyPackagedNativeComponents
} from './native-components.mjs'

type NativeFile = { package: string; name: string; sha256: string; size: number; url: string }
type Release = {
  schema: number
  target: string
  source: string
  node: string
  signing: string
  files: NativeFile[]
}
type Step = { name?: string; if?: string; run?: string }
type Workflow = {
  on: { workflow_call: { inputs: { dry_run: { default: boolean } } } }
  jobs: { build: { strategy: { matrix: { include: { target: string }[] } }; steps: Step[] } }
}

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function fixture(): Promise<{
  directory: string
  catalog: Record<string, Release>
  fetchImpl: ReturnType<typeof vi.fn>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'native-components-'))
  directories.push(directory)
  await writeFile(
    join(directory, 'package-lock.json'),
    JSON.stringify({ packages: { 'node_modules/node-gyp': { version: '12.4.0' } } })
  )
  for (const pkg of Object.keys(spec.packages)) {
    await mkdir(join(directory, 'packages', pkg, 'src'), { recursive: true })
    await writeFile(join(directory, 'packages', pkg, 'binding.gyp'), '{}')
    await writeFile(join(directory, 'packages', pkg, 'src/main.cc'), 'native-source')
  }
  for (const path of [
    '.github/workflows/native-components.yml',
    'scripts/produce-native-components.mjs',
    'scripts/verify-native-component-signatures.ps1'
  ]) {
    await mkdir(join(directory, path, '..'), { recursive: true })
    await writeFile(join(directory, path), await readFile(path))
  }
  const target = 'linux-x64'
  const files = nativeFiles(target).map((file: { package: string; name: string }) => {
    const bytes = Buffer.from(file.name)
    const sha256 = digest(bytes)
    return {
      ...file,
      sha256,
      size: bytes.length,
      url: `${spec.cdn}/${target}/${sha256}/${file.name}`
    }
  })
  const catalog = {
    [target]: {
      schema: 1,
      target,
      source: await sourceFingerprint(directory),
      node: spec.node,
      signing: 'none',
      files
    }
  }
  const fetchImpl = vi.fn(async (url: string) => new Response(url.split('/').at(-1)))
  return { directory, catalog, fetchImpl }
}
it('stages exactly pinned bytes at existing package paths and reuses the verified cache', async () => {
  const options = await fixture()
  await stageNativeComponents({ ...options, target: 'linux-x64' })
  expect(options.fetchImpl).toHaveBeenCalledTimes(5)
  for (const file of nativeFiles('linux-x64')) {
    const path = join(options.directory, 'packages', file.package, 'build/Release', file.name)
    expect(await readFile(path, 'utf8')).toBe(file.name)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o755)
  }
  options.fetchImpl.mockClear()
  await stageNativeComponents({ ...options, target: 'linux-x64' })
  expect(options.fetchImpl).not.toHaveBeenCalled()
})
it('rejects stale sources before any download or output mutation', async () => {
  const options = await fixture()
  await writeFile(join(options.directory, 'packages/process-tree-native/src/main.cc'), 'changed')
  await expect(stageNativeComponents({ ...options, target: 'linux-x64' })).rejects.toThrow('stale')
  expect(options.fetchImpl).not.toHaveBeenCalled()
})
it.each([
  'missing',
  'unsigned',
  'wrong-platform',
  'traversal',
  'duplicate',
  'foreign-url',
  'oversized'
])('rejects %s release metadata', async (kind) => {
  const { catalog } = await fixture()
  const release = catalog['linux-x64']
  const fingerprint = release.source
  if (kind === 'missing') release.files = []
  if (kind === 'unsigned') release.signing = 'unsigned'
  if (kind === 'wrong-platform') release.target = 'linux-arm64'
  if (kind === 'traversal') release.files[0].name = '../escape'
  if (kind === 'duplicate') release.files[1] = release.files[0]
  if (kind === 'foreign-url') release.files[0].url = 'https://example.org/binary'
  if (kind === 'oversized') release.files[0].size = 21 * 1024 * 1024
  expect(() => validateNativeRelease(release, 'linux-x64', fingerprint)).toThrow()
})
it.each(['corrupted', 'truncated', 'oversized', 'unavailable'])(
  'rejects a %s download without installing any outputs',
  async (kind) => {
    const options = await fixture()
    options.fetchImpl.mockImplementationOnce(
      async () =>
        new Response(kind === 'truncated' ? '' : kind === 'oversized' ? 'x'.repeat(100) : 'wrong', {
          status: kind === 'unavailable' ? 404 : 200
        })
    )
    await expect(stageNativeComponents({ ...options, target: 'linux-x64' })).rejects.toThrow()
    await expect(
      stat(join(options.directory, 'packages/credential-identity-probe-native/build'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  }
)
it('fails closed on corrupted cached bytes rather than downloading a replacement', async () => {
  const options = await fixture()
  await stageNativeComponents({ ...options, target: 'linux-x64' })
  await writeFile(
    join(
      options.directory,
      'node_modules/.cache/native-components',
      options.catalog['linux-x64'].files[0].sha256
    ),
    'tampered'
  )
  options.fetchImpl.mockClear()
  await expect(stageNativeComponents({ ...options, target: 'linux-x64' })).rejects.toThrow()
  expect(options.fetchImpl).not.toHaveBeenCalled()
})
it.skipIf(process.platform === 'win32')('rejects cached symlinks', async () => {
  const options = await fixture()
  const file = options.catalog['linux-x64'].files[0]
  const cache = join(options.directory, 'node_modules/.cache/native-components')
  await mkdir(cache, { recursive: true })
  await writeFile(join(options.directory, 'outside'), file.name)
  await symlink(join(options.directory, 'outside'), join(cache, file.sha256))
  await expect(stageNativeComponents({ ...options, target: 'linux-x64' })).rejects.toThrow(
    'file type'
  )
})
it('requires release signatures for both desktop signing platforms', async () => {
  const { catalog } = await fixture()
  for (const target of ['darwin-arm64', 'win32-x64']) {
    const release = { ...catalog['linux-x64'], target, signing: 'unsigned' }
    expect(() => validateNativeRelease(release, target, release.source)).toThrow('unsigned')
  }
})
it.skipIf(process.platform !== 'darwin')(
  'parses the literal macOS requirement and rejects a different signer',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-signature-'))
    directories.push(directory)
    const binary = join(directory, 'helper')
    await copyFile('/usr/bin/true', binary)
    expect(spawnSync('codesign', ['--force', '--sign', '-', binary]).status).toBe(0)
    verifyNativeSignatures(
      '/unused',
      `darwin-${process.arch}`,
      (command: string, args: string[]) => {
        // An ad-hoc fixture has a valid signature but must fail our Developer ID requirement.
        const result = spawnSync(command, [...args.slice(0, -1), binary], {
          encoding: 'utf8'
        })
        expect(result.error).toBeUndefined()
        expect(result.stderr).not.toContain('invalid requirement specification')
        expect(result.status).toBe(args.includes('-R') ? 3 : 0)
      }
    )
  }
)
it('keeps dry-run compilation on the same producer without signing or publishing', async () => {
  const workflow = load(
    await readFile('.github/workflows/native-components.yml', 'utf8')
  ) as Workflow
  expect(workflow.on.workflow_call.inputs.dry_run.default).toBe(true)
  const job = workflow.jobs.build
  expect(job.strategy.matrix.include.map((entry) => entry.target).sort()).toEqual(
    [...spec.targets].sort()
  )
  expect(job.steps.find((s) => s.name === 'Install producer dependencies only').run).toContain(
    '--ignore-scripts'
  )
  for (const name of [
    'Prepare macOS signing keychain',
    'Sign macOS components with stable identifiers',
    'Azure login',
    'Sign Windows components',
    'Publish immutable native components'
  ])
    expect(job.steps.find((s) => s.name === name).if).toContain('!inputs.dry_run')
  expect(job.steps.find((s) => s.name === 'Record verified artifacts').run).toContain('--dry-run')
})

it('verifies both packaged copies and rejects a byte changed by a later signing pass', async () => {
  const { directory, catalog } = await fixture()
  catalog['linux-x64'].source = await sourceFingerprint()
  for (const base of ['backend', 'app.asar.unpacked'])
    for (const file of catalog['linux-x64'].files) {
      const output = join(directory, base, 'node_modules/@aipoch', file.package, 'build/Release')
      await mkdir(output, { recursive: true })
      await writeFile(join(output, file.name), file.name)
    }
  expect((await verifyPackagedNativeComponents(directory, 'linux-x64', catalog)).size).toBe(10)
  await writeFile(
    join(
      directory,
      'backend/node_modules/@aipoch/credential-identity-probe-native/build/Release/credential_secret'
    ),
    'changed-signature'
  )
  await expect(verifyPackagedNativeComponents(directory, 'linux-x64', catalog)).rejects.toThrow()
})
it('publishes only verified files with an atomic create-only S3 condition', async () => {
  const { directory, catalog } = await fixture()
  const release = catalog['linux-x64']
  for (const file of release.files) await writeFile(join(directory, file.name), file.name)
  const invoke = vi.fn((_command: string, args: string[]) =>
    args[1] === 'head-object' ? { status: 1, stderr: '(404)' } : { status: 0 }
  )
  await publishNativeFiles(directory, release, { S3_BUCKET: 'fixture' }, invoke)
  expect(invoke).toHaveBeenCalledTimes(10)
  const put = invoke.mock.calls.filter((call) => call[1][1] === 'put-object')
  for (const [, args] of put) {
    expect(args).toContain('--if-none-match')
    expect(args[args.indexOf('--if-none-match') + 1]).toBe('*')
    expect(args).toContain('--checksum-sha256')
  }
  const failure = vi.fn(() => ({ status: 1, stderr: '(403)' }))
  await expect(
    publishNativeFiles(directory, release, { S3_BUCKET: 'fixture' }, failure)
  ).rejects.toThrow('Cannot inspect')
  expect(failure).toHaveBeenCalledTimes(1)
  await writeFile(join(directory, release.files[0].name), 'tampered')
  invoke.mockClear()
  await expect(
    publishNativeFiles(directory, release, { S3_BUCKET: 'fixture' }, invoke)
  ).rejects.toThrow()
  expect(invoke).not.toHaveBeenCalled()
})
it('reuses matching immutable objects and refuses an existing object with different bytes', async () => {
  const { directory, catalog } = await fixture()
  const release = catalog['linux-x64']
  for (const file of release.files) await writeFile(join(directory, file.name), file.name)
  const invoke = vi.fn((_command: string, args: string[]) => {
    const file = release.files.find((f) => args.includes(new URL(f.url).pathname.slice(1)))!
    return {
      status: 0,
      stdout: JSON.stringify({
        ContentLength: file.size,
        ChecksumSHA256: Buffer.from(file.sha256, 'hex').toString('base64')
      })
    }
  })
  await publishNativeFiles(directory, release, { S3_BUCKET: 'fixture' }, invoke)
  expect(invoke).toHaveBeenCalledTimes(5)
  await expect(
    publishNativeFiles(directory, release, { S3_BUCKET: 'fixture' }, () => ({
      status: 0,
      stdout: '{}'
    }))
  ).rejects.toThrow('differs')
})
it('routes normal builds and installation to staging, preserving component signatures', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  expect(pkg.scripts['build:backend-native']).toBe('node scripts/native-components.mjs')
  expect(pkg.scripts.postinstall).toContain('node scripts/install-native-components.mjs')
  expect(pkg.scripts.postinstall).not.toContain('install-app-deps')
  for (const name of Object.keys(spec.packages)) {
    const native = JSON.parse(await readFile(`packages/${name}/package.json`, 'utf8'))
    expect(native.gypfile).toBe(false)
    expect(native.scripts.install).toBeUndefined()
  }
  expect(await readFile('build/stage-desktop-runtime.cjs', 'utf8')).not.toContain('node-gyp')
  const config = load(await readFile('electron-builder.yml', 'utf8')) as {
    mac: { signIgnore: string[] }
    win: { signExts: string[] }
  }
  for (const file of nativeFiles('darwin-arm64')) {
    const path = `/fixture/Contents/Resources/backend/node_modules/@aipoch/${file.package}/build/Release/${file.name}`
    expect(config.mac.signIgnore.some((pattern) => new RegExp(pattern).test(path))).toBe(true)
  }
  expect(config.win.signExts).toEqual([
    '!credential_identity_probe.exe',
    '!credential_key_validator.exe',
    '!credential_secret.exe'
  ])
})

it('the installed Electron rebuilder skips linked first-party gyp sources', async () => {
  const { directory } = await fixture()
  const dependencies = Object.fromEntries(
    Object.keys(spec.packages).map((name) => [`@aipoch/${name}`, `file:packages/${name}`])
  )
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'native-fixture', version: '1.0.0', dependencies })
  )
  await mkdir(join(directory, 'node_modules/@aipoch'), { recursive: true })
  for (const name of Object.keys(spec.packages)) {
    const source = join(directory, 'packages', name)
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({ name: `@aipoch/${name}`, version: '1.0.0' })
    )
    // Deliberately invalid: any attempted gyp rebuild must fail this test.
    await writeFile(join(source, 'binding.gyp'), 'invalid-gyp-must-not-run')
    await symlink(source, join(directory, 'node_modules/@aipoch', name), 'junction')
  }
  await expect(rebuildElectronDependencies(directory)).resolves.toBeUndefined()
})
