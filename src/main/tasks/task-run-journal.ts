import { join } from 'node:path'

import type { TaskRun, TaskRunFailureCode, TaskRunStatus } from '../../shared/task-api'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile
} from '../storage/durable-json-file'

const TASK_RUN_JOURNAL_FILE = 'task-runs.json'
const TASK_RUN_JOURNAL_VERSION = 1 as const

export type TaskRunJournalEntry = TaskRun & {
  promptMessageId?: string
  sessionCommitStatus?: Exclude<TaskRunStatus, 'running'>
}

type TaskRunJournalDocument = {
  version: typeof TASK_RUN_JOURNAL_VERSION
  runs: TaskRunJournalEntry[]
}

export type TaskRunJournal = {
  load(): Promise<TaskRunJournalEntry[]>
  replace(runs: readonly TaskRunJournalEntry[]): Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isOptionalFiniteNumber = (value: unknown): value is number | undefined =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value))

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

const TASK_RUN_STATUSES = new Set<TaskRunStatus>(['running', 'completed', 'failed', 'cancelled'])
const TASK_RUN_FAILURE_CODES = new Set<TaskRunFailureCode>(['process_restarted'])

const decodeRun = (value: unknown): TaskRunJournalEntry => {
  if (!isRecord(value)) throw new Error('Task Run journal contains a non-object Run.')
  if (
    typeof value.id !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.projectId !== 'string' ||
    typeof value.cwd !== 'string' ||
    typeof value.status !== 'string' ||
    !TASK_RUN_STATUSES.has(value.status as TaskRunStatus) ||
    typeof value.startedAt !== 'number' ||
    !Number.isFinite(value.startedAt) ||
    !isOptionalFiniteNumber(value.cancelRequestedAt) ||
    !isOptionalFiniteNumber(value.cancelledAt) ||
    !isOptionalFiniteNumber(value.completedAt) ||
    (value.output !== undefined && typeof value.output !== 'string') ||
    (value.error !== undefined && typeof value.error !== 'string') ||
    (value.failureCode !== undefined &&
      (typeof value.failureCode !== 'string' ||
        !TASK_RUN_FAILURE_CODES.has(value.failureCode as TaskRunFailureCode))) ||
    (value.promptMessageId !== undefined && typeof value.promptMessageId !== 'string') ||
    (value.sessionCommitStatus !== undefined &&
      value.sessionCommitStatus !== 'completed' &&
      value.sessionCommitStatus !== 'cancelled' &&
      value.sessionCommitStatus !== 'failed') ||
    !Array.isArray(value.artifacts) ||
    !isStringArray(value.preferredComputeHostIds)
  ) {
    throw new Error('Task Run journal contains an invalid Run.')
  }
  return value as TaskRunJournalEntry
}

const decodeDocument = (contents: string): TaskRunJournalEntry[] => {
  const value = JSON.parse(contents) as unknown
  if (!isRecord(value)) throw new Error('Task Run journal must contain an object.')
  if (
    typeof value.version === 'number' &&
    Number.isInteger(value.version) &&
    value.version > TASK_RUN_JOURNAL_VERSION
  ) {
    throw new DurableJsonRecoveryBarrierError('Unsupported Task Run journal version.')
  }
  if (value.version !== TASK_RUN_JOURNAL_VERSION || !Array.isArray(value.runs)) {
    throw new Error('Task Run journal has an invalid format.')
  }
  return value.runs.map(decodeRun)
}

export class FileTaskRunJournal implements TaskRunJournal {
  private readonly filePath: string

  constructor(configRoot: string) {
    this.filePath = join(configRoot, TASK_RUN_JOURNAL_FILE)
  }

  async load(): Promise<TaskRunJournalEntry[]> {
    const result = await readDurableJsonFile(this.filePath, decodeDocument)
    return result.status === 'found' ? result.value : []
  }

  async replace(runs: readonly TaskRunJournalEntry[]): Promise<void> {
    const document: TaskRunJournalDocument = {
      version: TASK_RUN_JOURNAL_VERSION,
      runs: runs.map((run) => structuredClone(run))
    }
    await writeDurableJsonFile(this.filePath, `${JSON.stringify(document, null, 2)}\n`)
  }
}
