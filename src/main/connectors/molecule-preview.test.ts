import { describe, expect, it, vi } from 'vitest'

import { createMoleculePreviewHandler } from './molecule-preview'

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

    const out = await handler({ smiles: ASPIRIN_SMILES, filename: 'aspirin' }, { sessionId: 's-1' })

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
          smiles: 'CC(OC1=CC=CC=C1C(O)=O)=O'
        }
      }
    })
    expect(written.content).toContain('V2000')
    expect(out).toMatchObject({
      valid: true,
      artifact_id: 'artifact-1',
      version_id: 'version-1',
      version_number: 1,
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
