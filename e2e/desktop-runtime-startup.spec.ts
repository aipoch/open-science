import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { electronLaunchTarget, launchEnvironment } from './fixtures/electron-app'

// eslint-disable-next-line no-empty-pattern
test('installation manifests capture physical ASAR bytes in Electron and reject external links', async ({}) => {
  const { build } = await import('esbuild')
  const { createPackage } = await import('@electron/asar')
  const { symlink, copyFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'installation-asar-'))
  let application: ElectronApplication | undefined
  try {
    const bundle = join(root, 'Open-Science.app')
    const resources = join(bundle, 'Contents', 'Resources')
    const source = join(root, 'archive-source')
    await Promise.all([resources, source].map((path) => mkdir(path, { recursive: true })))
    await writeFile(join(source, 'index.js'), 'throw Error("Archive code must not execute")')
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({ version: '9.1.0', main: 'index.js' })
    )
    const archive = join(resources, 'app.asar')
    await createPackage(source, archive)
    const expectedHash = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex')
    const versionRoot = join(root, 'version-install')
    await mkdir(join(versionRoot, 'resources'), { recursive: true })
    await copyFile(archive, join(versionRoot, 'resources', 'app.asar'))
    await build({
      stdin: {
        contents: `export { captureInstallationManifest, captureInstallationManifestAsync, verifyInstallationManifest, verifyInstallationManifestAsync } from './src/main/update/installation-protection'; export { readPackagedVersion } from './src/main/update/installation-artifact'`,
        resolveDir: process.cwd()
      },
      outfile: join(root, 'manifest.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      define: { 'import.meta.url': '__entryUrl' },
      // Electron ignores NODE_PATH. Resolve external fixture dependencies from this checkout.
      banner: {
        js: `const __entryUrl = require('node:url').pathToFileURL(__filename).href; require = require('node:module').createRequire(${JSON.stringify(resolve('package.json'))});`
      }
    })
    await writeFile(
      join(root, 'main.cjs'),
      `globalThis.manifestTest = require('./manifest.cjs'); require('electron').app.whenReady();`
    )
    application = await electron.launch({
      args: [join(root, 'main.cjs'), `--user-data-dir=${join(root, 'profile')}`]
    })
    const run = async (): Promise<{ sync: unknown; async: unknown }> =>
      application!.evaluate(async (_electron, bundle) => {
        const api = (
          globalThis as unknown as {
            manifestTest: typeof import('../src/main/update/installation-protection')
          }
        ).manifestTest
        return {
          sync: api.captureInstallationManifest(bundle, '9.1.0'),
          async: await api.captureInstallationManifestAsync(bundle, '9.1.0')
        }
      }, bundle)
    const expected = {
      version: '9.1.0',
      files: { [join('Contents', 'Resources', 'app.asar')]: expectedHash }
    }
    expect(await run()).toEqual({ sync: expected, async: expected })
    expect(
      await application.evaluate(async (_electron, versionRoot) => {
        const api = (
          globalThis as unknown as {
            manifestTest: typeof import('../src/main/update/installation-artifact')
          }
        ).manifestTest
        return api.readPackagedVersion(versionRoot)
      }, versionRoot)
    ).toBe('9.1.0')
    const verify = async (): Promise<boolean[]> =>
      application!.evaluate(
        async (_electron, { bundle, expected }) => {
          const api = (
            globalThis as unknown as {
              manifestTest: typeof import('../src/main/update/installation-protection')
            }
          ).manifestTest
          return [
            api.verifyInstallationManifest(bundle, expected),
            await api.verifyInstallationManifestAsync(bundle, expected)
          ]
        },
        { bundle, expected }
      )
    expect(await verify()).toEqual([true, true])
    await writeFile(join(source, 'index.js'), 'throw Error("Changed archive")')
    await createPackage(source, archive)
    expect(await verify()).toEqual([false, false])
    if (process.platform !== 'win32') {
      await symlink(join(source, 'index.js'), join(resources, 'external'))
      await expect(
        application.evaluate(async (_electron, bundle) => {
          await (
            globalThis as unknown as {
              manifestTest: typeof import('../src/main/update/installation-protection')
            }
          ).manifestTest.captureInstallationManifestAsync(bundle, '9.1.0')
        }, bundle)
      ).rejects.toThrow('Unsupported installation link or file')
    }
  } finally {
    await application?.close()
    await rm(root, { recursive: true, force: true })
  }
})

// eslint-disable-next-line no-empty-pattern
test('unverified legacy stop preserves its owner and retries into a usable Desktop', async ({}) => {
  test.skip(
    process.platform !== 'darwin' || Boolean(process.env.OPEN_SCIENCE_E2E_EXECUTABLE),
    'Source credential fixture'
  )
  const root = await mkdtemp(join(tmpdir(), 'legacy-recheck-e2e-'))
  const config = join(root, 'config'),
    profile = join(root, 'profile')
  await mkdir(config)
  const env = { ...launchEnvironment(config), OPEN_SCIENCE_USER_DATA: profile }
  let app: ElectronApplication | undefined
  const legacy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
  })
  const requests: string[] = []
  const generation = randomUUID(),
    token = randomUUID()
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end()
      return
    }
    if (request.method !== 'GET' || request.url !== '/owner') {
      response.writeHead(503).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ generation, pid: legacy.pid }))
  })
  try {
    app = await electron.launch({ ...electronLaunchTarget(profile), env })
    let page = await app.firstWindow()
    await expect
      .poll(() => page.evaluate(() => window.api.databaseStartup.getState()), { timeout: 60000 })
      .toMatchObject({ phase: 'ready' })
    const project = await page.evaluate(() =>
      window.api.projects.create({ name: 'Preserved legacy recheck project' })
    )
    const seedDesktop = app.process()
    void app.close().catch(() => undefined)
    await expect.poll(() => seedDesktop.exitCode, { timeout: 25000 }).toBe(0)
    app = undefined
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    await writeFile(join(config, 'web-token'), token)
    await writeFile(
      join(config, 'runtime-owner.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation,
        pid: legacy.pid,
        host: 'node',
        port: address.port,
        desktop: {
          path: join(root, 'legacy.sock'),
          generation: randomUUID(),
          secret: 'a'.repeat(64),
          version: 'old'
        }
      })
    )
    expect(legacy.pid).toBeGreaterThan(0)
    const originalOwner = await readFile(join(config, 'runtime-owner.json'), 'utf8')
    app = await electron.launch({ ...electronLaunchTarget(profile), env })
    page = await app.firstWindow()
    await expect(
      page.getByRole('button', { name: 'Close it and continue', exact: true })
    ).toBeVisible({
      timeout: 30000
    })
    await page.getByRole('button', { name: 'Close it and continue', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled()
    expect(requests).toContain('POST /web/start?port=0')
    expect(
      requests.every((request) => ['GET /owner', 'POST /web/start?port=0'].includes(request))
    ).toBe(true)
    expect(await readFile(join(config, 'runtime-owner.json'), 'utf8')).toBe(originalOwner)
    expect(legacy.exitCode).toBeNull()
    expect(legacy.signalCode).toBeNull()
    const exited = once(legacy, 'exit')
    legacy.kill('SIGTERM')
    await exited
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    const replacement = app.waitForEvent('window')
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    const workspace = await replacement
    await expect
      .poll(() => workspace.evaluate(() => window.api?.runtimeStartup?.getState()), {
        timeout: 60000
      })
      .toMatchObject({ phase: 'ready' })
    await expect
      .poll(() => workspace.evaluate(() => window.api.databaseStartup.getState()))
      .toMatchObject({ phase: 'ready' })
    expect(app.process().exitCode).toBeNull()
    expect(
      await workspace.evaluate(
        async (id) => (await window.api.projects.list()).some((project) => project.id === id),
        project.id
      )
    ).toBe(true)
  } finally {
    if (legacy.exitCode === null && legacy.signalCode === null) {
      const exited = once(legacy, 'exit')
      legacy.kill('SIGTERM')
      await exited
    }
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (app) {
      const desktop = app.process()
      void app.close().catch(() => undefined)
      await expect.poll(() => desktop.exitCode, { timeout: 25000 }).toBe(0)
    }
    await rm(root, { recursive: true, force: true })
  }
})

// eslint-disable-next-line no-empty-pattern
test('guides legacy shutdown through failure, retry and opening the saved project', async ({}, testInfo) => {
  test.skip(
    process.platform !== 'darwin' || Boolean(process.env.OPEN_SCIENCE_E2E_EXECUTABLE),
    'Source credential fixture'
  )
  const { build } = await import('esbuild')
  const root = await mkdtemp(join(tmpdir(), 'legacy-guided-stop-'))
  const config = join(root, 'config'),
    profile = join(root, 'profile')
  await mkdir(config)
  const env = { ...launchEnvironment(config), OPEN_SCIENCE_USER_DATA: profile }
  let app: ElectronApplication | undefined
  let service: ChildProcess | undefined
  try {
    app = await electron.launch({ ...electronLaunchTarget(profile), env })
    let page = await app.firstWindow()
    await expect
      .poll(() => page.evaluate(() => window.api.databaseStartup.getState()), { timeout: 60000 })
      .toMatchObject({ phase: 'ready' })
    const project = await page.evaluate(() =>
      window.api.projects.create({ name: 'Saved before upgrade' })
    )
    await page.evaluate(() => window.api.settings.markOnboardingComplete())
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'zh-Hans' }))
    await app.close()
    app = undefined
    const entry = join(root, 'service.cjs')
    await build({
      stdin: {
        contents: `
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startRuntimeControl} from './src/main/runtime-control';
import {acquireRuntimeDirectorySync} from './src/main/runtime-ownership';
const root=process.argv[2], lease=acquireRuntimeDirectorySync(root);
let attempts=0;
async function main() {
 const server=createServer(async(req,res)=>{
  const token=(await readFile(join(root,'web-token'),'utf8')).trim();
  if(req.url!='/api/shutdown'||req.headers.authorization!=='Bearer '+token){res.writeHead(403).end();return;}
  await writeFile(join(root,'shutdown-attempts'),String(++attempts));
  if(attempts===1){res.writeHead(503).end();return;}
  res.writeHead(202).end();
  setTimeout(()=>server.close(async()=>{await control.close();lease.release();}),1200);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port;
 await writeFile(join(root,'web-service.json'),JSON.stringify({pid:process.pid,port}));
 const control=await startRuntimeControl(root,'node',async()=>port,{path:join(root,'runtime.sock'),generation:randomUUID(),secret:'a'.repeat(64),version:'0.37.1'});
 process.send('ready');
}main();`,
        resolveDir: process.cwd()
      },
      outfile: entry,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
    service = spawn(process.execPath, [entry, config], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NODE_PATH: resolve('node_modules') }
    })
    await once(service, 'message')
    service.disconnect()
    app = await electron.launch({ ...electronLaunchTarget(profile), env })
    page = await app.firstWindow()
    const continueButton = page.getByRole('button', {
      name: '关闭并继续',
      exact: true
    })
    await expect(continueButton).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('real-startup.png'), animations: 'disabled' })
    await expect(readFile(join(config, 'shutdown-attempts'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(service.exitCode).toBeNull()
    await continueButton.click()
    await expect
      .poll(() => readFile(join(config, 'shutdown-attempts'), 'utf8').catch(() => ''))
      .toBe('1')
    const retryButton = page.getByRole('button', { name: '重试', exact: true })
    await expect(retryButton).toBeEnabled()
    await expect(
      page.getByText('你的项目是安全的。请重试，或保存报告以便我们协助。', { exact: true })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: '恢复应用', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('real-retry.png'), animations: 'disabled' })
    const replacement = app.waitForEvent('window')
    await retryButton.click()
    await expect(page.locator('[data-runtime-startup-state="S26"]')).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('real-stopping.png'),
      animations: 'disabled'
    })
    const workspace = await replacement
    await expect.poll(() => service!.exitCode).toBe(0)
    await expect
      .poll(() => workspace.evaluate(() => window.api.databaseStartup.getState()), {
        timeout: 60000
      })
      .toMatchObject({ phase: 'ready' })
    expect(
      await workspace.evaluate(
        async (id) => (await window.api.projects.list()).some((project) => project.id === id),
        project.id
      )
    ).toBe(true)
    expect(await readFile(join(config, 'shutdown-attempts'), 'utf8')).toBe('2')
    await expect(
      workspace.locator('header').getByRole('button', { name: '新建项目', exact: true })
    ).toBeVisible()
    await expect(workspace.getByText('Saved before upgrade', { exact: true }).first()).toBeVisible()
    await workspace.getByText('Saved before upgrade', { exact: true }).first().click()
    await expect(workspace.getByRole('button', { name: '所有项目', exact: true })).toBeVisible()
    await workspace.screenshot({
      path: testInfo.outputPath('real-project.png'),
      animations: 'disabled'
    })
    expect(app.process().exitCode).toBeNull()
  } finally {
    await app?.close()
    if (service && service.exitCode === null && service.signalCode === null) {
      const exited = once(service, 'exit')
      service.kill('SIGKILL')
      await exited
    }
    await rm(root, { recursive: true, force: true })
  }
})
