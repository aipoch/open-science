import type { SkillDocumentParser } from '../src/ports'

/** Fixture-only participant: production Skill syntax is exercised by host integration tests. */
export const fixtureSkillParser: SkillDocumentParser = (raw) => {
  const fields = Object.fromEntries(
    [...raw.matchAll(/^([a-z]+):[ \t]*(.*)$/gm)].map((match) => [
      match[1],
      match[2].replace(/^['"]|['"]$/g, '')
    ])
  )
  const { name, description, ...metadata } = fields
  return {
    name,
    description,
    metadata,
    body: raw.split('---').slice(2).join('---').trim(),
    hasFrontmatter: raw.startsWith('---')
  }
}

export const fakeSkillParticipant: import('../src/ports').SpecialistPackageSkillPort = {
  snapshot: async () => [],
  prepare: async () => {},
  beginMutation: async () => {},
  runInMutationContext: async (_id, operation) => operation(),
  endMutation: async () => {},
  prepareDeletion: async () => {},
  commit: async () => {},
  rollback: async () => {},
  recover: async () => {}
}
