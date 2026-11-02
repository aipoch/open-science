import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import {
  inspectInstallationProcesses,
  inspectInstallationProcessesAsync
} from './installation-occupancy'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'

function waitForFileHolder(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ''
    let errors = ''
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onErrorData)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      if (output.includes('file-held')) finish()
    }
    const onErrorData = (chunk: Buffer): void => {
      errors += chunk.toString()
    }
    const onError = (error: Error): void => finish(error)
    const onExit = (): void => finish(new Error(`File holder exited before readiness: ${errors}`))
    const timer = setTimeout(() => finish(new Error(`File holder timed out: ${errors}`)), 15_000)
    child.stdout.on('data', onData)
    child.stderr.on('data', onErrorData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function stopFileHolder(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('File holder did not exit.')), 5000)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGKILL')
  })
}

it.runIf(process.platform === 'win32')(
  'detects and releases a Windows file occupant despite customized PowerShell search paths',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'installation-occupancy-'))
    const installation = join(root, '应用 程序')
    const modules = join(root, 'host-modules')
    const module = join(modules, 'CimCmdlets')
    await mkdir(installation)
    await mkdir(module, { recursive: true })
    const file = join(installation, 'helper.dat')
    await writeFile(file, 'fixture')
    // A host module with the same name must never replace the system identity provider.
    await writeFile(
      join(module, 'CimCmdlets.psd1'),
      "@{RootModule='CimCmdlets.psm1';ModuleVersion='1.0.0';FunctionsToExport=@('Get-CimInstance')}"
    )
    await writeFile(
      join(module, 'CimCmdlets.psm1'),
      "function Get-CimInstance { throw 'Unexpected host CimCmdlets module' }"
    )
    const powershell = resolveWindowsPowerShellExecutable()
    const encoded = Buffer.from(file, 'utf8').toString('base64')
    // Start before customizing PATH. An exclusive file handle, rather than the command line or
    // executable location, is the only evidence linking this external process to the installation.
    const child = spawn(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ` +
          '$file = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); ' +
          'try { [Console]::WriteLine("file-held"); [Console]::ReadLine() | Out-Null } finally { $file.Dispose() }'
      ],
      { windowsHide: true, stdio: 'pipe' }
    )
    try {
      await waitForFileHolder(child)
      const systemModules = join(powershell, '..', 'Modules')
      vi.stubEnv('PSModulePath', `${modules};${systemModules}`)
      expect(await inspectInstallationProcessesAsync(installation)).toContain(child.pid)
      vi.stubEnv('PATH', root)
      expect(inspectInstallationProcesses(installation)).toContain(child.pid)
      expect(await inspectInstallationProcessesAsync(installation)).toContain(child.pid)
      await stopFileHolder(child)
      expect(await inspectInstallationProcessesAsync(installation)).not.toContain(child.pid)
    } finally {
      vi.unstubAllEnvs()
      try {
        await stopFileHolder(child)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  },
  90_000
)

it.runIf(process.platform === 'darwin')(
  'detects an actual installation file handle without a matching command line',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'installation-handle-'))
    const installation = join(root, 'Science.app')
    await mkdir(installation)
    const file = join(installation, 'helper.dat')
    await writeFile(file, 'fixture')
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
    process.once('message', path => {
      require('node:fs').openSync(path, 'r');
      process.send('ready');
      setInterval(() => {}, 1000);
    });
  `
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    )
    try {
      const ready = new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve())
        child.once('error', reject)
        child.once('exit', () => reject(new Error('Fixture exited before opening file')))
      })
      child.send(file)
      await ready
      expect(await inspectInstallationProcessesAsync(installation)).toContain(child.pid)
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      await exited
      expect(await inspectInstallationProcessesAsync(installation)).not.toContain(child.pid)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  },
  30000
)
