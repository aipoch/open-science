import { describe, expect, it } from 'vitest'

import { windowsLaunch } from '../runtime/src/platform/windows-appcontainer.js'

describe('Windows AppContainer launch', () => {
  it('routes local RPC through the authenticated command gateway', () => {
    const launch = windowsLaunch({
      command: 'node repl_loop.js',
      cwd: '/workspace',
      gatewayPort: 49700,
      gatewayCredentials: { username: 'command', password: 'secret' },
      env: {
        OPEN_SCIENCE_MCP_RPC_ENDPOINT: 'http://localhost',
        OPEN_SCIENCE_MCP_RPC_SOCKET_PATH: '\\\\.\\pipe\\open-science-notebook'
      },
      localRpcSocketPath: '\\\\.\\pipe\\open-science-notebook',
      filesystem: {
        readOnlyRoots: ['/runtime'],
        readWriteRoots: ['/workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      },
      hostPath: 'C:\\resources\\notebook-sandbox-host.exe',
      installationId: '0123456789abcdef01234567',
      ownershipRoot: 'C:\\sandbox'
    })

    expect(launch.env.OPEN_SCIENCE_MCP_RPC_ENDPOINT).toBe(
      'http://open-science-notebook-rpc.invalid/'
    )
    expect(launch.env.OPEN_SCIENCE_MCP_RPC_SOCKET_PATH).toBeUndefined()
    expect(launch.env.HTTP_PROXY).toContain('command:secret@127.0.0.1:49700')
  })
})
