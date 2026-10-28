import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import { prepareGitSnapshot } from './prepare-git-snapshot.mjs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(files: Record<string, string> = {}): Promise<{
  root: string
  repo: string
  commit: string
  options: { repository: string; commit: string; sourceUrl: string; outputDirectory: string }
  git: (args: string[]) => string
}> {
  const root = await mkdtemp(join(tmpdir(), 'research-source-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init'])
  for (const [path, value] of Object.entries({
    'package.json': '{"version":"1.0.0"}\n',
    ...files
  })) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), value)
  }
  git(['add', '.'])
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'fixture'
  ])
  const commit = git(['rev-parse', 'HEAD']).trim()
  return {
    root,
    repo,
    commit,
    git,
    options: {
      repository: repo,
      commit,
      sourceUrl: 'https://example.invalid/source',
      outputDirectory: join(root, 'snapshot')
    }
  }
}

function tarFiles(payload: Buffer): Map<string, { body: Buffer; mode: number }> {
  const tar = gunzipSync(payload)
  const files = new Map<string, { body: Buffer; mode: number }>()
  for (let offset = 0; tar[offset];) {
    const header = tar.subarray(offset, offset + 512)
    const string = (start: number, end: number): string =>
      header.subarray(start, end).toString('utf8').replace(/\0.*$/su, '')
    const name = [string(345, 500), string(0, 100)].filter(Boolean).join('/')
    const size = parseInt(string(124, 136), 8)
    expect(string(257, 263)).toBe('ustar')
    expect(string(156, 157)).toBe('0')
    files.set(name, {
      body: tar.subarray(offset + 512, offset + 512 + size),
      mode: parseInt(string(100, 108), 8)
    })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

describe('fixed Git source publication snapshots', () => {
  it('reads fixed committed bytes, excludes environment/local data, and never executes project code', async () => {
    const f = await fixture({
      '.env': 'FIXTURE_SECRET=not-a-real-credential',
      '.env.example': 'FIXTURE_TEMPLATE=',
      '.envrc': 'DIR_ENV_FIXTURE=not-a-real-credential',
      'nested/.env-production': 'HYPHEN_ENV_FIXTURE=not-a-real-credential',
      'nested/.env.local': 'nested fixture',
      'nested/.ENV.production': 'mixed-case environment fixture',
      'reports/private.json': 'private fixture',
      'node_modules/local/index.js': 'ignored fixture',
      'source/main.mjs': 'throw new Error("Project code must not execute")',
      LICENSE: 'Fixture license'
    })
    await writeFile(join(f.repo, 'package.json'), 'uncommitted content')
    await writeFile(join(f.repo, '.env'), 'WORKTREE_CONTENT_MUST_NOT_BE_READ')
    await writeFile(join(f.repo, 'untracked.txt'), 'untracked')
    const before = f.git(['status', '--porcelain'])
    const manifest = await prepareGitSnapshot(f.options)
    const files = tarFiles(await readFile(join(f.options.outputDirectory, 'source.tar.gz')))
    expect([...files.keys()]).toEqual([
      'project/LICENSE',
      'project/package.json',
      'project/source/main.mjs'
    ])
    expect(files.get('project/package.json')?.body.toString()).toBe('{"version":"1.0.0"}\n')
    expect(manifest.exclusions.files).toHaveLength(8)
    expect(manifest.licenseEvidence).toHaveLength(1)
    for (const entry of manifest.files) {
      const content = files.get(`project/${entry.path}`)!.body
      expect(content.length).toBe(entry.sizeBytes)
      expect(createHash('sha256').update(content).digest('hex')).toBe(entry.sha256)
    }
    expect(f.git(['status', '--porcelain'])).toBe(before)
  })

  it('produces identical artifacts for a fixed commit and scope', async () => {
    const f = await fixture({ 'source/example.txt': 'fixed\n' })
    const first = await prepareGitSnapshot(f.options)
    const secondDir = join(f.root, 'second')
    const second = await prepareGitSnapshot({ ...f.options, outputDirectory: secondDir })
    expect(second).toEqual(first)
    expect(await readFile(join(secondDir, 'source.tar.gz'))).toEqual(
      await readFile(join(f.options.outputDirectory, 'source.tar.gz'))
    )
  })

  it('retains executable Git modes without consulting working-tree file modes', async () => {
    const f = await fixture({ 'bin/entry.mjs': '#!/usr/bin/env node\n' })
    f.git(['update-index', '--chmod=+x', 'bin/entry.mjs'])
    f.git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'executable'
    ])
    await chmod(join(f.repo, 'bin/entry.mjs'), 0o600)
    const manifest = await prepareGitSnapshot({
      ...f.options,
      commit: f.git(['rev-parse', 'HEAD']).trim()
    })
    expect(manifest.files.find((entry) => entry.path === 'bin/entry.mjs')?.mode).toBe('100755')
    expect(
      tarFiles(await readFile(join(f.options.outputDirectory, 'source.tar.gz'))).get(
        'project/bin/entry.mjs'
      )?.mode
    ).toBe(0o755)
  })

  it('refuses to overwrite a destination or write inside the source tree', async () => {
    const f = await fixture()
    await mkdir(f.options.outputDirectory)
    await writeFile(join(f.options.outputDirectory, 'sentinel'), 'preserve')
    await expect(prepareGitSnapshot(f.options)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(f.options.outputDirectory, 'sentinel'), 'utf8')).toBe('preserve')
    await expect(
      prepareGitSnapshot({ ...f.options, outputDirectory: join(f.repo, 'nested/new') })
    ).rejects.toThrow('outside')
    await expect(readFile(join(f.repo, 'nested/new/source.tar.gz'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await mkdir(join(f.repo, 'subdirectory'))
    await expect(
      prepareGitSnapshot({
        ...f.options,
        repository: join(f.repo, 'subdirectory'),
        outputDirectory: join(f.repo, 'sibling-snapshot')
      })
    ).rejects.toThrow('outside')
  })

  it('rejects moving refs, secret-bearing URLs, unsafe paths, and symlink Git objects', async () => {
    const f = await fixture()
    await expect(prepareGitSnapshot({ ...f.options, commit: 'HEAD' })).rejects.toThrow(
      'full lowercase'
    )
    await expect(
      prepareGitSnapshot({ ...f.options, sourceUrl: 'https://token@example.invalid/repo' })
    ).rejects.toThrow('without credentials')
    await expect(
      prepareGitSnapshot({ ...f.options, excludePaths: ['../outside'] })
    ).rejects.toThrow('Non-portable')
    // Write a symbolic-link object through the index, without following or reading its target.
    const object = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: f.repo,
      input: '/private/fixture\n',
      encoding: 'utf8'
    }).trim()
    f.git(['update-index', '--add', '--cacheinfo', `120000,${object},unsafe-link`])
    f.git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'link'
    ])
    await expect(
      prepareGitSnapshot({ ...f.options, commit: f.git(['rev-parse', 'HEAD']).trim() })
    ).rejects.toThrow('links and submodules')
  })

  it('checks a symlinked output parent before creating directories', async () => {
    const f = await fixture()
    await symlink(f.repo, join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(
      prepareGitSnapshot({ ...f.options, outputDirectory: join(f.root, 'alias/new/snapshot') })
    ).rejects.toThrow('outside')
    expect(f.git(['status', '--porcelain'])).toBe('')
  })

  it('rejects unmaterialized submodules and case-colliding committed paths', async () => {
    const f = await fixture()
    f.git(['update-index', '--add', '--cacheinfo', `160000,${f.commit},dependency`])
    f.git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'submodule'
    ])
    await expect(
      prepareGitSnapshot({ ...f.options, commit: f.git(['rev-parse', 'HEAD']).trim() })
    ).rejects.toThrow('links and submodules')
    f.git(['update-index', '--force-remove', 'dependency'])
    const object = f.git(['rev-parse', `${f.commit}:package.json`]).trim()
    f.git(['update-index', '--add', '--cacheinfo', `100644,${object},PACKAGE.json`])
    f.git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'case collision'
    ])
    await expect(
      prepareGitSnapshot({ ...f.options, commit: f.git(['rev-parse', 'HEAD']).trim() })
    ).rejects.toThrow('Case-colliding')
  })

  it('records explicit disclosure exclusions and supports long Unicode archive paths', async () => {
    const path = `${'segment/'.repeat(15)}研究.txt`
    const f = await fixture({ [path]: 'portable bytes', 'private/example.txt': 'exclude me' })
    const manifest = await prepareGitSnapshot({ ...f.options, excludePaths: ['private'] })
    expect(manifest.exclusions.files).toEqual([
      { path: 'private/example.txt', reason: 'explicit-exclusion' }
    ])
    expect(
      tarFiles(await readFile(join(f.options.outputDirectory, 'source.tar.gz')))
        .get(`project/${path}`)
        ?.body.toString()
    ).toBe('portable bytes')
  })

  it('rejects case collisions in implicit parent directories', async () => {
    const f = await fixture()
    const object = f.git(['rev-parse', `${f.commit}:package.json`]).trim()
    for (const path of ['a/one.txt', 'A/two.txt']) {
      f.git([
        '-c',
        'core.ignorecase=false',
        'update-index',
        '--add',
        '--cacheinfo',
        `100644,${object},${path}`
      ])
    }
    f.git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'directory collision'
    ])
    await expect(
      prepareGitSnapshot({ ...f.options, commit: f.git(['rev-parse', 'HEAD']).trim() })
    ).rejects.toThrow('Case-colliding')
  })

  it.each(['COM¹.txt', 'LPT²', 'COM³'])(
    'rejects Windows reserved superscript device name %s',
    async (path) => {
      const f = await fixture({ [path]: 'device-name fixture' })
      await expect(prepareGitSnapshot(f.options)).rejects.toThrow('Non-portable')
    }
  )

  it('fails on missing promisor blobs instead of fetching them from a remote', async () => {
    const f = await fixture({ 'source/large.txt': 'source fixture\n'.repeat(1000) })
    f.git(['config', 'uploadpack.allowFilter', 'true'])
    const partial = join(f.root, 'partial')
    execFileSync(
      'git',
      ['clone', '--filter=blob:none', '--no-checkout', pathToFileURL(f.repo).href, partial],
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    await expect(prepareGitSnapshot({ ...f.options, repository: partial })).rejects.toThrow()
    await expect(readFile(join(f.options.outputDirectory, 'source.tar.gz'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    // With fetching disabled, the original missing blob must still be missing after preparation.
    const blob = f.git(['rev-parse', `${f.commit}:source/large.txt`]).trim()
    expect(() =>
      execFileSync('git', ['-C', partial, 'cat-file', '-e', blob], {
        env: {
          ...process.env,
          GIT_NO_LAZY_FETCH: '1',
          GIT_ALLOW_PROTOCOL: '',
          GIT_TERMINAL_PROMPT: '0'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    ).toThrow()
  })
})
