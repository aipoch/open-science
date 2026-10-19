import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startMacInstallProgress } from '../src/main/update/macos-install-progress'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

describe.skipIf(process.platform !== 'darwin')('native macOS update presentation', () => {
  let root: string
  let helper: string
  const children: ChildProcess[] = []
  const helperPids: number[] = []
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw error
    }
  }
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mac-progress-native-'))
    helper = join(root, 'progress')
    const result = spawnSync(
      'clang',
      [
        '-fobjc-arc',
        '-O2',
        '-mmacosx-version-min=12.0',
        '-framework',
        'Cocoa',
        resolve('build/macos-update-progress/progress.m'),
        '-o',
        helper
      ],
      { encoding: 'utf8' }
    )
    expect(result.stderr, result.error?.message).toBe('')
    expect(result.status).toBe(0)
  })
  afterAll(async () => {
    for (const child of children) if (child.connected) child.disconnect()
    for (const pid of helperPids) if (alive(pid)) process.kill(pid, 'SIGTERM')
    if (root) await rm(root, { recursive: true, force: true })
  })
  async function launch(): Promise<{
    child: ChildProcess
    pid: number
    directory: string
    operationId: string
    visible: boolean
  }> {
    const child = fork(
      resolve('scripts/fixtures/macos-update-progress/parent.mjs'),
      [helper, root],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    )
    children.push(child)
    const ready = await new Promise<{
      pid: number
      directory: string
      operationId: string
      visible: boolean
    }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native window readiness timed out')), 15000)
      child.once('message', (value) => {
        clearTimeout(timer)
        resolve(value as never)
      })
      child.once('error', reject)
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Fixture exited before readiness: ${code}`))
      })
    })
    helperPids.push(ready.pid)
    expect(ready.visible).toBe(true)
    return { child, ...ready }
  }
  it('starts through the production launcher and cancels without retaining a process', async () => {
    const profilePath = join(root, 'profile')
    const applicationPath = join(root, 'Test.app/Contents/MacOS/app')
    await mkdir(profilePath)
    await mkdir(join(root, 'Test.app/Contents/MacOS'), { recursive: true })
    await writeFile(applicationPath, '')
    const info = vi.fn()
    const presentation = await startMacInstallProgress({
      helperPath: helper,
      profilePath,
      applicationPath,
      targetVersion: '1.0.2',
      startupOptions: {
        configRoot: profilePath,
        dataRoot: profilePath,
        profilePath,
        port: 0,
        host: '127.0.0.1',
        credentialStore: 'os'
      },
      translate: (key) => key,
      log: { info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
    })
    const pid = info.mock.calls[0][1].helperPid as number
    helperPids.push(pid)
    expect(alive(pid)).toBe(true)
    presentation.cancel()
    await vi.waitFor(() => expect(alive(pid)).toBe(false))
  })
  it('survives parent exit during installation and exits only after readiness', async () => {
    const f = await launch()
    f.child.send('handoff')
    await vi.waitFor(() => expect(f.child.exitCode).toBe(0))
    expect(alive(f.pid)).toBe(true)
    expect(JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')).phase).toBe(
      'handoff'
    )
    await writeFile(
      join(f.directory, 'ready.tmp'),
      JSON.stringify({ operationId: f.operationId, phase: 'ready' }),
      { mode: 0o600 }
    )
    await rename(join(f.directory, 'ready.tmp'), join(f.directory, 'state.json'))
    await vi.waitFor(() => expect(alive(f.pid)).toBe(false))
    await expect(readFile(join(f.directory, 'config.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
  it('exits if the parent dies before handoff', async () => {
    const f = await launch()
    f.child.send('exit')
    await vi.waitFor(() => expect(f.child.exitCode).toBe(0))
    await vi.waitFor(() => expect(alive(f.pid)).toBe(false))
  })
  it('dismisses an aborted handoff while keeping its parent alive', async () => {
    const f = await launch()
    f.child.send('cancel')
    await vi.waitFor(() => expect(alive(f.pid)).toBe(false))
    expect(f.child.exitCode).toBe(null)
    f.child.disconnect()
  })
})
