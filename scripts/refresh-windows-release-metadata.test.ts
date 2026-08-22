import { gunzipSync } from 'node:zlib'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { refreshWindowsReleaseMetadata } from './refresh-windows-release-metadata.mjs'

describe('refresh Windows release metadata', () => {
  it('rebuilds the blockmap and feed from the signed installer bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'windows-release-metadata-'))
    const installerName = 'aipoch-open-science-0.17.0-win-x64-setup.exe'
    const installerPath = join(root, installerName)
    const blockmapPath = `${installerPath}.blockmap`
    await writeFile(installerPath, Buffer.from('signed installer bytes'))
    await writeFile(blockmapPath, Buffer.from('stale blockmap'))
    await writeFile(
      join(root, 'latest.yml'),
      [
        'version: 0.17.0',
        'files:',
        `  - url: ${installerName}`,
        '    sha512: stale',
        '    size: 1',
        `path: ${installerName}`,
        'sha512: stale',
        'releaseDate: 2026-08-19T00:00:00.000Z',
        ''
      ].join('\n')
    )

    const result = await refreshWindowsReleaseMetadata({ artifactDirectory: root })
    const feed = load(await readFile(join(root, 'latest.yml'), 'utf8')) as {
      files: Array<{ url: string; sha512: string; size: number }>
      path: string
      sha512: string
    }
    const blockmap = JSON.parse(gunzipSync(await readFile(blockmapPath)).toString('utf8')) as {
      version: string
      files: Array<{ sizes: number[] }>
    }

    expect(result).toMatchObject({ installerName, size: 22 })
    expect(result.sha512).toMatch(/^[A-Za-z0-9+/]{86}==$/)
    expect(feed).toMatchObject({
      path: installerName,
      sha512: result.sha512,
      files: [{ url: installerName, sha512: result.sha512, size: result.size }]
    })
    expect(blockmap.version).toBe('2')
    expect(blockmap.files[0].sizes.reduce((sum, size) => sum + size, 0)).toBe(result.size)
  })
})
