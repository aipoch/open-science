import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep, win32 } from 'node:path'
import { assertUpgradeIsolation, isWithin } from './upgrade-isolation.mjs'

// Exercise the containment contract with Windows path parsing even on a macOS/Linux host.
assert.equal(isWithin('C:\\upgrade', 'C:\\upgrade\\uploads\\evidence.txt', win32), true)
assert.equal(isWithin('C:\\upgrade', 'C:\\upgrade\\..\\outside', win32), false)
assert.equal(isWithin('C:\\upgrade', 'D:\\upgrade\\uploads\\evidence.txt', win32), false)

const root = await mkdtemp(join(tmpdir(), 'open-science-upgrade-isolation-'))
const outside = await mkdtemp(join(tmpdir(), 'open-science-outside-'))
const options = { root, repository: resolve('.'), suffix: 'config' }
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'
try {
  await assertUpgradeIsolation(options)
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'config/settings.json'), JSON.stringify({ dataRoot: outside }))
  await assert.rejects(assertUpgradeIsolation(options), /escapes disposable root/)
  await writeFile(
    join(root, 'config/settings.json'),
    JSON.stringify({ dataRoot: join(root, 'relocated/new/data') })
  )
  await assertUpgradeIsolation(options)
  await writeFile(
    join(root, 'config/settings.json.transaction.tmp'),
    JSON.stringify({ dataRoot: outside })
  )
  await assert.rejects(assertUpgradeIsolation(options), /Settings recovery remnants/)
  await rm(join(root, 'config/settings.json.transaction.tmp'))
  await assertUpgradeIsolation(options)
  await symlink(outside, join(root, 'relocated'), directoryLinkType)
  await assert.rejects(assertUpgradeIsolation(options), /escapes disposable root/)
  await rm(join(root, 'relocated'))
  for (const name of ['home', 'profile', 'logs']) {
    await symlink(outside, join(root, name), directoryLinkType)
    await assert.rejects(assertUpgradeIsolation(options), /escapes disposable root/)
    await rm(join(root, name))
  }
  await assert.rejects(assertUpgradeIsolation({ ...options, root: homedir() }))
  await assert.rejects(assertUpgradeIsolation({ ...options, root: options.repository }))
  await assert.rejects(assertUpgradeIsolation({ ...options, root: tmpdir() }))
  await assert.rejects(
    assertUpgradeIsolation({ ...options, suffix: '../outside' }),
    /parent traversal/
  )
  await mkdir(join(outside, 'child'))
  await mkdir(join(outside, 'data'))
  await symlink(join(outside, 'child'), join(root, 'escape'), directoryLinkType)
  for (const tail of ['data', `missing${sep}child`]) {
    const escaped = `${join(root, 'escape')}${sep}..${sep}${tail}`
    await writeFile(join(root, 'config/settings.json'), JSON.stringify({ dataRoot: escaped }))
    await assert.rejects(
      assertUpgradeIsolation(options),
      /Parent traversal|escapes disposable root/
    )
  }
  await rm(join(root, 'escape'))
  await rm(join(root, 'config/settings.json'))

  // On Windows, the normal OS temp directory is under the user profile. Exercise that
  // layout in a fresh process so os.homedir() and os.tmpdir() read the fake environment.
  const fakeHome = join(root, 'test-home')
  const fakeTemp = join(fakeHome, 'AppData', 'Local', 'Temp')
  const nestedRoot = join(fakeTemp, 'open-science-upgrade-within-home')
  await mkdir(nestedRoot, { recursive: true })
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { assertUpgradeIsolation } from ${JSON.stringify(new URL('./upgrade-isolation.mjs', import.meta.url).href)}; await assertUpgradeIsolation({ root: process.env.UPGRADE_TEST_ROOT, repository: process.env.UPGRADE_TEST_REPOSITORY, suffix: 'config' })`
    ],
    {
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        TMPDIR: fakeTemp,
        TEMP: fakeTemp,
        TMP: fakeTemp,
        UPGRADE_TEST_ROOT: nestedRoot,
        UPGRADE_TEST_REPOSITORY: options.repository
      }
    }
  )
  await rm(join(root, 'config'), { recursive: true })
  await symlink(outside, join(root, 'config'), directoryLinkType)
  await assert.rejects(assertUpgradeIsolation(options), /escapes disposable root/)
  console.log(
    'Upgrade isolation self-check passed: external settings, symlink and parent traversal escapes, temp within home, and protected roots.'
  )
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}
