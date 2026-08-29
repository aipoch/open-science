import { Prisma } from '@prisma/client'

import type { ProjectFilesClient } from './mutation-projection'

const PROJECT_FILES_INDEX_STATE_ID = 'project-files-index'

type ManagedFileIndexStateRow = {
  isIndexComplete: boolean | bigint | number
}

const isSqliteTrue = (value: boolean | bigint | number | undefined): boolean =>
  value === true || value === 1n || value === 1

const readProjectFilesIndexComplete = async (
  client: ProjectFilesClient,
  projectIds: string[]
): Promise<boolean> => {
  const rows = await client.$queryRaw<ManagedFileIndexStateRow[]>(Prisma.sql`
    SELECT CASE WHEN
      EXISTS (
        SELECT 1 FROM "ManagedFileIndexState"
        WHERE "id" = ${PROJECT_FILES_INDEX_STATE_ID}
          AND "isReconciliationComplete" = true
      )
      AND NOT EXISTS (
        SELECT 1 FROM "ManagedFileSessionSync"
        WHERE "projectId" IN (${Prisma.join(projectIds)})
          AND "filesRevision" < 0
          AND "deletedAt" IS NULL
      )
    THEN true ELSE false END AS "isIndexComplete"
  `)

  return isSqliteTrue(rows[0]?.isIndexComplete)
}

const setProjectFilesReconciliationComplete = async (
  client: ProjectFilesClient,
  isComplete: boolean
): Promise<void> => {
  await client.$executeRaw`
    INSERT INTO "ManagedFileIndexState" ("id", "isReconciliationComplete")
    VALUES (${PROJECT_FILES_INDEX_STATE_ID}, ${isComplete})
    ON CONFLICT("id") DO UPDATE SET
      "isReconciliationComplete" = excluded."isReconciliationComplete"
  `
}

export { isSqliteTrue, readProjectFilesIndexComplete, setProjectFilesReconciliationComplete }
