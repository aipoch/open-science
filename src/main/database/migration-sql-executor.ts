import type { Prisma, PrismaClient } from '@prisma/client'

type MigrationSqlClient = PrismaClient | Prisma.TransactionClient

// This is the only production seam allowed to invoke Prisma's unsafe raw methods for schema work.
// Callers must supply trusted, application-owned SQL; user data stays on Prisma's parameterized APIs.
const migrationSqlExecutor = {
  execute: (client: MigrationSqlClient, statement: string, ...values: unknown[]): Promise<number> =>
    client.$executeRawUnsafe(statement, ...values),
  query: <Result>(
    client: MigrationSqlClient,
    statement: string,
    ...values: unknown[]
  ): Promise<Result> => client.$queryRawUnsafe<Result>(statement, ...values)
}

export { migrationSqlExecutor }
export type { MigrationSqlClient }
