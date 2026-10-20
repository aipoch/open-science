import type { FetchedSkillFile } from './github-import'

/** Stable installation facts; additional signed source fields stay opaque to the repository. */
export type SkillReleaseReceipt = {
  id: string
  version: string
  contentSha256: string
  descriptorSha256: string
  [key: string]: unknown
}
export type InstalledSkillReleaseReceipt = SkillReleaseReceipt & { installedContentSha256: string }
export type SkillReleasePackage = { files: FetchedSkillFile[]; receipt: SkillReleaseReceipt }

/** Source-owned validation and version policy. The repository alone performs filesystem writes. */
export type SkillReleasePolicy = {
  metadataKey: string
  parseRelease: (value: unknown) => SkillReleaseReceipt
  parseReceipt: (value: unknown) => InstalledSkillReleaseReceipt
  contentDigest: (files: readonly FetchedSkillFile[]) => string
  isNewerVersion: (offered: string, installed: string) => boolean
  diffLabel: string
}

export function assertSkillReleasePolicy(policy: SkillReleasePolicy): void {
  if (
    !/^[a-z][a-z0-9_-]{0,63}$/.test(policy.metadataKey) ||
    ['url', 'signature', 'agentHome', '__proto__', 'constructor', 'prototype'].includes(
      policy.metadataKey
    )
  )
    throw new Error('Invalid Skill release metadata key')
}

export type SkillReleaseConflictReason =
  | 'name-taken'
  | 'local-content-changed'
  | 'installation-unverifiable'
  | 'invalid-name'
  | 'version-changed'
  | 'release-mismatch'

// Opaque caller policy revision, recomputed under the caller's impact lock at commit.
export type SkillReleaseUpdateGuard = (id: string, ownerIds: readonly string[]) => Promise<string>

// Short-lived preview only. Tokens are process-local and never stored in a release receipt.
export type SkillReleaseUpdatePreview = {
  token: string
  localSkillId: string
  displayName: string
  source: 'personal' | 'imported'
  installedVersion?: string
  localChanges: 'unchanged' | 'modified' | 'unknown'
  added: string[]
  modified: string[]
  removed: string[]
  differences: { path: string; patch?: string }[]
}

export type SkillReleaseInstallation =
  | { kind: 'not-installed' }
  | { kind: 'conflict'; reason?: SkillReleaseConflictReason; localSkillId?: string }
  | {
      kind: 'installed'
      version: string
      canUpdate: boolean
      localSkillId?: string
      requiresPreview?: boolean
      protected?: boolean
    }
