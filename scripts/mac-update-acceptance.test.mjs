/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertAutomaticUpdate, startFeed } from './mac-update-acceptance-core.mjs'
const expected = {
  sourcePid: 10,
  appliedAt: 100,
  executable: '/isolated/Open-Science.app/Contents/MacOS/Open-Science',
  version: '1.0.7',
  configRoot: '/isolated/data',
  profilePath: '/isolated/profile',
  project: { id: 'p', name: 'Research 数据' },
  session: { id: 's', content: 'Saved original content 数据' },
  sentinelIdentity: '20:90:/other/app'
}
const good = () => ({
  process: { pid: 11, startedAt: 101, executable: expected.executable },
  launchedByHarness: false,
  version: expected.version,
  nativeWindowVisible: true,
  rendererReady: true,
  backendReady: true,
  configRoot: expected.configRoot,
  profilePath: expected.profilePath,
  project: expected.project,
  session: { id: 's', messages: [{ content: expected.session.content }] },
  sentinelIdentity: expected.sentinelIdentity,
  sentinelBackendReady: true,
  sentinelWindowVisible: true,
  sentinelDataPreserved: true,
  feedRequests: 1,
  packageBytes: 100
})
test('accepts automatic target with real readiness and preserved contents', () =>
  assert.equal(assertAutomaticUpdate(good(), expected).status, 'passed'))
for (const [name, patch] of [
  ['no automatic target', { process: undefined }],
  [
    'unknown target birth identity',
    { process: { pid: 11, startedAt: Number.NaN, executable: expected.executable } }
  ],
  [
    'malformed target PID',
    { process: { pid: 0, startedAt: 101, executable: expected.executable } }
  ],
  ['old version started', { version: '1.0.6' }],
  ['target launched by harness', { launchedByHarness: true }],
  ['headless only', { nativeWindowVisible: false }],
  ['backend unavailable', { backendReady: false }],
  ['profile changed', { profilePath: '/wrong' }],
  ['saved content corrupted', { session: { id: 's', messages: [{ content: 'corrupt' }] } }],
  ['other installation killed', { sentinelIdentity: undefined }],
  ['other installation alive but backend failed', { sentinelBackendReady: false }],
  ['other installation alive but window lost', { sentinelWindowVisible: false }],
  ['other installation alive but saved data corrupted', { sentinelDataPreserved: false }],
  ['production feed used', { feedRequests: 0 }]
])
  test(`rejects ${name}`, () =>
    assert.throws(() => assertAutomaticUpdate({ ...good(), ...patch }, expected)))
test('loopback feed serves real range bytes and rejects out-of-bounds requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mac-update-feed-'))
  let feed
  try {
    const file = join(root, 'package.zip')
    await writeFile(file, 'abcdefghij')
    feed = await startFeed(
      new Map([
        ['/package.zip', file],
        ['/latest-mac.yml', file]
      ]),
      0
    )
    const response = await fetch(`${feed.url}package.zip`, { headers: { Range: 'bytes=2-5' } })
    assert.equal(response.status, 206)
    assert.equal(await response.text(), 'cdef')
    assert.equal(
      (await fetch(`${feed.url}package.zip`, { headers: { Range: 'bytes=20-' } })).status,
      416
    )
    assert.equal((await fetch(`${feed.url}../secrets`)).status, 404)
    await (await fetch(`${feed.url}latest-mac.yml`)).text()
    assert.deepEqual(feed.metrics, { feedRequests: 1, packageBytes: 4, packageRequests: 1 })
  } finally {
    await feed?.close()
    await rm(root, { recursive: true, force: true })
  }
})
