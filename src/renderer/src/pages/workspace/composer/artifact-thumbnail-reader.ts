import {
  getDesktopRuntimeEpoch,
  desktopRuntimeWritable
} from '../../../stores/desktop-runtime-recovery-store'
import { createKeyedRequestReader, type KeyedRequestReader } from '../project-file-preview-queue'
import type { ArtifactPreviewResult } from '../../../../../shared/artifacts'

type ThumbnailRequest = { path: string; source: 'upload' | 'artifact' | 'literature' }
export type ArtifactThumbnailReader = KeyedRequestReader<
  ThumbnailRequest,
  ArtifactPreviewResult | undefined
>
export const thumbnailRequestKey = ({ source, path }: ThumbnailRequest): string =>
  `${getDesktopRuntimeEpoch()}:${source}:${path}`

// Physical reads outlive a closing popup. Share their admission budget across popup instances,
// while each popup retains its own keys and deduplication. Cancellation never frees a running slot.
type ThumbnailTask = {
  current(): boolean
  run(): Promise<ArtifactPreviewResult | undefined>
  resolve(value: ArtifactPreviewResult | undefined): void
  reject(error: unknown): void
}
let activeReads = 0
const waiting: ThumbnailTask[] = []
const pump = (): void => {
  for (let index = waiting.length - 1; index >= 0; index--) {
    if (!waiting[index].current()) waiting.splice(index, 1)[0].resolve(undefined)
  }
  while (activeReads < 4 && waiting.length) {
    const task = waiting.shift()!
    activeReads++
    void task
      .run()
      .then(task.resolve, task.reject)
      .finally(() => {
        activeReads--
        pump()
      })
  }
}

// One reader belongs to the popup; its queue skips work filtered out before physical admission.
export const createArtifactThumbnailReader = (): ArtifactThumbnailReader => {
  let activeKeys: ReadonlySet<string> | undefined
  const reader = createKeyedRequestReader<ThumbnailRequest, ArtifactPreviewResult | undefined>(
    (request) => {
      const epoch = getDesktopRuntimeEpoch()
      const key = thumbnailRequestKey(request)
      const current = (): boolean =>
        desktopRuntimeWritable() &&
        epoch === getDesktopRuntimeEpoch() &&
        (activeKeys === undefined || activeKeys.has(key))
      if (!current() || waiting.length >= 64) return Promise.resolve(undefined)
      return new Promise((resolve, reject) => {
        waiting.push({
          current,
          resolve,
          reject,
          run: async () => {
            const read =
              request.source === 'upload'
                ? window.api.uploads.readPreview
                : window.api.artifacts.readPreview
            const result = await read({
              path: request.path,
              maxBytes: THUMBNAIL_MAX_BYTES,
              encoding: 'base64'
            })
            return current() ? result : undefined
          }
        })
        pump()
      })
    },
    thumbnailRequestKey,
    4,
    {
      getGenerationKey: () => String(getDesktopRuntimeEpoch()),
      createCanceledResult: () => undefined
    }
  )
  const setActiveKeys = reader.setActiveKeys
  reader.setActiveKeys = (keys) => {
    activeKeys = new Set(keys)
    setActiveKeys(keys)
    pump()
  }
  return reader
}

// Keep the per-row thumbnail read tiny; the popup only needs a small preview image.
const THUMBNAIL_MAX_BYTES = 256 * 1024
