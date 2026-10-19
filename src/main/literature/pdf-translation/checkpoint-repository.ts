import type { Prisma } from '@prisma/client'
import { Prisma as SQL } from '@prisma/client'
import type { TranslationTransaction } from '@aipoch/pdf-translation/storage'
import { createSqliteTranslationTransaction } from './sqlite-checkpoint-storage'
import {
  fromPackageCheckpoint,
  toPackageCheckpoint,
  pdfTranslationCheckpointSchema
} from '../../../shared/pdf-translation'
import { pdfTranslationCheckpointSchema as packageCheckpointSchema } from '@aipoch/pdf-translation/contracts'

// Persist the established host representation. Package IDs never become database/IPC fields.
const encode = (payload: string): string =>
  JSON.stringify(fromPackageCheckpoint(packageCheckpointSchema.parse(JSON.parse(payload))))
const decode = (payload: string): string =>
  JSON.stringify(toPackageCheckpoint(pdfTranslationCheckpointSchema.parse(JSON.parse(payload))))
type SourceAuthority = Pick<TranslationTransaction, 'requireSource' | 'requireDocument'>
export function translationTransaction(
  tx: Prisma.TransactionClient,
  authority: SourceAuthority
): TranslationTransaction {
  return createSqliteTranslationTransaction(
    {
      query: ({ strings, values }) => tx.$queryRaw(SQL.sql(strings, ...values)),
      execute: ({ strings, values }) => tx.$executeRaw(SQL.sql(strings, ...values))
    },
    authority,
    { encode, decode }
  )
}
