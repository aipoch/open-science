import { join } from 'node:path'

import type { WslSelection, WslSetupOperationKind } from '../../shared/wsl-setup'
import { readDurableJsonFile, writeDurableJsonFile } from '../storage/durable-json-file'

const JOURNAL_VERSION = 1 as const
const JOURNAL_FILE = 'wsl-setup-operation.json'

type WslSetupOperationRecordBase = Readonly<{
  operationReference: string
  startedAt: number
}>

export type WslSetupOperationRecord =
  | Readonly<
      WslSetupOperationRecordBase & {
        kind: Exclude<WslSetupOperationKind, 'install-runtime-dependencies'>
      }
    >
  | Readonly<
      WslSetupOperationRecordBase & {
        kind: 'install-runtime-dependencies'
        selection: Readonly<WslSelection>
      }
    >

type SerializedOperation = Readonly<{
  kind: WslSetupOperationKind
  operationReference: string
  startedAt: number
  selection?: unknown
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

const validSelectionPart = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxLength &&
  !/[\0\r\n]/.test(value)

const decode = (contents: string): WslSetupOperationRecord | undefined => {
  const value = JSON.parse(contents) as Partial<JournalDocument>
  if (value.version !== JOURNAL_VERSION || !('operation' in value)) {
    throw new Error('WSL setup operation journal has an invalid format.')
  }
  if (value.operation === null) return undefined
  const operation = value.operation as SerializedOperation | undefined
  if (
    !operation ||
    (operation.kind !== 'install-platform' &&
      operation.kind !== 'install-recommended-distro' &&
      operation.kind !== 'install-runtime-dependencies') ||
    typeof operation.operationReference !== 'string' ||
    !operation.operationReference ||
    typeof operation.startedAt !== 'number' ||
    !Number.isFinite(operation.startedAt)
  ) {
    throw new Error('WSL setup operation journal contains an invalid operation.')
  }
  if (operation.kind === 'install-runtime-dependencies') {
    const selection = operation.selection as Partial<WslSelection> | null | undefined
    if (
      !selection ||
      !validSelectionPart(selection.distro, 256) ||
      !validSelectionPart(selection.user, 128) ||
      selection.user === 'root'
    ) {
      throw new Error('WSL setup operation journal contains an invalid operation.')
    }
    return Object.freeze({
      kind: operation.kind,
      operationReference: operation.operationReference,
      startedAt: operation.startedAt,
      selection: Object.freeze({ distro: selection.distro, user: selection.user })
    })
  }
  return Object.freeze({
    kind: operation.kind,
    operationReference: operation.operationReference,
    startedAt: operation.startedAt
  })
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
