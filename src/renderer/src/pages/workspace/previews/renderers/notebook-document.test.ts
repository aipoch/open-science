import { describe, expect, it } from 'vitest'
import { notebookOutputText, parseNotebookDocument } from './notebook-document'

describe('saved Notebook preview', () => {
  it('reads multiline cells and saved outputs without executing code or interpreting output HTML', () => {
    const result = parseNotebookDocument(
      JSON.stringify({
        nbformat: 4,
        cells: [
          { cell_type: 'markdown', source: ['# Notes\n', 'Saved analysis'] },
          {
            cell_type: 'code',
            source: ['print(1)'],
            execution_count: 3,
            outputs: [
              {
                output_type: 'display_data',
                data: { 'text/html': '<script>execute()</script>', 'text/plain': ['1\n', '2'] }
              }
            ]
          }
        ]
      })
    )
    expect(result.cells[0].source).toBe('# Notes\nSaved analysis')
    expect(notebookOutputText(result.cells[1].outputs![0].data!['text/plain'])).toBe('1\n2')
    expect(notebookOutputText({ malicious: true })).toBe('')
  })
  it('rejects malformed or truncated documents instead of presenting missing cells as empty', () => {
    expect(() => parseNotebookDocument('{"nbformat":4')).toThrow()
    expect(() =>
      parseNotebookDocument('{"nbformat":4,"cells":[{"cell_type":"code","source":42}]}')
    ).toThrow()
  })
})
