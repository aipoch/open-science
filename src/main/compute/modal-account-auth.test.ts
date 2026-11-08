import { spawnSync } from 'node:child_process'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { modalAccountAdapter } from './modal-account-auth'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (load) => ({
  ...(await load<typeof import('node:child_process')>()),
  spawn
}))
configureTestRuntimeMetadata(() => ({ applicationPath: join(process.cwd(), 'app.asar') }))
afterEach(() => {
  spawn.mockReset()
  vi.unstubAllEnvs()
})
function helper(...events: object[]): { stdin: PassThrough } {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: 0,
    signalCode: null,
    kill: vi.fn()
  })
  spawn.mockImplementation(() => {
    queueMicrotask(() => {
      child.stdout.end(events.map((e) => JSON.stringify(e) + '\n').join(''))
      child.emit('close', 0)
    })
    return child
  })
  return child
}
describe('Modal workspace identity', () => {
  const signal = new AbortController().signal
  it('delivers a credential record over the parent pipe and refuses regular-file redirection', async ({
    skip
  }) => {
    const python =
      process.env.OPEN_SCIENCE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
    const material = { tokenId: 'ak-test', tokenSecret: 'secret-test' }
    const args = [
      '-I',
      '-c',
      [
        'import json, runpy, sys',
        'protocol_writer = runpy.run_path(sys.argv[1])["protocol_writer"]',
        'with protocol_writer() as emit:',
        '    emit(json.load(sys.stdin))'
      ].join('\n'),
      join(process.cwd(), 'resources', 'compute-modal-auth.py')
    ]
    const options = { encoding: 'utf8' as const, input: JSON.stringify(material), timeout: 10_000 }
    const piped = spawnSync(python, args, options)
    if (
      !process.env.OPEN_SCIENCE_TEST_PYTHON &&
      (piped.error as NodeJS.ErrnoException)?.code === 'ENOENT'
    ) {
      skip('The Modal helper requires Python.')
    }
    expect(piped.error).toBeUndefined()
    expect(piped.status).toBe(0)
    expect(JSON.parse(piped.stdout)).toEqual(material)
    expect(piped.stderr).toBe('')

    const directory = await mkdtemp(join(tmpdir(), 'modal-auth-output-'))
    try {
      const path = join(directory, 'stdout')
      const file = await open(path, 'wx')
      try {
        const redirected = spawnSync(python, args, { ...options, stdio: ['pipe', file.fd, 'pipe'] })
        expect(redirected.status).toBe(1)
        expect(redirected.stderr.trim()).toBe('Modal authentication requires a local IPC channel.')
      } finally {
        await file.close()
      }
      expect(await readFile(path, 'utf8')).toBe('')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('probes a saved token only on stdin and returns the workspace', async () => {
    const child = helper({ workspace: 'lab' })
    const material = { tokenId: 'ak-test', tokenSecret: 'secret-test' }
    await expect(modalAccountAdapter.probe(material, signal)).resolves.toBe('lab')
    expect(child.stdin.read()?.toString()).toBe(JSON.stringify({ action: 'probe', material }))
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['-I', join(process.cwd(), 'app.asar.unpacked', 'resources', 'compute-modal-auth.py')],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'ignore'] })
    )
  })
  it('publishes only the official challenge before accepting credentials', async () => {
    const material = { tokenId: 'ak-test', tokenSecret: 'secret-test' }
    const challenge = vi.fn(async () => {})
    helper({ url: 'https://modal.com/token-flow/example', userCode: '' }, material)
    await expect(modalAccountAdapter.authorize(challenge, signal)).resolves.toEqual(material)
    expect(challenge).toHaveBeenCalledWith(
      'https://modal.com/token-flow/example',
      undefined,
      expect.any(Number)
    )
    challenge.mockClear()
    helper(
      { url: 'https://modal.com.other.invalid/token-flow/example', userCode: 'code' },
      material
    )
    await expect(modalAccountAdapter.authorize(challenge, signal)).rejects.toMatchObject({
      reason: 'authorization'
    })
    expect(challenge).not.toHaveBeenCalled()
  })
  it('preserves actionable local errors and discards unexpected provider output', async () => {
    helper({ error: 'missing' })
    await expect(modalAccountAdapter.probe(undefined, signal)).rejects.toMatchObject({
      reason: 'missing'
    })
    helper({ secret: 'private diagnosis' })
    await expect(modalAccountAdapter.probe(undefined, signal)).rejects.toThrow(
      /^Compute account: network$/
    )
    spawn.mockClear()
    await expect(modalAccountAdapter.probe(undefined, AbortSignal.abort())).rejects.toMatchObject({
      reason: 'cancelled'
    })
    expect(spawn).not.toHaveBeenCalled()
  })
})
