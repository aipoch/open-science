import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import { startOrAttachDesktopBackend } from './desktop-runtime-launcher'
import { resolveElectronProfile } from './storage/electron-profile'
const children: ChildProcess[] = []
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
const server=http.createServer((req,res)=>{
 if(req.headers.authorization!=='Bearer '+token||req.headers['x-open-science-runtime-generation']!==generation){res.writeHead(403).end();return;}
 res.end(JSON.stringify({generation,pid:process.pid}));
});
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(path.join(root,'runtime-owner.json'),JSON.stringify({schemaVersion:1,generation,pid:process.pid,host:'node',port:server.address().port,desktop:{path:path.join(root,'fixture.sock'),generation:crypto.randomUUID(),secret:'a'.repeat(64),version:'test'}})));
process.once('SIGTERM',()=>server.close());
`
describe('ordinary Node desktop launcher', () => {
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
    if (first.startedProcess) children.push(first.startedProcess)
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
