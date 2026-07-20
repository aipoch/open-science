import { describe, expect, it, vi } from 'vitest'

import { createMoleculePreviewHandler } from './molecule-preview'

const ASPIRIN_SMILES = 'CC(=O)Oc1ccccc1C(=O)O'

describe('molecule preview handler', () => {
  it('validates a SMILES, writes a canonical .mol artifact, and returns its id', async () => {
    const writeArtifactForCurrentRun = vi.fn().mockResolvedValue({
      id: 'session:run:aspirin.mol',
      name: 'aspirin.mol',
      path: '/artifacts/aspirin.mol'
    })
    const handler = createMoleculePreviewHandler({ writeArtifactForCurrentRun })

    const out = await handler({ smiles: ASPIRIN_SMILES, filename: 'aspirin' }, { sessionId: 's-1' })

    expect(writeArtifactForCurrentRun).toHaveBeenCalledTimes(1)
    const [sessionId, written] = writeArtifactForCurrentRun.mock.calls[0]
    expect(sessionId).toBe('s-1')
    expect(written).toMatchObject({ filename: 'aspirin.mol', mimeType: 'chemical/x-mdl-molfile' })
    expect(written.content).toContain('V2000')
    expect(out).toMatchObject({
      valid: true,
      artifact_id: 'session:run:aspirin.mol',
      filename: 'aspirin.mol',
      formula: 'C9H8O4'
    })
  })

  it('returns valid:false and writes nothing for an unparseable structure', async () => {
    const writeArtifactForCurrentRun = vi.fn()
    const handler = createMoleculePreviewHandler({ writeArtifactForCurrentRun })

    const out = await handler({ smiles: 'not-a-real-smiles' }, { sessionId: 's-1' })

    expect(out).toMatchObject({ valid: false })
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
})
