import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReplayViewerAssetReader, resolveReplayViewerAssetRoot } from './assets'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'viewer-assets-'))
  directories.push(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<main>Replay</main>')
  await writeFile(join(root, 'assets', 'main.js'), 'export const ready = true')
  return root
}

describe('the packaged observer asset reader', () => {
  it('serves only the known bundle entry and asset types from actual disk', async () => {
    const root = await fixture()
    const read = createReplayViewerAssetReader(root)
    expect(await read('index.html')).toEqual({
      body: Buffer.from('<main>Replay</main>'),
      mimeType: 'text/html; charset=utf-8'
    })
    expect((await read('assets/main.js'))?.mimeType).toBe('text/javascript; charset=utf-8')
    expect(await read('assets/missing.js')).toBeUndefined()
    await writeFile(join(root, 'assets', 'main.js.map'), '{}')
    await writeFile(join(root, 'private.js'), 'secret')
    for (const path of [
      'private.js',
      'assets/main.js.map',
      '/index.html',
      '../index.html',
      'assets/../index.html',
      'assets//main.js',
      'assets/./main.js',
      'assets/%2e%2e/index.html',
      'assets\\main.js',
      'index.html?x=1',
      'assets/main.js\0'
    ]) {
      expect(await read(path), path).toBeUndefined()
    }
    await mkdir(join(root, 'assets', 'folder.js'))
    expect(await read('assets/folder.js')).toBeUndefined()
  })

  it('rejects final-file, intermediate-directory, and bundle-root symlinks', async () => {
    const root = await fixture()
    const outside = await fixture()
    await symlink(join(outside, 'index.html'), join(root, 'assets', 'linked.html'))
    await symlink(join(outside, 'assets'), join(root, 'assets', 'linked-directory'))
    const rootLink = `${root}-link`
    directories.push(rootLink)
    await symlink(root, rootLink)
    const read = createReplayViewerAssetReader(root)
    expect(await read('assets/linked.html')).toBeUndefined()
    expect(await read('assets/linked-directory/main.js')).toBeUndefined()
    expect(await createReplayViewerAssetReader(rootLink)('index.html')).toBeUndefined()
    await rm(join(root, 'assets'), { recursive: true })
    await symlink(join(outside, 'assets'), join(root, 'assets'))
    expect(await read('assets/main.js')).toBeUndefined()
  })

  it('bounds actual bytes and allows the exact asset-size boundary', async () => {
    const root = await fixture()
    const read = createReplayViewerAssetReader(root)
    const asset = join(root, 'assets', 'large.png')
    await writeFile(asset, '')
    await truncate(asset, 16 * 1024 * 1024)
    expect((await read('assets/large.png'))?.body.byteLength).toBe(16 * 1024 * 1024)
    await truncate(asset, 16 * 1024 * 1024 + 1)
    expect(await read('assets/large.png')).toBeUndefined()
  })

  it('uses unpacked packaged assets without replacing unrelated path substrings', () => {
    expect(
      resolveReplayViewerAssetRoot(
        '/Applications/Open Science.app/Contents/Resources/app.asar/out/main'
      )
    ).toBe('/Applications/Open Science.app/Contents/Resources/app.asar.unpacked/out/replay-viewer')
    expect(resolveReplayViewerAssetRoot('/work/app.asar-example/out/main')).toBe(
      '/work/app.asar-example/out/replay-viewer'
    )
    expect(resolveReplayViewerAssetRoot('/work/app.asar.unpacked/out/main')).toBe(
      '/work/app.asar.unpacked/out/replay-viewer'
    )
    expect(resolveReplayViewerAssetRoot('/work/out/main')).toBe('/work/out/replay-viewer')
  })
})
