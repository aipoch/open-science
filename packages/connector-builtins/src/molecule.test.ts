import { describe, expect, it } from 'vitest'
import { Molecule } from 'openchemlib'

import { MOLECULE_TOOLS } from './molecule'
import type { ToolContext } from '@aipoch/connector-core'

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
    expect(out.smiles).toBe('CC(OC1=CC=CC=C1C(O)=O)=O')
    expect(out.filename_suggestion).toBe('aspirin.mol')
  })

  it('suggests a formula-based filename when none is given', async () => {
    const out = (await renderMolecule.run!(ctx, { smiles: ASPIRIN_SMILES })) as RenderResult
    expect(out.filename_suggestion).toBe('C9H8O4.mol')
  })

  it.each([999, 1000])(
    'round-trips a %i-atom structure from SMILES and V3000 input',
    async (atoms) => {
      const smiles = 'C'.repeat(atoms)
      const source = Molecule.fromSmiles(smiles)
      for (const args of [{ smiles }, { molfile: source.toMolfileV3() }]) {
        const out = (await renderMolecule.run!(ctx, args)) as RenderResult
        expect(out.valid).toBe(true)
        expect(out.molfile).toContain(atoms > 999 ? 'V3000' : 'V2000')
        const restored = Molecule.fromMolfile(out.molfile!)
        expect(restored.getAllAtoms()).toBe(atoms)
        expect(restored.getAllBonds()).toBe(atoms - 1)
        expect(restored.toSmiles()).toBe(source.toSmiles())
        expect(out.heavy_atom_count).toBe(atoms)
        expect(out.formula).toBe(source.getMolecularFormula().formula)
      }
    },
    // Each case round-trips both inputs; OpenChemLib is slower under CI's V8 coverage.
    120_000
  )

  it.each([999, 1000])('round-trips a structure with 999 atoms and %i bonds', async (bonds) => {
    const source = Molecule.fromSmiles('C'.repeat(999))
    source.addBond(0, 2)
    if (bonds === 1000) source.addBond(3, 5)
    expect(source.getAllAtoms()).toBe(999)
    expect(source.getAllBonds()).toBe(bonds)

    const out = (await renderMolecule.run!(ctx, { molfile: source.toMolfileV3() })) as RenderResult
    expect(out.valid).toBe(true)
    expect(out.molfile).toContain(bonds > 999 ? 'V3000' : 'V2000')
    const restored = Molecule.fromMolfile(out.molfile!)
    expect(restored.getAllAtoms()).toBe(999)
    expect(restored.getAllBonds()).toBe(bonds)
    expect(restored.toSmiles()).toBe(source.toSmiles())
  })

  it('includes explicit hydrogens when selecting the molfile format', async () => {
    const source = Molecule.fromSmiles('C'.repeat(334))
    source.addImplicitHydrogens()
    expect(source.getAtoms()).toBe(334)
    expect(source.getAllAtoms()).toBe(1004)
    expect(source.getAllBonds()).toBe(1003)

    const out = (await renderMolecule.run!(ctx, { molfile: source.toMolfileV3() })) as RenderResult
    expect(out.valid).toBe(true)
    expect(out.molfile).toContain('V3000')
    const restored = Molecule.fromMolfile(out.molfile!)
    expect(restored.getAllAtoms()).toBe(1004)
    expect(restored.getAllBonds()).toBe(1003)
    expect(restored.toSmiles()).toBe(source.toSmiles())
    expect(out.heavy_atom_count).toBe(334)
  })

  it.each([
    ['[H][H]', 0],
    ['[2H]O[2H]', 1],
    ['[3H]O[3H]', 1],
    ['[13C]O', 2]
  ])('counts heavy atoms by atomic number for %s', async (smiles, expected) => {
    const out = (await renderMolecule.run!(ctx, { smiles })) as RenderResult
    expect(out.valid).toBe(true)
    expect(out.heavy_atom_count).toBe(expected)
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
