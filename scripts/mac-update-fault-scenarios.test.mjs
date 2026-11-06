/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, copyFile, writeFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertBlocked,
  assertFaultHit,
  assertReadableFixture,
  corruptRetainedPackage,
  loadMacUpdateScenario,
  watchScannerFaults
} from './mac-update-fault-scenarios.mjs'
import { digest, startFeed } from './mac-update-acceptance-core.mjs'
const run = promisify(execFile)
const wait = async (fn) => {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    const result = await fn()
    if (result) return result
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error('Native fixture condition was not observed')
}
test('rejects missing hit and malformed or vanished target blocker state', () => {
  assert.throws(() => assertFaultHit({ kind: 'scanner-timeout', hit: true }, 'scanner-timeout'))
  assert.throws(() => assertBlocked({ state: 'ready', latest: '1.1.0' }, '1.1.0'))
  assert.throws(() => assertBlocked({ state: 'ready', latest: '1.2.0', error: 'locked' }, '1.1.0'))
  assert.throws(() =>
    assertBlocked({ state: 'ready', latest: '1.1.0', error: 'locked', outcome: 'success' }, '1.1.0')
  )
  assert.doesNotThrow(() =>
    assertBlocked({ state: 'ready', latest: '1.1.0', error: 'locked' }, '1.1.0')
  )
})
test('rejects data-directory existence as substitute for readable project and session contents', () => {
  const fixture = {
    project: { id: 'p', name: 'Research 数据' },
    session: { id: 's', content: 'original' }
  }
  assert.throws(() => assertReadableFixture({ projects: [], session: undefined }, fixture))
  assert.throws(() =>
    assertReadableFixture(
      { projects: [fixture.project], session: { id: 's', messages: [{ content: 'damaged' }] } },
      fixture
    )
  )
  assert.doesNotThrow(() =>
    assertReadableFixture(
      { projects: [fixture.project], session: { id: 's', messages: [{ content: 'original' }] } },
      fixture
    )
  )
})
test('M12 uses a separate real verified-startup ticket driver', async () => {
  const scenario = await loadMacUpdateScenario('M12', {})
  assert.equal(typeof scenario.apply, 'function')
  assert.equal(typeof scenario.afterUpdate, 'function')
})
test('retained ZIP corruption changes only already-bound package bytes and keeps original target request', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mac-cache-fault-')))
  try {
    const directory = join(root, 'account-app-data', 'mac-update-handoffs', 'operation-fixture')
    await mkdir(directory, { recursive: true })
    const requestPath = join(directory, 'request.json')
    const zip = join(directory, 'update.zip')
    const request = {
      installerPath: zip,
      targetVersion: '1.1.0',
      installerSha512: 'original-target-hash',
      applicationPath: join(root, 'Source.app'),
      profilePath: join(root, 'profile'),
      startupOptions: { configRoot: join(root, 'config') },
      operationId: 'fixture-op'
    }
    await writeFile(requestPath, JSON.stringify(request))
    await writeFile(zip, 'original real package fixture bytes')
    const requestSha256 = await digest(requestPath)
    const ctx = {
      root,
      appDataRoot: join(root, 'account-app-data'),
      appBundle: request.applicationPath,
      profile: request.profilePath,
      configRoot: request.startupOptions.configRoot,
      targetVersion: '1.1.0',
      report: {},
      feed: { metrics: { packageBytes: 123 } }
    }
    for (const wrong of [
      { profile: join(root, 'wrong-profile') },
      { targetVersion: '9.9.9' },
      { appBundle: join(root, 'Other.app') }
    ]) {
      await assert.rejects(
        corruptRetainedPackage(
          { ...ctx, ...wrong },
          {
            request,
            record: {
              handoffDirectory: directory,
              requestSha256,
              operationId: 'fixture-op',
              installationRoot: request.applicationPath,
              targetVersion: '1.1.0'
            }
          }
        ),
        /Handoff is not bound/
      )
    }
    assert.equal(await digest(requestPath), requestSha256)
    await corruptRetainedPackage(ctx, {
      request,
      record: {
        handoffDirectory: directory,
        requestSha256,
        operationId: 'fixture-op',
        installationRoot: request.applicationPath,
        targetVersion: '1.1.0'
      }
    })
    assert.equal(await digest(requestPath), requestSha256)
    assert.equal(ctx.report.cacheFault.requestUnchanged, true)
    assert.equal(ctx.report.cacheFault.downloadBytesBefore, 123)
    assert.notEqual(ctx.report.cacheFault.originalSha256, ctx.report.cacheFault.damagedSha256)
    await assert.rejects(
      corruptRetainedPackage(
        { ...ctx, root: join(root, 'other') },
        {
          request,
          record: {
            handoffDirectory: directory,
            requestSha256,
            operationId: 'fixture-op',
            installationRoot: request.applicationPath,
            targetVersion: '1.1.0'
          }
        }
      ),
      /Handoff is not bound/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('real feed pause is acknowledged by an actual request and can be cancelled before retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mac-held-feed-'))
  let feed
  try {
    const zip = join(root, 'update.zip')
    await writeFile(zip, 'original package fixture')
    feed = await startFeed(new Map([['/update.zip', zip]]), 0)
    feed.holdPackages()
    const abort = new AbortController()
    const first = fetch(feed.url + 'update.zip', { signal: abort.signal })
      .then((r) => r.text())
      .catch(() => 'aborted')
    await wait(() => feed.heldTransfers().length)
    assert.equal(feed.metrics.packageBytes, 0)
    abort.abort()
    assert.equal(await first, 'aborted')
    feed.releasePackages()
    assert.equal(await (await fetch(feed.url + 'update.zip')).text(), 'original package fixture')
    assert.equal(feed.metrics.packageRequests, 2)
  } finally {
    await feed?.close()
    await rm(root, { recursive: true, force: true })
  }
})
for (const persistent of [false, true])
  test(
    `native scanner fault watcher ${persistent ? 'ends scanner' : 'pauses first scanner'} after observing exact parent and birth`,
    {
      skip: process.platform !== 'darwin' || process.env.MAC_UPDATE_NATIVE_FIXTURES !== '1',
      timeout: 20000
    },
    async () => {
      const launcher = spawn(
        '/bin/sh',
        ['-c', '/usr/sbin/lsof -n -P -r 1 -p $$ >/dev/null & wait'],
        { stdio: 'ignore' }
      )
      let watcher
      try {
        const processes = async () => {
          const output = (await run('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='])).stdout
          return output.split('\n').flatMap((line) => {
            const m =
              /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/.exec(line)
            return m
              ? [{ pid: +m[1], ppid: +m[2], startedAt: Date.parse(m[3]), executable: m[4] }]
              : []
          })
        }
        watcher = watchScannerFaults(
          { sourcePid: launcher.pid, processes, run, executable: '/not-the-source' },
          persistent
        )
        await wait(() => watcher.hits.length)
        await watcher.stop()
        const hit = watcher.hits[0]
        assertFaultHit(hit, persistent ? 'scanner-exit' : 'scanner-timeout')
        if (!persistent) {
          assert.match((await run('/bin/ps', ['-o', 'state=', '-p', String(hit.pid)])).stdout, /T/)
          process.kill(hit.pid, 'SIGKILL')
        }
      } finally {
        await watcher?.cleanup()
        try {
          launcher.kill('SIGKILL')
        } catch {
          /* already exited */
        }
      }
    }
  )

test(
  'M14 native fixture proves an independent process maps unchanged installation bytes and cleanup preserves another process',
  {
    skip: process.platform !== 'darwin' || process.env.MAC_UPDATE_NATIVE_FIXTURES !== '1',
    timeout: 20000
  },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mac-external-mapping-')))
    const other = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    let driver
    try {
      const appBundle = join(root, 'Fixture.app')
      const path = join(
        appBundle,
        'Contents/Resources/app.asar.unpacked/node_modules/@aipoch/process-tree-native/build/Release/process_tree_native.node'
      )
      await mkdir(join(path, '..'), { recursive: true })
      await copyFile(
        new URL(
          '../packages/process-tree-native/build/Release/process_tree_native.node',
          import.meta.url
        ),
        path
      )
      const processes = async () => {
        const output = (await run('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='])).stdout
        return output.split('\n').flatMap((line) => {
          const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/.exec(
            line
          )
          return m
            ? [{ pid: +m[1], ppid: +m[2], startedAt: Date.parse(m[3]), executable: m[4] }]
            : []
        })
      }
      const ctx = {
        root,
        appBundle,
        children: [],
        report: {},
        processes,
        run,
        wait: (_label, fn) => wait(fn)
      }
      driver = await loadMacUpdateScenario('M14', ctx)
      const before = await digest(path)
      await driver.beforeApply()
      assert.equal(ctx.report.externalMapping.observed, true)
      assert.equal(ctx.report.externalMapping.mappedLibrarySha256, before)
      assert.equal(await digest(path), before)
      await driver.cleanup()
      assert.equal(other.exitCode, null)
      assert.equal(other.signalCode, null)
    } finally {
      await driver?.cleanup()
      other.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  }
)
