import { afterEach, describe, expect, it, vi } from 'vitest'
import { Parser } from 'web-tree-sitter'

import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

afterEach(() => vi.restoreAllMocks())

describe('shared Notebook source parsing', () => {
  it.each(['python', 'r'] as const)(
    'parses %s once for dependency and file evidence',
    async (language) => {
      const source =
        language === 'python'
          ? "import pandas as pd\nframe = pd.read_csv('input.csv')\nframe.to_csv('output.csv')"
          : 'frame <- read.csv("input.csv")\nwrite.csv(frame, "output.csv")'
      await analyzeNotebookSourceFileAccess(language, source)
      const parse = vi.spyOn(Parser.prototype, 'parse')
      const result = await analyzeNotebookSourceFileAccess(language, source)
      expect(result).toMatchObject({
        reads: ['input.csv'],
        writes: ['output.csv'],
        readState: 'complete',
        writeState: 'complete'
      })
      expect(parse).toHaveBeenCalledTimes(1)
    }
  )
})
