import { describe, expect, it } from 'vitest'

import {
  connectionProbeSpecification,
  windowsElevationScript,
  windowsLaunch
} from '../runtime/src/platform/windows-appcontainer.js'

describe('Windows AppContainer network fence probe', () => {
  it('keeps PowerShell catch and finally clauses attached to the try statement', () => {
    const specification = JSON.parse(
      Buffer.from(connectionProbeSpecification(49700), 'base64url').toString('utf8')
    ) as { arguments: string[] }
    const command = specification.arguments.at(-1)

    expect(command).toContain("ConnectAsync('127.0.0.1', 49700)")
    expect(command).toContain('}\ncatch { exit 33 }\nfinally { $client.Dispose() }')
    expect(command).not.toContain('}; catch')
  })
})

describe('Windows AppContainer elevation', () => {
  it('recognizes a wrapped Windows UAC cancellation without matching localized text', () => {
    const script = windowsElevationScript(
      "C:\\Program Files\\Open Science\\host's.exe",
      '0123456789abcdef01234567',
      'C:\\Users\\Researcher\\AppData\\Local\\sandbox',
      'setup'
    )

    expect(script).toContain('} catch { exit 1223 }')
    expect(script).toContain("'C:\\Program Files\\Open Science\\host''s.exe'")
  })
})

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
