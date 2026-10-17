import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
    expect(children.length).toBe(2)
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
