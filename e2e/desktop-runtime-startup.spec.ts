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
test('legacy service recheck hands the startup window to a usable Desktop', async ({}) => {
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
  const requests: string[] = []
  const generation = randomUUID(),
    token = randomUUID()
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ generation, pid: process.pid }))
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
        pid: process.pid,
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
    const originalOwner = await readFile(join(config, 'runtime-owner.json'), 'utf8')
    app = await electron.launch({ ...electronLaunchTarget(profile), env })
    page = await app.firstWindow()
    await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeVisible({
      timeout: 30000
    })
    await page.getByRole('button', { name: 'Check again', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled()
    expect(requests.every((request) => request === 'GET /owner')).toBe(true)
    expect(await readFile(join(config, 'runtime-owner.json'), 'utf8')).toBe(originalOwner)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    const replacement = app.waitForEvent('window')
    await page.getByRole('button', { name: 'Check again', exact: true }).click()
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
test('guides legacy shutdown through cancellation, retry and opening the saved project', async ({}) => {
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
  server.close(async()=>{await control.close();lease.release();});
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
      name: 'Stop service and continue',
      exact: true
    })
    await expect(continueButton).toBeVisible()
    await continueButton.click()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(readFile(join(config, 'shutdown-attempts'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(service.exitCode).toBeNull()
    await continueButton.click()
    await page.getByRole('button', { name: 'Stop service', exact: true }).click()
    await expect
      .poll(() => readFile(join(config, 'shutdown-attempts'), 'utf8').catch(() => ''))
      .toBe('1')
    await expect(continueButton).toBeEnabled()
    await expect(
      page.getByText(
        'The service could not be stopped or checked. Try again, or save diagnostics for help.',
        { exact: true }
      )
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Recover app', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeEnabled()
    const replacement = app.waitForEvent('window')
    await continueButton.click()
    await page.getByRole('button', { name: 'Stop service', exact: true }).click()
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
