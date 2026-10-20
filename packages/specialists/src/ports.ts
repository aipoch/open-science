import type { SpecialistPackageSkillPlan } from './archive-contracts'

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

export type SpecialistPackageSkillDisposition =
  | 'install'
  | 'reuse-builtin'
  | 'reuse-owned'
  | 'reuse-standalone'
  | 'reuse-existing'
  | 'conflict'
  | 'replace-existing'
export type SkillSource = 'featured' | 'imported' | 'personal'
/** The host owns Skill syntax; Specialist owns archive/reference validation. */
export type SkillDocumentParser = (raw: string) => {
  name?: string
  description?: string
  metadata: Record<string, string>
  body: string
  hasFrontmatter: boolean
}
export const missingSkillDocumentParser: SkillDocumentParser = () => {
  throw new Error('A Skill document parser is required for bundled Skills.')
}
export interface SkillEnablementPort {
  disabledSkillIds(): Promise<readonly string[]>
  setSkillsEnabled(ids: readonly string[], enabled: boolean): Promise<void>
}
export const missingSkillEnablement: SkillEnablementPort = {
  disabledSkillIds: async () => [],
  setSkillsEnabled: async (ids) => {
    if (ids.length) throw new Error('A Skill enablement port is required.')
  }
}
export interface SpecialistLogger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}
export const silentLogger: SpecialistLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}
export interface ExclusiveRunner {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
}
