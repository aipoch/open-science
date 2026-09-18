import { describe, expect, it } from 'vitest'
import { Molecule } from 'openchemlib'

import { MOLECULE_TOOLS } from './molecule'
import type { ToolContext } from '../types'

const renderMolecule = MOLECULE_TOOLS.find((t) => t.id === 'render_molecule')!

// render_molecule is pure in-process compute; it must never touch the ToolContext transport.
const ctx: ToolContext = {
  credentials: {},
  fetchJson: async () => {
    throw new Error('render_molecule must not use ctx.fetchJson')
  },
  fetchText: async () => {
    throw new Error('render_molecule must not use ctx.fetchText')
  },
  fetchJsonWithHeaders: async () => {
    throw new Error('render_molecule must not use ctx.fetchJsonWithHeaders')
  },
  postForm: async () => {
    throw new Error('unused multipart transport')
  },
  postJson: async () => {
    throw new Error('render_molecule must not use ctx.postJson')
  }
}

type RenderResult = {
  valid: boolean
  molfile?: string
  smiles?: string
  formula?: string
  molecular_weight?: number
  heavy_atom_count?: number
  filename_suggestion?: string
  error?: string
}

const ASPIRIN_SMILES = 'CC(=O)Oc1ccccc1C(=O)O'

describe('molecule/render_molecule', () => {
  it('validates and normalizes a SMILES into a canonical molfile with descriptors', async () => {
    const out = (await renderMolecule.run!(ctx, {
      smiles: ASPIRIN_SMILES,
      filename: 'aspirin'
    })) as RenderResult

    expect(out.valid).toBe(true)
    expect(out.formula).toBe('C9H8O4')
    expect(out.heavy_atom_count).toBe(13)
    expect(out.molecular_weight).toBeCloseTo(180.16, 1)
    expect(out.molfile).toContain('V2000')
    expect(out.smiles).toBeTruthy()
    expect(out.filename_suggestion).toBe('aspirin.mol')
  })

  it('suggests a formula-based filename when none is given', async () => {
    const out = (await renderMolecule.run!(ctx, { smiles: ASPIRIN_SMILES })) as RenderResult
    expect(out.filename_suggestion).toBe('C9H8O4.mol')
  })

  it.each(['\n', '\r\n'])('preserves a generated molfile with %j line endings', async (newline) => {
    const seed = (await renderMolecule.run!(ctx, { smiles: ASPIRIN_SMILES })) as RenderResult
    expect(seed.molfile).toMatch(/^\n/)
    const out = (await renderMolecule.run!(ctx, {
      molfile: seed.molfile!.replaceAll('\n', newline)
    })) as RenderResult

    expect(out).toMatchObject({
      valid: true,
      smiles: seed.smiles,
      formula: 'C9H8O4',
      heavy_atom_count: 13
    })
    expect(out.molecular_weight).toBeCloseTo(180.16, 1)
    expect(Molecule.fromMolfile(out.molfile!).getAllAtoms()).toBe(13)
  })

  it('preserves a V3000 molfile with an empty title', async () => {
    const molfile = Molecule.fromSmiles(ASPIRIN_SMILES).toMolfileV3()
    const out = (await renderMolecule.run!(ctx, { molfile })) as RenderResult

    expect(out).toMatchObject({ valid: true, formula: 'C9H8O4', heavy_atom_count: 13 })
    expect(out.molecular_weight).toBeCloseTo(180.16, 1)
  })

  it('continues to accept a molfile with a nonempty title', async () => {
    const molfile = `aspirin${Molecule.fromSmiles(ASPIRIN_SMILES).toMolfile()}`
    const out = (await renderMolecule.run!(ctx, { molfile })) as RenderResult

    expect(out).toMatchObject({ valid: true, formula: 'C9H8O4', heavy_atom_count: 13 })
  })

  it('returns valid:false for an empty molecular structure', async () => {
    const molfile = new Molecule(0, 0).toMolfile()
    const out = (await renderMolecule.run!(ctx, { molfile })) as RenderResult

    expect(out).toMatchObject({ valid: false, error: expect.any(String) })
  })

  it('returns valid:false with an error for an unparseable SMILES', async () => {
    const out = (await renderMolecule.run!(ctx, { smiles: 'not-a-real-smiles' })) as RenderResult
    expect(out.valid).toBe(false)
    expect(typeof out.error).toBe('string')
  })

  it('rejects calls with neither or both inputs', async () => {
    await expect(renderMolecule.run!(ctx, {})).rejects.toThrow(/requires either/)
    await expect(
      renderMolecule.run!(ctx, { smiles: ASPIRIN_SMILES, molfile: 'x' })
    ).rejects.toThrow(/only one/)
    await expect(renderMolecule.run!(ctx, { molfile: ' \n\t ' })).rejects.toThrow(/requires either/)
    await expect(
      renderMolecule.run!(ctx, { smiles: ASPIRIN_SMILES, molfile: ' \n\t ' })
    ).resolves.toMatchObject({ valid: true, formula: 'C9H8O4' })
  })
})
