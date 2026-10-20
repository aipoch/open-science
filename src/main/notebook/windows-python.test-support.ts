import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
export const execWindowsPython = async (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding = {}
): Promise<{ stdout: string; stderr: string }> => execFileAsync(file, args, options)

export type WindowsPythonFixture = {
  root: string
  sourcePython: string
  version: string
  interpreters: Record<'plain' | 'spaces' | 'parentheses', string>
  brokenInterpreter: string
  cleanup: () => Promise<void>
}

async function findRealPython(): Promise<string> {
  const configured = process.env.OPEN_SCIENCE_TEST_PYTHON
  const candidates = configured
    ? [{ command: configured, args: [] }]
    : [
        { command: 'py', args: ['-3'] },
        { command: 'python', args: [] },
        { command: 'python3', args: [] }
      ]
  for (const candidate of candidates) {
    try {
      const { stdout } = await execWindowsPython(
        candidate.command,
        [
          ...candidate.args,
          '-c',
          'import sys; assert sys.version_info.major == 3; print(sys.executable)'
        ],
        { timeout: 10_000, windowsHide: true }
      )
      return stdout.trim()
    } catch {
      // Try another real interpreter, never substitute a simulated process or platform.
    }
  }
  throw new Error('Windows Python regression requires Python 3; set OPEN_SCIENCE_TEST_PYTHON.')
}

export async function createWindowsPythonFixture(): Promise<WindowsPythonFixture> {
  if (process.platform !== 'win32') throw new Error('This fixture requires a real Windows host.')
  const sourcePython = await findRealPython()
  const { stdout } = await execWindowsPython(
    sourcePython,
    ['-c', 'import sys; print(sys.version.split()[0], flush=True)'],
    {
      timeout: 10_000,
      windowsHide: true
    }
  )
  const version = stdout.trim()
  const root = await mkdtemp(join(tmpdir(), 'os-python-probe-'))
  const cleanup = async (): Promise<void> => {
    // Guard recursive cleanup explicitly: only delete the test's own temporary subtree.
    const target = resolve(root)
    const temporaryRoot = resolve(tmpdir())
    if (!target.startsWith(`${temporaryRoot}${sep}`))
      throw new Error('Unsafe fixture cleanup path.')
    await rm(target, { recursive: true, force: true })
  }
  try {
    const names = { plain: 'plain', spaces: 'Program Files', parentheses: 'Program Files (vee)' }
    const interpreters = {} as WindowsPythonFixture['interpreters']
    for (const [variant, name] of Object.entries(names)) {
      const prefix = join(root, name, 'Python')
      await execWindowsPython(sourcePython, ['-m', 'venv', '--without-pip', prefix], {
        timeout: 30_000,
        windowsHide: true
      })
      interpreters[variant as keyof typeof interpreters] = join(prefix, 'Scripts', 'python.exe')
    }
    const brokenInterpreter = join(root, 'Broken Python (unrunnable)', 'python.exe')
    await mkdir(join(root, 'Broken Python (unrunnable)'), { recursive: true })
    // An existing corrupt interpreter file is a real OS launch failure, not an absent candidate.
    await writeFile(brokenInterpreter, 'This is a corrupt Python executable.\r\n')
    return { root, sourcePython, version, interpreters, brokenInterpreter, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
