/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  aggregateEvidence,
  artifactEvidence,
  writePlatformEvidence,
  writeWindowsUpdateEvidence
} from './release-certification-evidence.mjs'

const platforms = ['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']

describe('release certification evidence', () => {
  it('hashes only user-facing distributables in stable order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-evidence-artifacts-'))
    await writeFile(join(root, 'latest.yml'), 'ignored')
    await writeFile(join(root, 'b.zip'), 'b')
    await writeFile(join(root, 'a.dmg'), 'a')

    await expect(artifactEvidence(root)).resolves.toMatchObject([
      { name: 'a.dmg', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { name: 'b.zip', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
    ])
  })

  it('writes one platform record tied to the workflow run and source SHA', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-evidence-write-'))
    const output = join(root, 'certification-linux-x64.json')
    const databaseCertification = join(root, 'database-migration-certification.json')
    await writeFile(join(root, 'app.AppImage'), 'artifact')
    await writeFile(
      databaseCertification,
      JSON.stringify({
        schemaVersion: 1,
        compatibilityFloor: {
          migrationId: '0001_runtime_schema_baseline',
          migrationChecksum: 'e29d0483786c3ed2e1c9cd358369b254a54ccf54213931c5ef71a8fd4e161525',
          sqliteVersion: '3.46.0'
        },
        checks: {
          freshInstall: 'passed',
          legacyAdoption: 'passed',
          reopen: 'passed',
          specialPath: 'passed'
        }
      })
    )

    await writePlatformEvidence({
      argv: [
        '--platform',
        'linux-x64',
        '--artifact-dir',
        root,
        '--output',
        output,
        '--electron-p0',
        'not-applicable',
        '--visual-regression',
        'not-applicable',
        '--package-smoke',
        'passed',
        '--database-migration-certification',
        databaseCertification,
        '--authenticode',
        'not-applicable'
      ],
      environment: {
        GITHUB_REPOSITORY: 'aipoch/open-science',
        GITHUB_REF: 'refs/tags/v0.11.0',
        GITHUB_SHA: 'abc123',
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '2'
      }
    })

    await expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
      platform: 'linux-x64',
      source: { sha: 'abc123', runId: '42', runAttempt: '2' },
      checks: {
        electronP0: 'not-applicable',
        visualRegression: 'not-applicable',
        packageSmoke: 'passed'
      },
      databaseMigration: {
        compatibilityFloor: { sqliteVersion: '3.46.0' },
        checks: { reopen: 'passed', specialPath: 'passed' }
      }
    })
  })

  it('records every real Windows update-drill phase without claiming code signing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-evidence-update-'))
    const output = join(root, 'certification-windows-update.json')
    const updaterObservation = join(root, 'windows-updater-observation.json')
    const databaseCertification = join(root, 'database-migration-certification.json')
    const environment = {
      GITHUB_SHA: 'abc123',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1'
    }
    await writeFile(
      updaterObservation,
      JSON.stringify({
        schemaVersion: 1,
        mode: 'electron-updater-differential',
        feedRequests: 1,
        blockmapRequests: 2,
        rangeRequests: 3,
        fullInstallerRequests: 0,
        downloadedInstallerBytes: 40,
        installerBytes: 100,
        versionedFeed: true,
        previousInstallerCacheVerified: true,
        previousVersion: '0.10.0',
        currentVersion: '0.11.0'
      })
    )
    await writeFile(
      databaseCertification,
      JSON.stringify({
        schemaVersion: 1,
        compatibilityFloor: {
          migrationId: '0001_runtime_schema_baseline',
          migrationChecksum: 'e29d0483786c3ed2e1c9cd358369b254a54ccf54213931c5ef71a8fd4e161525',
          sqliteVersion: '3.46.0'
        },
        checks: {
          freshInstall: 'passed',
          legacyAdoption: 'passed',
          reopen: 'passed',
          specialPath: 'passed'
        }
      })
    )

    await expect(
      writeWindowsUpdateEvidence({
        argv: [
          '--output',
          output,
          '--current-tag',
          'v0.11.0',
          '--previous-tag',
          'v0.10.0',
          '--status',
          'passed',
          '--updater-observation',
          updaterObservation,
          '--database-migration-certification',
          databaseCertification
        ],
        environment
      })
    ).resolves.toMatchObject({
      kind: 'windows-update-drill',
      checks: {
        authenticode: 'not-required',
        electronUpdater: 'passed',
        incrementalDownload: 'passed',
        feedCompatibility: 'passed',
        silentInstall: 'passed',
        processLock: 'passed',
        rollback: 'passed',
        restart: 'passed'
      },
      databaseMigration: { compatibilityFloor: { sqliteVersion: '3.46.0' } }
    })
    await expect(
      writeWindowsUpdateEvidence({
        argv: ['--output', output, '--current-tag', 'v0.11.0', '--status', 'passed'],
        environment
      })
    ).rejects.toThrow(/previous stable tag/)
    await expect(
      writeWindowsUpdateEvidence({
        argv: [
          '--output',
          output,
          '--current-tag',
          'v0.11.0',
          '--previous-tag',
          'v0.10.0',
          '--status',
          'passed'
        ],
        environment
      })
    ).rejects.toThrow(/differential updater observation/)
    await expect(
      writeWindowsUpdateEvidence({
        argv: [
          '--output',
          output,
          '--current-tag',
          'v0.12.0',
          '--previous-tag',
          'v0.10.0',
          '--status',
          'passed',
          '--updater-observation',
          updaterObservation,
          '--database-migration-certification',
          databaseCertification
        ],
        environment
      })
    ).rejects.toThrow(/do not match the release tags/)
    await expect(
      writeWindowsUpdateEvidence({
        argv: ['--output', output, '--current-tag', 'v0.11.0', '--status', 'not-applicable'],
        environment
      })
    ).rejects.toThrow(/approved reason/)
    await expect(
      writeWindowsUpdateEvidence({
        argv: [
          '--output',
          output,
          '--current-tag',
          'v0.11.0',
          '--previous-tag',
          'v0.10.0',
          '--status',
          'failed',
          '--reason',
          'updater=failure,installer=success'
        ],
        environment
      })
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'updater=failure,installer=success',
      checks: { authenticode: 'not-required', electronUpdater: 'failed' }
    })
  })

  it('fails closed on missing platforms, mismatched SHA, or incomplete stable evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-evidence-aggregate-'))
    const output = join(root, 'RELEASE-CERTIFICATION.json')
    const artifactDigest = 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'
    const recordFor = (platform: string, sha = 'abc123') => ({
      schemaVersion: 1,
      platform,
      source: { sha },
      checks: {
        electronP0: 'not-applicable',
        visualRegression: 'not-applicable',
        packageSmoke: 'passed',
        authenticode: platform === 'windows-x64' ? 'not-required' : 'not-applicable'
      },
      databaseMigration: {
        schemaVersion: 1,
        compatibilityFloor: {
          migrationId: '0001_runtime_schema_baseline',
          migrationChecksum: 'e29d0483786c3ed2e1c9cd358369b254a54ccf54213931c5ef71a8fd4e161525',
          sqliteVersion: platform === 'macos-arm64' ? '3.45.0' : '3.46.0'
        },
        checks: {
          freshInstall: 'passed',
          legacyAdoption: 'passed',
          reopen: 'passed',
          specialPath: 'passed'
        }
      },
      artifacts: [{ name: `${platform}.zip`, sha256: artifactDigest }]
    })
    for (const platform of platforms.slice(0, -1)) {
      await writeFile(join(root, `${platform}.zip`), 'a')
      await writeFile(
        join(root, `certification-${platform}.json`),
        JSON.stringify(recordFor(platform))
      )
    }
    const args = ['--directory', root, '--output', output, '--expected-sha', 'abc123']
    await expect(aggregateEvidence({ argv: args })).rejects.toThrow(/missing: windows-x64/)

    await writeFile(join(root, 'windows-x64.zip'), 'a')
    await writeFile(
      join(root, 'certification-windows-x64.json'),
      JSON.stringify(recordFor('windows-x64'))
    )
    await expect(aggregateEvidence({ argv: args })).resolves.toMatchObject({
      sourceSha: 'abc123',
      databaseCompatibilityFloor: { sqliteVersion: '3.45.0' },
      platforms: expect.arrayContaining([expect.objectContaining({ platform: 'windows-x64' })])
    })

    await expect(
      aggregateEvidence({ argv: [...args, '--require-signed-windows'] })
    ).rejects.toThrow(/Windows Authenticode did not pass/)
    await writeFile(
      join(root, 'certification-windows-x64.json'),
      JSON.stringify({
        ...recordFor('windows-x64'),
        checks: { ...recordFor('windows-x64').checks, authenticode: 'passed' }
      })
    )
    await expect(
      aggregateEvidence({ argv: [...args, '--require-signed-windows'] })
    ).resolves.toMatchObject({
      platforms: expect.arrayContaining([
        expect.objectContaining({
          platform: 'windows-x64',
          checks: expect.objectContaining({ authenticode: 'passed' })
        })
      ])
    })

    await writeFile(
      join(root, 'certification-macos-arm64.json'),
      JSON.stringify({
        ...recordFor('macos-arm64'),
        checks: {
          ...recordFor('macos-arm64').checks,
          electronP0: 'passed',
          visualRegression: 'passed'
        }
      })
    )
    await expect(aggregateEvidence({ argv: args })).rejects.toThrow(
      /Invalid release certification evidence for macos-arm64/
    )
    await writeFile(
      join(root, 'certification-macos-arm64.json'),
      JSON.stringify(recordFor('macos-arm64'))
    )

    await writeFile(
      join(root, 'certification-macos-arm64.json'),
      JSON.stringify({
        ...recordFor('macos-arm64'),
        checks: { ...recordFor('macos-arm64').checks, packageSmoke: 'not-applicable' }
      })
    )
    await expect(aggregateEvidence({ argv: args })).rejects.toThrow(
      /Package smoke did not pass for macos-arm64/
    )
    await writeFile(
      join(root, 'certification-macos-arm64.json'),
      JSON.stringify(recordFor('macos-arm64'))
    )

    await expect(
      aggregateEvidence({ argv: [...args, '--require-windows-update'] })
    ).rejects.toThrow(/stable Windows update drill evidence/)
    await writeFile(
      join(root, 'certification-windows-update.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'windows-update-drill',
        source: { sha: 'abc123' },
        currentTag: 'v0.11.0',
        previousTag: 'v0.10.0',
        status: 'passed',
        checks: {
          authenticode: 'not-required',
          electronUpdater: 'passed',
          incrementalDownload: 'passed',
          feedCompatibility: 'passed',
          silentInstall: 'passed',
          processLock: 'passed',
          rollback: 'passed',
          restart: 'passed'
        },
        databaseMigration: recordFor('windows-x64').databaseMigration,
        updater: {
          schemaVersion: 1,
          mode: 'electron-updater-differential',
          feedRequests: 1,
          blockmapRequests: 2,
          rangeRequests: 3,
          fullInstallerRequests: 0,
          downloadedInstallerBytes: 40,
          installerBytes: 100,
          versionedFeed: true,
          previousInstallerCacheVerified: true,
          previousVersion: '0.10.0',
          currentVersion: '0.11.0'
        }
      })
    )
    await expect(
      aggregateEvidence({
        argv: [...args, '--require-windows-update']
      })
    ).resolves.toMatchObject({
      releaseChecks: {
        windowsUpdate: { status: 'passed' }
      }
    })
  })
})
