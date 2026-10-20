import type {
  PdfTranslationCheckpointRequest,
  PdfTranslationCheckpoint,
  PdfTranslationEdition,
  PdfTranslationSelectEditionRequest,
  PdfTranslationSaveSnapshotRequest,
  PdfTranslationRecordLayoutRequest,
  PdfTranslationBeginRequest,
  PdfTranslationModel,
  PdfTranslationBlockFailure
} from './contracts.js'
/** One store owns every checkpoint mutation, including revision conflicts and source access. */
export interface TranslationCheckpointStore {
  contentKey(source: PdfTranslationCheckpointRequest): Promise<string>
  read(
    source: PdfTranslationCheckpointRequest,
    key?: string
  ): Promise<PdfTranslationCheckpoint | null>
  list(source: PdfTranslationCheckpointRequest): Promise<PdfTranslationEdition[]>
  select(
    request: PdfTranslationSelectEditionRequest,
    signal?: AbortSignal
  ): Promise<PdfTranslationCheckpoint>
  delete(request: PdfTranslationSelectEditionRequest, signal?: AbortSignal): Promise<void>
  open(
    input: PdfTranslationBeginRequest,
    targetKey: string,
    model: PdfTranslationModel
  ): Promise<PdfTranslationCheckpoint | undefined>
  append(
    checkpoint: PdfTranslationCheckpoint,
    index: number,
    text: string | undefined,
    signal: AbortSignal,
    replaceExisting?: boolean,
    diagnostic?: PdfTranslationBlockFailure
  ): Promise<PdfTranslationCheckpoint>
  saveSnapshot(input: PdfTranslationSaveSnapshotRequest, signal: AbortSignal): Promise<void>
  recordLayout(input: PdfTranslationRecordLayoutRequest, signal: AbortSignal): Promise<void>
}
