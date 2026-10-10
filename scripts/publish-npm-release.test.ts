import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { collectPackages, publishPlan } from './publish-npm-release.mjs'
import { releaseManifests } from './stage-npm-release.mjs'
import { runtimeTargets } from '../packages/open-science/runtime-package.mjs'
import { isMachO } from './verify-runtime-signatures.mjs'

it('checks actual tarballs, a complete target set, source identity and identical entry bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'npm-publication-'))
  const sha = 'a'.repeat(40)
  try {
    for (const target of runtimeTargets) {
      const folder = join(root, `npm-${target.id}`)
      await mkdir(join(folder, 'package'), { recursive: true })
      const manifests = releaseManifests(
        { name: '@aipoch/open-science' },
        {
          version: '1.2.3',
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
    const packages = await collectPackages(root, '1.2.3', sha)
    expect(packages).toHaveLength(6)
    expect(packages.at(-1)?.manifest.name).toBe('@aipoch/open-science')
    await expect(collectPackages(root, '1.2.3', 'b'.repeat(40))).rejects.toThrow('source commit')
    await expect(collectPackages(root, '1.2.4', sha)).rejects.toThrow()
    const target = runtimeTargets[0]
    const reportPath = join(root, `npm-${target.id}`, `${target.id}.json`)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    report.packages[0].manifest.version = '9.9.9'
    await writeFile(reportPath, JSON.stringify(report))
    await expect(collectPackages(root, '1.2.3', sha)).rejects.toThrow()
    await rm(reportPath)
    await expect(collectPackages(root, '1.2.3', sha)).rejects.toThrow()
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
