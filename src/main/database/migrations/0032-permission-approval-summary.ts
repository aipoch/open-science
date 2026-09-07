/* Immutable 0032 migration snapshot. Do not regenerate after release. */
const permissionApprovalSummaryMigration = {
  id: '0032_permission_approval_summary',
  statements: ['ALTER TABLE "PermissionGrant" ADD COLUMN "approvalSummary" TEXT'] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'PermissionGrant', column: 'approvalSummary' }
  ] as const
}
export { permissionApprovalSummaryMigration }
