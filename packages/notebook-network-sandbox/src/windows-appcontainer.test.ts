import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  connectionProbeSpecification,
  windowsElevationScript,
  windowsLaunch,
  windowsStandardLaunch
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
  it('launches a structured standard-mode executable directly to preserve persistent stdio', () => {
    const request = {
      command:
        "& 'D:\\Open Science\\open-science.exe' 'D:\\Open Science\\resources\\notebook\\repl_loop.js'",
      executable: 'D:\\Open Science\\open-science.exe',
      args: ['D:\\Open Science\\resources\\notebook\\repl_loop.js'],
      gatewayPort: 49700,
      gatewayCredentials: { username: 'command', password: 'secret' },
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }

    const launch = windowsStandardLaunch(request)

    expect(launch.argv).toEqual([request.executable, ...request.args])
  })

  it('launches a structured executable directly instead of through PowerShell', () => {
    const launch = windowsLaunch({
      command: "& '/runtime/python.exe' '/app/python_loop.py'",
      executable: '/runtime/python.exe',
      args: ['/app/python_loop.py'],
      cwd: '/workspace',
      gatewayPort: 49700,
      gatewayCredentials: { username: 'command', password: 'secret' },
      env: {},
      filesystem: {
        readOnlyRoots: ['/runtime', '/app/python_loop.py'],
        readWriteRoots: ['/workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      },
      hostPath: 'C:\\resources\\notebook-sandbox-host.exe',
      installationId: '0123456789abcdef01234567',
      ownershipRoot: 'C:\\sandbox'
    })

    const specification = JSON.parse(
      Buffer.from(launch.argv.at(-1)!, 'base64url').toString('utf8')
    ) as { executable: string; arguments: string[]; cwd: string }

    expect(specification).toMatchObject({
      executable: '/runtime/python.exe',
      arguments: ['/app/python_loop.py'],
      cwd: '/workspace'
    })
  })

  it('launches a structured batch-file shim through cmd.exe', () => {
    const launch = windowsLaunch({
      command: "& 'C:\\runtime path\\python.bat' 'C:\\app path\\python_loop.py'",
      executable: 'C:\\runtime path\\python.bat',
      args: ['C:\\app path\\python_loop.py'],
      cwd: 'C:\\workspace',
      gatewayPort: 49700,
      gatewayCredentials: { username: 'command', password: 'secret' },
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      filesystem: {
        readOnlyRoots: ['/runtime', '/app/python_loop.py'],
        readWriteRoots: ['/workspace'],
        deniedReadRoots: [],
        deniedWriteRoots: []
      },
      hostPath: 'C:\\resources\\notebook-sandbox-host.exe',
      installationId: '0123456789abcdef01234567',
      ownershipRoot: 'C:\\sandbox'
    })

    const specification = JSON.parse(
      Buffer.from(launch.argv.at(-1)!, 'base64url').toString('utf8')
    ) as { executable: string; arguments: string[]; verbatimArguments?: boolean }

    expect(specification).toMatchObject({
      executable: 'C:\\Windows\\System32\\cmd.exe',
      arguments: ['/d', '/s', '/c', expect.stringContaining('python.bat')],
      verbatimArguments: true
    })
  })

  it.runIf(process.platform === 'win32')(
    'keeps a standard-mode structured child alive for delayed stdin',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'os-standard-launch-'))
      const helper = join(root, 'persistent-loop.js')
      writeFileSync(
        helper,
        "require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => process.stdout.write(line + '\\n'))"
      )
      const quotePowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`
      const request = {
        command: `& ${quotePowerShell(process.execPath)} ${quotePowerShell(helper)}`,
        executable: process.execPath,
        args: [helper],
        gatewayPort: 49700,
        gatewayCredentials: { username: 'command', password: 'secret' },
        env: process.env
      }
      const launch = windowsStandardLaunch(request)
      const child = spawn(launch.argv[0]!, launch.argv.slice(1), {
        cwd: root,
        env: launch.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))

      try {
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(child.exitCode).toBeNull()
        child.stdin.write('delayed-frame\n')
        await Promise.race([
          new Promise<void>((resolve) => {
            const check = (): void => {
              if (stdout.includes('delayed-frame\n')) resolve()
              else child.stdout.once('data', check)
            }
            check()
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('structured child did not answer stdin')), 2_000)
          )
        ])
        expect(stdout).toContain('delayed-frame\n')
      } finally {
        if (child.exitCode === null) {
          child.kill()
          await once(child, 'exit')
        }
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    },
    5_000
  )

  it.runIf(process.platform === 'win32')(
    'preserves metacharacters when cmd.exe executes the generated batch invocation',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'os-batch-launch-'))
      const shim = join(root, 'python shim.cmd')
      const helper = join(root, 'print-argument.js')
      writeFileSync(helper, 'process.stdout.write(`[${process.argv[2]}]`)')
      writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${helper}" %*\r\n`)
      try {
        const launch = windowsLaunch({
          command: 'unused',
          executable: shim,
          args: ['hello & goodbye'],
          cwd: root,
          gatewayPort: 49700,
          gatewayCredentials: { username: 'command', password: 'secret' },
          env: { ComSpec: process.env.ComSpec },
          filesystem: {
            readOnlyRoots: [root],
            readWriteRoots: [root],
            deniedReadRoots: [],
            deniedWriteRoots: []
          },
          hostPath: 'C:\\resources\\notebook-sandbox-host.exe',
          installationId: '0123456789abcdef01234567',
          ownershipRoot: 'C:\\sandbox'
        })
        const specification = JSON.parse(
          Buffer.from(launch.argv.at(-1)!, 'base64url').toString('utf8')
        ) as { executable: string; arguments: string[]; verbatimArguments: boolean }

        const result = spawnSync(specification.executable, specification.arguments, {
          cwd: root,
          encoding: 'utf8',
          windowsVerbatimArguments: specification.verbatimArguments
        })

        expect(result.status).toBe(0)
        expect(result.stdout.trim()).toBe('[hello & goodbye]')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

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
