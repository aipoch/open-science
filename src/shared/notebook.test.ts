import { describe, it, expect } from 'vitest'
import type { NotebookLanguage, NotebookOutput, NotebookCell } from './notebook'

describe('shared notebook types', () => {
  it('NotebookLanguage admits python and r', () => {
    const langs: NotebookLanguage[] = ['python', 'r']
    expect(langs).toEqual(['python', 'r'])
  })

  it('NotebookOutput supports a display (mime bundle) variant', () => {
    const output: NotebookOutput = {
      type: 'display',
      data: { 'text/plain': '42', 'image/png': 'iVBORw0KGgo=' }
    }
    expect(output.type).toBe('display')
    // data is a string→string mime bundle
    expect(output.data['text/plain']).toBe('42')
  })

  it('NotebookCell.language is a NotebookLanguage', () => {
    const cell: NotebookCell = { id: 'c1', language: 'r', code: '1+1', status: 'idle' }
    expect(cell.language).toBe('r')
  })
})
