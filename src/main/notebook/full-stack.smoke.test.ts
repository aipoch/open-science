import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { NotebookKernelExecutor } from './kernel-executor'
import { installPackages } from './package-manager'

// Full-stack wiring smoke: drives the real NotebookKernelExecutor + installPackages (the same
// pieces the app wires through the MCP manage_packages tool and runtime-service) against an
// actually-provisioned env. This is not a substitute for the unit suite -- it only proves the real
// pieces still work together end to end: a python cell persists state across two executes; an
// install through installPackages() is importable afterwards; and (only when an R env is also
// provisioned) the R exec-loop runs a scalar print and a ggplot cell producing a PNG display output.
//
// Gated exactly like host-mcp.integration.test.ts: skipped unless both a gate flag and a provisioned
// env path are present, so it is inert in normal CI/dev runs. Run with:
//   RUN_SMOKE=1 OPEN_SCIENCE_TEST_PY_ENV=/path/to/default-python/bin/python \
//   [OPEN_SCIENCE_TEST_R_ENV=/path/to/default-r] npx vitest run src/main/notebook/full-stack.smoke.test.ts
const pyBin = process.env.OPEN_SCIENCE_TEST_PY_ENV
const rEnvPrefix = process.env.OPEN_SCIENCE_TEST_R_ENV
const gate = process.env.RUN_SMOKE && pyBin ? describe : describe.skip

// The real exec-loop scripts the app ships, so the smoke exercises the shipped kernel code paths.
const PYTHON_LOOP = join(__dirname, '../../../resources/notebook/python_loop.py')
const R_LOOP = join(__dirname, '../../../resources/notebook/r_loop.R')

// pyBin is <storageRoot>/runtime/envs/default-python/bin/python; walking up five segments recovers
// the storageRoot so installPackages() resolves to the exact provisioned env under test instead of
// the real user profile (its default storageRoot is $HOME/.open-science -- see package-manager.ts).
const storageRootFor = (pythonBin: string): string => join(pythonBin, '..', '..', '..', '..', '..')

const tmpDirs: string[] = []
const makeTmpDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

gate('full-stack notebook env smoke (python)', () => {
  it('persists python state across two executes', async () => {
    const exec = new NotebookKernelExecutor({ pythonBin: pyBin, pythonLoopPath: PYTHON_LOOP })
    const tmp = makeTmpDir('os-smoke-state-')
    try {
      const a = await exec.execute({
        code: 'smoke_value = 40',
        cwd: tmp,
        notebookSessionRoot: tmp,
        dataRoot: tmp,
        runtimeRoot: tmp
      })
      expect(a.status).toBe('completed')

      const b = await exec.execute({
        code: 'smoke_value + 2',
        cwd: tmp,
        notebookSessionRoot: tmp,
        dataRoot: tmp,
        runtimeRoot: tmp
      })
      expect(b.status).toBe('completed')
      // The trailing bare expression echoes REPL-style: the exec-loop returns its repr as `result`,
      // which the mapper surfaces as a display output carrying text/plain.
      const display = b.outputs.find((o) => o.type === 'display')
      expect(display?.type === 'display' ? display.data['text/plain'] : undefined).toBe('42')
    } finally {
      await exec.shutdown()
    }
  }, 60_000)

  it('installs a package via installPackages (manage_packages wiring) and imports it in the kernel', async () => {
    const storageRoot = storageRootFor(pyBin as string)
    const install = await installPackages(
      { language: 'python', packages: ['six'] },
      { storageRoot }
    )
    expect(install.ok).toBe(true)

    const exec = new NotebookKernelExecutor({ pythonBin: pyBin, pythonLoopPath: PYTHON_LOOP })
    const tmp = makeTmpDir('os-smoke-pkg-')
    try {
      const result = await exec.execute({
        code: 'import six\nprint(six.__version__)',
        cwd: tmp,
        notebookSessionRoot: tmp,
        dataRoot: tmp,
        runtimeRoot: tmp
      })
      expect(result.status).toBe('completed')
      expect(result.stdout.trim().length).toBeGreaterThan(0)
    } finally {
      await exec.shutdown()
    }
  }, 180_000)
})

const rGate = process.env.RUN_SMOKE && pyBin && rEnvPrefix ? it : it.skip

describe('full-stack notebook env smoke (r)', () => {
  rGate(
    'runs the R exec-loop print(41+1) and a ggplot cell producing a PNG display output',
    async () => {
      const exec = new NotebookKernelExecutor({
        pythonBin: pyBin,
        rEnvPrefix,
        pythonLoopPath: PYTHON_LOOP,
        rLoopPath: R_LOOP
      })
      const tmp = makeTmpDir('os-smoke-r-')
      try {
        const scalar = await exec.execute({
          code: 'print(41 + 1)',
          cwd: tmp,
          notebookSessionRoot: tmp,
          dataRoot: tmp,
          runtimeRoot: tmp,
          language: 'r'
        })
        expect(scalar.status).toBe('completed')
        // stdout accumulates the printed scalar as a stream output plus the flattened stdout text.
        expect(scalar.stdout).toContain('42')
        expect(
          scalar.outputs.some(
            (o) => o.type === 'stream' && o.name === 'stdout' && o.text.includes('42')
          )
        ).toBe(true)

        const plot = await exec.execute({
          code: [
            'library(ggplot2)',
            'ggplot(data.frame(x=1:3, y=1:3), aes(x, y)) + geom_point()'
          ].join('\n'),
          cwd: tmp,
          notebookSessionRoot: tmp,
          dataRoot: tmp,
          runtimeRoot: tmp,
          language: 'r'
        })
        expect(plot.status).toBe('completed')
        const display = plot.outputs.find((o) => o.type === 'display' && 'image/png' in o.data)
        expect(display).toBeTruthy()
      } finally {
        await exec.shutdown()
      }
    },
    120_000
  )
})
