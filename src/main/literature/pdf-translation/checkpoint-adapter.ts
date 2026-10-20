import type { TranslationCheckpointStore } from '@aipoch/pdf-translation'
import type { PdfTranslationCheckpoints } from './checkpoints'
import {
  fromPackageBegin,
  fromPackageCheckpoint,
  fromTranslationSourceId,
  toPackageCheckpoint
} from '../../../shared/pdf-translation'
export type HostCheckpointStore = Pick<
  PdfTranslationCheckpoints,
  | 'contentKey'
  | 'read'
  | 'list'
  | 'select'
  | 'delete'
  | 'open'
  | 'append'
  | 'saveSnapshot'
  | 'recordLayout'
>
/** Translate the host IPC/persistence source contract once at the workflow boundary. */
export function adaptCheckpointStore(store: HostCheckpointStore): TranslationCheckpointStore {
  return {
    contentKey: (source) => store.contentKey(fromTranslationSourceId(source)),
    async read(source, key) {
      const value = await store.read(fromTranslationSourceId(source), key)
      return value ? toPackageCheckpoint(value) : null
    },
    list: (source) => store.list(fromTranslationSourceId(source)),
    async select(request, signal) {
      return toPackageCheckpoint(
        await store.select({ ...request, source: fromTranslationSourceId(request.source) }, signal)
      )
    },
    delete: (request, signal) =>
      store.delete({ ...request, source: fromTranslationSourceId(request.source) }, signal),
    async open(input, key, model) {
      const value = await store.open(fromPackageBegin(input), key, model)
      return value ? toPackageCheckpoint(value) : undefined
    },
    async append(checkpoint, ...args) {
      return toPackageCheckpoint(await store.append(fromPackageCheckpoint(checkpoint), ...args))
    },
    saveSnapshot: (request, signal) =>
      store.saveSnapshot({ ...request, source: fromTranslationSourceId(request.source) }, signal),
    recordLayout: (request, signal) =>
      store.recordLayout({ ...request, source: fromTranslationSourceId(request.source) }, signal)
  }
}
