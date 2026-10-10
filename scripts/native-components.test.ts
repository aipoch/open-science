import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { load } from 'js-yaml'
import {
  digest,
  nativeFiles,
  sourceFingerprint,
  spec,
  stageNativeComponents,
  validateNativeRelease
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
