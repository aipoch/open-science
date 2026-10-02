import { describe, expect, it, vi } from 'vitest'

import type { ArtifactVersionDescriptor } from '../../shared/artifact-provenance'
import { MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS } from '../../shared/artifacts'
import { resolveManuscriptReferences } from './artifact-references'

const descriptor = (
  overrides: Partial<ArtifactVersionDescriptor> = {}
): ArtifactVersionDescriptor => ({
  id: 'version-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  versionNumber: 3,
  name: 'volcano.png',
  sessionId: 'session-1',
  projectId: 'project-1',
  checksum: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00.000Z',
  state: 'finalized',
  size: 123,
  mtimeMs: 1,
  ...overrides
})

const manuscript = (checksum = 'a'.repeat(64)): string => `---
title: Volcano analysis
open-science:
  artifact-references:
    fig-volcano:
      artifact-id: artifact-1
      version-id: version-1
      checksum: ${checksum}
---

See @fig-volcano for the result.

![Volcano plot](volcano.png){#fig-volcano}
`

describe('manuscript artifact references', () => {
  it('resolves an exact immutable Artifact Version and writes its identity into the caption and supplement', async () => {
    const resolveVersionDescriptors = vi.fn(async () => [descriptor()])

    const prepared = await resolveManuscriptReferences({
      projectId: 'project-1',
      appSessionId: 'session-1',
      content: manuscript(),
      resolveVersionDescriptors
    })

    expect(resolveVersionDescriptors).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      versionIds: ['version-1']
    })
    expect(prepared.references).toEqual([
      {
        label: 'fig-volcano',
        artifactId: 'artifact-1',
        versionId: 'version-1',
        checksum: 'a'.repeat(64)
      }
    ])
    expect(prepared.markdown).toContain(
      'Artifact version version-1 (artifact-1, SHA-256 ' + 'a'.repeat(64) + ')'
    )
    expect(prepared.markdown).toContain('## Artifact provenance')
    expect(prepared.markdown).toContain(
      '| @fig-volcano | artifact-1 | version-1 | ' + 'a'.repeat(64) + ' |'
    )
    expect(prepared.markdown).not.toContain('open-science:')
  })

  it('fails closed when a referenced Artifact Version is unknown', async () => {
    await expect(
      resolveManuscriptReferences({
        projectId: 'project-1',
        appSessionId: 'session-1',
        content: manuscript(),
        resolveVersionDescriptors: vi.fn(async () => [])
      })
    ).rejects.toMatchObject({ code: 'UNKNOWN_ARTIFACT_VERSION' })
  })

  it('fails closed when the immutable checksum no longer matches', async () => {
    await expect(
      resolveManuscriptReferences({
        projectId: 'project-1',
        appSessionId: 'session-1',
        content: manuscript(),
        resolveVersionDescriptors: vi.fn(async () => [descriptor({ checksum: 'b'.repeat(64) })])
      })
    ).rejects.toMatchObject({ code: 'STALE_ARTIFACT_VERSION' })
  })

  it('fails closed when the referenced Artifact Version is not finalized', async () => {
    await expect(
      resolveManuscriptReferences({
        projectId: 'project-1',
        appSessionId: 'session-1',
        content: manuscript(),
        resolveVersionDescriptors: vi.fn(async () => [descriptor({ state: 'pending' })])
      })
    ).rejects.toMatchObject({ code: 'UNKNOWN_ARTIFACT_VERSION' })
  })

  it('rejects a @fig reference without an explicit immutable binding', async () => {
    await expect(
      resolveManuscriptReferences({
        projectId: 'project-1',
        appSessionId: 'session-1',
        content: 'See @fig-missing.\n',
        resolveVersionDescriptors: vi.fn()
      })
    ).rejects.toMatchObject({ code: 'UNKNOWN_ARTIFACT_REFERENCE' })
  })

  it('resolves more references than one Artifact Version descriptor page allows', async () => {
    const references = Array.from(
      { length: MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS + 1 },
      (_, index) => ({
        label: `fig-${index}`,
        artifactId: `artifact-${index}`,
        versionId: `version-${index}`,
        checksum: index.toString(16).padStart(64, '0')
      })
    )
    const resolveVersionDescriptors = vi.fn(async ({ versionIds }: { versionIds: string[] }) =>
      versionIds.map((versionId) => {
        const index = Number(versionId.slice('version-'.length))
        const reference = references[index]!
        return descriptor({
          id: versionId,
          artifactId: reference.artifactId,
          versionId,
          checksum: reference.checksum
        })
      })
    )
    const bindings = references
      .map(
        ({ label, artifactId, versionId, checksum }) => `    ${label}:
      artifact-id: ${artifactId}
      version-id: ${versionId}
      checksum: '${checksum}'`
      )
      .join('\n')
    const content = `---
title: Batch manuscript
open-science:
  artifact-references:
${bindings}
---

${references.map(({ label }) => `See @${label}.`).join('\n')}
`

    const prepared = await resolveManuscriptReferences({
      projectId: 'project-1',
      appSessionId: 'session-1',
      content,
      resolveVersionDescriptors
    })

    expect(resolveVersionDescriptors).toHaveBeenCalledTimes(2)
    expect(
      resolveVersionDescriptors.mock.calls.map(([request]) => request.versionIds.length)
    ).toEqual([MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS, 1])
    expect(prepared.references).toHaveLength(references.length)
  })
})

describe('manuscript bibliography', () => {
  it('reuses Literature metadata through the injected BibTeX exporter', async () => {
    const exportBibtex = vi.fn(async () => ({
      content: '@article{smith2020, title={A paper}}\n',
      citationKeys: [{ itemId: 'item-1', citationKey: 'smith2020' }]
    }))
    const content = `---
title: Cited manuscript
open-science:
  bibliography:
    item-ids:
      - item-1
---

Quarto cites [@item-1].
`

    const prepared = await resolveManuscriptReferences({
      projectId: 'project-1',
      appSessionId: 'session-1',
      content,
      resolveVersionDescriptors: vi.fn(),
      exportBibtex
    })

    expect(exportBibtex).toHaveBeenCalledWith(['item-1'])
    expect(prepared.bibliography).toEqual({
      filename: 'references.bib',
      content: '@article{smith2020, title={A paper}}\n',
      itemIds: ['item-1'],
      citationKeys: [{ itemId: 'item-1', citationKey: 'smith2020' }]
    })
    expect(prepared.qmd).toContain('bibliography: references.bib')
    expect(prepared.qmd).toContain('Quarto cites [@smith2020].')
    expect(prepared.qmd).not.toContain('Quarto cites [@item-1].')
    expect(prepared.markdown).toContain('Quarto cites [@item-1].')
  })
})
