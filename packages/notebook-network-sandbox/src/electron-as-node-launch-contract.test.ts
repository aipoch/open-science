import { describe, expect, it, vi } from 'vitest'

import {
  ELECTRON_NO_STDIO_INIT,
  windowsLaunch
} from '../runtime/src/platform/windows-appcontainer.js'

const backend = vi.hoisted(() => ({
  wrap: vi.fn(async (request: Record<string, unknown>) => ({
    argv: ['child.exe'],
    env: (request.env ?? {}) as NodeJS.ProcessEnv,
    annotateStderr: (value: string) => value,
    cleanup: async () => ({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    }),
    setExecutionActive: () => undefined,
    resetNetworkConnections: () => undefined
  })),
  initialize: vi.fn(async () => {}),
  reset: vi.fn(async () => {})
}))

vi.mock('../runtime/src/index.js', () => ({
  NotebookNetworkRuntime: backend,
  statusForPlatform: vi.fn(async () => ({ warnings: [], errors: [] }))
}))

import { NotebookNetworkSandbox } from './index.js'

describe('Electron-as-Node launch intent contract', () => {
  it('forwards an explicit Electron-as-Node intent through the production sandbox seam', async () => {
    const sandbox = new NotebookNetworkSandbox({
      resources: { root: 'C:\\resources' },
      policy: { allowedDomains: [], deniedDomains: [] }
    })
    await sandbox.initialize()
    await sandbox.wrap({
      command: 'electron repl_loop.js',
      executable: 'C:\\Program Files\\Open-Science\\open-science.exe',
      args: ['repl_loop.js'],
      electronAsNode: true,
      cwd: process.cwd(),
      env: { ELECTRON_RUN_AS_NODE: '1' },
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: [process.cwd()],
        deniedReadRoots: [],
        deniedWriteRoots: []
      },
      onNetworkAccessRequest: async () => false
    })
    expect(backend.wrap).toHaveBeenCalledWith(expect.objectContaining({ electronAsNode: true }))
  })

  it('does not infer Electron from an inherited environment marker', () => {
    const launch = windowsLaunch({
      command: 'node repl_loop.js',
      executable: 'C:\\Program Files\\Node\\node.exe',
      args: ['repl_loop.js'],
      electronAsNode: false,
      cwd: process.cwd(),
      gatewayPort: 49700,
      gatewayCredentials: { username: 'contract', password: 'contract' },
      env: { ELECTRON_RUN_AS_NODE: '1' },
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: [process.cwd()],
        deniedReadRoots: [],
        deniedWriteRoots: []
      },
      hostPath: 'C:\\resources\\notebook-appcontainer-host.exe',
      installationId: '0123456789abcdef01234567',
      ownershipRoot: 'C:\\sandbox'
    })
    const specification = JSON.parse(
      Buffer.from(launch.argv.at(-1)!, 'base64url').toString('utf8')
    ) as { arguments: string[] }
    expect(specification.arguments).toEqual(['repl_loop.js'])
    expect(specification.arguments).not.toContain(ELECTRON_NO_STDIO_INIT)
  })
})
