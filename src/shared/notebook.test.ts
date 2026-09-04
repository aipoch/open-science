import { describe, it, expect } from 'vitest'
import {
  notebookEnvironmentApplicationCommandContracts,
  parseNotebookLanguage,
  parseOptionalNotebookLanguage,
  type NotebookOutput,
  type NotebookCell
} from './notebook'

describe('shared notebook types', () => {
  it('parses only python and r as NotebookLanguage', () => {
    expect(parseNotebookLanguage('python')).toBe('python')
    expect(parseNotebookLanguage('r')).toBe('r')
    expect(parseOptionalNotebookLanguage(undefined)).toBeUndefined()
    expect(parseOptionalNotebookLanguage(null)).toBeUndefined()
    expect(() => parseNotebookLanguage('julia')).toThrow(/python or r/i)
    expect(() => parseNotebookLanguage('R')).toThrow(/python or r/i)
    expect(() => parseNotebookLanguage(null)).toThrow(/python or r/i)
    expect(() => parseOptionalNotebookLanguage('julia')).toThrow(/python or r/i)
  })

  it('rejects an unknown Environment command language before the owner runs', () => {
    expect(notebookEnvironmentApplicationCommandContracts.provision.args.parse(['python'])).toEqual(
      ['python']
    )
    expect(
      notebookEnvironmentApplicationCommandContracts.provision.args.parse(['r', 'op-1'])
    ).toEqual(['r', 'op-1'])
    expect(notebookEnvironmentApplicationCommandContracts.cancel.args.parse([])).toEqual([])
    expect(notebookEnvironmentApplicationCommandContracts.cancel.args.parse(['python'])).toEqual([
      'python'
    ])
    expect(notebookEnvironmentApplicationCommandContracts.cancel.args.parse([null])).toEqual([])
    expect(
      notebookEnvironmentApplicationCommandContracts.provision.args.parse(['python', null])
    ).toEqual(['python'])
    expect(
      notebookEnvironmentApplicationCommandContracts.repair.args.parse(['r', 'default-r', null])
    ).toEqual(['r', 'default-r'])
    expect(
      notebookEnvironmentApplicationCommandContracts.repair.args.parse([
        'python',
        '/runtime/default-python/python',
        'repair-1'
      ])
    ).toEqual(['python', '/runtime/default-python/python', 'repair-1'])
    expect(() =>
      notebookEnvironmentApplicationCommandContracts.repair.args.parse(['python', ''])
    ).toThrow()
    expect(() =>
      notebookEnvironmentApplicationCommandContracts.provision.args.parse([null])
    ).toThrow()
    expect(() =>
      notebookEnvironmentApplicationCommandContracts.provision.args.parse(['julia'])
    ).toThrow()
    expect(() =>
      notebookEnvironmentApplicationCommandContracts.repair.args.parse(['julia'])
    ).toThrow()
    expect(() =>
      notebookEnvironmentApplicationCommandContracts.cancel.args.parse(['julia'])
    ).toThrow()
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
