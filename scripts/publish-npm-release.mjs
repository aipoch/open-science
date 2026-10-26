/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { appendFile, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeTargets, runtimePackageName } from '../packages/open-science/runtime-package.mjs'

const registry = 'https://registry.npmjs.org'

// npm registry visibility can lag minutes behind a successful publish; the run
// must outlast that lag, and concurrent reruns must converge instead of E403-failing.
export const VISIBILITY_ATTEMPTS = 30
export const VISIBILITY_INTERVAL_MS = 10_000

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
    const report = JSON.parse(
      await readFile(join(folder, `${target.id}.json`), 'utf8').catch((error) => {
        if (error.code === 'ENOENT')
          throw new Error(
            `Missing verified npm artifact: ${target.id}. Use the original Release artifacts; do not rebuild partially published versions.`,
            { cause: error }
          )
        throw error
      })
    )
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
async function registryPackage(name) {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(30_000)
  })
  if (response.status === 404) return null
  assert.ok(response.ok, `Registry lookup failed: ${response.status} ${name}`)
  return response.json()
}

export async function waitForPublished(pkg, lookup, delay = setTimeout) {
  const { name, version } = pkg.manifest
  for (let attempt = 0; attempt < VISIBILITY_ATTEMPTS; attempt++) {
    const published = (await lookup(name))?.versions?.[version]
    if (published) {
      assert.equal(
        published.dist?.integrity,
        pkg.integrity,
        `Published bytes differ: ${name}@${version}`
      )
      return
    }
    if (attempt < VISIBILITY_ATTEMPTS - 1) await delay(VISIBILITY_INTERVAL_MS)
  }
  throw new Error(
    `Published version is not visible in the registry after ${VISIBILITY_ATTEMPTS} checks: ${name}@${version}`
  )
}

export function publishTarball(pkg, npmCli = process.env.npm_execpath) {
  console.log(`Publishing ${pkg.manifest.name}@${pkg.manifest.version}`)
  return new Promise((accept, reject) => {
    let stderr = ''
    const child = spawn(
      process.execPath,
      [
        npmCli,
        'publish',
        pkg.path,
        '--registry',
        registry,
        '--access',
        'public',
        '--ignore-scripts',
        '--provenance',
        '--loglevel=error'
      ],
      { stdio: ['inherit', 'inherit', 'pipe'] }
    )
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) {
        const detail = stderr.trim()
        if (detail) console.error(detail)
        accept()
      } else {
        const detail = stderr.trim().slice(-500)
        reject(
          new Error(
            `npm publish failed for ${pkg.manifest.name} (exit ${code}, signal ${signal})` +
              (detail ? `: ${detail}` : '')
          )
        )
      }
    })
  })
}

export async function publishPackages(
  packages,
  lookup = registryPackage,
  publish = publishTarball,
  delay = setTimeout
) {
  const names = packages.map((pkg) => pkg.manifest.name)
  assert.deepEqual(names, [...runtimeTargets.map(runtimePackageName), '@aipoch/open-science'])
  // Finish the complete batch preflight before starting any immutable registry write.
  const plan = await publishPlan(packages, lookup)
  const entry = plan.at(-1)
  const publishMissing = async (pkg) => {
    if (pkg.published) {
      console.log(`Already published with matching integrity: ${pkg.manifest.name}`)
      return
    }
    try {
      await publish(pkg)
    } catch (error) {
      // Between preflight and publish, a concurrent rerun can land the same immutable
      // version; npm then rejects with E403 while the registry still lags. Poll the
      // same bounded visibility window before treating the race as fatal.
      try {
        await waitForPublished(pkg, lookup, delay)
      } catch {
        throw error
      }
      console.log(`Concurrent publication verified: ${pkg.manifest.name}@${pkg.manifest.version}`)
    }
  }
  const results = await Promise.allSettled(
    plan.slice(0, -1).map(async (pkg) => {
      try {
        await publishMissing(pkg)
        await waitForPublished(pkg, lookup, delay)
      } catch (error) {
        throw new Error(`${pkg.manifest.name}: ${error.message}`, { cause: error })
      }
    })
  )
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (errors.length)
    throw new AggregateError(
      errors,
      `Platform publication failed; entry package blocked:\n${errors.map((error) => error.message).join('\n')}`
    )
  await publishMissing(entry)
  await waitForPublished(entry, lookup, delay)
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
  const publish = mode === '--publish' || mode === '--publish-release'
  if (mode === '--publish') {
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push')
    assert.equal(process.env.GITHUB_REF, `refs/tags/v${version}`)
  }
  if (publish) await publishPackages(packages)
  else if (mode === '--verify-release') await publishPlan(packages, registryPackage)
  // Build-time checks are local: registry availability must not block a GitHub Release.
  console.log(`Verified ${packages.length} npm packages at ${version} from ${sourceSha}`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
