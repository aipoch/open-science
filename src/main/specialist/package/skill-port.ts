import type { SpecialistPackageSkillPort } from '@aipoch/skills'

export const NOOP_SPECIALIST_PACKAGE_SKILL_PORT: SpecialistPackageSkillPort = {
  snapshot: async () => [],
  prepare: async () => undefined,
  beginMutation: async () => undefined,
  runInMutationContext: async (_transactionId, operation) => operation(),
  endMutation: async () => undefined,
  prepareDeletion: async () => undefined,
  commit: async () => undefined,
  rollback: async () => undefined,
  recover: async () => undefined
}
