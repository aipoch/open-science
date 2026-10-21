import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer as createTcpServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureSource, setBuildVersion, validateVersions } from './source.mjs'
import { startUpdateServer } from './server.mjs'
import { evaluateScenario, writeReport } from './report.mjs'
import { observe, ownedRun } from './index.mjs'

const roots: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []
const temp = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-update-test-')))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

describe('frozen current-workspace source', () => {
  it('captures staged/unstaged/untracked/binary/symlinks/deletions without touching index or copying ignored outputs', async () => {
    const root = await temp()
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const git = (...args: string[]): Buffer => execFileSync('git', ['-C', workspace, ...args])
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    await writeFile(join(workspace, '.gitignore'), 'node_modules/\nout/\n*.secret\n')
    await writeFile(join(workspace, 'changed.txt'), 'HEAD')
    await writeFile(join(workspace, 'deleted.txt'), 'deleted')
    git('add', '.')
    git('commit', '-qm', 'fixture')
    await writeFile(join(workspace, 'changed.txt'), 'staged')
    git('add', 'changed.txt')
    await writeFile(join(workspace, 'changed.txt'), 'working tree')
    await unlink(join(workspace, 'deleted.txt'))
    await writeFile(join(workspace, 'new.bin'), Buffer.from([0, 255, 31]))
    await symlink('changed.txt', join(workspace, 'relative-link'))
    await mkdir(join(workspace, 'out'))
    await writeFile(join(workspace, 'out', 'stale-build'), 'NO')
    await mkdir(join(workspace, 'node_modules'))
    await writeFile(join(workspace, 'node_modules', 'dependency'), 'NO')
    await writeFile(join(workspace, 'credential.secret'), 'NO')
    const index = await readFile(join(workspace, '.git', 'index'))
    const diff = git('diff', '--binary', 'HEAD')
    const destination = join(root, 'snapshot')
    const receipt = await captureSource(workspace, destination)
    expect(await readFile(join(destination, 'changed.txt'), 'utf8')).toBe('working tree')
    expect(await readFile(join(destination, 'new.bin'))).toEqual(Buffer.from([0, 255, 31]))
    expect(await readFile(join(destination, 'relative-link'), 'utf8')).toBe('working tree')
    expect(receipt.files.map((entry: { path: string }) => entry.path)).toEqual([
      '.gitignore',
      'changed.txt',
      'new.bin',
      'relative-link'
    ])
    expect(await readFile(join(workspace, '.git', 'index'))).toEqual(index)
    expect(git('diff', '--binary', 'HEAD')).toEqual(diff)
    await writeFile(join(workspace, 'changed.txt'), 'later edit')
    expect(await readFile(join(destination, 'changed.txt'), 'utf8')).toBe('working tree')
    expect(receipt.snapshotId).toBe(sha256(JSON.stringify(receipt.files)))
  })

  it('refuses symlinks to original or unrelated files rather than capturing live dependencies', async () => {
    const root = await temp()
    const source = join(root, 'repo')
    await mkdir(source)
    execFileSync('git', ['-C', source, 'init', '-q'])
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture'
    ])
    await symlink(root, join(source, 'outside'))
    await expect(captureSource(source, join(root, 'snapshot'))).rejects.toThrow('leaves snapshot')
  })

  it('updates both package versions only in build copies and rejects invalid ordering', async () => {
    const root = await temp()
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    await writeFile(
      join(root, 'package-lock.json'),
      JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' } } })
    )
    await setBuildVersion(root, '0.0.2')
    expect(
      JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')).packages[''].version
    ).toBe('0.0.2')
    expect(() => validateVersions('1.0.0', '1.0.0')).toThrow('newer')
    expect(() => validateVersions('2.0.0', '1.9.9')).toThrow('newer')
    expect(() => validateVersions('0.0.0', '0.0.1')).toThrow('greater than 0.0.0')
    expect(() => validateVersions('1.0.0-beta', '2.0.0')).toThrow('stable')
  })
})

async function source(scenario = 'boundary'): Promise<{
  server: Awaited<ReturnType<typeof startUpdateServer>>
  path: string
  bytes: Buffer
  events: string
}> {
  const root = await temp()
  const bytes = Buffer.alloc(1024 * 1024, 42)
  const name = 'aipoch-open-science-0.0.2-mac-arm64.zip'
  await writeFile(join(root, name), bytes)
  const events = join(root, 'server.jsonl')
  const server = await startUpdateServer({
    artifact: {
      directory: root,
      snapshotId: 'source',
      files: [
        { name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }
      ]
    },
    versionA: '0.0.1',
    versionB: '0.0.2',
    scenario,
    eventsPath: events
  })
  servers.push(server)
  return { server, path: `${server.origin}/${name}`, bytes, events }
}

describe('loopback update source and fault evidence', () => {
  it('serves real ZIP bytes, notes, manifests and bounded range requests without traversing files', async () => {
    const value = await source()
    expect((await fetch(`${value.server.origin}/health`)).ok).toBe(true)
    expect(await (await fetch(`${value.server.origin}/version.json`)).json()).toMatchObject({
      version: '0.0.2',
      downloads: {}
    })
    expect(await (await fetch(`${value.server.origin}/release-notes.md`)).text()).toContain(
      'source source'
    )
    const partial = await fetch(value.path, { headers: { Range: 'bytes=10-19' } })
    expect(partial.status).toBe(206)
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(value.bytes.subarray(10, 20))
    expect((await fetch(value.path, { headers: { Range: 'bytes=0-99999999' } })).status).toBe(416)
    expect((await fetch(`${value.server.origin}/../secret`)).status).toBe(404)
    await value.server.close()
    await expect(fetch(`${value.server.origin}/health`)).rejects.toThrow()
    expect(await readFile(value.events, 'utf8')).toContain('source-closed')
  })

  it('injects a real network error once, then serves an intact retry', async () => {
    const value = await source('network-failure')
    expect((await fetch(value.path)).status).toBe(503)
    const retry = await fetch(value.path)
    expect(sha256(Buffer.from(await retry.arrayBuffer()))).toBe(sha256(value.bytes))
    expect(value.server.faultTriggered).toBe(true)
    expect(await readFile(value.events, 'utf8')).toContain('fault-triggered')
  })

  it('throttles only the first cancelable download and streams the retry at normal speed', async () => {
    const value = await source('download-cancel')
    const cancellation = new AbortController()
    const first = await fetch(value.path, { signal: cancellation.signal })
    const reader = first.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    cancellation.abort()
    await reader.cancel().catch(() => undefined)
    const retry = await fetch(value.path)
    expect(sha256(Buffer.from(await retry.arrayBuffer()))).toBe(sha256(value.bytes))
    await value.server.close()
    const events = (await readFile(value.events, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      events.filter(
        (event) => event.type === 'fault-triggered' && event.fault === 'download-cancel'
      )
    ).toHaveLength(1)
    expect(
      events.some((event) => event.type === 'response-interrupted' && event.throttled === true)
    ).toBe(true)
    expect(
      events.some((event) => event.type === 'response-completed' && event.throttled === false)
    ).toBe(true)
  })

  it('changes the declared checksum or actual payload, and records each injected fault', async () => {
    const checksum = await source('checksum-failure')
    const feed = await (await fetch(`${checksum.server.origin}/latest-mac.yml`)).json()
    expect(feed.files[0].sha512).toBe(Buffer.alloc(64).toString('base64'))
    expect(checksum.server.faultTriggered).toBe(true)
    const corrupt = await source('corrupt-artifact')
    expect(sha256(Buffer.from(await (await fetch(corrupt.path)).arrayBuffer()))).not.toBe(
      sha256(corrupt.bytes)
    )
    expect(corrupt.server.faultTriggered).toBe(true)
  })

  it('does not bind a public interface or steal an occupied loopback port', async () => {
    await expect(startUpdateServer({ host: '0.0.0.0' })).rejects.toThrow('loopback')
    const value = await source()
    const port = Number(new URL(value.server.origin).port)
    await expect(
      startUpdateServer({
        artifact: { files: [{ name: 'B.zip' }] },
        versionA: '0.0.1',
        versionB: '0.0.2',
        scenario: 'boundary',
        eventsPath: value.events,
        port
      })
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect((await fetch(`${value.server.origin}/health`)).ok).toBe(true)
  })

  it('advertises same and lower versions from separate sources', async () => {
    const same = await source('same-version')
    const lower = await source('lower-version')
    expect((await (await fetch(`${same.server.origin}/latest-mac.yml`)).json()).version).toBe(
      '0.0.1'
    )
    expect((await (await fetch(`${lower.server.origin}/latest-mac.yml`)).json()).version).toBe(
      '0.0.0'
    )
  })
})

describe('evidence evaluation', () => {
  const at = (seconds: number): string =>
    new Date(Date.parse('2026-10-16T00:00:00.000Z') + seconds * 1000).toISOString()
  const app = [
    { type: 'application-started', pid: 1, at: at(-4) },
    {
      type: 'download-verified',
      artifactSha512: 'B-checksum',
      networkTransferred: true,
      checksumAlgorithm: 'sha512',
      at: at(-3)
    },
    {
      type: 'runtime-stopped',
      pid: 42,
      generation: 'old',
      processExited: true,
      exitRecord: 'clean',
      lockHeld: true,
      at: at(-2)
    },
    { type: 'handoff-failure', nativeInstallInvoked: false, targetStarted: false, at: at(-1) },
    { type: 'runtime-recovered', pid: 43, generation: 'new', serviceReady: true, at: at(0) }
  ]
  const server = [
    { type: 'source-ready', origin: 'http://127.0.0.1:12345', at: at(-6) },
    { type: 'source-closed', origin: 'http://127.0.0.1:12345', at: at(2) }
  ]
  const observations = [
    { type: 'initial-application-launched', pid: 1, at: at(-4) },
    {
      type: 'source-health-before-launch',
      origin: 'http://127.0.0.1:12345',
      ready: true,
      at: at(-5)
    },
    { type: 'runtime-exit-observed', pid: 42, generation: 'old', at: at(-1.5) },
    {
      type: 'source-health-after-runtime-stop',
      origin: 'http://127.0.0.1:12345',
      ready: true,
      pid: 42,
      generation: 'old',
      at: at(-1.5)
    },
    { type: 'runtime-recovery-observed', pid: 43, generation: 'new', at: at(0.5) },
    { type: 'source-port-released', origin: 'http://127.0.0.1:12345', at: at(3) }
  ]
  const fixture = { preserved: true, recoveryWrite: { exists: true, mtimeMs: Date.parse(at(1)) } }
  it('requires actual process observations, verified B identity and a new write after user recovery', () => {
    const args = {
      scenario: 'handoff-failure',
      app,
      server,
      observations,
      fixture,
      zipSha512: 'B-checksum'
    }
    expect(evaluateScenario(args).status).toBe('passed')
    expect(
      evaluateScenario({
        ...args,
        app: app.map((event) =>
          event.type === 'download-verified' ? { ...event, networkTransferred: false } : event
        )
      }).status
    ).toBe('failed')
    expect(evaluateScenario({ ...args, observations: [] }).status).toBe('failed')
    expect(
      evaluateScenario({
        ...args,
        server: server.filter((event) => event.type !== 'source-closed')
      }).status
    ).toBe('failed')
    expect(
      evaluateScenario({
        ...args,
        observations: observations.filter((event) => event.type !== 'source-port-released')
      }).status
    ).toBe('failed')
    expect(
      evaluateScenario({
        ...args,
        observations: observations.filter(
          (event) => event.type !== 'source-health-after-runtime-stop'
        )
      }).status
    ).toBe('failed')
    expect(evaluateScenario({ ...args, zipSha512: 'different-artifact' }).status).toBe('failed')
    expect(
      evaluateScenario({
        ...args,
        fixture: { ...fixture, recoveryWrite: { exists: true, mtimeMs: 1 } }
      }).status
    ).toBe('failed')
    expect(
      evaluateScenario({
        ...args,
        app: [...app, { type: 'update-status', status: { outcome: 'installed' } }]
      }).status
    ).toBe('failed')
  })
  it('requires independent exact Finder selection, rather than only a reveal invocation', () => {
    const path = '/owned/cache/B.zip'
    const manualApp = [
      ...app,
      { type: 'update-status', status: { manualInstall: { kind: 'local' } }, at: at(1) },
      { type: 'manual-file-reveal-invoked', path, at: at(1.5) }
    ]
    const args = {
      scenario: 'manual-local',
      app: manualApp,
      server,
      observations,
      fixture,
      zipSha512: 'B-checksum'
    }
    expect(evaluateScenario(args).status).toBe('failed')
    expect(
      evaluateScenario({
        ...args,
        observations: [
          ...observations,
          { type: 'native-finder-selection', path: '/different/file.zip', at: at(2) }
        ]
      }).status
    ).toBe('failed')
    expect(
      evaluateScenario({
        ...args,
        observations: [...observations, { type: 'native-finder-selection', path, at: at(2) }]
      }).status
    ).toBe('passed')
  })
  it('requires actual cache mutation and a subsequent website transition without file reveal', () => {
    const scenario = 'cache-corrupt-reveal'
    const manualApp = [
      ...app,
      {
        type: 'update-status',
        status: { manualInstall: { kind: 'website', reason: 'unavailable' } },
        at: at(2)
      }
    ]
    const args = {
      scenario,
      app: manualApp,
      server,
      observations,
      fixture,
      zipSha512: 'B-checksum'
    }
    expect(evaluateScenario(args).status).toBe('failed')
    const observed = [...observations, { type: 'fault-triggered', fault: scenario, at: at(1) }]
    expect(evaluateScenario({ ...args, observations: observed }).status).toBe('passed')
    expect(
      evaluateScenario({
        ...args,
        observations: observed,
        app: [...manualApp, { type: 'manual-file-reveal-invoked', at: at(3) }]
      }).status
    ).toBe('failed')
  })
  it('accepts a checksum-verified non-standalone package only with a website-only failure path', () => {
    const args = {
      scenario: 'manual-non-standalone',
      app: [
        ...app,
        {
          type: 'update-status',
          status: { manualInstall: { kind: 'website', reason: 'not-standalone' } },
          at: at(1)
        }
      ],
      server,
      observations,
      fixture,
      zipSha512: 'B-checksum'
    }
    expect(evaluateScenario(args).status).toBe('passed')
    expect(evaluateScenario({ ...args, zipSha512: 'different-payload' }).status).toBe('failed')
    expect(
      evaluateScenario({
        ...args,
        app: [...args.app, { type: 'manual-file-reveal-invoked', at: at(2) }]
      }).status
    ).toBe('failed')
  })
  it('requires a real shutdown fault, user release, retained recovery and restored data without any handoff', () => {
    const faultApp = [
      app[0],
      app[1],
      {
        type: 'update-status',
        status: {
          reason: 'runtime-stop-unclean',
          error: 'Unsafe runtime lock file',
          recovery: { canRecover: true }
        },
        at: at(-2.5)
      },
      { ...app[2], at: at(-1) },
      app[4]
    ]
    const faultServer = [
      ...server,
      {
        type: 'fault-triggered',
        fault: 'shutdown-failure',
        mechanism: 'runtime-lock-hardlink',
        dev: 11,
        ino: 22,
        nlink: 2,
        at: at(-3.5)
      },
      {
        type: 'fault-released',
        fault: 'shutdown-failure',
        reason: 'user-request',
        dev: 11,
        ino: 22,
        nlink: 1,
        at: at(-2)
      }
    ]
    const faultObservations = observations.map((event) =>
      event.type === 'source-health-after-runtime-stop' || event.type === 'runtime-exit-observed'
        ? { ...event, at: at(-0.5) }
        : event
    )
    faultObservations.push(
      { type: 'shutdown-fault-observed', dev: 11, ino: 22, nlink: 2, at: at(-3) },
      { type: 'shutdown-fault-release-observed', dev: 11, ino: 22, nlink: 1, at: at(-1.5) }
    )
    const args = {
      scenario: 'shutdown-failure',
      app: faultApp,
      server: faultServer,
      observations: faultObservations,
      fixture,
      zipSha512: 'B-checksum'
    }
    expect(evaluateScenario(args).status).toBe('passed')
    expect(
      evaluateScenario({
        ...args,
        server: faultServer.filter((event) => event.type !== 'fault-released')
      }).status
    ).toBe('failed')
    expect(
      evaluateScenario({
        ...args,
        app: faultApp.filter((event) => event.type !== 'runtime-recovered')
      }).status
    ).toBe('failed')
    expect(
      evaluateScenario({
        ...args,
        server: faultServer.map((event) =>
          event.type === 'fault-released' ? { ...event, reason: 'source-closed' } : event
        )
      }).status
    ).toBe('failed')
  })

  it('requires matching build, runner and application evidence for sandbox isolation', async () => {
    const root = await temp()
    await writeFile(
      join(root, '.local-update-validation-owner.json'),
      JSON.stringify({ schema: 1, runId: randomUUID(), root })
    )
    await writeFile(join(root, 'build.json'), JSON.stringify({ credentialMode: 'sandbox' }))
    const dir = join(root, 'scenarios', 'sandbox')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'local-update.json'),
      JSON.stringify({ runId: 'sandbox', scenario: 'manual-local', credentialMode: 'sandbox' })
    )
    const scope = {
      isolated: true,
      mode: 'local-update-credential-sandbox',
      productionCredentialAcceptance: false
    }
    await writeFile(join(dir, 'keychain-verification.json'), JSON.stringify(scope))
    expect((await writeReport(root)).scenarios[0].isolationVerified).toBe(false)
    await writeFile(
      join(dir, 'app-events.jsonl'),
      JSON.stringify({
        ...scope,
        type: 'credential-scope-verified',
        runId: 'sandbox',
        scenario: 'manual-local'
      }) + '\n'
    )
    const result = (await writeReport(root)).scenarios[0]
    expect(result.isolationVerified).toBe(true)
    expect(result.productionCredentialAcceptance).toBe(false)
    expect(result.status).not.toBe('passed') // Isolation alone proves no update behavior.
  })

  it('cannot hide an unsafe historical attempt behind a later passing retry', async () => {
    const root = await temp()
    await writeFile(
      join(root, '.local-update-validation-owner.json'),
      JSON.stringify({ schema: 1, runId: randomUUID(), root })
    )
    await writeFile(
      join(root, 'build.json'),
      JSON.stringify({
        versionA: '0.0.1',
        b: { files: [{ name: 'B.zip', sha512: 'B-checksum' }] },
        boundaryVerified: true,
        productionFullPackageVerified: true
      })
    )
    for (const [name, unsafe] of [
      ['old', true],
      ['retry', false]
    ] as const) {
      const dir = join(root, 'scenarios', name)
      await mkdir(dir, { recursive: true })
      const keychainPath = join(dir, 'home', 'test.keychain-db')
      await writeFile(
        join(dir, 'local-update.json'),
        JSON.stringify({ runId: name, scenario: 'handoff-failure', keychainPath })
      )
      await writeFile(
        join(dir, 'keychain-verification.json'),
        JSON.stringify({
          isolated: true,
          hostPreferencesUnchanged: true,
          defaultKeychain: keychainPath,
          searchList: [keychainPath]
        })
      )
      const history = app.map((event) => ({
        ...event,
        version: '0.0.1',
        runId: name,
        scenario: 'handoff-failure',
        ...(unsafe && event.type === 'handoff-failure' ? { targetStarted: true } : {})
      }))
      for (const [filename, entries] of [
        ['app-events.jsonl', history],
        ['server-events.jsonl', server],
        ['observations.jsonl', observations]
      ] as const)
        await writeFile(
          join(dir, filename),
          entries.map((event) => JSON.stringify(event)).join('\n') + '\n'
        )
      await writeFile(join(dir, 'fixture-verification.json'), JSON.stringify(fixture))
    }
    const report = await writeReport(root)
    expect(report.scenarios.find((result) => result.directory.endsWith('/retry'))?.status).toBe(
      'passed'
    )
    expect(
      report.requiredScenarios.find((result) => result.scenario === 'handoff-failure')?.status
    ).toBe('failed')
    expect(report.status).toBe('not-passed')
  })

  it('does not count unused injected faults, cached ready status, or unexercised shutdown failure as passing', () => {
    expect(
      evaluateScenario({
        scenario: 'checksum-failure',
        app: [{ type: 'update-status', status: { state: 'error' } }]
      }).status
    ).toBe('failed')
    expect(
      evaluateScenario({
        scenario: 'boundary',
        app: [{ type: 'update-status', status: { state: 'ready' } }]
      }).handoffBoundaryReached
    ).toBe(false)
    expect(
      evaluateScenario({ scenario: 'shutdown-failure', app: [{ type: 'application-started' }] })
        .status
    ).toBe('not-run')
  })
  it('keeps suite incomplete if any required scenario or package boundary is unverified', async () => {
    const root = await temp()
    const runId = randomUUID()
    await writeFile(
      join(root, '.local-update-validation-owner.json'),
      JSON.stringify({ schema: 1, runId, root })
    )
    const report = await writeReport(root)
    expect(report.status).toBe('not-passed')
    expect(
      report.requiredScenarios.every(
        (scenario: { status: string }) => scenario.status === 'not-run'
      )
    ).toBe(true)
    expect(report.unverified).toEqual([
      'native-installation',
      'B-startup',
      'post-update-data',
      'production-signing-and-notarization',
      'Windows-NSIS-native-and-differential',
      'Linux-AppImage-native',
      'Linux-DEB-native',
      'external-browser-website-route',
      'production-full-package'
    ])
    expect((await ownedRun(root)).owner.runId).toBe(runId)
    const alias = join(await temp(), 'alias')
    await symlink(root, alias)
    await expect(ownedRun(alias)).rejects.toThrow('symlinks')
  })
})

describe('read-only task and recovery observations', () => {
  it('requires a running PID, observes its natural exit, and rejects a rewritten task PID file after recovery', async () => {
    const root = await temp()
    const config = {
      runRoot: root,
      runId: 'observation-run',
      scenario: 'active-task',
      eventsPath: join(root, 'app-events.jsonl')
    }
    await writeFile(join(root, 'fixture-manifest.json'), JSON.stringify({ workspace: root }))
    const task = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
      stdio: ['pipe', 'ignore', 'ignore']
    })
    await new Promise<void>((resolve, reject) => {
      task.once('spawn', resolve)
      task.once('error', reject)
    })
    const service = createTcpServer()
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
    try {
      await writeFile(join(root, 'task.pid'), String(task.pid))
      const seen = new Set()
      await observe(config, seen)
      const exit = new Promise((resolve) => task.once('exit', resolve))
      task.stdin!.end()
      await exit
      await observe(config, seen)
      const address = service.address() as { port: number }
      const recovered = {
        schema: 1,
        type: 'runtime-recovered',
        runId: config.runId,
        scenario: config.scenario,
        pid: process.pid,
        port: address.port,
        generation: 'restored',
        at: new Date(Date.now() - 1000).toISOString()
      }
      await writeFile(config.eventsPath, JSON.stringify(recovered) + '\n')
      await writeFile(join(root, 'recovery-write.txt'), 'LOCAL_UPDATE_RECOVERY_WRITE\n')
      await observe(config, seen)
      const events = (await readFile(join(root, 'observations.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(events.map((event) => event.type)).toEqual([
        'task-running-observed',
        'task-exit-observed',
        'runtime-recovery-observed',
        'task-not-restarted'
      ])
      expect(
        events.every(
          (event) => event.type === 'runtime-recovery-observed' || event.pid === task.pid
        )
      ).toBe(true)
      // A new PID file is a different task instance; it cannot borrow previous exit evidence.
      await writeFile(join(root, 'task.pid'), String(process.pid))
      await observe(config, seen)
      const updated = (await readFile(join(root, 'observations.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(updated.at(-1).type).toBe('task-running-observed')
      expect(updated.filter((event) => event.type === 'task-not-restarted')).toHaveLength(1)
    } finally {
      task.stdin?.end()
      await new Promise<void>((resolve) => service.close(() => resolve()))
    }
  })
})

describe('runner signal shutdown', () => {
  it.skipIf(process.platform === 'win32')(
    'finishes the verification worker, source close and final report under repeated real SIGINT/SIGTERM',
    async () => {
      const root = await temp()
      await writeFile(
        join(root, '.local-update-validation-owner.json'),
        JSON.stringify({ schema: 1, runId: randomUUID(), root })
      )
      const harness = join(root, 'signal-shutdown.mjs')
      await writeFile(
        harness,
        `
      import { writeFile, readFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { installRunSignalHandlers } from ${JSON.stringify(new URL('./lifecycle.mjs', import.meta.url).href)};
      import { runCommand } from ${JSON.stringify(new URL('./build.mjs', import.meta.url).href)};
      import { startUpdateServer } from ${JSON.stringify(new URL('./server.mjs', import.meta.url).href)};
      import { writeReport } from ${JSON.stringify(new URL('./report.mjs', import.meta.url).href)};
      const root = ${JSON.stringify(root)};
      await writeFile(join(root, 'B.zip'), 'test-artifact');
      const server = await startUpdateServer({
        artifact: { directory: root, files: [{ name: 'B.zip', size: 13, sha512: 'test' }] },
        versionA: '0.0.1', versionB: '0.0.2', scenario: 'boundary', eventsPath: join(root, 'server-events.jsonl')
      });
      let stopRequests = 0, finish;
      const finished = new Promise((resolve) => { finish = resolve });
      const removeHandlers = installRunSignalHandlers(() => { stopRequests += 1; finish() });
      let signalCount = 0;
      const repeatedSignals = setInterval(() => {
        signalCount += 1;
        process.kill(-process.pid, signalCount % 2 ? 'SIGINT' : 'SIGTERM');
      }, 10);
      try {
        await finished;
        await runCommand(process.execPath, ['-e',
          'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ completed: true })), 80)',
          join(root, 'fixture-verification.json')],
          { cwd: root, logPath: join(root, 'verification.log'), detached: true });
        await server.close();
        // Keep sending signals while final evidence is being saved, after the listener is gone.
        await new Promise((resolve) => setTimeout(resolve, 80));
        await writeReport(root);
        console.log(JSON.stringify({ stopRequests, signalCount, origin: server.origin }));
      } finally {
        clearInterval(repeatedSignals);
        await server.close();
        removeHandlers();
      }
      `
      )
      const child = spawn(process.execPath, [harness], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      let errors = ''
      child.stdout!.on('data', (bytes) => {
        output += bytes
      })
      child.stderr!.on('data', (bytes) => {
        errors += bytes
      })
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject)
          child.once('exit', (code, signal) => resolve({ code, signal }))
        }
      )
      expect(errors).toBe('')
      expect(outcome).toEqual({ code: 0, signal: null })
      const result = JSON.parse(output.trim())
      expect(result.stopRequests).toBe(1)
      expect(result.signalCount).toBeGreaterThan(4)
      expect(JSON.parse(await readFile(join(root, 'fixture-verification.json'), 'utf8'))).toEqual({
        completed: true
      })
      expect(await readFile(join(root, 'server-events.jsonl'), 'utf8')).toContain('source-closed')
      expect(JSON.parse(await readFile(join(root, 'result.json'), 'utf8')).status).toBe(
        'not-passed'
      )
      await expect(fetch(`${result.origin}/health`)).rejects.toThrow()
    }
  )
})
