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
        kind: 'install-platform'
      }
    >
  | Readonly<
      WslSetupOperationRecordBase & {
        kind: 'install-recommended-distro'
        distro?: string
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
  distro?: unknown
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

const isOperationKind = (value: unknown): value is WslSetupOperationKind =>
  value === 'install-platform' ||
  value === 'install-recommended-distro' ||
  value === 'install-runtime-dependencies'

const isSerializedOperation = (value: unknown): value is SerializedOperation => {
  if (!value || typeof value !== 'object') return false
  const operation = value as Partial<SerializedOperation>
  return (
    isOperationKind(operation.kind) &&
    typeof operation.operationReference === 'string' &&
    operation.operationReference.length > 0 &&
    typeof operation.startedAt === 'number' &&
    Number.isFinite(operation.startedAt)
  )
}

const invalidOperation = (): Error =>
  new Error('WSL setup operation journal contains an invalid operation.')

const decode = (contents: string): WslSetupOperationRecord | undefined => {
  const value = JSON.parse(contents) as Partial<JournalDocument>
  if (value.version !== JOURNAL_VERSION || !('operation' in value)) {
    throw new Error('WSL setup operation journal has an invalid format.')
  }
  if (value.operation === null) return undefined
  if (!isSerializedOperation(value.operation)) throw invalidOperation()
  const operation = value.operation
  const base = {
    operationReference: operation.operationReference,
    startedAt: operation.startedAt
  }
  switch (operation.kind) {
    case 'install-runtime-dependencies': {
      const selection = operation.selection as Partial<WslSelection> | null | undefined
      if (
        !selection ||
        !validSelectionPart(selection.distro, 256) ||
        !validSelectionPart(selection.user, 128) ||
        selection.user === 'root'
      ) {
        throw invalidOperation()
      }
      return Object.freeze({
        ...base,
        kind: operation.kind,
        selection: Object.freeze({ distro: selection.distro, user: selection.user })
      })
    }
    case 'install-recommended-distro':
      if (operation.distro !== undefined && !validSelectionPart(operation.distro, 256)) {
        throw invalidOperation()
      }
      return Object.freeze({
        ...base,
        kind: operation.kind,
        // Version 1 records created before distro selection always installed Ubuntu 22.04.
        distro: operation.distro ?? 'Ubuntu-22.04'
      })
    case 'install-platform':
      return Object.freeze({ ...base, kind: operation.kind })
  }
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
