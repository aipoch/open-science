import { afterEach, expect, it } from 'vitest'
import { build } from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { discoverDesktopBackend } from './desktop-runtime-launcher'
import { DesktopRuntimeStartupError } from './desktop-startup-recovery'
import { acquireRuntimeDirectorySync } from './runtime-ownership'
let child: ChildProcess | undefined
let root: string | undefined
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
  if (root) await rm(root, { recursive: true, force: true })
})
it.each([
  { modern: true, alreadyStopped: false, cleanExit: true },
  { modern: false, alreadyStopped: false, cleanExit: true },
  { modern: true, alreadyStopped: true, cleanExit: true },
  { modern: true, alreadyStopped: true, cleanExit: false },
  { modern: false, alreadyStopped: true, cleanExit: true }
])(
  'gracefully stops a mismatched service (modern: $modern, already stopped: $alreadyStopped, clean: $cleanExit)',
  async ({ modern, alreadyStopped, cleanExit }) => {
    root = await mkdtemp(join(tmpdir(), 'startup-recovery-'))
    const entry = join(root, 'fixture.ts')
    const output = join(root, 'fixture.cjs')
    const main = resolve('src/main')
    await writeFile(
      entry,
      `
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startRuntimeControl} from ${JSON.stringify(join(main, 'runtime-control.ts'))};
import {acquireRuntimeDirectorySync} from ${JSON.stringify(join(main, 'runtime-ownership.ts'))};
import {writeRuntimeExit} from ${JSON.stringify(join(main, 'runtime-stop-confirmation.ts'))};
const root=process.argv[2], generation=randomUUID(), lease=acquireRuntimeDirectorySync(root);
const startupOptions={configRoot:root,dataRoot:root,profilePath:root,port:0,host:'127.0.0.1',credentialStore:'os'};
async function main(){
 const server=createServer(async(req,res)=>{
  const token=(await readFile(join(root,'web-token'),'utf8')).trim();
  if(req.url!='/api/shutdown'||req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end();return;}
  await writeFile(join(root,'shutdown-observed'),'yes');
  res.writeHead(202);res.end();
  server.close(async()=>{await control.close();if(${modern})await writeRuntimeExit(root,{generation,pid:process.pid,outcome:'${cleanExit ? 'clean' : 'failed'}'});lease.release();});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await writeFile(join(root,'web-service.json'),JSON.stringify({pid:process.pid,port:server.address().port}));
 const control=await startRuntimeControl(root,'node',async()=>{}, {path:join(root,'runtime.sock'),generation,secret:'a'.repeat(64),version:'old'}, ${modern ? 'startupOptions' : 'undefined'});
 process.send('ready');
}main();`
    )
    await build({
      entryPoints: [entry],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      logLevel: 'silent'
    })
    child = spawn(process.execPath, [output, root], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        NODE_PATH: resolve('node_modules'),
        OPEN_SCIENCE_INSTALLATION_STATE_ROOT: join(root, 'installation-state')
      }
    })
    await once(child, 'message')
    child.disconnect()
    const error = await discoverDesktopBackend(root, 'new').catch((error) => error)
    expect(error).toBeInstanceOf(DesktopRuntimeStartupError)
    expect(error.issue.canStop).toBe(true)
    if (alreadyStopped) {
      // Another client can stop the service while the Desktop confirmation stays open.
      const service = JSON.parse(await readFile(join(root, 'web-service.json'), 'utf8'))
      const token = (await readFile(join(root, 'web-token'), 'utf8')).trim()
      const exited = once(child, 'exit')
      const response = await fetch(`http://127.0.0.1:${service.port}/api/shutdown`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` }
      })
      expect(response.ok).toBe(true)
      await response.arrayBuffer()
      await exited
      if (cleanExit || !modern) await expect(error.stopAndContinue()).resolves.toBeUndefined()
      else
        await expect(error.stopAndContinue()).rejects.toMatchObject({
          code: 'runtime-stop-unclean'
        })
      acquireRuntimeDirectorySync(root).release()
      return
    }
    if (modern) {
      expect(error.issue.reason).toBe('version-mismatch')
      expect(error.startupOptions.configRoot).toBe(root)
      await error.stopAndContinue()
    } else {
      expect(error.issue).toMatchObject({ reason: 'legacy-service', canRecover: true })
      const originalFiles = (await readdir(root)).sort()
      await expect(error.recover()).rejects.toMatchObject({
        issue: { reason: 'legacy-service', canStop: true }
      })
      expect(child.exitCode).toBeNull()
      expect(() => acquireRuntimeDirectorySync(root!)).toThrow()
      await expect(readFile(join(root, 'shutdown-observed'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect((await readdir(root)).sort()).toEqual(originalFiles)
      const exited = once(child, 'exit')
      await error.stopAndContinue()
      await exited
      await expect(readFile(join(root, 'shutdown-observed'), 'utf8')).resolves.toBe('yes')
      await expect(readFile(join(root, 'runtime-exit.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      await expect(error.recover()).resolves.toBeUndefined()
      await expect(discoverDesktopBackend(root, 'new')).resolves.toBeUndefined()
    }
    expect(child.exitCode).toBe(0)
    acquireRuntimeDirectorySync(root).release()
  },
  20_000
)
