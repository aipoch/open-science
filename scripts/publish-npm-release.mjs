/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeTargets, runtimePackageName } from '../packages/open-science/runtime-package.mjs'

const registry = 'https://registry.npmjs.org'

// A successful stable Release is the authority for historical and future npm publications.
// The workflow revision and the package source revision are deliberately separate.
export async function releaseSource(runId, api) {
  assert.match(runId, /^[1-9]\d*$/, 'Expected a Release run ID')
  const run = await api(`actions/runs/${runId}`)
  assert.equal(String(run.id), runId)
  assert.equal(run.path, '.github/workflows/release.yml')
  assert.equal(run.event, 'push')
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success')
  assert.equal(run.repository?.full_name, 'aipoch/open-science')
  assert.equal(run.head_repository?.full_name, 'aipoch/open-science')
  assert.match(run.head_branch, /^v\d+\.\d+\.\d+$/, 'Expected a stable Release tag')
  assert.match(run.head_sha, /^[a-f0-9]{40}$/)
  const tag = run.head_branch
  const release = await api(`releases/tags/${tag}`)
  assert.equal(release.tag_name, tag)
  assert.equal(release.draft, false)
  assert.equal(release.prerelease, false)
  assert.ok(release.published_at, 'Release must be published')
  const commit = await api(`commits/${tag}`)
  assert.equal(commit.sha, run.head_sha, 'Release tag moved since certification')
  const comparison = await api(`compare/${run.head_sha}...main`)
  assert.ok(
    ['ahead', 'identical'].includes(comparison.status),
    'Release must belong to main history'
  )
  const source = await api(`contents/package.json?ref=${run.head_sha}`)
  assert.equal(source.encoding, 'base64')
  const { version } = JSON.parse(Buffer.from(source.content, 'base64').toString('utf8'))
  assert.equal(tag, `v${version}`, 'Release tag and source version differ')
  return { version, sourceSha: run.head_sha, tag }
}

export function assertReleasePublisher(env) {
  assert.equal(env.GITHUB_REPOSITORY, 'aipoch/open-science')
  assert.ok(['workflow_dispatch', 'workflow_run'].includes(env.GITHUB_EVENT_NAME))
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Registry writes require the main workflow')
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    'aipoch/open-science/.github/workflows/npm-release.yml@refs/heads/main'
  )
}

async function githubApi(path) {
  const response = await fetch(`https://api.github.com/repos/aipoch/open-science/${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    signal: AbortSignal.timeout(30_000)
  })
  assert.ok(response.ok, `GitHub source verification failed: ${response.status} ${path}`)
  return response.json()
}
export async function collectPackages(directory, version, sha) {
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.match(sha, /^[a-f0-9]{40}$/)
  const result = new Map()
  for (const target of runtimeTargets) {
    const folder = join(directory, `npm-${target.id}`)
    const report = JSON.parse(await readFile(join(folder, `${target.id}.json`), 'utf8'))
    assert.equal(report.sourceSha, sha, 'Artifact source commit mismatch')
    assert.equal(report.target, target.id)
    assert.equal(report.packages.length, 2)
    const expected = new Set(['@aipoch/open-science', runtimePackageName(target)])
    for (const pkg of report.packages) {
      assert.ok(expected.delete(pkg.manifest.name), 'Unexpected or duplicate package')
      assert.equal(pkg.manifest.version, version)
      assert.equal(basename(pkg.filename), pkg.filename)
      assert.ok(pkg.filename.endsWith('.tgz'))
      const path = join(folder, pkg.filename)
      const bytes = await readFile(path)
      assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, pkg.integrity)
      const actual = JSON.parse(
        execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' })
      )
      assert.deepEqual(actual, pkg.manifest, 'Tarball manifest differs from verification report')
      if (pkg.manifest.name === '@aipoch/open-science') {
        assert.deepEqual(
          pkg.manifest.optionalDependencies,
          Object.fromEntries(runtimeTargets.map((t) => [runtimePackageName(t), version]))
        )
      } else {
        assert.deepEqual(pkg.manifest.os, [target.os])
        assert.deepEqual(pkg.manifest.cpu, [target.cpu])
        if (target.libc) assert.deepEqual(pkg.manifest.libc, [target.libc])
      }
      const previous = result.get(pkg.manifest.name)
      if (previous)
        assert.equal(previous.integrity, pkg.integrity, 'Entry tarball differs across platforms')
      result.set(pkg.manifest.name, { ...pkg, path })
    }
  }
  return [
    ...runtimeTargets.map((t) => result.get(runtimePackageName(t))),
    result.get('@aipoch/open-science')
  ]
}
export async function publishPlan(packages, lookup) {
  const plan = []
  for (const pkg of packages) {
    const existing = await lookup(pkg.manifest.name)
    const version = pkg.manifest.version
    const published = existing?.versions?.[version]
    if (published)
      assert.equal(
        published.dist?.integrity,
        pkg.integrity,
        `Published bytes differ: ${pkg.manifest.name}@${version}`
      )
    const latest = existing?.['dist-tags']?.latest
    if (latest && /^\d+\.\d+\.\d+$/.test(latest)) {
      const a = latest.split('.').map(Number),
        b = version.split('.').map(Number)
      const difference = a.map((v, i) => v - b[i]).find((v) => v !== 0) ?? 0
      assert.ok(difference <= 0, `Refusing to downgrade latest from ${latest} to ${version}`)
    }
    plan.push({ ...pkg, published: Boolean(published) })
  }
  return plan
}
async function main() {
  const root = resolve(import.meta.dirname, '..')
  if (process.argv[2] === '--plan-release') {
    const source = await releaseSource(process.env.NPM_RELEASE_RUN_ID, githubApi)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `source_sha=${source.sourceSha}\nversion=${source.version}\ntag=${source.tag}\n`
    )
    console.log(JSON.stringify(source))
    return
  }
  const mode = process.argv[3]
  assert.ok(['--publish', '--dry-run', '--publish-release', '--verify-release'].includes(mode))
  const releaseMode = mode === '--publish-release' || mode === '--verify-release'
  if (mode === '--publish-release') assertReleasePublisher(process.env)
  const source = releaseMode
    ? await releaseSource(process.env.NPM_RELEASE_RUN_ID, githubApi)
    : {
        version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
        sourceSha: process.env.GITHUB_SHA
      }
  const { version, sourceSha } = source
  if (!releaseMode && process.env.GITHUB_REF?.startsWith('refs/tags/'))
    assert.equal(process.env.GITHUB_REF_NAME, `v${version}`)
  const packages = await collectPackages(resolve(process.argv[2]), version, sourceSha)
  const plan = await publishPlan(packages, async (name) => {
    const response = await fetch(`${registry}/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(30_000)
    })
    if (response.status === 404) return null
    assert.ok(response.ok, `Registry lookup failed: ${response.status} ${name}`)
    return response.json()
  })
  const publish = mode === '--publish' || mode === '--publish-release'
  if (mode === '--publish') {
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push')
    assert.equal(process.env.GITHUB_REF, `refs/tags/v${version}`)
  }
  // All integrity and registry checks finish before the first immutable registry write.
  for (const pkg of plan) {
    if (pkg.published) {
      console.log(`Already published with matching integrity: ${pkg.manifest.name}`)
      continue
    }
    execFileSync(
      process.execPath,
      [
        process.env.npm_execpath,
        'publish',
        pkg.path,
        '--registry',
        registry,
        '--access',
        'public',
        '--ignore-scripts',
        '--provenance',
        ...(publish ? [] : ['--dry-run'])
      ],
      { stdio: 'inherit' }
    )
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
