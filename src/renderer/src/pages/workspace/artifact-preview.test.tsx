import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { ArtifactPreviewResult } from '../../../../shared/artifacts'

import { ArtifactPreview } from './artifact-preview'
import { getArtifactExtension, shouldReadArtifactPreview } from './artifact-preview-utils'

type PreviewArtifact = React.ComponentProps<typeof ArtifactPreview>['artifact']

const createArtifact = (overrides: Partial<PreviewArtifact>): PreviewArtifact => ({
  id: 'artifact-1',
  kind: 'managed-file',
  path: '/Users/example/.open-science/artifacts/default-project/session-1/reply-1/result.txt',
  fileUrl:
    'file:///Users/example/.open-science/artifacts/default-project/session-1/reply-1/result.txt',
  name: 'result.txt',
  mimeType: 'text/plain',
  size: 1024,
  mtimeMs: 1710000000000,
  ...overrides
})

const createPreview = (content: string): ArtifactPreviewResult => ({
  content,
  encoding: 'utf8',
  size: content.length,
  truncated: false
})

describe('artifact preview rendering', () => {
  it('keeps full extensions for matching while compact labels can still truncate later', () => {
    const artifact = createArtifact({ name: 'nif3.treefile' })

    expect(getArtifactExtension(artifact)).toBe('treefile')
    expect(shouldReadArtifactPreview(artifact)).toBe(true)
  })

  it('renders csv previews with multiple column names', () => {
    const artifact = createArtifact({ name: 'nif3_metadata.csv', mimeType: 'text/csv' })
    const html = renderToStaticMarkup(
      <ArtifactPreview
        artifact={artifact}
        preview={createPreview(
          'label,accession,entry_name,organism,genus,domain\nNIF3,Q12345,NIF3_TEST,Example species,Example,Bacteria'
        )}
      />
    )

    expect(html).toContain('1 rows · 6 columns')
    expect(html).toContain('label')
    expect(html).toContain('accession')
    expect(html).toContain('entry_name')
    expect(html).toContain('organism')
    expect(html).toContain('genus')
    expect(html).toContain('+1 more')
  })

  it('does not render persisted file urls for images without a verified preview', () => {
    const artifact = createArtifact({
      fileUrl: 'file:///Users/example/private-image.png',
      name: 'private-image.png',
      mimeType: 'image/png'
    })
    const html = renderToStaticMarkup(<ArtifactPreview artifact={artifact} />)

    expect(html).not.toContain('file:///Users/example/private-image.png')
    expect(html).not.toContain('<img')
    expect(html).toContain('PNG')
  })

  it('renders fasta previews as a compact colored sequence grid', () => {
    const artifact = createArtifact({ name: 'nif3_homologs.fasta', mimeType: 'text/plain' })
    const html = renderToStaticMarkup(
      <ArtifactPreview
        artifact={artifact}
        preview={createPreview(
          '>seq1\nMTEYKLVVVGAGGVGKSALTIQLIQNHFVDEYDPTIEDSY\n>seq2\nGAGGVGKSALTIQLIQNHFVDEYDPTIEDSYRKQV'
        )}
      />
    )

    expect(html).toContain('data-testid="artifact-fasta-preview"')
    expect(html).toContain('<svg')
    expect(html).toContain('#2166AC')
    expect(html).not.toContain('&gt;seq1')
  })

  it('renders tree and analysis text formats as a skeleton preview instead of a raw extension card', () => {
    const artifact = createArtifact({ name: 'nif3_rooted.nwk', mimeType: 'text/plain' })
    const html = renderToStaticMarkup(
      <ArtifactPreview artifact={artifact} preview={createPreview('(A:0.1,(B:0.2,C:0.3):0.4);')} />
    )

    expect(html).toContain('data-testid="artifact-skeleton-preview"')
    expect(html).toContain('<svg')
    expect(html).not.toContain('NWK')
  })
})
