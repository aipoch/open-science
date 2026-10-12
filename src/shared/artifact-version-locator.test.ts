import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  createArtifactVersionLocator,
  parseArtifactVersionLocator,
  type ArtifactVersionIdentity
} from './artifact-version-locator'
import * as provenance from './artifact-provenance'

describe('artifact version locator contract', () => {
  it('retains the public facade and request identity type', () => {
    expect(provenance.createArtifactVersionLocator).toBe(createArtifactVersionLocator)
    expect(provenance.parseArtifactVersionLocator).toBe(parseArtifactVersionLocator)
    expectTypeOf<ArtifactVersionIdentity>().toExtend<provenance.GetArtifactVersionProvenanceRequest>()
    expectTypeOf<provenance.GetArtifactVersionProvenanceRequest>().toExtend<ArtifactVersionIdentity>()
  })

  it('reads existing encoded identities without filesystem or data-root context', () => {
    const identity: ArtifactVersionIdentity = {
      projectId: 'project/one',
      appSessionId: 'session two',
      artifactId: '图%#',
      versionId: 'v:1',
      cursor: 'ignored'
    }
    const stored = 'artifact-version:project%2Fone/session%20two/%E5%9B%BE%25%23/v%3A1'
    expect(createArtifactVersionLocator(identity)).toBe(stored)
    expect(parseArtifactVersionLocator(stored)).toEqual({
      projectId: 'project/one',
      appSessionId: 'session two',
      artifactId: '图%#',
      versionId: 'v:1'
    })
    expect(parseArtifactVersionLocator('artifact-version:p/s/a/v')).toEqual({
      projectId: 'p',
      appSessionId: 's',
      artifactId: 'a',
      versionId: 'v'
    })
  })

  it.each([
    '',
    'file:///p/s/a/v',
    'artifact-version:p/s/a',
    'artifact-version:p/s/a/v/extra',
    'artifact-version:p//a/v',
    'artifact-version:p/s/a/',
    'artifact-version:p/s/a/%',
    'artifact-version:p/s/a/%FF'
  ])('rejects malformed stored locator %s', (value) => {
    expect(parseArtifactVersionLocator(value)).toBeUndefined()
  })
})
