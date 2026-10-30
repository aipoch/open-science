// Existing projects retain the built-in template until a project override is saved.
export const projectOptimizationPromptMigration = {
  id: '0055_project_optimization_prompt',
  statements: [
    `ALTER TABLE "Project" ADD COLUMN "optimizationPrompt" TEXT NOT NULL DEFAULT ''`
  ] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'Project', column: 'optimizationPrompt' }
  ] as const
}
