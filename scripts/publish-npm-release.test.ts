import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  assertReleasePublisher,
  collectPackages,
  publishPlan,
  publishPackages,
  publishTarball,
  waitForPublished,
  releaseSource,
  VISIBILITY_ATTEMPTS,
  VISIBILITY_INTERVAL_MS
} from './publish-npm-release.mjs'
import { releaseManifests } from './stage-npm-release.mjs'
import { runtimeTargets, runtimePackageName } from '../packages/open-science/runtime-package.mjs'
import { isMachO } from './verify-runtime-signatures.mjs'

it('checks actual tarballs, a complete target set, source identity and identical entry bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'npm-publication-'))
  const sha = 'a'.repeat(40)
  const version = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ).version
  try {
    for (const target of runtimeTargets) {
      const folder = join(root, `npm-${target.id}`)
      await mkdir(join(folder, 'package'), { recursive: true })
      const manifests = releaseManifests(
        { name: '@aipoch/open-science' },
        {
          version,
          os: [target.os],
          cpu: [target.cpu]
        },
        target
      )
      const packages = []
      for (const [name, manifest] of Object.entries(manifests)) {
        await writeFile(join(folder, 'package/package.json'), JSON.stringify(manifest))
        const filename = `${name}.tgz`
        // Copy the same entry tarball to every target to avoid timestamp-dependent test bytes.
        if (name === 'main' && target !== runtimeTargets[0]) {
          await writeFile(
            join(folder, filename),
            await readFile(join(root, `npm-${runtimeTargets[0].id}`, filename))
          )
        } else execFileSync('tar', ['-czf', join(folder, filename), '-C', folder, 'package'])
        const integrity = `sha512-${createHash('sha512')
          .update(await readFile(join(folder, filename)))
          .digest('base64')}`
        packages.push({ filename, manifest, integrity })
      }
      await writeFile(
        join(folder, `${target.id}.json`),
        JSON.stringify({ sourceSha: sha, target: target.id, packages })
      )
    }
    const packages = await collectPackages(root, version, sha)
    expect(packages).toHaveLength(6)
    expect(packages.at(-1)?.manifest.name).toBe('@aipoch/open-science')
    // Build-time complete-set verification must not contact npm or start npm publish.
    execFileSync(
      process.execPath,
      [
        '--import',
        'data:text/javascript,globalThis.fetch=()=>{throw new Error("unexpected network")}',
        fileURLToPath(new URL('./publish-npm-release.mjs', import.meta.url)),
        root,
        '--dry-run'
      ],
      {
        env: {
          ...process.env,
          GITHUB_SHA: sha,
          GITHUB_REF: 'refs/heads/test',
          npm_execpath: join(root, 'missing-npm.cjs')
        },
        stdio: 'pipe'
      }
    )
    await expect(collectPackages(root, version, 'b'.repeat(40))).rejects.toThrow('source commit')
    await expect(collectPackages(root, '1.2.4', sha)).rejects.toThrow()
    const target = runtimeTargets[0]
    const reportPath = join(root, `npm-${target.id}`, `${target.id}.json`)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    report.packages[0].manifest.version = '9.9.9'
    await writeFile(reportPath, JSON.stringify(report))
    await expect(collectPackages(root, version, sha)).rejects.toThrow()
    await rm(reportPath)
    await expect(collectPackages(root, version, sha)).rejects.toThrow(
      'Missing verified npm artifact'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it('resumes only missing versions and rejects conflicting bytes or a latest downgrade', async () => {
  const packages = ['native', 'main'].map((name) => ({
    manifest: { name, version: '1.2.3' },
    integrity: name
  }))
  const plan = await publishPlan(packages, async (name) =>
    name === 'native' ? { versions: { '1.2.3': { dist: { integrity: name } } } } : null
  )
  expect(plan.map((item) => item.published)).toEqual([true, false])
  await expect(
    publishPlan(packages, async () => ({ versions: { '1.2.3': { dist: { integrity: 'other' } } } }))
  ).rejects.toThrow('Published bytes differ')
  await expect(
    publishPlan(packages, async () => ({ 'dist-tags': { latest: '1.3.0' } }))
  ).rejects.toThrow('downgrade')
  await expect(
    publishPlan(packages, async () => {
      throw new Error('registry unavailable')
    })
  ).rejects.toThrow('registry unavailable')
})
it('recognizes executable formats without relying on filename extensions', () => {
  expect(isMachO(Buffer.from('cffaedfe00000000', 'hex'))).toBe(true)
  expect(isMachO(Buffer.from('cafebabe00000000', 'hex'))).toBe(true)
  expect(isMachO(Buffer.from('not an executable'))).toBe(false)
})

describe('certified historical Release source', () => {
  const sha = 'a'.repeat(40)
  function responses(): Record<string, unknown> {
    return {
      'actions/runs/42': {
        id: 42,
        path: '.github/workflows/release.yml',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        repository: { full_name: 'aipoch/open-science' },
        head_repository: { full_name: 'aipoch/open-science' },
        head_branch: 'v1.0.1',
        head_sha: sha
      },
      'releases/tags/v1.0.1': {
        tag_name: 'v1.0.1',
        draft: false,
        prerelease: false,
        published_at: '2026-10-20T12:20:57Z'
      },
      'commits/v1.0.1': { sha },
      [`compare/${sha}...main`]: { status: 'ahead' },
      [`contents/package.json?ref=${sha}`]: {
        encoding: 'base64',
        content: Buffer.from('{"version":"1.0.1"}').toString('base64')
      }
    }
  }
  it('resolves the certified tag SHA rather than the publishing workflow revision', async () => {
    const data = responses()
    expect(await releaseSource('42', async (path: string) => data[path])).toEqual({
      version: '1.0.1',
      sourceSha: sha,
      tag: 'v1.0.1'
    })
  })
  it.each([
    ['actions/runs/42', { id: 43 }],
    ['actions/runs/42', { path: '.github/workflows/nightly.yml' }],
    ['actions/runs/42', { event: 'workflow_dispatch' }],
    ['actions/runs/42', { status: 'in_progress' }],
    ['actions/runs/42', { conclusion: 'failure' }],
    ['actions/runs/42', { head_branch: 'v1.0.1-beta.1' }],
    ['actions/runs/42', { head_branch: 'main' }],
    ['actions/runs/42', { repository: { full_name: 'fork/open-science' } }],
    ['actions/runs/42', { head_repository: { full_name: 'fork/open-science' } }],
    ['releases/tags/v1.0.1', { draft: true }],
    ['releases/tags/v1.0.1', { prerelease: true }],
    ['releases/tags/v1.0.1', { published_at: null }],
    ['commits/v1.0.1', { sha: 'b'.repeat(40) }],
    [`compare/${sha}...main`, { status: 'diverged' }],
    [`compare/${sha}...main`, { status: 'behind' }],
    [
      `contents/package.json?ref=${sha}`,
      { content: Buffer.from('{"version":"1.0.2"}').toString('base64') }
    ]
  ])('rejects uncertified source %s %j', async (path, overrides) => {
    const data = responses()
    data[path] = { ...Object(data[path]), ...overrides }
    await expect(releaseSource('42', async (key: string) => data[key])).rejects.toThrow()
  })
  it('accepts a cancelled run whose publish job certified the release', async () => {
    const data = responses()
    data['actions/runs/42'] = { ...Object(data['actions/runs/42']), conclusion: 'cancelled' }
    data['actions/runs/42/jobs?per_page=100'] = {
      jobs: [{ name: 'publish', conclusion: 'success' }]
    }
    expect(await releaseSource('42', async (path: string) => data[path])).toEqual({
      version: '1.0.1',
      sourceSha: sha,
      tag: 'v1.0.1'
    })
  })
  it.each([[undefined], [{ jobs: [] }], [{ jobs: [{ name: 'publish', conclusion: 'failure' }] }]])(
    'rejects a cancelled run without certified publish job %j',
    async (jobs) => {
      const data = responses()
      data['actions/runs/42'] = { ...Object(data['actions/runs/42']), conclusion: 'cancelled' }
      if (jobs !== undefined) data['actions/runs/42/jobs?per_page=100'] = jobs
      await expect(releaseSource('42', async (path: string) => data[path])).rejects.toThrow()
    }
  )
  it('fails closed on malformed inputs and unavailable GitHub evidence', async () => {
    for (const runId of ['', '../42', '42\n', '0']) {
      await expect(releaseSource(runId, async () => null)).rejects.toThrow()
    }
    await expect(
      releaseSource('42', async () => {
        throw new Error('GitHub unavailable')
      })
    ).rejects.toThrow('GitHub unavailable')
  })
  it('only authorizes registry writes through the main npm workflow', () => {
    const env = {
      GITHUB_REPOSITORY: 'aipoch/open-science',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKFLOW_REF: 'aipoch/open-science/.github/workflows/npm-release.yml@refs/heads/main'
    }
    expect(() => assertReleasePublisher(env)).not.toThrow()
    expect(() =>
      assertReleasePublisher({ ...env, GITHUB_EVENT_NAME: 'workflow_run' })
    ).not.toThrow()
    for (const overrides of [
      { GITHUB_REPOSITORY: 'fork/open-science' },
      { GITHUB_EVENT_NAME: 'pull_request' },
      { GITHUB_REF: 'refs/heads/ci/npm-trusted-publishing' },
      { GITHUB_WORKFLOW_REF: 'aipoch/open-science/.github/workflows/release.yml@refs/heads/main' }
    ])
      expect(() => assertReleasePublisher({ ...env, ...overrides })).toThrow()
  })
})

describe('parallel platform publication', () => {
  const packages = [...runtimeTargets.map(runtimePackageName), '@aipoch/open-science'].map(
    (name) => ({
      manifest: { name, version: '1.2.3' },
      integrity: name,
      path: `${name}.tgz`
    })
  )
  const published = (
    pkg: (typeof packages)[number]
  ): { versions: Record<string, { dist: { integrity: string } }> } => ({
    versions: { '1.2.3': { dist: { integrity: pkg.integrity } } }
  })

  it('starts all platforms concurrently and waits for registry visibility before the entry', async () => {
    const registry = new Map()
    const finish = new Map<string, () => void>()
    const uploads = vi.fn(async (pkg: (typeof packages)[number]) => {
      if (pkg.manifest.name === packages.at(-1)?.manifest.name) {
        expect(registry.size).toBe(5)
        registry.set(pkg.manifest.name, published(pkg))
        return
      }
      await new Promise<void>((resolve) => finish.set(pkg.manifest.name, resolve))
    })
    const lookup = vi.fn(async (name: string) => registry.get(name))
    const delay = vi.fn(async () => {
      for (const pkg of packages.slice(0, -1)) registry.set(pkg.manifest.name, published(pkg))
    })
    const result = publishPackages(packages, lookup, uploads, delay)
    await vi.waitFor(() => expect(finish.size).toBe(5))
    expect(uploads).toHaveBeenCalledTimes(5)
    for (const resolve of finish.values()) resolve()
    await result
    expect(delay).toHaveBeenCalled()
    expect(uploads).toHaveBeenLastCalledWith(expect.objectContaining(packages.at(-1)))
  })

  it('waits for siblings and reports every failure without publishing the entry', async () => {
    const finish: Array<() => void> = []
    const registry = new Map()
    const uploads = vi.fn(async (pkg: (typeof packages)[number]) => {
      if (pkg.manifest.name === packages[0].manifest.name) throw new Error('ENEEDAUTH')
      if (pkg.manifest.name === packages[1].manifest.name) throw new Error('network failure')
      await new Promise<void>((resolve) => finish.push(resolve))
      registry.set(pkg.manifest.name, published(pkg))
    })
    let settled = false
    const result = publishPackages(
      packages,
      async (name: string) => registry.get(name),
      uploads,
      async () => {}
    )
      .catch((error: AggregateError) => error)
      .finally(() => {
        settled = true
      })
    await vi.waitFor(() => expect(finish).toHaveLength(3))
    expect(settled).toBe(false)
    for (const resolve of finish) resolve()
    const error = await result
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
    expect((error as Error).message).toContain('ENEEDAUTH')
    expect((error as Error).message).toContain('network failure')
    expect(uploads).toHaveBeenCalledTimes(5)
  })

  it('checks every package before writes and rejects malformed sets', async () => {
    const uploads = vi.fn()
    await expect(
      publishPackages(
        packages,
        async (name: string) => {
          if (name === packages.at(-1)?.manifest.name) throw new Error('registry unavailable')
          return null
        },
        uploads
      )
    ).rejects.toThrow('registry unavailable')
    expect(uploads).not.toHaveBeenCalled()
    await expect(publishPackages(packages.slice(1), async () => null, uploads)).rejects.toThrow()
    expect(uploads).not.toHaveBeenCalled()
  })

  it('retries only missing immutable versions and skips a fully published batch', async () => {
    const registry = new Map(packages.slice(0, 2).map((pkg) => [pkg.manifest.name, published(pkg)]))
    const uploads = vi.fn(async (pkg: (typeof packages)[number]) => {
      registry.set(pkg.manifest.name, published(pkg))
    })
    const lookup = async (name: string): Promise<ReturnType<typeof published> | undefined> =>
      registry.get(name)
    await publishPackages(packages, lookup, uploads)
    expect(uploads.mock.calls.map(([pkg]) => pkg.manifest.name)).toEqual(
      packages.slice(2).map((pkg) => pkg.manifest.name)
    )
    uploads.mockClear()
    await publishPackages(packages, lookup, uploads)
    expect(uploads).not.toHaveBeenCalled()
  })

  it('blocks the entry if uploads succeed but registry versions never appear', async () => {
    const uploads = vi.fn(async () => {})
    await expect(
      publishPackages(
        packages,
        async () => null,
        uploads,
        async () => {}
      )
    ).rejects.toThrow('entry package blocked')
    expect(uploads).toHaveBeenCalledTimes(5)
  })

  it('bounds visibility polling and fails immediately for conflicting bytes or lookup errors', async () => {
    const delay = vi.fn(async () => {})
    const lookup = vi.fn(async () => null)
    await expect(waitForPublished(packages[0], lookup, delay)).rejects.toThrow('not visible')
    expect(lookup).toHaveBeenCalledTimes(VISIBILITY_ATTEMPTS)
    expect(delay).toHaveBeenCalledTimes(VISIBILITY_ATTEMPTS - 1)
    expect(delay).toHaveBeenCalledWith(VISIBILITY_INTERVAL_MS)
    delay.mockClear()
    await expect(
      waitForPublished(
        packages[0],
        async () => ({ versions: { '1.2.3': { dist: { integrity: 'wrong' } } } }),
        delay
      )
    ).rejects.toThrow('Published bytes differ')
    await expect(
      waitForPublished(
        packages[0],
        async () => {
          throw new Error('registry unavailable')
        },
        delay
      )
    ).rejects.toThrow('registry unavailable')
    expect(delay).not.toHaveBeenCalled()
  })

  it('converges when a concurrent rerun landed the same immutable version during publish', async () => {
    const registry = new Map()
    const uploads = vi.fn(async (pkg: (typeof packages)[number]) => {
      // Simulate the E403 race: a concurrent run landed this exact version, so npm
      // rejects the duplicate while the registry already shows matching bytes.
      registry.set(pkg.manifest.name, published(pkg))
      if (pkg.manifest.name !== packages.at(-1)?.manifest.name)
        throw new Error('npm publish failed (exit 1, signal null): E403')
    })
    const lookup = async (name: string): Promise<ReturnType<typeof published> | undefined> =>
      registry.get(name)
    await publishPackages(packages, lookup, uploads, async () => {})
    expect(uploads).toHaveBeenCalledTimes(packages.length)
  })

  it('keeps polling when the concurrent publication is not visible yet', async () => {
    const registry = new Map()
    const uploads = vi.fn(async (pkg: (typeof packages)[number]) => {
      if (pkg.manifest.name !== packages.at(-1)?.manifest.name)
        throw new Error('npm publish failed (exit 1, signal null): E403')
      registry.set(pkg.manifest.name, published(pkg))
    })
    // The concurrent bytes surface only after the E403, mid-verification window.
    let probes = 0
    const lookup = async (name: string): Promise<ReturnType<typeof published> | undefined> => {
      if (name !== packages.at(-1)?.manifest.name && probes++ < 3) return undefined
      return registry.get(name)
    }
    const delay = vi.fn(async () => {
      for (const pkg of packages.slice(0, -1)) registry.set(pkg.manifest.name, published(pkg))
    })
    await publishPackages(packages, lookup, uploads, delay)
    expect(uploads).toHaveBeenCalledTimes(packages.length)
  })

  it('treats a publish failure as fatal when the registry shows no matching version', async () => {
    const uploads = vi.fn(async () => {
      throw new Error('ENEEDAUTH')
    })
    await expect(
      publishPackages(
        packages,
        async () => null,
        uploads,
        async () => {}
      )
    ).rejects.toThrow('ENEEDAUTH')
    expect(uploads).toHaveBeenCalledTimes(5)
  })

  it('includes npm stderr detail in subprocess failure messages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'npm-publish-stderr-'))
    try {
      const cli = join(directory, 'npm.cjs')
      await writeFile(
        cli,
        'process.stderr.write("E403 cannot publish over existing version"); process.exit(1)'
      )
      await expect(publishTarball(packages[0], cli)).rejects.toThrow(
        'E403 cannot publish over existing version'
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('propagates real npm subprocess failures with package identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'npm-publish-process-'))
    try {
      const cli = join(directory, 'npm.cjs')
      await writeFile(
        cli,
        `const assert = require('node:assert/strict'); assert.ok(process.argv.includes('--provenance')); assert.ok(process.argv.includes('--ignore-scripts'));`
      )
      await expect(publishTarball(packages[0], cli)).resolves.toBeUndefined()
      await writeFile(cli, 'process.exit(7)')
      await expect(publishTarball(packages[0], cli)).rejects.toThrow(
        `npm publish failed for ${packages[0].manifest.name} (exit 7`
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
