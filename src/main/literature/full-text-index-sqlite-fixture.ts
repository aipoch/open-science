import { LiteratureIndex } from '@aipoch/literature-reading'
import { openSqliteLiteratureIndex, type IndexDatabase } from './full-text-index-storage'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
export const indexPath = (root: string): string => join(root, 'index.sqlite')
export function openDatabase(root: string): IndexDatabase {
  const connection = new DatabaseSync(indexPath(root))
  const db: IndexDatabase = {
    execute: async (sql, ...values) =>
      Number(connection.prepare(sql).run(...(values as SQLInputValue[])).changes),
    query: async <T>(sql: string, ...values: unknown[]) =>
      connection.prepare(sql).all(...(values as SQLInputValue[])) as T,
    transaction: async (operation) => {
      connection.exec('BEGIN')
      try {
        const result = await operation(db)
        connection.exec('COMMIT')
        return result
      } catch (error) {
        connection.exec('ROLLBACK')
        throw error
      }
    },
    close: async () => connection.close()
  }
  return db
}
export const sql = {
  execute: (db: IndexDatabase, statement: string, ...values: unknown[]): Promise<number> =>
    db.execute(statement, ...values),
  query: <T>(db: IndexDatabase, statement: string, ...values: unknown[]): Promise<T> =>
    db.query<T>(statement, ...values)
}
export function createIndex(root: string): LiteratureIndex {
  return new LiteratureIndex({
    exists: async () => existsSync(indexPath(root)),
    open: async () => {
      const db = openDatabase(root)
      return openSqliteLiteratureIndex(
        {
          ...db,
          query: (statement, ...values) => sql.query(db, statement, ...values),
          execute: (statement, ...values) => sql.execute(db, statement, ...values)
        },
        () => {}
      )
    }
  })
}
