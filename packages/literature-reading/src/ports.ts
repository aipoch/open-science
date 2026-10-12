/** A connection to the package-owned SQLite FTS5 sidecar; values are always bound parameters. */
export interface IndexDatabase {
  execute(sql: string, ...values: unknown[]): Promise<number>
  query<T>(sql: string, ...values: unknown[]): Promise<T>
  transaction<T>(operation: (db: IndexDatabase) => Promise<T>): Promise<T>
  close(): Promise<void>
}
export type IndexOptions = {
  open(): Promise<IndexDatabase>
  exists(): Promise<boolean>
  maintenance?(operation: () => Promise<void>): Promise<void>
  log?(message: string, fields: Record<string, unknown>): void
}
export type DocumentReference = Readonly<{
  bindingId: string
  name: string
  checksum: string
  sizeBytes: number
}>
export type TextExtraction = Readonly<{ text: string; pageCount: number; truncated: boolean }>
