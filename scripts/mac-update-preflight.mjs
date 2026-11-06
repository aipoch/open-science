/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { startFeed } from './mac-update-acceptance-core.mjs'
export const run = promisify(execFile)
export const preflight = async (output) => {
  if (process.platform !== 'darwin') throw new Error('Native macOS GUI session required')
  await mkdir(output, { recursive: true })
  const root = await mkdtemp(
    join(process.env.RUNNER_TEMP || tmpdir(), 'open-science-mac-update-preflight-')
  )
  const keychain = join(root, 'fixture.keychain-db')
  const result = {
    platform: process.platform,
    arch: process.arch,
    checks: {},
    cleanup: {},
    status: 'failed'
  }
  let feed
  try {
    const binary = join(output, 'gui-probe')
    await run(
      '/usr/bin/xcrun',
      ['swiftc', resolve('scripts/mac-update-gui-probe.swift'), '-o', binary],
      { timeout: 120000 }
    )
    const gui = await run(binary, [], { timeout: 20000 })
    result.checks.gui = JSON.parse(gui.stdout.trim())
    // The real keychain is never added to or substituted into the user's search list.
    const before = (await run('/usr/bin/security', ['list-keychains', '-d', 'user'])).stdout
    result.checks.keychain = { created: false, readBack: false }
    const password = randomBytes(32).toString('hex')
    await run('/usr/bin/security', ['create-keychain', '-p', password, keychain])
    result.checks.keychain.created = true
    try {
      await run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain])
      await run('/usr/bin/security', [
        'add-generic-password',
        '-a',
        'fixture',
        '-s',
        'open-science-update-preflight',
        '-w',
        password,
        keychain
      ])
      const read = await run('/usr/bin/security', [
        'find-generic-password',
        '-a',
        'fixture',
        '-s',
        'open-science-update-preflight',
        '-w',
        keychain
      ])
      if (read.stdout.trim() !== password) throw new Error('Isolated Keychain read-back failed')
      result.checks.keychain.readBack = true
    } finally {
      await run('/usr/bin/security', ['delete-keychain', keychain])
      const after = (await run('/usr/bin/security', ['list-keychains', '-d', 'user'])).stdout
      result.cleanup.keychainDeleted = true
      result.cleanup.searchListUnchanged = before === after
    }
    if (!result.cleanup.searchListUnchanged) throw new Error('User Keychain search list changed')
    const file = join(root, 'probe.zip')
    await writeFile(file, 'isolated-update-feed-bytes')
    feed = await startFeed(
      new Map([
        ['/probe.zip', file],
        ['/latest-mac.yml', file]
      ])
    )
    const bytes = await (
      await fetch(`${feed.url}probe.zip`, { headers: { Range: 'bytes=0-7' } })
    ).text()
    if (bytes !== 'isolated') throw new Error('Isolated range feed failed')
    await (await fetch(`${feed.url}latest-mac.yml`)).text()
    result.checks.feed = { url: feed.url, ...feed.metrics, rangeReadBack: true }
    result.status = 'passed'
  } catch (error) {
    result.error = error.message
    throw error
  } finally {
    await feed?.close()
    await rm(root, { recursive: true, force: true })
    result.cleanup.fixtureRootDeleted = true
    await writeFile(join(output, 'preflight.json'), JSON.stringify(result, null, 2))
  }
  return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2] || 'test-results/mac-update-preflight')
  preflight(output).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(error.message)
      process.exitCode = 1
    }
  )
}
