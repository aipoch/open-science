// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Molecule, Reaction } from 'openchemlib'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { getPreviewFormatForFile } from '../../preview-support'

const mocks = vi.hoisted(() => ({
  state: undefined as unknown,
  addSurface: vi.fn(),
  atoms: [] as unknown[]
}))
vi.mock('../usePreviewFileContent', () => ({ usePreviewFileContent: () => mocks.state }))
vi.mock('3dmol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('3dmol')>()
  return {
    SurfaceType: { VDW: 1 },
    createViewer: () => ({
      addModel: (content: string, _format: string, options: object) => {
        mocks.atoms = actual.Parsers.pdb(content, options)[0] ?? []
        return { selectedAtoms: () => mocks.atoms }
      },
      resize: vi.fn(),
      setStyle: vi.fn(),
      removeAllSurfaces: vi.fn(),
      addSurface: mocks.addSurface,
      zoomTo: vi.fn(),
      render: vi.fn(),
      clear: vi.fn()
    })
  }
})
import { MoleculePreviewRenderer } from './MoleculePreview'
import { PdbPreviewRenderer } from './PdbPreview'

const file = (name: string, mimeType?: string): PreviewFileItem => ({
  id: name,
  sessionId: 's',
  title: name,
  type: 'file',
  path: `/workspace/${name}`,
  name,
  mimeType,
  format: getPreviewFormatForFile({ name, mimeType })
})
const ready = (content: string, truncated = false): void => {
  mocks.state = {
    status: 'ready',
    preview: { content, encoding: 'utf8', truncated },
    pagination: { pageNumber: 1, hasPrevious: false, hasNext: false }
  }
}
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  mocks.atoms = []
  mocks.addSurface.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const structure = (): Element | null =>
  document.querySelector('[aria-label^="Structure preview"] svg')

it.each(['smi', 'sdf'])(
  'SC01: labels the first record and exposes complete %s source',
  async (ext) => {
    const content =
      ext === 'smi'
        ? 'CCO ethanol\nc1ccccc1 benzene'
        : ['CCO', 'c1ccccc1']
            .map((s) => Molecule.fromSmiles(s).toMolfile() + '\n> <NAME>\nrecord-name\n\n$$$$\n')
            .join('')
    const parsed = ext === 'smi' ? Molecule.fromSmiles(content) : Molecule.fromMolfile(content)
    expect(parsed.getMolecularFormula().formula).toBe('C2H6O')
    ready(content)
    render(<MoleculePreviewRenderer item={file(`records.${ext}`)} />)
    await waitFor(() => expect(structure()).not.toBeNull())
    expect(screen.getByText('Only the first record is previewed.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(document.querySelector('code')?.textContent).toContain(
      ext === 'smi' ? 'benzene' : 'record-name'
    )
  }
)
it.each(['smi', 'sdf'])('keeps truncated %s in source view', (ext) => {
  ready('partial record', true)
  render(<MoleculePreviewRenderer item={file(`large.${ext}`)} />)
  expect(document.querySelector('code')?.textContent).toContain('partial record')
  expect(structure()).toBeNull()
})
it('SC05: uses SMILES MIME for an extensionless structure', async () => {
  ready('CCO')
  const item = file('structure', 'chemical/x-daylight-smiles')
  expect(item.format).toBe('molecule')
  render(<MoleculePreviewRenderer item={item} />)
  await waitFor(() => expect(structure()?.querySelectorAll('circle')).toHaveLength(3))
})
it('SC05: rejects a parsed zero-atom molfile', async () => {
  expect(Molecule.fromMolfile('CCO').getAllAtoms()).toBe(0)
  ready('CCO')
  render(<MoleculePreviewRenderer item={file('invalid.mol')} />)
  await waitFor(() => expect(screen.getByText(/No atoms found/)).toBeTruthy())
  expect(structure()).toBeNull()
})
it('SC05: uses RXN MIME for an extensionless reaction', async () => {
  const reaction = Reaction.create()
  reaction.addReactant(Molecule.fromSmiles('CCO'))
  reaction.addProduct(Molecule.fromSmiles('CC=O'))
  ready(reaction.toRxn())
  render(<MoleculePreviewRenderer item={file('reaction', 'chemical/x-mdl-rxnfile')} />)
  await waitFor(() =>
    expect(document.querySelectorAll('[aria-label^="Structure preview"] svg')).toHaveLength(2)
  )
})
const atom = (serial: number, element = 'C', alt = ' '): string =>
  `HETATM${String(serial).padStart(5)}  ${element.padEnd(3)}${alt}LIG A   1       ${serial.toFixed(3).padStart(5)}   0.000   0.000  1.00 20.00          ${element.padStart(2)}  `
it.each([
  [
    'two models',
    `MODEL        1\n${atom(1)}\n${atom(2)}\nENDMDL\nMODEL        2\n${atom(3)}\nENDMDL`,
    2
  ],
  ['hydrogen', `${atom(1)}\n${atom(2, 'H')}`, 1],
  ['alternate locations', `${atom(1, 'C', 'A')}\n${atom(2, 'C', 'B')}`, 1],
  ['unfiltered control', `${atom(1)}\n${atom(2)}`, 2]
])('SC02: reports parsed atoms for %s', async (_label, content, count) => {
  ready(content)
  render(<PdbPreviewRenderer item={file('structure.pdb')} />)
  await waitFor(() => expect(mocks.atoms).toHaveLength(count))
  expect(screen.getByText(`${count} atoms`)).toBeTruthy()
  if (_label !== 'unfiltered control') expect(screen.getByText(/Hydrogens are hidden/)).toBeTruthy()
  if (content.includes('MODEL')) expect(screen.getByText(/Previewing model 1 of 2\./)).toBeTruthy()
})
it('SC04: reports pending and failed surface generation and allows another attempt', async () => {
  let reject!: (reason: Error) => void
  mocks.addSurface.mockImplementationOnce(
    () =>
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise
      })
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ready(atom(1))
  render(<PdbPreviewRenderer item={file('structure.pdb')} />)
  await waitFor(() => expect(mocks.atoms).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: 'Surface' }))
  await waitFor(() => expect(mocks.addSurface).toHaveBeenCalledOnce())
  expect(screen.getByRole('status').textContent).toContain('Generating surface')
  fireEvent.click(screen.getByRole('button', { name: 'Surface' }))
  expect(screen.getByRole('status').textContent).toContain('Generating surface')
  await act(async () => reject(new Error('surface failure')))
  expect(screen.getByRole('alert').textContent).toContain('Surface could not be generated')
  expect(screen.getByRole('button', { name: 'Stick' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(mocks.addSurface).toHaveBeenCalledTimes(2))
})

it('ignores a stale surface failure after switching styles', async () => {
  let reject!: (reason: Error) => void
  mocks.addSurface.mockImplementationOnce(
    () =>
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise
      })
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  ready(atom(1))
  render(<PdbPreviewRenderer item={file('structure.pdb')} />)
  await waitFor(() => expect(mocks.atoms).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: 'Surface' }))
  fireEvent.click(screen.getByRole('button', { name: 'Sphere' }))
  await act(async () => reject(new Error('stale surface')))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('button', { name: 'Sphere' }).getAttribute('aria-pressed')).toBe('true')
})
it('keeps an explicit SMILES extension ahead of conflicting MIME metadata', async () => {
  ready('CCO')
  render(<MoleculePreviewRenderer item={file('structure.smi', 'chemical/x-mdl-molfile')} />)
  await waitFor(() => expect(structure()?.querySelectorAll('circle')).toHaveLength(3))
})
