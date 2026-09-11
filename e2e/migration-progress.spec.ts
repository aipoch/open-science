/* eslint-disable no-empty-pattern -- Electron tests do not use a Playwright browser fixture. */
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

const root = process.cwd()
const environment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RENDERER_URL: '' }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

test('macOS startup hides the blocked owner Dock icon until ready without opening the real profile', async () => {
  test.skip(process.platform !== 'darwin', 'Native macOS activation policy')
  const fixture = await mkdtemp(join(tmpdir(), 'open-science-dock-migration-'))
  const entry = join(fixture, 'owner.cjs')
  const evidence = join(fixture, 'dock.json')
  const source = resolve('src/main/brand-path-migration.ts')
  // Bundle the real startup adapter. Wrap the app boundary only to observe native Dock state;
  // migration, Electron activation policy, ready and filesystem operations all remain real.
  await build({
    stdin: {
      contents: `
        const { app } = require('electron');
        const { writeFileSync, mkdirSync } = require('node:fs');
        const { join } = require('node:path');
        const { prepareBrandPathMigration } = require(${JSON.stringify(source)});
        const fixture = ${JSON.stringify(fixture)};
        for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) {
          const path = join(fixture, name); mkdirSync(path); app.setPath(name, path);
        }
        app.commandLine.appendSwitch('open-science-headless');
        let hiddenBeforeReady;
        prepareBrandPathMigration({
          isPackaged: false,
          getAppPath: () => ${JSON.stringify(root)},
          getPath: app.getPath.bind(app),
          commandLine: app.commandLine,
          on: app.on.bind(app), once: app.once.bind(app),
          setActivationPolicy(policy) {
            app.setActivationPolicy(policy);
            if (policy === 'accessory') hiddenBeforeReady = !app.dock.isVisible() && !app.isReady();
          }
        });
        app.whenReady().then(() => {
          writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({hiddenBeforeReady, visibleAfterReady: app.dock.isVisible()}));
          app.quit();
        });`,
      resolveDir: root,
      loader: 'ts'
    },
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external'
  })
  const executable = createRequire(resolve('package.json'))('electron') as string
  const child = spawn(executable, [entry], {
    env: { ...environment(), OPEN_SCIENCE_E2E_STORAGE_ROOT: fixture },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const timer = setTimeout(() => child.kill(), 60000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('exit', resolve)
      child.once('error', reject)
    })
    expect(code, stderr).toBe(0)
    expect(JSON.parse(await readFile(evidence, 'utf8'))).toEqual({
      hiddenBeforeReady: true,
      visibleAfterReady: true
    })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await rm(fixture, { recursive: true, force: true })
  }
})

test('shows an isolated progress window and retains a failure without opening the real profile', async ({}, info) => {
  const fixture = await mkdtemp(join(tmpdir(), 'open-science-progress-e2e-'))
  const profile = join(fixture, 'legacy-profile')
  await mkdir(profile)
  await writeFile(join(profile, 'Preferences'), 'preserve-original-profile')
  const application = await electron.launch({
    args: [`--user-data-dir=${profile}`, root, '--brand-migration-progress-window'],
    env: {
      ...environment(),
      OPEN_SCIENCE_STORAGE_ROOT: fixture,
      OPEN_SCIENCE_MIGRATION_LOCALE: 'zh-Hans'
    }
  })
  try {
    const page = await application.firstWindow()
    await expect(page.getByRole('heading', { name: '正在升级本地数据' })).toBeVisible()
    const paths = await application.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
      logs: app.getPath('logs')
    }))
    for (const value of Object.values(paths)) {
      expect(value).toContain('open-science-migration-ui-')
      expect(value.startsWith(fixture)).toBe(false)
    }
    await application.evaluate(() => {
      ;(process as NodeJS.EventEmitter).emit('message', {
        type: 'progress',
        event: { phase: 'scanning', path: '/fixture/workspace', completed: 2816 }
      })
    })
    await expect(page.getByText('已检查条目：2816')).toBeVisible()
    await page.screenshot({ path: info.outputPath('migration-progress.png') })
    // Closing during an active transaction must not silently discard the only visible progress.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect(page.getByRole('heading', { name: '正在升级本地数据' })).toBeVisible()
    await application.evaluate(() => process.emit('disconnect'))
    await expect(page.getByText('无法获取迁移进度。')).toBeVisible()
    await application.evaluate(() =>
      (process as NodeJS.EventEmitter).emit('message', {
        type: 'failed',
        error: 'Migration paths are occupied (PID 123)'
      })
    )
    await expect(page.getByText('本地数据迁移未能完成')).toBeVisible()
    await expect(page.getByText('Migration paths are occupied (PID 123)')).toBeVisible()
    await page.screenshot({ path: info.outputPath('migration-failure.png') })
    expect(await readFile(join(profile, 'Preferences'), 'utf8')).toBe('preserve-original-profile')
    expect(await readdir(profile)).toEqual(['Preferences'])
    await page.getByRole('button', { name: '关闭', exact: true }).click()
  } finally {
    await application
      .evaluate(() => (process as NodeJS.EventEmitter).emit('message', { type: 'complete' }))
      .catch(() => {})
    await application.close().catch(() => {})
    await rm(fixture, { recursive: true, force: true })
  }
})

test('actual startup CLI paints progress before migrating a disposable historical tree', async () => {
  test.skip(process.platform === 'win32', 'Native Windows migration requires an occupancy provider')
  const fixture = await mkdtemp(join(tmpdir(), 'open-science-progress-pipeline-'))
  const old = join(fixture, 'OpenScience-DEV')
  await mkdir(old)
  await writeFile(join(old, 'history.txt'), 'historical-research')
  const executable = createRequire(resolve('package.json'))('electron') as string
  const child = spawn(
    executable,
    [
      resolve('resources/brand-migration/cli.mjs'),
      '--home',
      fixture,
      '--app-data',
      join(fixture, 'profiles'),
      '--mode',
      'dev',
      '--execute',
      '--startup-owner',
      String(process.pid),
      '--show-progress-window'
    ],
    {
      cwd: root,
      env: { ...environment(), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const timeout = setTimeout(() => child.kill(), 60000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('exit', resolve)
      child.once('error', reject)
    })
    expect(code, stderr).toBe(0)
    expect(stderr).toContain('[brand-migration]')
    expect(stderr).toContain('scanning')
    expect(stderr.indexOf('[brand-migration-ui] ready')).toBeGreaterThanOrEqual(0)
    expect(stderr.indexOf('[brand-migration-ui] ready')).toBeLessThan(stderr.indexOf('scanning'))
    expect(stderr).toContain('completed')
    expect(JSON.parse(stdout).status).toBe('committed')
    expect(await readFile(join(fixture, 'Open-Science-DEV', 'history.txt'), 'utf8')).toBe(
      'historical-research'
    )
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await rm(fixture, { recursive: true, force: true })
  }
})
