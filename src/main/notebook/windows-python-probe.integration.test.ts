import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createWindowsPythonFixture,
  execWindowsPython,
  type WindowsPythonFixture
} from './windows-python.test-support'
import { defaultDiscoveryDeps, discoverInterpreters } from './environment-discovery'
import { findPythonCommand, probeInterpreterVersion } from './python-command'
import { flushLogs, initLogger } from '../logger'

// Host-only regression: uses production probes, real CPython venvs and real Windows subprocesses.
// OPEN_SCIENCE_TEST_PYTHON selects a real installation when it is not available through PATH/py.
describe.skipIf(process.platform !== 'win32')('real Windows Python version probes', () => {
  let fixture: WindowsPythonFixture

  beforeAll(async () => {
    fixture = await createWindowsPythonFixture()
    initLogger({ logDir: join(fixture.root, 'logs'), mirrorToConsole: true })
  }, 90_000)

  afterAll(async () => {
    await flushLogs()
    await fixture?.cleanup()
  })

  it.each(['plain', 'spaces', 'parentheses'] as const)(
    'discovers and validates a runnable interpreter under %s paths',
    async (variant) => {
      const interpreter = fixture.interpreters[variant]
      await expect
        .soft(
          defaultDiscoveryDeps(join(fixture.root, 'runtime')).probeVersion(interpreter, 'python')
        )
        .resolves.toBe(fixture.version)
      await expect.soft(probeInterpreterVersion(interpreter)).resolves.toBe(fixture.version)
    }
  )

  it('reproduces the old shell command failure against the same real interpreter', async () => {
    const interpreter = fixture.interpreters.parentheses
    await expect(
      execWindowsPython(interpreter, ['--version'], {
        timeout: 10_000,
        windowsHide: true,
        shell: true
      })
    ).rejects.toMatchObject({ code: 1 })
  })

  it('reports the Python version across every path shape for 20 rounds', async () => {
    const discovery = defaultDiscoveryDeps(join(fixture.root, 'runtime'))
    for (let round = 0; round < 20; round++) {
      for (const interpreter of Object.values(fixture.interpreters)) {
        await expect(discovery.probeVersion(interpreter, 'python')).resolves.toBe(fixture.version)
        await expect(probeInterpreterVersion(interpreter)).resolves.toBe(fixture.version)
      }
    }
  }, 60_000)

  it('reports the version even when a Python startup hook fails', async () => {
    const hookDirectory = join(fixture.root, 'failing-startup-hook')
    await mkdir(hookDirectory)
    await writeFile(join(hookDirectory, 'sitecustomize.py'), 'raise SystemExit(73)\n')
    const env = { ...process.env, PYTHONPATH: hookDirectory }
    const interpreter = fixture.interpreters.plain
    await expect(
      execWindowsPython(interpreter, ['-c', 'pass'], {
        env,
        timeout: 10_000,
        windowsHide: true
      })
    ).rejects.toMatchObject({ stderr: expect.stringContaining('SystemExit: 73') })
    await expect(probeInterpreterVersion(interpreter, [], { env })).resolves.toBe(fixture.version)
  })

  it('rejects corrupt, missing, and real non-Python executables', async () => {
    await expect(
      execWindowsPython(fixture.brokenInterpreter, ['--version'], {
        timeout: 10_000,
        windowsHide: true
      })
    ).rejects.toBeDefined()
    for (const interpreter of [
      fixture.brokenInterpreter,
      join(fixture.root, 'missing-python.exe'),
      process.execPath
    ]) {
      await expect(
        defaultDiscoveryDeps(join(fixture.root, 'runtime')).probeVersion(interpreter, 'python')
      ).resolves.toBeUndefined()
      await expect(probeInterpreterVersion(interpreter)).resolves.toBeUndefined()
    }
  })

  it.each(['cmd', 'bat'])(
    'rejects a .%s launcher that cannot be launched by the Python execution chain',
    async (extension) => {
      const launcherDirectory = join(fixture.root, 'Launchers (Python)')
      await mkdir(launcherDirectory, { recursive: true })
      const launcher = join(launcherDirectory, `python.${extension}`)
      await writeFile(launcher, `@echo off\r\n"${fixture.interpreters.parentheses}" %*\r\n`)
      await expect(
        execWindowsPython(launcher, ['--version'], { timeout: 10_000, windowsHide: true })
      ).rejects.toBeDefined()
      await expect(probeInterpreterVersion(launcher)).resolves.toBeUndefined()
      await expect(
        defaultDiscoveryDeps(join(fixture.root, 'runtime')).probeVersion(launcher, 'python')
      ).resolves.toBeUndefined()
    }
  )

  it('discovers a manually added path with spaces and parentheses as runnable', async () => {
    const interpreter = fixture.interpreters.parentheses
    const discovery = defaultDiscoveryDeps(join(fixture.root, 'runtime'), () => [interpreter])
    expect(await discovery.candidatePaths('python')).toContain(interpreter)
    const environments = await discoverInterpreters('python', discovery)
    expect(
      environments.find((environment) => environment.interpreterPath === interpreter)
    ).toMatchObject({
      runnable: true,
      version: fixture.version,
      provenance: 'user-own'
    })
  })

  it('preserves the installed py -3 launcher when available', async (context) => {
    let version: string
    let launcherExecutable: string
    try {
      const { stdout: locations } = await execWindowsPython('where.exe', ['py'], {
        timeout: 10_000,
        windowsHide: true
      })
      launcherExecutable = locations.trim().split(/\r?\n/)[0]
      const { stdout } = await execWindowsPython(
        'py',
        ['-3', '-c', 'import sys; print(sys.version.split()[0], flush=True)'],
        {
          timeout: 10_000,
          windowsHide: true
        }
      )
      version = stdout.trim()
    } catch {
      context.skip()
      return
    }
    await expect(probeInterpreterVersion('py', ['-3'])).resolves.toBe(version)
    const python = await findPythonCommand()
    expect(python).toEqual({ command: 'py', baseArgs: ['-3'] })

    const launcherDirectory = join(fixture.root, 'Executable Launchers (Python)')
    await mkdir(launcherDirectory, { recursive: true })
    const copiedLauncher = join(launcherDirectory, 'py.exe')
    await cp(launcherExecutable, copiedLauncher)
    await expect(probeInterpreterVersion(copiedLauncher, ['-3'])).resolves.toBe(version)
  })

  it('retains real py -0p installation paths containing spaces', async (context) => {
    let installations: string
    try {
      const { stdout, stderr } = await execWindowsPython('py', ['-0p'], {
        timeout: 10_000,
        windowsHide: true
      })
      installations = `${stdout}\n${stderr}`
    } catch {
      context.skip()
      return
    }
    const realPaths = installations
      .split(/\r?\n/)
      .map((line) => line.match(/([A-Za-z]:\\.*?python(?:3)?\.exe)\s*$/i)?.[1])
      .filter((path): path is string => Boolean(path && path.includes(' ')))
    if (realPaths.length === 0) {
      context.skip()
      return
    }
    const candidates = await defaultDiscoveryDeps(join(fixture.root, 'runtime')).candidatePaths(
      'python'
    )
    for (const interpreter of realPaths) expect(candidates).toContain(interpreter)
  })
})
