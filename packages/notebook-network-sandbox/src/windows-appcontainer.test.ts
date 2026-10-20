import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { open, type FileHandle } from 'node:fs/promises'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  connectionProbeSpecification,
  windowsElevationScript,
  windowsLaunch,
  windowsSupervisedLaunch,
  windowsStandardLaunch
} from '../runtime/src/platform/windows-appcontainer.js'
import {
  applyElectronAsNodeLaunchPolicy,
  ELECTRON_NO_STDIO_INIT
} from '../runtime/src/platform/electron-as-node-launch-policy.js'

afterEach(() => vi.unstubAllEnvs())

describe.runIf(process.platform === 'win32')('Windows native Shell control pipe', () => {
  it.each([false, true])(
    'forwards fragmented input and rejects a different peer (%s)',
    async (wrongPeer) => {
      const root = mkdtempSync(join(tmpdir(), 'os-shell-pipe-'))
      const name = `OpenScience.Shell.${randomUUID().replaceAll('-', '')}`
      const code = wrongPeer
        ? 'Start-Sleep -Seconds 30'
        : `$p = [IO.Pipes.NamedPipeClientStream]::new('.', '${name}', [IO.Pipes.PipeDirection]::In); $p.Connect(10000); $r = [IO.StreamReader]::new($p); $s = ''; for ($i = 0; $i -lt 20; $i++) { $s += $r.ReadLine() }; [Console]::Write($s); [Console]::Write(':' + ($null -eq [Console]::ReadLine())); $r.Dispose(); $p.Dispose(); exit 7`
      const launch = windowsSupervisedLaunch({
        command: code,
        executable: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(code, 'utf16le').toString('base64')
        ],
        cwd: root,
        hostPath: join(
          process.cwd(),
          `packages/notebook-network-sandbox/vendor/windows/${process.arch}/notebook-appcontainer-host.exe`
        ),
        gatewayPort: 49700,
        gatewayCredentials: { username: 'unused', password: 'unused' },
        env: process.env,
        windowsShellControlPipe: name
      })
      const child = spawn(launch.argv[0]!, launch.argv.slice(1), {
        cwd: root,
        env: launch.env,
        windowsHide: true
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (data: string) => (stdout += data))
      child.stderr.setEncoding('utf8').on('data', (data: string) => (stderr += data))
      child.stdin.on('error', () => undefined)
      const closed = once(child, 'close')
      let impostor: FileHandle | undefined
      try {
        if (wrongPeer) {
          await expect
            .poll(async () => {
              try {
                impostor = await open(`\\\\.\\pipe\\${name}`, 'r')
                return true
              } catch {
                return false
              }
            })
            .toBe(true)
        } else {
          const frame = Array.from({ length: 20 }, (_, i) => `${i}:${'x'.repeat(3000)}\n`).join('')
          for (let offset = 0; offset < frame.length; offset += 777) {
            child.stdin.write(frame.slice(offset, offset + 777))
            await new Promise<void>((resolve) => setImmediate(resolve))
          }
        }
        const [exitCode] = await closed
        expect(exitCode, stderr).toBe(wrongPeer ? 1 : 7)
        if (wrongPeer) expect(stderr).toContain('unexpected Shell control client')
        else
          expect(stdout).toBe(
            Array.from({ length: 20 }, (_, i) => `${i}:${'x'.repeat(3000)}`).join('') + ':True'
          )
        expect(await launch.confirmProcessTreeTermination()).toBe(true)
        expect(await launch.requestProcessTreeTermination()).toBe(true)
        await expect(launch.confirmProcessState?.()).resolves.toBe('started-and-reaped')
        const socket = createConnection(`\\\\.\\pipe\\${name}`)
        try {
          await expect(once(socket, 'connect')).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
          socket.destroy()
        }
      } finally {
        await impostor?.close()
        if (child.exitCode === null) {
          child.kill()
          await closed
        }
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    },
    35_000
  )
})

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
  it.skipIf(process.platform !== 'win32')(
    'preserves native helper arguments and waits for its exit code',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'r elevation '))
      try {
        const helper = join(root, "argument helper's.exe")
        const output = join(root, 'arguments.txt')
        const args = [
          'with spaces',
          'with"quote',
          'trailing\\',
          'space and slash\\',
          'slash\\"quote'
        ]
        const expected = ['setup', 'installation', root, ...args]
        const source = `using System; using System.IO;
          public class Arguments {
            public static int Main(string[] args) {
              File.WriteAllLines(Environment.GetEnvironmentVariable("R_ELEVATION_TEST_OUTPUT"),
                Array.ConvertAll(args, arg => Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(arg))));
              return 7;
            }
          }`
        // Keep the real Windows argument parser and process wait; do not request UAC in CI.
        const script = windowsElevationScript(helper, 'installation', root, 'setup', args)
          .replace('-Verb RunAs', '-Verb Open')
          .replace("$start.Verb = 'runas'", "$start.Verb = 'open'")
        const fixture = `Add-Type -TypeDefinition '${source.replaceAll("'", "''")}' -OutputAssembly '${helper.replaceAll("'", "''")}' -OutputType ConsoleApplication; `
        const result = spawnSync(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(fixture + script, 'utf16le').toString('base64')
          ],
          {
            windowsHide: true,
            encoding: 'utf8',
            env: { ...process.env, R_ELEVATION_TEST_OUTPUT: output }
          }
        )
        expect(result.status, result.stderr).toBe(7)
        expect(
          readFileSync(output, 'utf8')
            .trimEnd()
            .split(/\r?\n/)
            .map((value) => Buffer.from(value, 'base64').toString('utf8'))
        ).toEqual(expected)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('recognizes a wrapped Windows UAC cancellation without matching localized text', () => {
    const script = windowsElevationScript(
      "C:\\Program Files\\Open-Science\\host's.exe",
      '0123456789abcdef01234567',
      'C:\\Users\\Researcher\\AppData\\Local\\sandbox',
      'setup'
    )

    expect(script).toContain('$failure.NativeErrorCode -eq 1223')
    expect(script).toContain('$failure = $failure.InnerException')
    expect(script).toContain('[Console]::Error.WriteLine($_.Exception.Message)')
    expect(script).toContain('exit 1')
    expect(script).toContain("'C:\\Program Files\\Open-Science\\host''s.exe'")
  })
})

describe('Windows AppContainer launch', () => {
  it.each([
    [
      'restricted Windows Electron-as-Node',
      { platform: 'win32' as NodeJS.Platform, restricted: true, electronAsNode: true },
      [ELECTRON_NO_STDIO_INIT, 'repl_loop.js']
    ],
    [
      'ordinary Windows launch',
      { platform: 'win32' as NodeJS.Platform, restricted: false, electronAsNode: true },
      ['repl_loop.js']
    ],
    [
      'unrestricted Electron-as-Node launch',
      { platform: 'win32' as NodeJS.Platform, restricted: false, electronAsNode: true },
      ['repl_loop.js']
    ],
    [
      'non-Windows Electron-as-Node launch',
      { platform: 'linux' as NodeJS.Platform, restricted: true, electronAsNode: true },
      ['repl_loop.js']
    ],
    [
      'Windows Python/R launch',
      { platform: 'win32' as NodeJS.Platform, restricted: true, electronAsNode: false },
      ['repl_loop.js']
    ]
  ])('applies the NUL compatibility switch only to %s', (_name, intent, expected) => {
    expect(applyElectronAsNodeLaunchPolicy({ ...intent, args: ['repl_loop.js'] })).toEqual(expected)
  })

  it('does not duplicate the NUL compatibility switch when a caller already supplied it', () => {
    expect(
      applyElectronAsNodeLaunchPolicy({
        platform: 'win32',
        restricted: true,
        electronAsNode: true,
        args: [ELECTRON_NO_STDIO_INIT, 'repl_loop.js']
      })
    ).toEqual([ELECTRON_NO_STDIO_INIT, 'repl_loop.js'])
  })

  it('keeps nested optional PATH candidates until their individual permissions are checked', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'optional-path-')))
    const parent = join(root, 'tools')
    const child = join(parent, 'bin')
    try {
      const launch = windowsLaunch({
        command: 'node script.js',
        executable: process.execPath,
        args: ['script.js'],
        cwd: root,
        gatewayPort: 49700,
        gatewayCredentials: { username: 'command', password: 'secret' },
        env: {},
        filesystem: {
          readOnlyRoots: [],
          optionalReadOnlyRoots: [parent, child, child],
          readWriteRoots: [root],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        hostPath: join(root, 'host.exe'),
        installationId: '0123456789abcdef01234567',
        ownershipRoot: root
      })
      const specification = JSON.parse(
        Buffer.from(launch.argv.at(-1)!, 'base64url').toString('utf8')
      )
      expect(specification.optionalReadOnlyRoots).toEqual([parent, child])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supervises standard-mode commands without requiring AppContainer setup', () => {
    const request = {
      command: 'Write-Output ready',
      cwd: 'C:\\workspace',
      hostPath: 'C:\\resources\\notebook-sandbox-host.exe',
      gatewayPort: 49700,
      gatewayCredentials: { username: 'command', password: 'secret' },
      env: {}
    }

    const launch = windowsSupervisedLaunch(request)
    const specification = JSON.parse(
      Buffer.from(launch.argv.at(-1)!, 'base64url').toString('utf8')
    ) as {
      executable: string
      arguments: string[]
      cwd: string
      terminationProofPath: string
      terminationProofToken: string
    }

    expect(launch.argv.slice(0, 2)).toEqual([request.hostPath, 'supervise'])
    expect(launch.confirmProcessTreeTermination).toBeTypeOf('function')
    expect(launch.requestProcessTreeTermination).toBeTypeOf('function')
    expect(specification).toMatchObject({
      executable: 'powershell.exe',
      arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', request.command],
      cwd: request.cwd,
      terminationProofPath: expect.stringContaining('.open-science-process-tree-terminated-'),
      terminationProofToken: expect.any(String)
    })
  })

  it('retries a termination request after its temporary directory becomes available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-proof-retry-'))
    const temporary = join(root, 'initially-missing')
    const launch = windowsSupervisedLaunch({
      command: 'unused',
      cwd: root,
      hostPath: join(root, 'host.exe'),
      gatewayPort: 49700,
      gatewayCredentials: { username: 'unused', password: 'unused' },
      env: { TEMP: temporary }
    })
    const spec = JSON.parse(Buffer.from(launch.argv.at(-1)!, 'base64url').toString('utf8'))
    try {
      await expect(launch.requestProcessTreeTermination()).resolves.toBe(false)
      mkdirSync(temporary)
      const retry = launch.requestProcessTreeTermination()
      await expect.poll(() => existsSync(spec.terminationRequestPath), { timeout: 500 }).toBe(true)
      expect(readFileSync(spec.terminationRequestPath, 'utf8')).toBe(spec.terminationProofToken)
      writeFileSync(
        spec.terminationProofPath,
        JSON.stringify({
          version: 1,
          token: spec.terminationProofToken,
          processState: 'started-and-reaped'
        })
      )
      await expect(retry).resolves.toBe(true)
      await expect(launch.requestProcessTreeTermination()).resolves.toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  describe.each(['never-started', 'started-and-reaped'] as const)(
    'terminal process proof: %s',
    (terminalState) => {
      it.each([
        'foreign token',
        'unsupported version',
        'preparation pending',
        'unrecognized state',
        'malformed JSON',
        'null JSON'
      ] as const)('rejects %s and accepts later matching evidence', async (invalidProof) => {
        const root = mkdtempSync(join(tmpdir(), 'os-proof-validation-'))
        const launch = windowsSupervisedLaunch({
          command: 'unused',
          cwd: root,
          hostPath: join(root, 'host.exe'),
          gatewayPort: 49700,
          gatewayCredentials: { username: 'unused', password: 'unused' },
          env: { TEMP: root }
        })
        const spec = JSON.parse(Buffer.from(launch.argv.at(-1)!, 'base64url').toString('utf8'))
        const proof = {
          version: 1,
          token: spec.terminationProofToken,
          processState: terminalState
        }
        const invalidContents = {
          'foreign token': JSON.stringify({ ...proof, token: 'another-launch' }),
          'unsupported version': JSON.stringify({ ...proof, version: 2 }),
          'preparation pending': JSON.stringify({ ...proof, processState: 'termination-unknown' }),
          'unrecognized state': JSON.stringify({ ...proof, processState: 'finished' }),
          'malformed JSON': '{',
          'null JSON': 'null'
        }
        try {
          writeFileSync(spec.terminationProofPath, invalidContents[invalidProof])
          await expect(launch.confirmProcessState()).resolves.toBe('termination-unknown')
          await expect(launch.confirmProcessTreeTermination()).resolves.toBe(false)
          expect(existsSync(spec.terminationProofPath)).toBe(true)

          writeFileSync(spec.terminationProofPath, JSON.stringify(proof))
          await expect(launch.confirmProcessState()).resolves.toBe(terminalState)
          expect(existsSync(spec.terminationProofPath)).toBe(false)
          await expect(launch.confirmProcessTreeTermination()).resolves.toBe(true)
          await expect(launch.confirmProcessState()).resolves.toBe(terminalState)
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      })
    }
  )

  it('launches a structured standard-mode executable directly to preserve persistent stdio', () => {
    const request = {
      command:
        "& 'D:\\Open-Science\\open-science.exe' 'D:\\Open-Science\\resources\\notebook\\repl_loop.js'",
      executable: 'D:\\Open-Science\\open-science.exe',
      args: ['D:\\Open-Science\\resources\\notebook\\repl_loop.js'],
      gatewayPort: 49700,
      gatewayCredentials: { username: 'command', password: 'secret' },
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }

    const launch = windowsStandardLaunch(request)

    expect(launch.argv).toEqual([request.executable, ...request.args])
  })

  it('supplies the AppContainer-local data base when the command environment is isolated', () => {
    const localAppData = join(tmpdir(), 'local-app-data')
    const runtimeRoot = join(tmpdir(), 'runtime')
    const appRoot = join(tmpdir(), 'app')
    const workspaceRoot = join(tmpdir(), 'workspace')
    vi.stubEnv('LOCALAPPDATA', localAppData)

    const launch = windowsLaunch({
      command: 'node repl_loop.js',
      executable: join(runtimeRoot, 'node.exe'),
      args: [join(appRoot, 'repl_loop.js')],
      cwd: workspaceRoot,
      gatewayPort: 49700,
      gatewayCredentials: { username: 'command', password: 'secret' },
      env: {},
      filesystem: {
        readOnlyRoots: [runtimeRoot, appRoot],
        readWriteRoots: [workspaceRoot],
        deniedReadRoots: [],
        deniedWriteRoots: []
      },
      hostPath: 'C:\\resources\\notebook-sandbox-host.exe',
      installationId: '0123456789abcdef01234567',
      ownershipRoot: 'C:\\sandbox'
    })

    expect(launch.env.LOCALAPPDATA).toBe(localAppData)
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
    expect(launch.confirmProcessTreeTermination).toBeTypeOf('function')
    expect(launch.requestProcessTreeTermination).toBeTypeOf('function')
  })

  it.runIf(process.platform === 'win32')(
    'adds Electron no-stdio-init only to a restricted Electron-as-Node child',
    () => {
      const launch = windowsLaunch({
        command: 'unused',
        executable: process.execPath,
        args: ['repl_loop.js'],
        electronAsNode: true,
        cwd: 'C:\\workspace',
        gatewayPort: 49700,
        gatewayCredentials: { username: 'command', password: 'secret' },
        env: { ELECTRON_RUN_AS_NODE: '1' },
        filesystem: {
          readOnlyRoots: ['C:\\runtime'],
          readWriteRoots: ['C:\\workspace'],
          deniedReadRoots: [],
          deniedWriteRoots: []
        },
        hostPath: 'C:\\resources\\notebook-sandbox-host.exe',
        installationId: '0123456789abcdef01234567',
        ownershipRoot: 'C:\\sandbox'
      })
      const specification = JSON.parse(
        Buffer.from(launch.argv.at(-1)!, 'base64url').toString('utf8')
      ) as { arguments: string[] }
      expect(specification.arguments).toEqual([ELECTRON_NO_STDIO_INIT, 'repl_loop.js'])
    }
  )

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

  it.runIf(process.platform === 'win32' && process.arch === 'x64')(
    'preserves the leader exit code and reaps its standard-mode helper before proving cleanup',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'os-supervised-launch-'))
      const pidFile = join(root, 'helper.pid')
      const leader = join(root, 'leader.js')
      writeFileSync(
        leader,
        [
          "const { spawn } = require('node:child_process')",
          "const { writeFileSync } = require('node:fs')",
          "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
          `writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid))`,
          'helper.unref()',
          'process.exitCode = 19'
        ].join(';')
      )
      const launch = windowsSupervisedLaunch({
        command: 'unused',
        executable: process.execPath,
        args: [leader],
        cwd: root,
        hostPath: join(
          process.cwd(),
          'packages/notebook-network-sandbox/vendor/windows/x64/notebook-appcontainer-host.exe'
        ),
        gatewayPort: 49700,
        gatewayCredentials: { username: 'command', password: 'secret' },
        env: process.env
      })
      const supervisor = spawn(launch.argv[0]!, launch.argv.slice(1), {
        cwd: root,
        env: launch.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const [code] = (await once(supervisor, 'exit')) as [number | null]
      const helperPid = Number(readFileSync(pidFile, 'utf8'))

      try {
        expect(code).toBe(19)
        await expect(launch.confirmProcessTreeTermination()).resolves.toBe(true)
        expect(() => process.kill(helperPid, 0)).toThrow()
      } finally {
        try {
          process.kill(helperPid, 'SIGKILL')
        } catch {
          // Expected once the supervisor closes its kill-on-close Job Object.
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
