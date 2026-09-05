// Keep uniqueness within a reference; Add and Inbox own their default reuse policy.
const literatureExplicitDuplicatesMigration = {
  id: '0030_literature_explicit_duplicates',
  statements: ['DROP INDEX "LiteratureIdentifier_identity_key"'] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'indexes-absent', version: 1, names: ['LiteratureIdentifier_identity_key'] }
  ] as const
}

export { literatureExplicitDuplicatesMigration }
