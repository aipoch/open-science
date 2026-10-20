/* eslint-disable @typescript-eslint/explicit-function-return-type -- standalone JavaScript validation runner. */
/**
 * Source Electron upgrade check. Build each git-tag checkout before using it.
 * Usage: node scripts/validation/historical-data-root-upgrade.mjs <app checkout> <disposable root> <seed|verify|migrate> <expected root suffix> [missing]
 * First seed with v0.2.2 (suffix config); verify v0.30.2 with `missing`, then current.
 * To exercise v0.31.1: copy only v0.2.2 settings.json into a new root/config,
 * create root/home/OpenScience-dev, then seed v0.31.1 using suffix home/OpenScience-dev.
 * Never points Electron home, profile, configuration, or logs at real user data.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright'
import { assertUpgradeIsolation, containsParentTraversal, isWithin } from './upgrade-isolation.mjs'

const [checkoutArg, rootArg, mode, suffix, missing] = process.argv.slice(2)
assert.ok(checkoutArg && rootArg && ['seed', 'verify', 'migrate'].includes(mode) && suffix)
const checkout = resolve(checkoutArg)
const root = resolve(rootArg)
assert.ok(
  isAbsolute(rootArg) && !containsParentTraversal(rootArg) && root.includes('upgrade'),
  'Use an explicit disposable upgrade root'
)
assert.ok(!isAbsolute(suffix) && !containsParentTraversal(suffix))
assert.ok(isWithin(root, join(root, suffix)), 'Expected root must remain inside the upgrade root')
const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const home = join(root, 'home')
const config = join(root, 'config')
const expected = join(root, suffix)
await assertUpgradeIsolation({ root, repository, suffix })
await Promise.all([mkdir(home, { recursive: true }), mkdir(config, { recursive: true })])
const preload = join(root, 'isolate.cjs')
await writeFile(
  preload,
  `const {app}=require('electron');app.setPath('home',process.env.UPGRADE_HOME);app.setPath('logs',process.env.UPGRADE_LOGS);\n`
)
const identity = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: checkout,
  encoding: 'utf8'
}).trim()
const version = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8')).version
const env = {
  ...process.env,
  UPGRADE_HOME: home,
  UPGRADE_LOGS: join(root, 'logs'),
  OPEN_SCIENCE_STORAGE_ROOT: config,
  OPEN_SCIENCE_CONFIG_ROOT: config,
  OPEN_SCIENCE_USER_DATA: join(root, 'profile'),
  OPEN_SCIENCE_E2E_WINDOW_MODE: 'hidden'
}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.OPEN_SCIENCE_E2E_STORAGE_ROOT
const app = await electron.launch({
  cwd: checkout,
  env,
  args: [
    `--user-data-dir=${join(root, 'profile')}`,
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    '--require',
    preload,
    ...(version === '0.2.2' || process.platform !== 'darwin'
      ? []
      : ['--require', join(repository, 'e2e/fixtures/mock-credential-identity.cjs')]),
    checkout
  ]
})
const page = await app.firstWindow()
async function ready(operation) {
  let lastError
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  throw lastError
}
const evidencePath = join(root, 'evidence.json')
try {
  await ready(() => page.evaluate(() => window.api.projects.list()))
  if (mode === 'seed') {
    if (version === '0.2.2') await page.evaluate(() => window.api.settings.markOnboardingComplete())
    const project = await page.evaluate(
      (version) =>
        window.api.projects.create({
          name: `Historical ${version} research`,
          description: 'Created by the historical tag application'
        }),
      version
    )
    const content = `Historical ${version} evidence retained verbatim`
    let uploadPath
    if (version === '0.2.2') {
      let uploads = await page.evaluate(
        (content) =>
          window.api.uploads.stageFiles({
            files: [
              { name: 'historical-evidence.txt', content: btoa(content), mimeType: 'text/plain' }
            ]
          }),
        content
      )
      uploads = await page.evaluate(
        (attachments) =>
          window.api.uploads.finalizeSession({
            sessionId: 'historical-upgrade-session',
            attachments
          }),
        uploads
      )
      uploadPath = uploads[0].path
    } else {
      // Modern upload publication requires a live model session. This branch tests a
      // fixture workspace file, while the v0.2.2 branch verifies a real historical upload.
      const info = await ready(() => page.evaluate(() => window.api.storage.getInfo()))
      assert.equal(await realpath(info.dataRoot), await realpath(expected))
      uploadPath = join(expected, 'workspaces', 'upgrade-fixture', 'evidence.txt')
      await mkdir(join(expected, 'workspaces', 'upgrade-fixture'), { recursive: true })
      await writeFile(uploadPath, content)
    }
    const settings = JSON.parse(await readFile(join(config, 'settings.json'), 'utf8'))
    assert.equal(settings.dataRoot, undefined)
    assert.ok(settings.onboardingCompletedAt)
    assert.ok(uploadPath && isWithin(expected, uploadPath) && uploadPath !== expected)
    const evidence = {
      version,
      identity,
      project,
      uploadRelativePath: relative(expected, uploadPath),
      content,
      onboardingCompletedAt: settings.onboardingCompletedAt,
      originalDataRoot: null,
      fileOrigin: version === '0.2.2' ? 'historical-upload-API' : 'test-owned-workspace-fixture'
    }
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2))
    console.log('SEEDED', JSON.stringify(evidence))
  } else {
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    const info = await ready(() => page.evaluate(() => window.api.storage.getInfo()))
    const projects = await page.evaluate(() => window.api.projects.list())
    const settings = JSON.parse(await readFile(join(config, 'settings.json'), 'utf8'))
    assert.equal(await realpath(info.dataRoot), await realpath(expected))
    assert.equal(settings.dataRoot, missing === 'missing' ? undefined : info.dataRoot)
    assert.equal(settings.onboardingCompletedAt, evidence.onboardingCompletedAt)
    assert.ok(
      projects.some(
        (project) => project.id === evidence.project.id && project.name === evidence.project.name
      )
    )
    assert.equal(
      await readFile(join(expected, evidence.uploadRelativePath), 'utf8'),
      evidence.content
    )
    if (mode === 'migrate') {
      const parent = join(root, 'relocated')
      await mkdir(parent, { recursive: true })
      const result = await page.evaluate(async (parent) => {
        const inspection = await window.api.storage.inspectDataRoot(parent)
        if (!['move', 'recover'].includes(inspection.kind) || !inspection.selection)
          throw new Error(JSON.stringify(inspection))
        const migration =
          inspection.kind === 'recover'
            ? { ok: true }
            : await window.api.storage.migrate(parent, inspection.selection)
        return { inspection, migration }
      }, parent)
      assert.equal(result.migration.ok, true)
      // Prevent an uncontrolled child process; let production commit and shutdown still execute.
      await app.evaluate(({ app }) => {
        app.relaunch = () => {}
      })
      await page
        .evaluate((parent) => window.api.storage.commitAndRelaunch(parent), parent)
        .catch((error) => {
          if (!/closed|destroyed/.test(String(error))) throw error
        })
      const committed = JSON.parse(await readFile(join(config, 'settings.json'), 'utf8'))
      assert.equal(committed.dataRoot, result.inspection.dataRoot)
      await writeFile(join(root, 'migration.json'), JSON.stringify(result, null, 2))
    } else {
      await page.screenshot({ path: join(root, `verified-${version}.png`) })
      const result = {
        version,
        identity,
        dataRoot: info.dataRoot,
        savedDataRoot: settings.dataRoot ?? null,
        projectRetained: true,
        fileRetained: true,
        fileOrigin: evidence.fileOrigin ?? 'historical-upload-API'
      }
      await writeFile(join(root, `verified-${version}.json`), JSON.stringify(result, null, 2))
      console.log('VERIFIED', JSON.stringify(result))
    }
  }
} finally {
  await app.close().catch(() => {})
}
