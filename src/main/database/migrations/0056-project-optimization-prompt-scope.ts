const projectOptimizationPromptScopeMigration = {
  id: '0056_project_optimization_prompt_scope',
  statements: [
    `ALTER TABLE "Project" ADD COLUMN "optimizationPromptScope" TEXT NOT NULL DEFAULT 'current'`
  ] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'Project', column: 'optimizationPromptScope' }
  ] as const
}

export { projectOptimizationPromptScopeMigration }
