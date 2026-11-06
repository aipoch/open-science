import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import {
  selectMacArtifacts,
  selectMacFeedEntry,
  regenerateMacFeed
} from './mac-artifact-contract.mjs'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'mac-artifact-contract-'))
  roots.push(root)
  return root
}
const stage = (root: string, arch: string): void => {
  for (const suffix of ['.dmg', '.zip', '-runtime.zip'])
    writeFileSync(
      join(root, `aipoch-open-science-1.2.3-mac-${arch}${suffix}`),
      `${arch} ${suffix} real test bytes`
    )
}
describe('stable Mac ordinary entry and runtime artifact boundary', () => {
  it('requires exactly one ordinary DMG, ordinary ZIP and runtime ZIP of the same version', () => {
    const root = fixture()
    stage(root, 'arm64')
    expect(selectMacArtifacts(root, 'arm64').runtime).toMatch(/-runtime\.zip$/)
    rmSync(selectMacArtifacts(root, 'arm64').runtime)
    expect(() => selectMacArtifacts(root, 'arm64')).toThrow(/runtime ZIP/)
    writeFileSync(
      join(root, 'aipoch-open-science-1.2.4-mac-arm64-runtime.zip'),
      'different release'
    )
    expect(() => selectMacArtifacts(root, 'arm64')).toThrow(/Mixed/)
  })
  it('regenerates SHA-512 and size from runtime bytes after stapling, never wrapper bytes', () => {
    const root = fixture()
    stage(root, 'arm64')
    const source = regenerateMacFeed(root, 'arm64')
    const value = load(source) as { files: { url: string; sha512: string; size: number }[] }
    const entry = value.files[0]
    expect(entry.url).toMatch(/-runtime\.zip$/)
    const bytes = readFileSync(join(root, entry.url))
    expect(entry.sha512).toBe(createHash('sha512').update(bytes).digest('base64'))
    expect(entry.size).toBe(bytes.length)
    const wrapper = entry.url.replace('-runtime.zip', '.zip')
    expect(() =>
      selectMacFeedEntry({ files: [{ ...entry, url: wrapper }] }, root, 'arm64')
    ).toThrow(/never the ordinary launcher/)
  })
  it('merges both runtime architecture feeds while ignoring downloadable ordinary ZIPs', () => {
    const root = fixture()
    for (const arch of ['arm64', 'x64']) {
      stage(root, arch)
      regenerateMacFeed(root, arch)
    }
    const result = spawnSync(process.execPath, ['scripts/merge-mac-feed.mjs', root], {
      encoding: 'utf8'
    })
    expect(result.status, result.stderr).toBe(0)
    const feed = load(readFileSync(join(root, 'latest-mac.yml'), 'utf8')) as {
      files: { url: string }[]
    }
    expect(feed.files).toHaveLength(2)
    expect(feed.files.every((entry) => entry.url.endsWith('-runtime.zip'))).toBe(true)
  })
  it('keeps historical monolithic feeds usable but refuses to relabel a wrapper once runtime exists', () => {
    const root = fixture()
    const ordinary = { url: 'aipoch-open-science-1.2.3-mac-arm64.zip' }
    expect(selectMacFeedEntry({ files: [ordinary] }, root, 'arm64')).toBe(ordinary)
    stage(root, 'arm64')
    expect(() => selectMacFeedEntry({ files: [ordinary] }, root, 'arm64')).toThrow(/runtime ZIP/)
  })
  it('notarizes both archive roles and refreshes only the runtime feed; downstream Electron scanners use runtime payload', () => {
    const notarize = load(readFileSync('.github/workflows/notarize-mac.yml', 'utf8')) as {
      jobs: { notarize: { steps: { name: string; run?: string }[] } }
    }
    const steps = notarize.jobs.notarize.steps
    expect(steps.find((s) => s.name === 'Notarize + staple')!.run).toContain(
      'mac-artifact-contract.mjs check mac "$ARCH"'
    )
    expect(steps.find((s) => s.name === 'Regenerate mac update feed')!.run).toContain(
      'mac-artifact-contract.mjs feed mac "$ARCH"'
    )
    for (const file of [
      'desktop-regression.yml',
      'performance-package-dryrun.yml',
      'release-sbom-poc.yml'
    ])
      expect(readFileSync(join('.github/workflows', file), 'utf8')).toContain(
        '*-mac-arm64-runtime.zip'
      )
    const mirror = readFileSync('.github/workflows/mirror-to-website.yml', 'utf8')
    expect(mirror).toContain('*-mac-arm64-runtime.zip|*-mac-x64-runtime.zip')
  })
})
