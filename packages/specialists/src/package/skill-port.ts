import type { SpecialistPackageSkillPort } from '../ports'

export const NOOP_SPECIALIST_PACKAGE_SKILL_PORT: SpecialistPackageSkillPort = {
  snapshot: async () => [],
  prepare: async (_transactionId, _specialistId, skills) => {
    if (skills.length) throw new Error('A Skill transaction participant is required.')
  },
  beginMutation: async () => undefined,
  runInMutationContext: async (_transactionId, operation) => operation(),
  endMutation: async () => undefined,
  prepareDeletion: async (_transactionId, _specialistId, owned, deleting) => {
    if (owned.length || deleting.length)
      throw new Error('A Skill transaction participant is required.')
  },
  commit: async () => undefined,
  rollback: async () => undefined,
  recover: async () => undefined
}
