import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import { startOrAttachDesktopBackend } from './desktop-runtime-launcher'
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
afterEach(async () => {
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
 res.end(JSON.stringify({generation,pid:process.pid,desktopGeneration,startupOptions}));
});
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(path.join(root,'runtime-owner.json'),JSON.stringify({schemaVersion:1,generation,pid:process.pid,host:'node',port:server.address().port,desktop:{path:path.join(root,'fixture.sock'),generation:desktopGeneration,secret:'a'.repeat(64),version:'test'}})));
process.once('SIGTERM',()=>server.close());
`
describe('ordinary Node desktop launcher', () => {
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
    const second = await startOrAttachDesktopBackend(options)
    expect(second.endpoint).toEqual(first.endpoint)
    expect(second.startedProcess).toBeUndefined()
    expect(first.startedProcess?.exitCode).toBeNull()
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
