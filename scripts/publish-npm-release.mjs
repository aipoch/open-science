/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeTargets, runtimePackageName } from '../packages/open-science/runtime-package.mjs'

const registry = 'https://registry.npmjs.org'
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
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  if (process.env.GITHUB_REF?.startsWith('refs/tags/'))
    assert.equal(process.env.GITHUB_REF_NAME, `v${version}`)
  const packages = await collectPackages(resolve(process.argv[2]), version, process.env.GITHUB_SHA)
  const plan = await publishPlan(packages, async (name) => {
    const response = await fetch(`${registry}/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(30_000)
    })
    if (response.status === 404) return null
    assert.ok(response.ok, `Registry lookup failed: ${response.status} ${name}`)
    return response.json()
  })
  const publish = process.argv[3] === '--publish'
  if (publish) {
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push')
    assert.equal(process.env.GITHUB_REF, `refs/tags/v${version}`)
  } else assert.equal(process.argv[3], '--dry-run')
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
