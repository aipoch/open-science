import { join } from 'node:path'

import type { WslSetupOperationKind } from '../../shared/wsl-setup'
import { readDurableJsonFile, writeDurableJsonFile } from '../storage/durable-json-file'

const JOURNAL_VERSION = 1 as const
const JOURNAL_FILE = 'wsl-setup-operation.json'

export type WslSetupOperationRecord = Readonly<{
  kind: WslSetupOperationKind
  operationReference: string
  startedAt: number
}>

export type WslSetupOperationJournal = {
  load(): Promise<WslSetupOperationRecord | undefined>
  save(record: WslSetupOperationRecord): Promise<void>
  clear(): Promise<void>
}

type JournalDocument = Readonly<{
  version: typeof JOURNAL_VERSION
  operation: WslSetupOperationRecord | null
}>

const decode = (contents: string): WslSetupOperationRecord | undefined => {
  const value = JSON.parse(contents) as Partial<JournalDocument>
  if (value.version !== JOURNAL_VERSION || !('operation' in value)) {
    throw new Error('WSL setup operation journal has an invalid format.')
  }
  if (value.operation === null) return undefined
  const operation = value.operation
  if (
    !operation ||
    (operation.kind !== 'install-platform' && operation.kind !== 'install-recommended-distro') ||
    typeof operation.operationReference !== 'string' ||
    !operation.operationReference ||
    typeof operation.startedAt !== 'number' ||
    !Number.isFinite(operation.startedAt)
  ) {
    throw new Error('WSL setup operation journal contains an invalid operation.')
  }
  return Object.freeze({ ...operation })
}

export class FileWslSetupOperationJournal implements WslSetupOperationJournal {
  private readonly filePath: string

  constructor(configRoot: string) {
    this.filePath = join(configRoot, JOURNAL_FILE)
  }

  async load(): Promise<WslSetupOperationRecord | undefined> {
    const result = await readDurableJsonFile(this.filePath, decode, {}, { maxBytes: 16 * 1024 })
    return result.status === 'found' ? result.value : undefined
  }

  save(record: WslSetupOperationRecord): Promise<void> {
    return this.write({ version: JOURNAL_VERSION, operation: record })
  }

  clear(): Promise<void> {
    return this.write({ version: JOURNAL_VERSION, operation: null })
  }

  private write(document: JournalDocument): Promise<void> {
    return writeDurableJsonFile(this.filePath, `${JSON.stringify(document, null, 2)}\n`)
  }
}
