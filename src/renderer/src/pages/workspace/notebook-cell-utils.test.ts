import { describe, expect, it } from 'vitest'

import {
  deriveErrorLine,
  detectCellLanguage,
  environmentLabel,
  kernelKindLabel,
  kernelOriginLabel,
  resolveRunErrorLine,
  resolveRunEnvironment,
  resolveRunKernelKind
} from './notebook-cell-utils'

import type { NotebookOutput, NotebookRunRecord } from '../../../../shared/notebook'

const makeRun = (outputs: NotebookOutput[], traceback = ''): NotebookRunRecord => ({
  runId: 'r1',
  cellId: 'c1',
  source: 'agent',
  kernelKind: 'r',
  script: 'library(ggrepel)',
  status: 'failed',
  startedAt: 0,
  text: { stdout: '', stderr: '', traceback, plain: [] },
  outputs,
  artifacts: [],
  workingFiles: []
})

describe('deriveErrorLine', () => {
  it('returns the runtime cell frame line, ignoring bridge and frozen frames', () => {
    const traceback = [
      'Traceback (most recent call last):',
      '  File "<string>", line 196, in <module>',
      '  File "<cell>", line 3, in <module>',
      '    import requests',
      '  File "<frozen importlib._bootstrap>", line 1234, in _find_and_load',
      "ModuleNotFoundError: No module named 'requests'"
    ].join('\n')

    expect(deriveErrorLine(traceback)).toBe(3)
  })

  it('returns the syntax-error line from the ast.parse <unknown> frame', () => {
    const traceback = [
      'Traceback (most recent call last):',
      '  File "<string>", line 136, in execute_captured',
      '  File "<string>", line 108, in _run_cell',
      '  File ".../ast.py", line 46, in parse',
      '  File "<unknown>", line 2',
      '    x <- seq(-2 * pi, 2 * pi)',
      'SyntaxError: invalid syntax'
    ].join('\n')

    expect(deriveErrorLine(traceback)).toBe(2)
  })

  it('returns undefined when no user-code frame is present', () => {
    expect(deriveErrorLine('ValueError: boom')).toBeUndefined()
  })
})

describe('resolveRunErrorLine', () => {
  it('prefers the line the kernel attributed to the error output (R)', () => {
    const run = makeRun([
      { type: 'error', message: "no package called 'ggrepel'", traceback: 'boom', line: 7 }
    ])

    expect(resolveRunErrorLine(run)).toBe(7)
  })

  it('falls back to parsing the Python traceback when no error output line is present', () => {
    const traceback = 'Traceback:\n  File "<cell>", line 3, in <module>\nModuleNotFoundError'
    const run = makeRun([{ type: 'error', message: 'x', traceback }], traceback)

    expect(resolveRunErrorLine(run)).toBe(3)
  })

  it('returns undefined when neither an output line nor a parseable frame exists', () => {
    expect(resolveRunErrorLine(makeRun([]))).toBeUndefined()
  })
})

describe('detectCellLanguage', () => {
  it('detects R from the <- assignment operator', () => {
    expect(detectCellLanguage('x <- seq(-2 * pi, 2 * pi, length.out = 200)\ny <- sin(x)')).toBe('r')
  })

  it('detects R from library()', () => {
    expect(detectCellLanguage('library(ggplot2)')).toBe('r')
  })

  it('detects bash from a leading shell command', () => {
    expect(detectCellLanguage('pwd; echo "---"; ls -la | head')).toBe('bash')
  })

  it('defaults to python', () => {
    expect(detectCellLanguage('import os\nprint(os.getcwd())')).toBe('python')
  })
})

describe('kernelKindLabel', () => {
  it('maps every kernel kind to its tab chip text', () => {
    expect(kernelKindLabel('python')).toBe('Python')
    expect(kernelKindLabel('r')).toBe('R')
    expect(kernelKindLabel('repl')).toBe('Agent SDK')
    expect(kernelKindLabel('bash')).toBe('Bash')
  })
})

describe('kernelOriginLabel', () => {
  it('is empty for the analysis kernels (python/r)', () => {
    expect(kernelOriginLabel('python')).toBe('')
    expect(kernelOriginLabel('r')).toBe('')
  })

  it('names the control-plane kernels (repl/bash)', () => {
    expect(kernelOriginLabel('repl')).toBe('repl')
    expect(kernelOriginLabel('bash')).toBe('bash')
  })
})

describe('resolveRunKernelKind', () => {
  const baseRun = {
    runId: 'r1',
    cellId: 'c1',
    source: 'agent' as const,
    status: 'completed' as const,
    startedAt: 0,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: []
  }

  it('prefers the stored kernelKind over detection', () => {
    expect(resolveRunKernelKind({ ...baseRun, kernelKind: 'repl', script: 'x <- 1' })).toBe('repl')
  })

  it('falls back to detectCellLanguage for legacy runs without kernelKind', () => {
    expect(
      resolveRunKernelKind({
        ...baseRun,
        kernelKind: undefined as never,
        script: 'x <- seq(1, 10)'
      })
    ).toBe('r')
  })
})

describe('resolveRunEnvironment', () => {
  const baseRun = {
    runId: 'r1',
    cellId: 'c1',
    source: 'agent' as const,
    status: 'completed' as const,
    startedAt: 0,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: []
  }

  it('returns the named environment for a python run', () => {
    expect(
      resolveRunEnvironment({
        ...baseRun,
        kernelKind: 'python',
        script: '',
        environment: 'my-analysis'
      })
    ).toBe('my-analysis')
  })

  it('defaults a legacy python run (no environment field) to default-python', () => {
    expect(resolveRunEnvironment({ ...baseRun, kernelKind: 'python', script: '' })).toBe(
      'default-python'
    )
  })

  it('defaults a legacy r run (no environment field) to default-r', () => {
    expect(resolveRunEnvironment({ ...baseRun, kernelKind: 'r', script: '' })).toBe('default-r')
  })

  it('returns undefined for repl and bash runs, which are not env-scoped', () => {
    expect(resolveRunEnvironment({ ...baseRun, kernelKind: 'repl', script: '' })).toBeUndefined()
    expect(resolveRunEnvironment({ ...baseRun, kernelKind: 'bash', script: '' })).toBeUndefined()
  })
})

describe('environmentLabel', () => {
  it('maps the canonical default envs to "default"', () => {
    expect(environmentLabel('default-python')).toBe('default')
    expect(environmentLabel('default-r')).toBe('default')
  })

  it('returns named envs as-is', () => {
    expect(environmentLabel('my-analysis')).toBe('my-analysis')
  })
})
