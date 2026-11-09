const computeKubernetesWorkspaceMigration = {
  id: '0056_compute_kubernetes_workspace',
  statements: ['ALTER TABLE "ComputeJob" ADD COLUMN "kubernetesWorkspace" TEXT'],
  operations: [],
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'ComputeJob', column: 'kubernetesWorkspace' }
  ]
} as const

export { computeKubernetesWorkspaceMigration }
