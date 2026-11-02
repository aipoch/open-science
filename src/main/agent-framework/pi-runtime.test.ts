import * as childProcess from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, copyFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import {
  assertPiAdapter,
  isPiAdapterAvailable,
  isPiRuntimeReady,
  piAdapterPath,
  piBootstrapPath,
  resolvePiExecutable
} from './pi-runtime'

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>())
}))
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof import('node:crypto')>())
}))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>())
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([
  ['desktop', true, 'Open-Science.app/Contents/Resources/backend'],
  ['standalone', true, 'standalone'],
  ['development', false, 'development']
] as const)('reads the shipped Pi bootstrap in the %s backend', async (_, packaged, layout) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-bootstrap-'))
  try {
    const applicationPath = join(root, layout)
    const bootstrap = join(applicationPath, 'out', 'pi-bootstrap')
    await mkdir(bootstrap, { recursive: true })
    // build-pi-acp.mjs and stage-backend.mjs ship these beside out/backend.
    const files = ['package-lock.json', 'bootstrap.mjs', 'permission-guard.mjs']
    for (const file of files) {
      await copyFile(join(process.cwd(), 'src/main/pi-acp', file), join(bootstrap, file))
    }
    // node-entry sets resources to the backend's resources, not Electron's resources.
    vi.stubEnv('OPEN_SCIENCE_HOST_PACKAGED', packaged ? '1' : '0')
    vi.stubEnv('OPEN_SCIENCE_RESOURCES_PATH', join(applicationPath, 'resources'))
    const resolved = piBootstrapPath({ backendDirectory: join(applicationPath, 'out', 'backend') })
    for (const file of files) {
      expect(await readFile(join(resolved, file), 'utf8')).toBe(
        await readFile(join(bootstrap, file), 'utf8')
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects an external or altered adapter before starting a process', async () => {
  const configRoot = await mkdtemp(join(tmpdir(), 'pi-integrity-'))
  const options = { configRoot }
  const spawn = vi.spyOn(childProcess, 'spawn')
  try {
    expect(() => assertPiAdapter(join(configRoot, 'external.js'), options)).toThrow(
      'not app-managed'
    )
    const adapter = piAdapterPath(options)
    await mkdir(dirname(adapter), { recursive: true })
    await writeFile(adapter, 'altered adapter')
    expect(() => assertPiAdapter(adapter, options)).toThrow('integrity check failed: bin.js')
    expect(isPiAdapterAvailable(options)).toBe(false)
    expect(await isPiRuntimeReady(options)).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    await rm(configRoot, { recursive: true, force: true })
  }
})

it.each(['compatible', 'wrong-version', 'invalid-json', 'timeout'] as const)(
  'probes ACP readiness and cleans its temporary profile: %s',
  async (scenario) => {
    // Isolate the process protocol from upstream package bytes. The rejection test above
    // exercises real hashing; here the filesystem/hash boundary represents a validated install.
    const hashes = [
      '066e83d7f9b4ccbd475691af05a5be365aec0927574769dcacd21e22abe49382',
      'ebf054246cc32ef65364e4b0da8ce8b6d3b9082f8189c2bdadae27be4cf698e6',
      '6498f4b2bf603ff91e9455dfbabc15af7f10e443119a00d9b9c7f685d3242336',
      '7b7bd311e494ae6813fb8fb036f4bd75cd37c43e011f7670e753d6ffa723fc9d'
    ].map((digest) => {
      const hash = crypto.createHash('sha256')
      vi.spyOn(hash, 'digest').mockReturnValue(digest)
      return hash
    })
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('validated fixture'))
    let hashIndex = 0
    vi.spyOn(crypto, 'createHash').mockImplementation(() => hashes[hashIndex++ % hashes.length])
    const child = Object.assign(new childProcess.ChildProcess(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
    const kill = vi.spyOn(child, 'kill').mockReturnValue(true)
    const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValue(child)
    const options = { configRoot: join(tmpdir(), 'pi-probe-fixture') }
    expect(isPiAdapterAvailable(options)).toBe(true)
    vi.useFakeTimers()
    const result = resolvePiExecutable(options).catch((error: Error) => error.message)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    const [, args, spawnOptions] = spawn.mock.calls[0]
    const temporary = spawnOptions?.env?.HOME
    expect(spawnOptions?.env).toMatchObject({ PI_OFFLINE: '1', HOME: temporary })
    expect(args).toContain('--no-delegation')
    expect(JSON.parse(child.stdin.read().toString())).toMatchObject({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1 }
    })
    if (scenario === 'timeout') {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await result).toBe('Pi ACP initialization timed out.')
      expect(kill).toHaveBeenCalledOnce()
    } else {
      const response =
        scenario === 'invalid-json'
          ? 'invalid json\n'
          : `${JSON.stringify({
              id: 1,
              result: {
                protocolVersion: 1,
                agentInfo: {
                  name: 'openma-pi-acp',
                  version: scenario === 'compatible' ? '0.1.8' : '0.0.0'
                }
              }
            })}\n`
      child.stdout.emit('data', '\n{"id":2}\n')
      child.stdout.emit('data', response.slice(0, 5))
      child.stdout.emit('data', response.slice(5))
      expect(child.stdin.writableEnded).toBe(true)
      child.emit('close', 0)
      expect(await result).toBe(
        scenario === 'compatible'
          ? piAdapterPath(options)
          : scenario === 'invalid-json'
            ? 'Pi ACP returned an invalid initialization response.'
            : 'Pi ACP initialization failed.'
      )
    }
    await expect(stat(temporary!)).rejects.toMatchObject({ code: 'ENOENT' })
  }
)
