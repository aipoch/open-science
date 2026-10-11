import { describe, expect, it, vi } from 'vitest'
import { Molecule } from 'openchemlib'
import { renderMoleculeStructure } from '@aipoch/connector-builtins/molecule-render'

import { createMoleculePreviewHandler } from './molecule-artifact-adapter'

const ASPIRIN_SMILES = 'CC(=O)Oc1ccccc1C(=O)O'

describe('molecule preview handler', () => {
  it('returns the Artifact lineage id separately from the immutable Version identity', async () => {
    const writeArtifactForCurrentRun = vi.fn().mockResolvedValue({
      id: 'version-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      versionNumber: 1,
      name: 'aspirin.mol',
      path: '/artifacts/aspirin.mol'
    })
    const handler = createMoleculePreviewHandler(
      { writeArtifactForCurrentRun },
      { createInvocationId: () => 'connector-call-1' }
    )

    const args = { smiles: ASPIRIN_SMILES, filename: 'aspirin' }
    const rendered = await renderMoleculeStructure(args)
    if (!rendered.valid) throw new Error('Expected a valid package fixture')
    const out = await handler(args, { sessionId: 's-1' })

    expect(writeArtifactForCurrentRun).toHaveBeenCalledTimes(1)
    const [sessionId, written] = writeArtifactForCurrentRun.mock.calls[0]
    expect(sessionId).toBe('s-1')
    expect(written).toMatchObject({
      filename: 'aspirin.mol',
      mimeType: 'chemical/x-mdl-molfile',
      producer: {
        kind: 'connector',
        connectorId: 'molecule',
        toolId: 'preview_molecule',
        invocationId: 'connector-call-1',
        implementationVersion: '1',
        normalizedArguments: {
          inputKind: 'smiles',
          filename: 'aspirin.mol',
          smiles: rendered.smiles
        }
      }
    })
    // Scientific normalization is package-owned; the adapter must publish its complete output.
    expect(written.content).toBe(rendered.molfile)
    expect(out).toMatchObject({
      valid: true,
      artifact_id: 'artifact-1',
      version_id: 'version-1',
      version_number: 1,
      filename: 'aspirin.mol',
      smiles: rendered.smiles,
      formula: rendered.formula,
      molecular_weight: rendered.molecular_weight,
      heavy_atom_count: rendered.heavy_atom_count
    })
  })

  it('returns valid:false and writes nothing for an unparseable structure', async () => {
    const writeArtifactForCurrentRun = vi.fn()
    const handler = createMoleculePreviewHandler({ writeArtifactForCurrentRun })

    const out = await handler({ smiles: 'not-a-real-smiles' }, { sessionId: 's-1' })

    expect(out).toMatchObject({ valid: false })
    expect(writeArtifactForCurrentRun).not.toHaveBeenCalled()
  })

  it('publishes the intact structure when a molfile has an empty title', async () => {
    const writeArtifactForCurrentRun = vi.fn().mockResolvedValue({
      id: 'version-1',
      name: 'aspirin.mol'
    })
    const handler = createMoleculePreviewHandler({ writeArtifactForCurrentRun })
    const molfile = Molecule.fromSmiles(ASPIRIN_SMILES).toMolfile()

    const args = { molfile, filename: 'aspirin' }
    const rendered = await renderMoleculeStructure(args)
    if (!rendered.valid) throw new Error('Expected a valid package fixture')
    const out = await handler(args, { sessionId: 's-1' })

    expect(out).toMatchObject({
      valid: true,
      formula: rendered.formula,
      heavy_atom_count: rendered.heavy_atom_count
    })
    expect(writeArtifactForCurrentRun).toHaveBeenCalledTimes(1)
    const [sessionId, written] = writeArtifactForCurrentRun.mock.calls[0]
    expect(sessionId).toBe('s-1')
    expect(written.content).toBe(rendered.molfile)
    expect(written.producer.normalizedArguments.inputKind).toBe('molfile')
  })

  it('does not publish an empty molecular structure', async () => {
    const writeArtifactForCurrentRun = vi.fn()
    const handler = createMoleculePreviewHandler({ writeArtifactForCurrentRun })

    const out = await handler({ molfile: new Molecule(0, 0).toMolfile() }, { sessionId: 's-1' })

    expect(out).toMatchObject({ valid: false, error: expect.any(String) })
    expect(writeArtifactForCurrentRun).not.toHaveBeenCalled()
  })

  it('fails closed for a valid structure with no session context so it cannot attach to a parallel run', async () => {
    const writeArtifactForCurrentRun = vi.fn()
    const handler = createMoleculePreviewHandler({ writeArtifactForCurrentRun })

    await expect(handler({ smiles: ASPIRIN_SMILES, filename: 'aspirin' })).rejects.toThrow(
      /active session/
    )
    expect(writeArtifactForCurrentRun).not.toHaveBeenCalled()
  })

  it('does not publish an Artifact after its connector call is cancelled', async () => {
    const writeArtifactForCurrentRun = vi.fn()
    const handler = createMoleculePreviewHandler({ writeArtifactForCurrentRun })
    const cancellation = new AbortController()
    cancellation.abort()

    await expect(
      handler(
        { smiles: ASPIRIN_SMILES, filename: 'aspirin' },
        { sessionId: 's-1' },
        cancellation.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(writeArtifactForCurrentRun).not.toHaveBeenCalled()
  })
})
