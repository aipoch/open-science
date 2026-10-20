import type { SmartScope, SmartRunProgress } from './contracts.js'

export type ScreeningDefinition = {
  collectionId: string
  scopeKind: string
  scopeId: string | null
  ruleRevision: number
  evidenceMode: string
  autoUpdate: boolean
  automaticPauseReason: string | null
  automaticPauseRunId: string | null
  collection: { description: string }
}
export type ScreeningRuleVersion = {
  revision: number
  description: string
  inclusionCriteria: string
  exclusionCriteria: string
  scopeKind: string
  scopeId: string | null
  evidenceMode: string
}
export type ScreeningRun = {
  id: string
  collectionId: string
  kind: string
  state: string
  ruleRevision: number
  policyKey: string
  model: string | null
  createdAt: Date
  updatedAt: Date
  abandonedAt: Date | null
  snapshotJson: string | null
}
export type ScreeningRunItem = {
  runId: string
  itemId: string
  digest: string
  state: string
  failure: string | null
  deferred: boolean
  resultJson: string | null
  evaluatedAt: Date | null
}
export type ScreeningAssessment = {
  ruleRevision: number
  inputDigest: string
  policyKey: string
  model: string
  verdict: string
  evaluatedAt: Date
  probabilitiesJson: string
  evidenceJson: string | null
}
export type ScreeningDocument = {
  id: string
  attachmentId: string
  checksum: string
  filename: string
  sizeBytes: bigint | number
  contentType: string
}
export type ScreeningPaper = { id: string; title: string; abstract: string }
export type ScreeningPaperState = ScreeningPaper & {
  smartAssessments: ScreeningAssessment[]
  smartOverrides: { decision: string }[]
}
export type ScreeningRunPatch = Partial<
  Pick<ScreeningRun, 'state' | 'model' | 'updatedAt' | 'abandonedAt'>
>
export type ScreeningPause = Pick<
  ScreeningDefinition,
  'automaticPauseReason' | 'automaticPauseRunId'
>
export type ScreeningRunSelection = {
  id?: string
  collectionId?: string
  states?: string[]
  abandoned?: false
}
export type ScreeningRunItemSelection = {
  runId: string
  states?: string[]
  deferred?: boolean
  itemId?: string
}
export type ScreeningScan = {
  itemIds?: string[]
  projectId?: string
  after?: string
  limit?: number
  details?: boolean
  collectionId?: string
}
export type ScreeningProgressData = {
  state: string
  counts: SmartRunProgress['counts']
  candidates: ScreeningRunItem[]
  outcomes: ScreeningRunItem[]
  titles: { id: string; title: string }[]
  overrides: { itemId: string; decision: string }[]
}
/** Transaction-scoped domain storage. It exposes no ORM expressions or host entities.
 * Reads must observe earlier writes in the same transaction. Collection removal cascades
 * screening data; the host owns that cross-domain deletion transaction.
 */
export interface ScreeningStore {
  listCollections(
    automaticOnly?: boolean
  ): Promise<{ collectionId: string; automaticPauseReason: string | null }[]>
  definition(id: string): Promise<ScreeningDefinition | null>
  scopeAvailable(scope: SmartScope): Promise<boolean>
  sourceName(scope: SmartScope): Promise<string>
  papers(scope: SmartScope, scan?: ScreeningScan): Promise<ScreeningPaperState[]>
  paper(scope: SmartScope, id: string): Promise<ScreeningPaper | null>
  documents(itemIds: string[]): Promise<{ itemId: string; document: ScreeningDocument | null }[]>
  ruleVersions(collectionId: string, revisions: number[]): Promise<ScreeningRuleVersion[]>
  hasOutdatedRun(collectionId: string, ruleRevision: number): Promise<boolean>
  findRun(selection: ScreeningRunSelection): Promise<ScreeningRun | null>
  latestRuns(collectionId: string, limit?: number): Promise<ScreeningRun[]>
  run(id: string): Promise<ScreeningRun & { rule: ScreeningRuleVersion }>
  /** Unfinished reads must retain unrecognized stored states so the engine can reject them. */
  runItems(
    selection: ScreeningRunItemSelection & { unfinished?: boolean }
  ): Promise<ScreeningRunItem[]>
  history(
    collectionId: string,
    itemId: string,
    offset: number
  ): Promise<(ScreeningRunItem & { run: { rule: ScreeningRuleVersion } })[]>
  usage(runId: string): Promise<{
    inputTokens: number
    outputTokens: number
    incomplete: boolean
    scenarios: { scenario: string }[]
  }>
  runCounts(runId: string): Promise<{ state: string; count: number }[]>
  runFailure(runId: string): Promise<{ failure: string | null } | null>
  createCollection(input: {
    name: string
    description: string
    scope: SmartScope
    evidenceMode: string
    autoUpdate: boolean
  }): Promise<{ id: string }>
  createRun(
    input: Omit<ScreeningRun, 'createdAt' | 'updatedAt' | 'abandonedAt' | 'model'> & {
      items: {
        itemId: string
        digest: string
        state: string
        failure?: string
        deferred?: boolean
      }[]
    }
  ): Promise<{ id: string }>
  updateRuns(selection: ScreeningRunSelection, patch: ScreeningRunPatch): Promise<number>
  updateRun(id: string, patch: ScreeningRunPatch): Promise<void>
  updateRunItems(
    selection: ScreeningRunItemSelection,
    patch: Partial<Pick<ScreeningRunItem, 'state' | 'failure' | 'resultJson' | 'evaluatedAt'>>
  ): Promise<void>
  /** Compare-and-set pause ownership. Omitted expected fields impose no condition. */
  updatePause(
    collectionId: string,
    expected: Partial<ScreeningPause> & { autoUpdate?: boolean },
    patch: Partial<ScreeningPause>
  ): Promise<number>
  clearOverrides(collectionId: string, itemIds?: string[]): Promise<void>
  saveOverrides(
    collectionId: string,
    itemIds: string[],
    decision: string,
    updatedAt: Date
  ): Promise<void>
  resolvedModel(collectionId: string, policyKey: string): Promise<string | undefined>
  invalidateAssessments(collectionId: string, policyKey: string, obsoleteKey: string): Promise<void>
  saveAssessment(
    collectionId: string,
    itemId: string,
    assessment: ScreeningAssessment
  ): Promise<void>
}
/** Stable identity per database. Adapters own transaction admission, rollback and SQL caches. */
export interface ScreeningDatabase extends ScreeningStore {
  progress(collectionId: string, runId: string): Promise<ScreeningProgressData>
  transaction<T>(
    operation: (store: ScreeningStore) => Promise<T>,
    options?: { maxWait?: number }
  ): Promise<T>
  /** Includes relevant local writes and all external commits. Must not open a nested transaction. */
  revision(): Promise<string>
}
export type ReadScreeningEvidence = (request: {
  attachmentId: string
  attachmentVersionId: string
  filename: string
  sizeBytes: number
  checksum: string
  query: string
}) => Promise<{
  coverage: 'full-text' | 'passages' | 'unavailable'
  passages: { pageStart: number; pageEnd: number; content: string }[]
}>
