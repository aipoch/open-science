// Existing projects retain the built-in template until a project override is saved.
const projectOptimizationPromptMigration = {
  id: '0057_project_optimization_prompt',
  statements: [
    `ALTER TABLE "Project" ADD COLUMN "optimizationPrompt" TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE "Project" ADD COLUMN "optimizationPromptScope" TEXT NOT NULL DEFAULT 'current'`
  ] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'Project', column: 'optimizationPrompt' },
    { kind: 'column-exists', version: 1, table: 'Project', column: 'optimizationPromptScope' }
  ] as const
}

export { projectOptimizationPromptMigration }
