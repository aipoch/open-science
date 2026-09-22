import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { formatCoverageMarkdown, validateReleaseSbom } from './validate-release-sbom.mjs'

const temporaryDirectories: string[] = []

const fixture = (packageNames: string[]): { artifactPath: string; sbomPath: string } => {
  const directory = mkdtempSync(join(tmpdir(), 'release-sbom-'))
  temporaryDirectories.push(directory)
  const artifactPath = join(directory, 'aipoch-open-science-1.2.3-mac-arm64.zip')
  const sbomPath = join(directory, 'release-sbom.spdx.json')
  writeFileSync(artifactPath, 'final archive bytes')
  writeFileSync(
    sbomPath,
    JSON.stringify({
      spdxVersion: 'SPDX-2.3',
      dataLicense: 'CC0-1.0',
      documentNamespace: 'https://example.test/spdx/release',
      packages: packageNames.map((name) => ({
        name,
        versionInfo:
          name.toLowerCase().replace(/[^a-z0-9]/g, '') === 'openscience' ? '1.2.3' : 'test-version'
      }))
    })
  )
  return { artifactPath, sbomPath }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('release SBOM coverage validator', () => {
  it('accepts representative components from the final stable-release archive', async () => {
    const files = fixture(['Open-Science', '@prisma/client', 'sharp', 'zod'])
    const result = await validateReleaseSbom({ ...files, tag: 'v1.2.3' })

    expect(result).toMatchObject({
      releaseTag: 'v1.2.3',
      releaseVersion: '1.2.3',
      artifact: 'aipoch-open-science-1.2.3-mac-arm64.zip',
      spdxVersion: 'SPDX-2.3',
      packageCount: 4,
      complete: true
    })
    expect(result.artifactSha256).toBe(
      createHash('sha256').update('final archive bytes').digest('hex')
    )
    expect(formatCoverageMarkdown(result)).toContain(
      '**PoC result:** representative final-package coverage is complete.'
    )
  })

  it('reports an app.asar blind spot without hiding the other successful boundaries', async () => {
    const files = fixture(['open-science', '@prisma/client', 'sharp'])
    const result = await validateReleaseSbom({ ...files, tag: 'v1.2.3' })

    expect(result.complete).toBe(false)
    expect(result.checks.find(({ id }) => id === 'zod')).toMatchObject({
      matched: null,
      ok: false
    })
    expect(result.checks.filter(({ ok }) => ok)).toHaveLength(3)
    expect(formatCoverageMarkdown(result)).toContain(
      '**PoC result:** representative final-package coverage is incomplete.'
    )
    expect(formatCoverageMarkdown(result)).toContain(
      'Custom SBOM composition is required before publication or attestation.'
    )
  })

  it('rejects prerelease tags and mismatched final archives', async () => {
    const files = fixture(['Open-Science', '@prisma/client', 'sharp', 'zod'])

    await expect(validateReleaseSbom({ ...files, tag: 'v1.2.3-beta.1' })).rejects.toThrow(
      'stable vMAJOR.MINOR.PATCH'
    )
    await expect(validateReleaseSbom({ ...files, tag: 'v1.2.4' })).rejects.toThrow(
      'does not match stable release'
    )
  })
})
