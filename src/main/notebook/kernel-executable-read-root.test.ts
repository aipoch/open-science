import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { kernelExecutableReadRoot } from './kernel-executable-read-root'

let directory: string | undefined
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

it.each(['conda', 'venv'] as const)(
  'includes %s Python libraries without widening ordinary executable roots',
  async (kind) => {
    directory = await mkdtemp(join(tmpdir(), 'python-read-root-'))
    const executable = join(directory, 'bin', 'python')
    await mkdir(join(directory, 'bin'))
    expect(kernelExecutableReadRoot(executable, 'python', 'darwin')).toBe(join(directory, 'bin'))
    if (kind === 'conda') await mkdir(join(directory, 'conda-meta'))
    else await writeFile(join(directory, 'pyvenv.cfg'), 'home = /usr/bin\n')
    expect(kernelExecutableReadRoot(executable, 'python', 'darwin')).toBe(directory)
    expect(kernelExecutableReadRoot(executable, 'python', 'linux')).toBe(directory)
    expect(kernelExecutableReadRoot(executable, 'repl', 'darwin')).toBe(join(directory, 'bin'))
    expect(kernelExecutableReadRoot(join(directory, 'tools', 'python'), 'python', 'darwin')).toBe(
      join(directory, 'tools')
    )
  }
)
