import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdaterOnlyArtifact, invalidateDownloadedArtifact } from './artifact-fault.mjs'
import { startUpdateServer } from './server.mjs'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(): Promise<{
  root: string
  cache: string
  path: string
  verified: { localPath: string; artifactSha512: string }
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'update-artifact-fault-')))
  roots.push(root)
  const cache = join(root, 'cache')
  await mkdir(cache)
  const path = join(cache, 'target.zip')
  const bytes = Buffer.from('downloaded full installer')
  await writeFile(path, bytes)
  return {
    root,
    cache,
    path,
    verified: {
      localPath: path,
      artifactSha512: createHash('sha512').update(bytes).digest('base64')
    }
  }
}
it('changes actual completed cache bytes and deletes only that owned artifact', async () => {
  const f = await fixture()
  const proof = await invalidateDownloadedArtifact(
    { updateCacheRoot: f.cache },
    f.verified,
    'corrupt'
  )
  expect(proof.mutation).toBe('corrupt')
  expect(
    createHash('sha512')
      .update(await readFile(f.path))
      .digest('base64')
  ).not.toBe(f.verified.artifactSha512)
  await expect(
    invalidateDownloadedArtifact({ updateCacheRoot: f.cache }, f.verified, 'delete')
  ).rejects.toThrow('already changed')
  const other = await fixture()
  await invalidateDownloadedArtifact({ updateCacheRoot: other.cache }, other.verified, 'delete')
  await expect(readFile(other.path)).rejects.toThrow()
})
it('refuses outside paths and symlink escapes', async () => {
  const f = await fixture()
  await expect(
    invalidateDownloadedArtifact(
      { updateCacheRoot: join(f.root, 'elsewhere') },
      f.verified,
      'delete'
    )
  ).rejects.toThrow('recorded download')
  const link = join(f.cache, 'link.zip')
  await symlink(f.path, link)
  await expect(
    invalidateDownloadedArtifact(
      { updateCacheRoot: f.cache },
      { ...f.verified, localPath: link },
      'delete'
    )
  ).rejects.toThrow('recorded download')
  expect(await readFile(f.path, 'utf8')).toBe('downloaded full installer')
})
it.skipIf(process.platform !== 'darwin')(
  'serves an actual updater-only ZIP with truthful download checksums',
  async () => {
    const f = await fixture()
    const artifact = await createUpdaterOnlyArtifact(
      join(f.root, 'source'),
      '0.0.2',
      'arm64',
      'snapshot'
    )
    const file = artifact.files[0]
    const names = execFileSync('/usr/bin/unzip', ['-Z1', join(artifact.directory, file.name)], {
      encoding: 'utf8'
    })
    expect(names.trim()).toBe('updater-payload-reference.json')
    const server = await startUpdateServer({
      artifact,
      versionA: '0.0.1',
      versionB: '0.0.2',
      scenario: 'manual-non-standalone',
      eventsPath: join(f.root, 'server.jsonl')
    })
    try {
      const feed = await (await fetch(`${server.origin}/latest-mac.yml`)).json()
      const payload = Buffer.from(
        await (await fetch(`${server.origin}/${feed.files[0].url}`)).arrayBuffer()
      )
      expect(createHash('sha512').update(payload).digest('base64')).toBe(feed.files[0].sha512)
      expect(payload.length).toBe(feed.files[0].size)
      expect(feed.files[0].url).toContain('-updater-only.zip')
    } finally {
      await server.close()
    }
  }
)
