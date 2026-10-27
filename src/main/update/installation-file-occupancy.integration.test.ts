import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { inspectInstallationProcessesAsync } from './installation-occupancy'

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
