import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { seatbeltProfile } from '../runtime/src/platform/macos-isolation.js'
import { validateLocalService } from '../runtime/src/platform/local-service.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const capability = (): { executionId: string; socketPath: string } => {
  // Use a short path: sockaddr_un on macOS has a 104-byte path field.
  const root = realpathSync(
    mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'os-service-run-'))
  )
  chmodSync(root, 0o700)
  roots.push(root)
  return { executionId: 'run', socketPath: join(root, 'service.sock') }
}
const request = {
  command: 'node fixture.js',
  shell: '/bin/bash',
  gatewayPort: 3128,
  gatewayCredentials: { username: 'fixture', password: 'not-a-secret' },
  env: {},
  filesystem: { readOnlyRoots: [], readWriteRoots: [], deniedReadRoots: [], deniedWriteRoots: [] }
}

describe('host-issued local service capability', () => {
  it.skipIf(process.platform === 'win32')(
    'adds only an exact Unix path and retains default TCP policy',
    () => {
      const ordinary = seatbeltProfile(request)
      expect(ordinary).not.toContain('network-inbound')
      expect(ordinary).not.toContain('network-bind')
      const service = capability()
      const enabled = seatbeltProfile({ ...request, localService: service })
      expect(enabled).toContain('(deny network*)')
      for (const op of ['network-bind', 'network-inbound', 'network-outbound']) {
        expect(enabled).toContain(`(allow ${op} (literal ${JSON.stringify(service.socketPath)}))`)
      }
      expect(enabled).not.toContain('localhost:*')
      expect(seatbeltProfile(request)).toBe(ordinary)
    }
  )

  it.each(['linux', 'win32'] as const)('fails closed on %s', (platform) => {
    expect(() => validateLocalService(capability(), platform)).toThrow('only by the native macOS')
  })

  it.skipIf(process.platform === 'win32')(
    'rejects WSL, malformed identity, traversal, foreign run paths and unknown grants',
    () => {
      const service = capability()
      expect(() => validateLocalService(service, 'darwin', 'wsl2')).toThrow()
      for (const value of [
        { ...service, executionId: '' },
        { ...service, executionId: 'different-run' },
        { ...service, socketPath: 'service.sock' },
        { ...service, socketPath: service.socketPath.replace('/service.sock', '/../service.sock') },
        { ...service, socketPath: '/tmp/' + 'x'.repeat(104) + '/service.sock' },
        { ...service, listenPorts: [45123] }
      ])
        expect(() => validateLocalService(value, 'darwin')).toThrow()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rejects a shared directory, occupied socket name and symlink ancestors',
    () => {
      const service = capability()
      const root = roots.at(-1)!
      chmodSync(root, 0o755)
      expect(() => validateLocalService(service, 'darwin')).toThrow('private')
      chmodSync(root, 0o700)
      writeFileSync(service.socketPath, '')
      expect(() => validateLocalService(service, 'darwin')).toThrow('occupied')
      rmSync(service.socketPath)
      const real = join(root, 'real')
      mkdirSync(real, { mode: 0o700 })
      const link = join(root, 'os-service-run-linked')
      symlinkSync(real, link)
      expect(() =>
        validateLocalService({ ...service, socketPath: join(link, 'service.sock') }, 'darwin')
      ).toThrow('private')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'captures immutable identity and path before asynchronous launch preparation',
    () => {
      const input = capability()
      const captured = validateLocalService(input, 'darwin')
      input.executionId = 'changed'
      expect(captured.executionId).toBe('run')
      expect(Object.isFrozen(captured)).toBe(true)
    }
  )
})
