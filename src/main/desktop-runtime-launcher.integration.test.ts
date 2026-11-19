import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { inspectInstallationProcessesAsync } from './update/installation-occupancy'
import { processBirthIdentity } from './process-birth-identity'
import { prefetchSystemBootIdentity } from './system-boot-identity'
import {
  inspectInstallationAvailability,
  captureInstallationHelperExit,
  beginInstallationUpdateAsync,
  advanceInstallationUpdate,
  advanceInstallationUpdateAsync
} from './update/installation-protection'
import * as childProcess from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { build } from 'esbuild'
import { desktopBackendPaths, startOrAttachDesktopBackend } from './desktop-runtime-launcher'
import { buildMacosServiceLauncher } from '../../scripts/build-macos-service-launcher.mjs'
import { resolveElectronProfile } from './storage/electron-profile'
const children = vi.hoisted(() => [] as ChildProcess[])
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args)
      children.push(child)
      return child
    }
  }
})
const roots: string[] = []
const replacements: { pid: number; birth: string }[] = []
afterEach(async () => {
  for (const { pid, birth } of replacements.splice(0)) {
    if (processBirthIdentity(pid) === birth) {
      process.kill(pid, 'SIGTERM')
      await vi.waitFor(() => expect(processBirthIdentity(pid)).not.toBe(birth))
    }
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      await exited
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
// The subprocess models only discovery/startup. Business ownership races have their own real
// SQLite-lock integration suite; this test proves actual ChildProcess lifetime and ordinary Node.
const fixtureSource = `
const http=require('node:http'), fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const root=process.env.OPEN_SCIENCE_CONFIG_ROOT, generation=crypto.randomUUID(), token='x'.repeat(43);
fs.writeFileSync(path.join(root,'web-token'),token);
fs.writeFileSync(path.join(root,'launched.json'),JSON.stringify({electron:process.versions.electron??null,asNode:process.env.ELECTRON_RUN_AS_NODE??null,argv:process.argv,configRoot:root,userData:process.env.OPEN_SCIENCE_USER_DATA??null}));
const desktopGeneration=crypto.randomUUID();
const startupOptions={configRoot:root,dataRoot:root,profilePath:root,port:0,host:'127.0.0.1',credentialStore:'os'};
const server=http.createServer((req,res)=>{
 if(req.headers.authorization!=='Bearer '+token||req.headers['x-open-science-runtime-generation']!==generation){res.writeHead(403).end();return;}
 res.end(JSON.stringify({generation,pid:process.pid,desktopGeneration,startupOptions,entryPath:fs.realpathSync(process.argv[1])}));
});
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(path.join(root,'runtime-owner.json'),JSON.stringify({schemaVersion:1,generation,pid:process.pid,host:'node',port:server.address().port,desktop:{path:path.join(root,'fixture.sock'),generation:desktopGeneration,secret:'a'.repeat(64),version:'test'}})));
process.once('SIGTERM',()=>server.close());
`
describe('ordinary Node desktop launcher', () => {
  it.each(['desktop', 'cli'])(
    'admits launch-log readers, rejects foreign occupants, and releases the installation on shutdown (%s)',
    async (surface) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'update-launch-ownership-')))
      roots.push(root)
      const installationRoot = join(root, 'installed app')
      const configRoot = join(root, 'config')
      const stateRoot = join(root, 'state')
      const entry = join(installationRoot, 'resources/backend/out/backend/index.cjs')
      const command = join(installationRoot, 'node' + (process.platform === 'win32' ? '.exe' : ''))
      const bootstrap = join(installationRoot, 'resources/backend/installation-startup.cjs')
      await mkdir(dirname(entry), { recursive: true })
      await mkdir(configRoot)
      await copyFile(process.execPath, command)
      await copyFile('packages/open-science/installation-startup.cjs', bootstrap)
      const previousStateRoot = process.env.OPEN_SCIENCE_INSTALLATION_STATE_ROOT
      process.env.OPEN_SCIENCE_INSTALLATION_STATE_ROOT = stateRoot
      try {
        await build({
          stdin: {
            contents: `import { registerInstallationRuntime } from './src/main/update/installation-protection';
import * as log from './packages/open-science/launch-log.mjs';
async function main() {
${fixtureSource
  .replace(
    ' res.end(JSON.stringify({generation,pid:process.pid,desktopGeneration',
    ` if(req.url==='/restart') {
      res.end('restarting');
      setImmediate(()=>{
        const child=log.restartWithLaunchLogReader(launchLogControl);
        child.unref();process.exit(0);
      });return;
    }
    if(req.url==='/stop') {
      // The writer must outlive the backend on Windows to hold the reader's input open.
      const writer=require('node:child_process').spawn(${JSON.stringify(process.execPath)}, ['-e',
        "const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])||!fs.existsSync(require('node:path').dirname(process.argv[1])))clearInterval(timer)},20);setTimeout(()=>process.exit(0),120000).unref()",
        ${JSON.stringify(join(root, 'release-reader'))}], {detached:true,windowsHide:true,stdio:['ignore','inherit','inherit']});
      writer.once('spawn',()=>{ writer.unref();res.end('stopping');server.close(); });return;
    }
    res.end(JSON.stringify({generation,pid:process.pid,desktopGeneration`
  )
  .replace(
    'const server=http',
    'setTimeout(()=>process.exit(2),300000).unref();\nconst server=http'
  )
  .replace(
    "req.headers['x-open-science-runtime-generation']!==generation",
    "(req.url!=='/api/bootstrap'&&req.headers['x-open-science-runtime-generation']!==generation)"
  )
  .replace(
    'server.listen(',
    `const installationLease=registerInstallationRuntime({installationRoot:${JSON.stringify(installationRoot)}, configRoot:root, generation});
process.once('exit',()=>installationLease.release());
const launchLogControl=await log.bindLaunchLogReader();
server.listen(`
  )}
} main().catch(error => {console.error(error);process.exit(1)});`,
            resolveDir: process.cwd()
          },
          outfile: entry,
          bundle: true,
          platform: 'node',
          format: 'cjs',
          packages: 'external',
          banner: {
            js: `require = require('node:module').createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))});`
          }
        })
        const options = {
          configRoot,
          profilePath: configRoot,
          version: 'test',
          command,
          entry,
          packaged: true,
          timeoutMs: 10000
        }
        let backendProcess: ChildProcess | undefined
        if (surface === 'desktop') {
          backendProcess = (await startOrAttachDesktopBackend(options)).startedProcess
        } else {
          const { startCommand } = await import(
            pathToFileURL(join(process.cwd(), 'packages/open-science/cli.mjs')).href
          )
          const result = await startCommand(
            { configRoot, port: 0, timeoutMs: 10000 },
            {
              locateBackend: async () => ({ command, entry, development: false }),
              findServiceState: async () => {
                try {
                  return {
                    ...JSON.parse(await readFile(join(configRoot, 'runtime-owner.json'), 'utf8')),
                    configRoot
                  }
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
                  throw error
                }
              },
              readWebToken: async () => readFile(join(configRoot, 'web-token'), 'utf8'),
              isAlive: (pid: number) => {
                try {
                  process.kill(pid, 0)
                  return true
                } catch {
                  return false
                }
              },
              fetch,
              now: Date.now,
              sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
              log: () => {},
              warn: () => {}
            }
          )
          expect(result.started).toBe(true)
          backendProcess = children.find((child) => child.pid === result.state.pid)
        }
        expect(backendProcess).toBeDefined()
        const owner = JSON.parse(await readFile(join(configRoot, 'runtime-owner.json'), 'utf8'))
        const location = { installationRoot, stateRoot }
        const runtime = { pid: owner.pid, generation: owner.generation, configRoot }
        const reader = children.find((child) => child.spawnargs.includes('--input-type=commonjs'))
        expect(reader?.pid).toBeDefined()
        const readerBirth = processBirthIdentity(reader!.pid!)
        expect(readerBirth).toBeTruthy()
        const expectAvailable = async (expectedRuntime: typeof runtime): Promise<void> => {
          const runtimeBirth = processBirthIdentity(expectedRuntime.pid)
          expect(runtimeBirth).toBeTruthy()
          // Hosted Windows provisioning can briefly hold the executable after a launch.
          // Keep both intended processes live while waiting for actual admission.
          await vi.waitFor(
            async () => {
              await expect(
                inspectInstallationAvailability({
                  ...location,
                  runtime: expectedRuntime
                })
              ).resolves.toBeUndefined()
              expect(processBirthIdentity(expectedRuntime.pid)).toBe(runtimeBirth)
              expect(processBirthIdentity(reader!.pid!)).toBe(readerBirth)
            },
            { timeout: 60000, interval: 250 }
          )
        }
        await expectAvailable(runtime)
        expect((await startOrAttachDesktopBackend(options)).startedProcess).toBeUndefined()
        await expectAvailable(runtime)
        const foreign = childProcess.spawn(
          command,
          ['-e', "process.stdout.write('ready');process.stdin.resume()"],
          { stdio: ['pipe', 'pipe', 'ignore'] }
        )
        const foreignExit = once(foreign, 'exit')
        await once(foreign.stdout!, 'data')
        try {
          await expect(
            inspectInstallationAvailability({ ...location, runtime })
          ).rejects.toMatchObject({
            reason: 'installation-busy',
            recovery: {
              detail: 'foreign-process',
              blockingProcesses: expect.arrayContaining([
                expect.objectContaining({ pid: foreign.pid })
              ])
            }
          })
        } finally {
          foreign.stdin!.end()
          await foreignExit
        }
        await expectAvailable(runtime)
        const restarted = once(backendProcess!, 'exit')
        await fetch(`http://127.0.0.1:${owner.port}/restart`, {
          headers: {
            authorization: 'Bearer ' + 'x'.repeat(43),
            'x-open-science-runtime-generation': owner.generation
          }
        })
        await restarted
        let replacement: typeof owner
        await vi.waitFor(
          async () => {
            replacement = JSON.parse(await readFile(join(configRoot, 'runtime-owner.json'), 'utf8'))
            expect(replacement.pid).not.toBe(owner.pid)
          },
          { timeout: 10000 }
        )
        const birth = processBirthIdentity(replacement.pid)
        expect(birth).toBeTruthy()
        replacements.push({ pid: replacement.pid, birth: birth! })
        await expectAvailable({
          pid: replacement.pid,
          generation: replacement.generation,
          configRoot
        })
        expect(await inspectInstallationProcessesAsync(installationRoot)).toEqual(
          expect.arrayContaining([replacement.pid, reader!.pid])
        )
        await prefetchSystemBootIdentity()
        const record = await beginInstallationUpdateAsync({
          ...location,
          runtime: { pid: replacement.pid, generation: replacement.generation, configRoot },
          currentVersion: '1',
          targetVersion: '2',
          targetManifest: { version: '2', files: {} },
          startupOptions: {
            configRoot,
            dataRoot: configRoot,
            profilePath: configRoot,
            port: 44100,
            host: '127.0.0.1',
            credentialStore: 'file'
          }
        })
        const waitForHelpers = captureInstallationHelperExit(location, record.runtime)
        advanceInstallationUpdate(location, record.operationId, 'stopping')
        const stopped = await fetch(`http://127.0.0.1:${replacement.port}/stop`, {
          headers: {
            authorization: 'Bearer ' + 'x'.repeat(43),
            'x-open-science-runtime-generation': replacement.generation
          }
        })
        expect(stopped.status).toBe(200)
        await vi.waitFor(() => expect(processBirthIdentity(replacement.pid)).toBeUndefined())
        expect(processBirthIdentity(reader!.pid!)).toBe(readerBirth)
        advanceInstallationUpdate(location, record.operationId, 'stopped', true, true)
        try {
          await expect(
            advanceInstallationUpdateAsync(location, record.operationId, 'handoff')
          ).rejects.toMatchObject({
            reason: 'installation-busy',
            recovery: {
              blockingProcesses: expect.arrayContaining([
                expect.objectContaining({ pid: reader!.pid })
              ])
            }
          })
        } finally {
          await writeFile(join(root, 'release-reader'), '')
          await waitForHelpers()
        }
        expect(processBirthIdentity(reader!.pid!)).toBeUndefined()
        await expect(
          advanceInstallationUpdateAsync(location, record.operationId, 'handoff')
        ).resolves.toMatchObject({ phase: 'handoff' })
      } finally {
        await writeFile(join(root, 'release-reader'), '')
        if (previousStateRoot === undefined) delete process.env.OPEN_SCIENCE_INSTALLATION_STATE_ROOT
        else process.env.OPEN_SCIENCE_INSTALLATION_STATE_ROOT = previousStateRoot
      }
    },
    240000
  )
  it.each([true, false])(
    'resolves bundled npm in the actual Node backend (packaged: %s)',
    async (packaged) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop npm 空间-')))
      roots.push(root)
      const paths = desktopBackendPaths({
        applicationPath: join(root, 'application'),
        resourcesPath: join(root, 'resources'),
        packaged
      })
      if (paths.serviceLauncher) buildMacosServiceLauncher(paths.serviceLauncher)
      const runtime = dirname(paths.command)
      const npmBin = join(runtime, 'node_modules/npm/bin')
      await mkdir(npmBin, { recursive: true })
      await mkdir(dirname(paths.entry), { recursive: true })
      await copyFile(process.execPath, paths.command)
      await writeFile(join(runtime, 'version.json'), '{"stagingVersion":2}')
      for (const name of ['npm', 'npx'])
        await writeFile(
          join(npmBin, `${name}-cli.js`),
          `process.stdout.write(JSON.stringify({node:process.execPath,args:process.argv.slice(2)}))`
        )
      const resolver = join(root, 'resolver.cjs')
      await build({
        stdin: {
          contents: `export { prepareMcpStdioLaunch } from './src/main/connectors/mcp-stdio-launch';
            export { EXTRA_PATH_DIRS } from './src/main/settings/shell-path';`,
          resolveDir: process.cwd(),
          loader: 'ts'
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: resolver
      })
      await writeFile(
        paths.entry,
        `const {prepareMcpStdioLaunch,EXTRA_PATH_DIRS}=require(${JSON.stringify(resolver)});
// Isolate installed-tool discovery only; process.execPath and the resolver are real.
EXTRA_PATH_DIRS.length=0;
const results=['npm','npx'].map(command=>{
 const launch=prepareMcpStdioLaunch({command,args:['space argument','a&b','$(literal)'],env:{...process.env,PATH:${JSON.stringify(join(root, 'empty-bin'))}}});
 const output=require('node:child_process').execFileSync(launch.command,launch.args,{env:launch.env,encoding:'utf8'});
 return {command:launch.command,result:JSON.parse(output)};
});
require('node:fs').writeFileSync(${JSON.stringify(join(root, 'npm-observed.json'))},JSON.stringify({electron:process.versions.electron??null,node:process.execPath,results}));
${fixtureSource}`
      )
      const launch = await startOrAttachDesktopBackend({
        configRoot: root,
        profilePath: root,
        version: 'test',
        ...paths,
        packaged,
        timeoutMs: 10000
      })
      expect(launch.startedProcess?.pid).toBeGreaterThan(0)
      const observed = JSON.parse(await readFile(join(root, 'npm-observed.json'), 'utf8'))
      expect(observed).toEqual({
        electron: null,
        node: paths.command,
        results: ['npm', 'npx'].map(() => ({
          command: paths.command,
          result: { node: paths.command, args: ['space argument', 'a&b', '$(literal)'] }
        }))
      })
    }
  )
  it.each(['deadline', 'abort'] as const)(
    'stops abandoned credential startup and its helper after %s',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'desktop-abandoned-credentials-'))
      roots.push(root)
      const entry = join(root, 'fixture.cjs')
      await writeFile(
        entry,
        `const fs = require('node:fs'), path = require('node:path');
      process.send({protocolVersion:1,attemptId:process.env.OPEN_SCIENCE_STARTUP_ATTEMPT,stage:'credentials',kind:'progress'});
      require('node:child_process').spawnSync(process.execPath, ['-e', "setTimeout(() => require('node:fs').writeFileSync(require('node:path').join(process.env.OPEN_SCIENCE_CONFIG_ROOT, 'late-startup'), 'continued'), 900)"]);
      setInterval(() => {}, 1000);`
      )
      const cancellation = new AbortController()
      await expect(
        startOrAttachDesktopBackend({
          configRoot: root,
          profilePath: root,
          version: 'test',
          command: process.execPath,
          entry,
          packaged: true,
          timeoutMs: mode === 'deadline' ? 300 : 5000,
          signal: cancellation.signal,
          onStatus() {
            if (mode === 'abort') cancellation.abort()
          }
        })
      ).rejects.toMatchObject(
        mode === 'deadline' ? { stage: 'credentials', canRetry: true } : { name: 'AbortError' }
      )
      await new Promise((resolve) => setTimeout(resolve, 1000))
      expect(await readdir(root)).not.toContain('late-startup')
    }
  )
  it('allows credential authorization beyond the ordinary startup deadline and retains retry after exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-credential-wait-'))
    roots.push(root)
    const entry = join(root, 'fixture.cjs')
    await writeFile(
      entry,
      `
      process.send({protocolVersion:1,attemptId:process.env.OPEN_SCIENCE_STARTUP_ATTEMPT,stage:'credentials',kind:'progress'});
      setTimeout(() => { process.send({protocolVersion:1,attemptId:process.env.OPEN_SCIENCE_STARTUP_ATTEMPT,stage:'credentials',kind:'failed',code:'credential-unavailable',reason:'native-secret-operation-failed'}); process.exitCode=1; process.disconnect(); }, 300);
    `
    )
    const now = Date.now.bind(Date)
    let elapsed = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed)
    try {
      await expect(
        startOrAttachDesktopBackend({
          configRoot: root,
          profilePath: root,
          version: 'test',
          command: process.execPath,
          entry,
          packaged: true,
          onStatus(status) {
            if (status.kind === 'progress') elapsed = 241_000
          }
        })
      ).rejects.toMatchObject({
        stage: 'credentials',
        canRetry: true,
        credentialFailure: { reason: 'native-secret-operation-failed' }
      })
    } finally {
      clock.mockRestore()
    }
  })
  it('hands a target-bound credential snapshot to one backend attempt and removes it after startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-launch-inventory-'))
    roots.push(root)
    const entry = join(root, 'fixture.cjs')
    await writeFile(
      entry,
      `const observedFs=require('node:fs');
const observedPath=require('node:path');
const inventoryPath=process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH;
const inventory=JSON.parse(observedFs.readFileSync(inventoryPath, 'utf8'));
observedFs.writeFileSync(observedPath.join(process.env.OPEN_SCIENCE_CONFIG_ROOT, 'inventory-observed.json'), JSON.stringify({ inventory, inventoryPath, existsDuringStartup: observedFs.existsSync(inventoryPath) }));
${fixtureSource}`
    )
    const profilePath = join(root, 'profile')
    const launch = await startOrAttachDesktopBackend({
      configRoot: root,
      profilePath,
      version: 'test',
      command: process.execPath,
      entry,
      packaged: true,
      credentialInventory: [Buffer.from('snapshot-ciphertext')],
      timeoutMs: 10000
    })
    const observed = JSON.parse(await readFile(join(root, 'inventory-observed.json'), 'utf8'))
    expect(observed).toMatchObject({
      inventory: {
        schemaVersion: 1,
        configRoot: root,
        profilePath,
        ciphertexts: [Buffer.from('snapshot-ciphertext').toString('base64')]
      },
      existsDuringStartup: true
    })
    expect(observed.inventory.attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    await expect(stat(observed.inventoryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH).toBeUndefined()
    expect(launch.startedProcess?.pid).toBeGreaterThan(0)
  })

  it('does not pass or remove an inherited snapshot when no new inventory is supplied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-launch-inherited-inventory-'))
    roots.push(root)
    const stalePath = join(root, 'stale-inventory.json')
    await writeFile(stalePath, JSON.stringify({ stale: true }))
    const entry = join(root, 'fixture.cjs')
    await writeFile(
      entry,
      `const observedFs=require('node:fs');
const observedPath=require('node:path').join(process.env.OPEN_SCIENCE_CONFIG_ROOT, 'inherited-observed.json');
observedFs.writeFileSync(observedPath, JSON.stringify({
  inventoryPath: process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH ?? null,
  inventoryDigest: process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256 ?? null,
  staleExists: observedFs.existsSync(${JSON.stringify(stalePath)})
}));
${fixtureSource}`
    )
    const previous = process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH
    const previousDigest = process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256
    process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH = stalePath
    process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256 = 'stale-digest'
    try {
      try {
        await startOrAttachDesktopBackend({
          configRoot: root,
          profilePath: join(root, 'profile'),
          version: 'test',
          command: process.execPath,
          entry,
          packaged: true,
          timeoutMs: 10000
        })
      } catch (error) {
        const logFiles = await readdir(join(root, 'logs')).catch(() => [])
        const log = (
          await Promise.all(
            logFiles.map((name) => readFile(join(root, 'logs', name), 'utf8').catch(() => ''))
          )
        ).join('\n')
        throw new Error(`${String(error)}\n${log}`, { cause: error })
      }
    } finally {
      if (previous === undefined) delete process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH
      else process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH = previous
      if (previousDigest === undefined) delete process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256
      else process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256 = previousDigest
    }
    expect(JSON.parse(await readFile(join(root, 'inherited-observed.json'), 'utf8'))).toEqual({
      inventoryPath: null,
      inventoryDigest: null,
      staleExists: true
    })
    await expect(stat(stalePath)).resolves.toBeDefined()
  })

  it('removes a credential snapshot when startup fails before publishing an endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-launch-inventory-failure-'))
    roots.push(root)
    const entry = join(root, 'fixture.cjs')
    await writeFile(
      entry,
      `const fs=require('node:fs');
const path=require('node:path');
const inventoryPath=process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH;
fs.writeFileSync(path.join(process.env.OPEN_SCIENCE_CONFIG_ROOT, 'failure-observed.json'), JSON.stringify({ exists: fs.existsSync(inventoryPath), inventory: JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) }));
process.exitCode=23;`
    )
    await expect(
      startOrAttachDesktopBackend({
        configRoot: root,
        profilePath: join(root, 'profile'),
        version: 'test',
        command: process.execPath,
        entry,
        packaged: true,
        credentialInventory: [Buffer.from('failed-startup')],
        timeoutMs: 2000
      })
    ).rejects.toThrow('exited during startup (23)')
    expect(JSON.parse(await readFile(join(root, 'failure-observed.json'), 'utf8')).exists).toBe(
      true
    )
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.credential-inventory-'))
    ).toEqual([])
  })

  it('requires a fresh desktop bootstrap instead of reusing inventory after an ownership conflict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-launch-inventory-retry-'))
    roots.push(root)
    const entry = join(root, 'fixture.cjs')
    const marker = join(root, 'first-attempt')
    await writeFile(
      entry,
      `const fs=require('node:fs');
const path=require('node:path');
const inventoryPath=process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH;
const observedPath=path.join(process.env.OPEN_SCIENCE_CONFIG_ROOT, 'retry-observed.json');
const observed=fs.existsSync(observedPath) ? JSON.parse(fs.readFileSync(observedPath, 'utf8')) : [];
observed.push({ exists: fs.existsSync(inventoryPath), inventory: JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) });
fs.writeFileSync(observedPath, JSON.stringify(observed));
if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(75); }
process.exit(23);`
    )
    await expect(
      startOrAttachDesktopBackend({
        configRoot: root,
        profilePath: join(root, 'profile'),
        version: 'test',
        command: process.execPath,
        entry,
        packaged: true,
        credentialInventory: [],
        timeoutMs: 2000,
        ownershipWaitMs: 100,
        terminationDeps: { lockHeld: () => false }
      })
    ).rejects.toThrow('inventory cannot be reused after an ownership conflict')
    const observed = JSON.parse(await readFile(join(root, 'retry-observed.json'), 'utf8'))
    expect(observed).toHaveLength(1)
    expect(observed.every((attempt: { exists: boolean }) => attempt.exists)).toBe(true)
    expect(
      observed.every(
        (attempt: { inventory: { ciphertexts: string[] } }) =>
          attempt.inventory.ciphertexts.length === 0
      )
    ).toBe(true)
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.credential-inventory-'))
    ).toEqual([])
  })

  it('re-spawns after an ownership conflict exit once the lock is released', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-launch-exit75-'))
    roots.push(root)
    const entry = join(root, 'fixture.cjs')
    const marker = join(root, 'first-attempt')
    await writeFile(
      entry,
      `{const f=require('node:fs');
if(!f.existsSync(${JSON.stringify(marker)})){f.writeFileSync(${JSON.stringify(marker)},'1');process.exit(75)}}
${fixtureSource}`
    )
    let locked = true
    const launched = await startOrAttachDesktopBackend({
      configRoot: root,
      profilePath: join(root, 'original-profile'),
      version: 'test',
      command: process.execPath,
      entry,
      packaged: true,
      timeoutMs: 10000,
      ownershipWaitMs: 3000,
      terminationDeps: {
        lockHeld: () => {
          const held = locked
          locked = false
          return held
        }
      }
    })
    expect(launched.startedProcess?.pid).toBeGreaterThan(0)
    expect(
      children.filter(
        (child) =>
          child.spawnargs.includes(entry) && !child.spawnargs.includes('--input-type=commonjs')
      )
    ).toHaveLength(2)
  })
  it('gives up with a recoverable error when the lock stays held after exit 75', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-launch-exit75-held-'))
    roots.push(root)
    const entry = join(root, 'fixture.cjs')
    await writeFile(entry, 'process.exit(75)')
    await expect(
      startOrAttachDesktopBackend({
        configRoot: root,
        profilePath: join(root, 'original-profile'),
        version: 'test',
        command: process.execPath,
        entry,
        packaged: true,
        timeoutMs: 10000,
        ownershipWaitMs: 300,
        terminationDeps: { lockHeld: () => true }
      })
    ).rejects.toThrow('still owned by another process')
  })
  it('releases the launch log reader if the backend executable disappears at spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-capture-spawn-failure-'))
    roots.push(root)
    const entry = join(root, 'fixture.cjs')
    await writeFile(entry, '')
    const spawn = childProcess.spawn
    const real = await vi.importActual<typeof childProcess>('node:child_process')
    const spy = vi
      .spyOn(childProcess, 'spawn')
      .mockImplementation((...args) =>
        Array.isArray(args[1]) &&
        args[1].includes(entry) &&
        !args[1].includes('--input-type=commonjs')
          ? real.spawn(join(root, 'missing-executable'), [], { stdio: 'ignore' })
          : spawn(...args)
      )
    try {
      await expect(
        startOrAttachDesktopBackend({
          configRoot: root,
          profilePath: root,
          version: 'test',
          command: process.execPath,
          entry,
          packaged: true
        })
      ).rejects.toMatchObject({ code: 'ENOENT' })
      expect(children).toHaveLength(1)
      await vi.waitFor(() => expect(children[0].exitCode).toBe(0))
    } finally {
      spy.mockRestore()
    }
  })
  it('reports a backend that exits cleanly before publishing an endpoint instead of a startup timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-launch-clean-exit-'))
    roots.push(root)
    const entry = join(root, 'failed.cjs')
    // The supplied logs stop at credential recovery; Node currently drains that failure with 0.
    await writeFile(
      entry,
      'console.error("[node-runtime] credential recovery required { reason: \'decryption-failed\' }"); process.exitCode = 0'
    )
    await expect(
      startOrAttachDesktopBackend({
        configRoot: root,
        profilePath: join(root, 'original-profile'),
        version: 'test',
        command: process.execPath,
        entry,
        packaged: true,
        timeoutMs: 1500
      })
    ).rejects.toThrow('exited during startup (0)')
  })
  it('returns classified credential recovery across the actual child-process boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-launch-credential-'))
    roots.push(root)
    const entry = join(root, 'failed.cjs')
    await writeFile(
      entry,
      `
      if (process.send) process.send({ protocolVersion: 1,
        attemptId: process.env.OPEN_SCIENCE_STARTUP_ATTEMPT,
        stage: 'credentials', kind: 'failed', code: 'credential-unavailable',
        reason: 'native-secret-operation-failed' });
      process.exitCode = 1;
    `
    )
    await expect(
      startOrAttachDesktopBackend({
        configRoot: root,
        profilePath: join(root, 'original-profile'),
        version: 'test',
        command: process.execPath,
        entry,
        packaged: true,
        timeoutMs: 1500
      })
    ).rejects.toMatchObject({
      stage: 'credentials',
      canRetry: true,
      credentialFailure: { reason: 'native-secret-operation-failed' }
    })
  })
  it.each(['wrong-attempt', 'unknown-reason', 'unknown-version'])(
    'ignores %s status instead of displaying untrusted recovery details',
    async (invalid) => {
      const root = await mkdtemp(join(tmpdir(), 'desktop-launch-status-'))
      roots.push(root)
      const entry = join(root, 'failed.cjs')
      await writeFile(
        entry,
        `
      process.send({ protocolVersion: ${invalid === 'unknown-version' ? 2 : 1},
        attemptId: ${invalid === 'wrong-attempt' ? "'a64f6d2b-5bc3-41fb-b63b-55ffb43af30b'" : 'process.env.OPEN_SCIENCE_STARTUP_ATTEMPT'},
        stage: 'credentials', kind: 'failed', code: 'credential-unavailable',
        reason: '${invalid === 'unknown-reason' ? 'private-token-secret' : 'decryption-failed'}' });
      process.exitCode = 1;
    `
      )
      const onStatus = vi.fn()
      const error = await startOrAttachDesktopBackend({
        configRoot: root,
        profilePath: join(root, 'profile'),
        version: 'test',
        command: process.execPath,
        entry,
        packaged: true,
        timeoutMs: 1500,
        onStatus
      }).catch((error: unknown) => error)
      expect(error).toMatchObject({ stage: 'bootstrap', canRetry: true })
      expect(error).toHaveProperty('credentialFailure', undefined)
      expect(onStatus).not.toHaveBeenCalled()
    }
  )

  it('returns the actual spawned handle, reuses the authenticated service and does not launch Electron', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-launch-process-'))
    roots.push(root)
    const entry = join(root, 'fixture.cjs')
    await writeFile(entry, fixtureSource)
    const options = {
      configRoot: root,
      profilePath: join(root, 'original-profile'),
      version: 'test',
      command: process.execPath,
      entry,
      packaged: false,
      timeoutMs: 10000
    }
    const first = await startOrAttachDesktopBackend(options)
    expect(first.startedProcess?.pid).toBeGreaterThan(0)
    const launched = JSON.parse(await readFile(join(root, 'launched.json'), 'utf8'))
    expect(launched).toMatchObject({ electron: null, asNode: null })
    expect(launched.argv).toContain('--development')
    expect(launched.argv).toContain('--serve')
    expect(launched.userData).toBe(options.profilePath)
    expect(
      resolveElectronProfile({
        appData: join(root, 'app-data'),
        configRoot: launched.configRoot,
        packaged: false,
        env: {
          OPEN_SCIENCE_CONFIG_ROOT: launched.configRoot,
          OPEN_SCIENCE_USER_DATA: launched.userData
        }
      })
    ).toBe(options.profilePath)
    const second = await startOrAttachDesktopBackend({ ...options, credentialInventory: [] })
    expect(second.endpoint).toEqual(first.endpoint)
    expect(second.startedProcess).toBeUndefined()
    expect(first.startedProcess?.exitCode).toBeNull()
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.credential-inventory-'))
    ).toEqual([])
  })

  it('removes the snapshot when the executable cannot be spawned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-launch-spawn-failure-'))
    roots.push(root)
    const entry = join(root, 'fixture.cjs')
    await writeFile(entry, 'process.exit(0)')
    await expect(
      startOrAttachDesktopBackend({
        configRoot: root,
        profilePath: join(root, 'profile'),
        version: 'test',
        command: root,
        entry,
        packaged: true,
        credentialInventory: [],
        timeoutMs: 2000
      })
    ).rejects.toThrow()
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.credential-inventory-'))
    ).toEqual([])
  })

  it('keeps two config and profile roots isolated while reusing each root on repeat startup', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'desktop-launch-profile-a-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'desktop-launch-profile-b-'))
    roots.push(firstRoot, secondRoot)
    const makeEntry = async (root: string): Promise<string> => {
      const entry = join(root, 'fixture.cjs')
      await writeFile(entry, fixtureSource)
      return entry
    }
    const firstOptions = {
      configRoot: firstRoot,
      profilePath: join(firstRoot, 'profile'),
      version: 'test',
      command: process.execPath,
      entry: await makeEntry(firstRoot),
      packaged: true,
      timeoutMs: 10000
    }
    const secondOptions = {
      ...firstOptions,
      configRoot: secondRoot,
      profilePath: join(secondRoot, 'profile'),
      entry: await makeEntry(secondRoot)
    }
    const first = await startOrAttachDesktopBackend(firstOptions)
    const repeated = await startOrAttachDesktopBackend(firstOptions)
    const second = await startOrAttachDesktopBackend(secondOptions)
    expect(repeated.endpoint).toEqual(first.endpoint)
    expect(repeated.startedProcess).toBeUndefined()
    expect(second.startedProcess?.pid).toBeGreaterThan(0)
    expect(second.endpoint).not.toEqual(first.endpoint)
    expect(JSON.parse(await readFile(join(firstRoot, 'launched.json'), 'utf8'))).toMatchObject({
      configRoot: firstRoot,
      userData: firstOptions.profilePath
    })
    expect(JSON.parse(await readFile(join(secondRoot, 'launched.json'), 'utf8'))).toMatchObject({
      configRoot: secondRoot,
      userData: secondOptions.profilePath
    })
  })
  it('keeps a live child intact and honors the deadline despite repeated ready reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-launch-live-'))
    roots.push(root)
    const entry = join(root, 'live.cjs')
    await writeFile(
      entry,
      `setInterval(() => {
      if (process.connected) process.send({ protocolVersion: 1,
        attemptId: process.env.OPEN_SCIENCE_STARTUP_ATTEMPT,
        stage: 'endpoint', kind: 'ready' }, () => {});
    }, 20);`
    )
    const onStatus = vi.fn()
    const started = Date.now()
    await expect(
      startOrAttachDesktopBackend({
        configRoot: root,
        profilePath: join(root, 'profile'),
        version: 'test',
        command: process.execPath,
        entry,
        packaged: true,
        timeoutMs: 500,
        onStatus
      })
    ).rejects.toMatchObject({ canRetry: false, stage: 'endpoint' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }))
    expect(children.at(-1)).toMatchObject({ exitCode: null, signalCode: null, killed: false })
  })

  it('reports fatal child startup promptly without terminating an unrelated process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-launch-failure-'))
    roots.push(root)
    const entry = join(root, 'failed.cjs')
    await writeFile(entry, 'process.exit(23)')
    await expect(
      startOrAttachDesktopBackend({
        configRoot: root,
        profilePath: join(root, 'original-profile'),
        version: 'test',
        command: process.execPath,
        entry,
        packaged: true,
        timeoutMs: 10000
      })
    ).rejects.toThrow('exited during startup (23)')
  })
})
