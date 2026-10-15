import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeRevision, type StaticImpactReport } from '../dist/index.js'
import { withSourceSnapshot } from './snapshot.js'

const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture(): {
  root: string
  write: (file: string, text: string) => void
  git: (...args: string[]) => string
} {
  const root = mkdtempSync(join(tmpdir(), 'impact-fixture-'))
  temporary.push(root)
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
      }
    }).trim()
  git('init', '--quiet')
  git('config', 'core.autocrlf', 'false')
  const write = (file: string, text: string): void => {
    const target = join(root, file)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, text)
  }
  return { root, write, git }
}

it('analyzes immutable blobs with trusted aliases while retaining unresolved and opaque limitations', async () => {
  const { root, write, git } = fixture()
  const marker = join(root, 'executed')
  const trap = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');throw Error('candidate executed')`
  write('package.json', JSON.stringify({ scripts: { postinstall: 'node poison.mjs' } }))
  write('registry.json', JSON.stringify({ packages: [{ root: 'packages/example' }] }))
  write(
    'packages/example/package.json',
    JSON.stringify({ name: '@fixture/example', exports: { '.': { default: './dist/index.js' } } })
  )
  write('packages/example/src/index.ts', 'export const value = 1')
  write(
    'entry.ts',
    `import './local.js'; import '@fixture/example'; import '@alias/雪 space'; import './asset.svg'; import 'uninstalled'; import './missing'; const load = (name: string) => import(name)`
  )
  write('local.ts', 'export const local = 1\r\n')
  write('雪 space.ts', 'export const unicode = 1')
  write('asset.svg', '<svg/>')
  write('poison.mjs', trap)
  write('.dependency-cruiser.mjs', trap)
  write('vite.config.ts', trap)
  write(
    'tsconfig.json',
    JSON.stringify({
      extends: '../outside.json',
      compilerOptions: { paths: { '@fixture/example': ['missing'] } }
    })
  )
  git('add', '.')
  git('commit', '--quiet', '-m', 'test(snapshot): add fixture')
  const revision = git('rev-parse', 'HEAD')
  write('entry.ts', "import './dirty'")
  write('node_modules/uninstalled/index.js', trap)
  const report = await analyzeRevision({
    repository: root,
    revision,
    configuration: { packageRegistry: 'registry.json', sourcePaths: { '@alias/*': ['*'] } }
  })
  expect(report.revision).toBe(revision)
  expect(report.canPruneTests).toBe(false)
  expect(report.purpose).toBe('diagnostic')
  expect(report.sourcePaths).toEqual({
    '@fixture/example': ['packages/example/src/index.ts'],
    '@alias/*': ['*']
  })
  expect(report.limitations.join(' ')).toContain('Computed and escaped loaders')
  expect(report.files.find((file) => file.path === 'entry.ts')).toEqual({
    path: 'entry.ts',
    dependencies: ['asset.svg', 'local.ts', 'packages/example/src/index.ts', '雪 space.ts'],
    unresolved: ['./missing', 'uninstalled']
  })
  expect(existsSync(marker)).toBe(false)
  let removed = ''
  await withSourceSnapshot(root, revision, async (snapshot) => {
    removed = snapshot.parent
    expect(readFileSync(join(snapshot.root, 'local.ts'), 'utf8')).toBe('export const local = 1\r\n')
  })
  expect(existsSync(removed)).toBe(false)
})

it('keeps runtime implementations and declarations, mocks and require.resolve edges', async () => {
  const { root, write, git } = fixture()
  write(
    'entry.ts',
    "import type { Value } from './value.mjs'; vi.mock('./mock'); jest.mock('./jest'); require.resolve('./required')"
  )
  write('value.mjs', 'export const value = 1')
  write('value.d.mts', 'export interface Value { value: number }')
  for (const name of ['mock', 'jest', 'required']) write(`${name}.ts`, 'export const value = 1')
  git('add', '.')
  git('commit', '--quiet', '-m', 'test(snapshot): add declaration fixture')
  const report = await analyzeRevision({ repository: root, revision: 'HEAD' })
  expect(report.files.find((file) => file.path === 'entry.ts')?.dependencies).toEqual([
    'jest.ts',
    'mock.ts',
    'required.ts',
    'value.d.mts',
    'value.mjs'
  ])
})

it('rejects outside targets and ignores inherited loaders without masking unresolved dependencies', async () => {
  const { root, write, git } = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'impact-outside-'))
  temporary.push(outside)
  const marker = join(outside, 'executed'),
    target = join(outside, 'outside.ts')
  writeFileSync(target, 'export const outside = 1')
  write('entry.ts', `import ${JSON.stringify(target)}; import '../outside'; import 'pollution'`)
  write(
    'poison.mjs',
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed')`
  )
  git('add', '.')
  git('commit', '--quiet', '-m', 'test(snapshot): add escape fixture')
  const previous = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = `--import=${join(root, 'poison.mjs')}`
  try {
    const report = await analyzeRevision({ repository: root, revision: 'HEAD' })
    expect(report.files.find((file) => file.path === 'entry.ts')?.dependencies).toEqual([])
    expect(report.files.find((file) => file.path === 'entry.ts')?.unresolved).toEqual(
      expect.arrayContaining([target, '../outside', 'pollution'])
    )
    expect(existsSync(marker)).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previous
  }
})

it('observes new commits and cleans snapshots after failed operations', async () => {
  const { root, write, git } = fixture()
  write('entry.ts', "import './a'")
  write('a.ts', 'export const a = 1')
  write('b.ts', 'export const b = 1')
  git('add', '.')
  git('commit', '--quiet', '-m', 'test(snapshot): add first revision')
  const first = await analyzeRevision({ repository: root, revision: 'HEAD' })
  write('entry.ts', "import './b'")
  git('add', '.')
  git('commit', '--quiet', '-m', 'test(snapshot): change edge')
  const second = await analyzeRevision({ repository: root, revision: 'HEAD' })
  expect(first.revision).not.toBe(second.revision)
  expect(second.files.find((file) => file.path === 'entry.ts')?.dependencies).toEqual(['b.ts'])
  let removed = ''
  await expect(
    withSourceSnapshot(root, 'HEAD', async (snapshot) => {
      removed = snapshot.parent
      throw new Error('expected failure')
    })
  ).rejects.toThrow('expected failure')
  expect(existsSync(removed)).toBe(false)
  await expect(
    analyzeRevision({ repository: root, revision: '--invalid-option' })
  ).rejects.toThrow()
})

it('rejects symlinks and gitlinks before analyzing candidate files', async () => {
  const { root, write, git } = fixture()
  write('entry.ts', 'export const value = 1')
  git('add', '.')
  git('commit', '--quiet', '-m', 'test(snapshot): add base')
  const first = git('rev-parse', 'HEAD')
  const blob = git('hash-object', '-w', '--stdin')
  git('update-index', '--add', '--cacheinfo', `120000,${blob},link`)
  git('commit', '--quiet', '-m', 'test(snapshot): add symlink')
  await expect(analyzeRevision({ repository: root, revision: 'HEAD' })).rejects.toThrow(
    'Unsupported snapshot entry'
  )
  git('update-index', '--force-remove', 'link')
  git('update-index', '--add', '--cacheinfo', `160000,${first},submodule`)
  git('commit', '--quiet', '-m', 'test(snapshot): add gitlink')
  await expect(analyzeRevision({ repository: root, revision: 'HEAD' })).rejects.toThrow(
    'Unsupported snapshot entry'
  )
})

it('runs the compiled CLI and fails invalid arguments without successful JSON output', () => {
  const { root, write, git } = fixture()
  write('entry.ts', "import './local'")
  write('local.ts', 'export const value = 1')
  git('add', '.')
  git('commit', '--quiet', '-m', 'test(snapshot): add CLI fixture')
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
  const output = execFileSync(process.execPath, [cli, '--repository', root, '--revision', 'HEAD'], {
    encoding: 'utf8'
  })
  expect(
    (JSON.parse(output) as StaticImpactReport).files.find((file) => file.path === 'entry.ts')
      ?.dependencies
  ).toEqual(['local.ts'])
  expect(() => execFileSync(process.execPath, [cli, '--unknown'], { stdio: 'pipe' })).toThrow()
  expect(() => execFileSync(process.execPath, [cli], { stdio: 'pipe' })).toThrow()
})
