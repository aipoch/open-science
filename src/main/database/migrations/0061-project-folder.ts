const projectFolderMigration = {
  id: '0061_project_folder',
  statements: [`ALTER TABLE "Project" ADD COLUMN "rootPath" TEXT`] as const,
  verifiers: [{ kind: 'column-exists', version: 1, table: 'Project', column: 'rootPath' }] as const
}

export { projectFolderMigration }
