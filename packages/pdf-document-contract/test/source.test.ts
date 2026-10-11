import { describe, expect, it } from 'vitest'
import { sanitizePdfDocumentSource } from '../src/index.js'
const source = {
  kind: 'literature-attachment-version',
  sourceFileId: ' attachment ',
  versionId: ' version ',
  checksum: 'a'.repeat(64),
  name: ' paper.pdf ',
  path: ' literature-attachment-version:version '
}
describe('portable PDF source identity', () => {
  it('preserves version authority and trims display hints', () => {
    expect(sanitizePdfDocumentSource(source)).toEqual({
      ...source,
      sourceFileId: 'attachment',
      versionId: 'version',
      name: 'paper.pdf',
      path: 'literature-attachment-version:version',
      projectId: undefined
    })
  })
  it.each(['artifact-version', 'upload-version'])('requires the project for %s', (kind) => {
    expect(sanitizePdfDocumentSource({ ...source, kind })).toBeUndefined()
    expect(sanitizePdfDocumentSource({ ...source, kind, projectId: 'project' })).toMatchObject({
      kind,
      projectId: 'project'
    })
  })
  it.each([
    { checksum: 'A'.repeat(64) },
    { versionId: '' },
    { sourceFileId: '' },
    { sessionId: ' ' },
    { projectId: ' ' },
    { path: 'x'.repeat(4097) },
    { readPath: '/etc/passwd' },
    { kind: 'path' }
  ])('rejects invalid or extra authority fields %j', (change) => {
    expect(sanitizePdfDocumentSource({ ...source, ...change })).toBeUndefined()
  })
})
