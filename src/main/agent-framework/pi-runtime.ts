import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfigRoot } from '../storage-root'

const EXPECTED = {
  'bin.js': '066e83d7f9b4ccbd475691af05a5be365aec0927574769dcacd21e22abe49382',
  'chunk-5IXHVFXW.js': 'ebf054246cc32ef65364e4b0da8ce8b6d3b9082f8189c2bdadae27be4cf698e6',
  'permission-guard.mjs': '6498f4b2bf603ff91e9455dfbabc15af7f10e443119a00d9b9c7f685d3242336'
} as const
const PACKAGE_HASH = '7b7bd311e494ae6813fb8fb036f4bd75cd37c43e011f7670e753d6ffa723fc9d'

type PiRuntimeLocation = Readonly<{
  configRoot?: string
  backendDirectory?: string
  resourcesPath?: string
  packaged?: boolean
}>

export const managedPiRoot = (configRoot = resolveConfigRoot()): string =>
  join(configRoot, 'pi-managed')

export const piAdapterPath = (options: PiRuntimeLocation = {}): string =>
  join(managedPiRoot(options.configRoot), 'adapter', 'dist', 'bin.js')

export const piBootstrapPath = (options: PiRuntimeLocation = {}): string => {
  const packaged = options.packaged ?? process.env.OPEN_SCIENCE_HOST_PACKAGED === '1'
  const resources = options.resourcesPath ?? process.env.OPEN_SCIENCE_RESOURCES_PATH
  if (packaged) {
    if (!resources) throw new Error('Pi bootstrap resources path is unavailable.')
    return join(resources, 'backend', 'out', 'pi-bootstrap')
  }
  const backend = options.backendDirectory ?? dirname(fileURLToPath(import.meta.url))
  return resolve(backend, '..', 'pi-bootstrap')
}

const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

// Accept only the application-owned output produced by the runtime bootstrap. A checked ACP bundle
// still relies on the version-pinned SDK and its runtime guard; it is not an OS sandbox.
export const assertPiAdapter = (path: string, options: PiRuntimeLocation = {}): void => {
  const expected = piAdapterPath(options)
  if (resolve(path) !== resolve(expected)) throw new Error('Pi ACP path is not app-managed.')
  const dist = dirname(expected)
  for (const [file, digest] of Object.entries(EXPECTED)) {
    if (hash(readFileSync(join(dist, file))) !== digest) {
      throw new Error(`Pi ACP integrity check failed: ${file}`)
    }
  }
  if (hash(readFileSync(join(dist, '..', 'package.json'))) !== PACKAGE_HASH) {
    throw new Error('Pi ACP package integrity check failed.')
  }
}

export const resolvePiExecutable = async (options: PiRuntimeLocation = {}): Promise<string> => {
  const path = piAdapterPath(options)
  assertPiAdapter(path, options)
  const temporary = await mkdtemp(join(tmpdir(), 'open-science-pi-smoke-'))
  try {
    await new Promise<void>((resolveReady, reject) => {
      const child = spawn(
        process.execPath,
        [
          path,
          '--agent-dir',
          join(temporary, 'agent'),
          '--session-dir',
          join(temporary, 'sessions'),
          '--no-delegation',
          '--quiet-startup'
        ],
        {
          stdio: 'pipe',
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: temporary,
            PI_CODING_AGENT_DIR: join(temporary, 'agent'),
            PI_ACP_SESSION_DIR: join(temporary, 'sessions'),
            PI_OFFLINE: '1',
            ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {})
          }
        }
      )
      let buffer = ''
      let initialized = false
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolveReady()
      }
      const timer = setTimeout(() => {
        child.stdin.end()
        child.kill()
        finish(new Error('Pi ACP initialization timed out.'))
      }, 10_000)
      child.on('error', (error) => finish(error))
      child.stdin.on('error', () => {})
      child.stderr.resume()
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        if (buffer.length > 256 * 1024) {
          child.stdin.end()
          finish(new Error('Pi ACP initialization response exceeded the limit.'))
          return
        }
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (!line) continue
          try {
            const response = JSON.parse(line) as {
              id?: number
              result?: { protocolVersion?: number; agentInfo?: { name?: string; version?: string } }
            }
            if (response.id !== 1) continue
            initialized =
              response.result?.protocolVersion === 1 &&
              response.result.agentInfo?.name === 'openma-pi-acp' &&
              response.result.agentInfo.version === '0.1.8'
            child.stdin.end()
          } catch {
            child.stdin.end()
            finish(new Error('Pi ACP returned an invalid initialization response.'))
          }
        }
      })
      child.on('close', (code) => {
        if (initialized && code === 0) finish()
        else finish(new Error('Pi ACP initialization failed.'))
      })
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
            clientInfo: { name: 'open-science', version: '0.0.0' }
          }
        })}\n`
      )
    })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return path
}

// Preflight uses this integrity-only readiness check while another framework is active.
// Selecting or launching Pi still requires the real ACP initialization probe above.
export const isPiAdapterAvailable = (options: PiRuntimeLocation = {}): boolean => {
  try {
    assertPiAdapter(piAdapterPath(options), options)
    return true
  } catch {
    return false
  }
}

export const isPiRuntimeReady = async (options: PiRuntimeLocation = {}): Promise<boolean> => {
  try {
    await resolvePiExecutable(options)
    return true
  } catch {
    return false
  }
}
