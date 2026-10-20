export type SpecialistPackageSkillDisposition =
  | 'install'
  | 'reuse-builtin'
  | 'reuse-owned'
  | 'reuse-standalone'
  | 'reuse-existing'
  | 'conflict'
  | 'replace-existing'

export type SpecialistPackageSkillConflict = {
  localId: string
  installedVersion: string
  installedContentHash: string
}

export type SpecialistPackageSkillPlan = {
  id: string
  version: string
  disposition: SpecialistPackageSkillDisposition
  localId?: string
  conflict?: SpecialistPackageSkillConflict
  contentHash: string
  filesToInstall: ReadonlyArray<{ path: string; bytes: Uint8Array }>
}

export type SpecialistPackageSkillSnapshot = {
  /** Stable ID of the locally installed Skill referenced by Specialist persistence. */
  localId: string
  /** Immutable invocation name used by specialist.json and skills/<name>/. */
  name: string
  version: string
  contentHash: string
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>
}

// The Skill Module owns its files. Package transactions can only stage an immutable plan, promote it,
// or deterministically settle/undo one transaction during normal completion and restart recovery.
export interface SpecialistPackageSkillPort {
  runMutationExclusive?<T>(operation: () => Promise<T>): Promise<T>
  snapshot(): Promise<
    ReadonlyArray<{
      id: string
      version: string
      contentHash: string
      standalone: boolean
      ownerIds: readonly string[]
    }>
  >
  prepare(
    transactionId: string,
    specialistId: string,
    skills: readonly SpecialistPackageSkillPlan[]
  ): Promise<void>
  beginMutation?(
    transactionId: string,
    specialistId: string,
    skills: readonly SpecialistPackageSkillPlan[]
  ): Promise<void>
  runInMutationContext?<T>(transactionId: string, operation: () => Promise<T>): Promise<T>
  endMutation?(transactionId: string): Promise<void>
  prepareDeletion?(
    transactionId: string,
    specialistId: string,
    /** Specialist-owned Skills whose ownership must be released when they are retained. */
    ownedSkillIds: readonly string[],
    /** Preview-approved Skill packages to remove; these may have independent provenance. */
    deleteSkillIds: readonly string[]
  ): Promise<void>
  commit(transactionId: string): Promise<void>
  rollback(transactionId: string): Promise<void>
  recover(transactionId: string | undefined, outcome: 'commit' | 'rollback'): Promise<void>
  exportSnapshot?: (
    skillIds: readonly string[]
  ) => Promise<ReadonlyArray<SpecialistPackageSkillSnapshot>>
}

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

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export const validateSpecialistPackageVersion = (version: string): string | undefined =>
  SEMVER_PATTERN.test(version) ? undefined : 'Package version must be valid SemVer.'
