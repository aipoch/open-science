import { buildSync } from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { observeNativeInstallationUpdate } from './native-update-observer'
import {
  acquireNativeInstallationUpdate,
  beginNativeInstallationShutdown,
  releaseNativeInstallationUpdate
} from './installation-protection'

const roots: string[] = []
const children: ChildProcess[] = []
const disposers: Array<() => void> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.kill()
    await exited
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = (): {
  root: string
  location: { installationRoot: string; stateRoot: string }
  input: Parameters<typeof acquireNativeInstallationUpdate>[1]
} => {
  const root = mkdtempSync(join(tmpdir(), 'update-observer-'))
  roots.push(root)
  const location = { installationRoot: join(root, 'app'), stateRoot: join(root, 'state') }
  mkdirSync(location.installationRoot)
  writeFileSync(join(location.installationRoot, 'app.exe'), 'fixture')
  return {
    root,
    location,
    input: {
      operationId: '11111111-1111-4111-8111-111111111111',
      handoffDirectory: root,
      targetVersion: '2',
      installerSha512: Buffer.alloc(64, 1).toString('base64'),
      requestSha256: 'a'.repeat(64)
    }
  }
}

it('another Desktop observes the live owner only when close starts and uses its unchanged deadline', async () => {
  const { root, location, input } = fixture()
  const script = join(root, 'owner.cjs')
  buildSync({
    stdin: {
      contents: `import { acquireNativeInstallationUpdate, beginNativeInstallationShutdown } from ${JSON.stringify(join(process.cwd(), 'src/main/update/installation-protection.ts'))}; acquireNativeInstallationUpdate(${JSON.stringify(location)}, ${JSON.stringify(input)}); process.stdout.write('ready'); process.stdin.on('data', () => beginNativeInstallationShutdown(${JSON.stringify(location)}, ${JSON.stringify(input.operationId)}, Date.now()+15000)); setInterval(()=>{},1000);`,
      resolveDir: process.cwd()
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    outfile: script,
    logLevel: 'silent'
  })
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve())
    child.once('error', reject)
    child.once('exit', () => reject(new Error('Owner exited before ready')))
  })
  const close = vi.fn<Parameters<typeof observeNativeInstallationUpdate>[0]['close']>(
    async () => {}
  )
  const onError = vi.fn()
  disposers.push(observeNativeInstallationUpdate({ location, close, onError }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(close).not.toHaveBeenCalled()
  child.stdin.write('close')
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(close.mock.calls[0][0]).toMatchObject({
    operationId: input.operationId,
    phase: 'preparing'
  })
  const deadline = (close.mock.calls[0] as unknown as [{ shutdownDeadlineAt: number }])[0]
    .shutdownDeadlineAt
  expect(deadline).toBeGreaterThan(Date.now())
  child.stdin.write('close-again')
  await new Promise((resolve) => setTimeout(resolve, 350))
  expect(close).toHaveBeenCalledOnce()
  expect(onError).not.toHaveBeenCalled()
}, 15_000)

it('does not close the initiating Desktop in response to its own operation', async () => {
  const { location, input } = fixture()
  acquireNativeInstallationUpdate(location, input)
  try {
    beginNativeInstallationShutdown(location, input.operationId, Date.now() + 1000)
    const close = vi.fn(async () => {})
    const onError = vi.fn()
    disposers.push(observeNativeInstallationUpdate({ location, close, onError }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(close).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  } finally {
    releaseNativeInstallationUpdate(location, input.operationId)
  }
})
