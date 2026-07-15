import { describe, expect, it } from 'vitest'

import { deriveErrorLine, detectCellLanguage } from './notebook-cell-utils'

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
