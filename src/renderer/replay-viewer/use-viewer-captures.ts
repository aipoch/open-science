import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunObservationSnapshot } from '../../shared/run-observation'
import type { ObservationViewerCapture } from '../../shared/run-observation-capture'
import type { ReplayViewerClient } from './client'

// Retain only images the user actually opened, not a second recording pipeline. Strings use
// at most two bytes per code unit; this bound includes the data URL/base64 expansion.
const IMAGE_CACHE_BYTES = 8 * 1024 * 1024
const IMAGE_CACHE_COUNT = 4
type RetainedCaptures = {
  client: ReplayViewerClient
  captures: readonly ObservationViewerCapture[]
  images: Map<string, { checksum: string; sizeBytes: number; src: string }>
  bytes: number
  disposed: boolean
}

export const capturesForObservation = (
  captures: readonly ObservationViewerCapture[],
  snapshot: RunObservationSnapshot
): readonly ObservationViewerCapture[] =>
  captures.filter(
    (capture) =>
      capture.viewerEvidence?.cursor.epoch === snapshot.cursor.epoch &&
      capture.viewerEvidence.cursor.sequence === snapshot.cursor.sequence &&
      capture.viewerEvidence.stepId === snapshot.stepId &&
      capture.viewerEvidence.observedAt === snapshot.observedAt
  )

export const useViewerCaptures = (
  client: ReplayViewerClient,
  active: boolean
): {
  captures: readonly ObservationViewerCapture[]
  readImage: (id: string) => Promise<string | null>
} => {
  const [result, setResult] = useState<{
    client: ReplayViewerClient
    captures: ObservationViewerCapture[]
  }>()
  const cache = useRef<RetainedCaptures | undefined>(undefined)
  useEffect(() => {
    const retained: RetainedCaptures = {
      client,
      captures: [],
      images: new Map(),
      bytes: 0,
      disposed: false
    }
    cache.current = retained
    return () => {
      retained.disposed = true
      retained.images.clear()
      retained.captures = []
      retained.bytes = 0
    }
  }, [client])
  useEffect(() => {
    const retained = cache.current
    if (!active || !retained || retained.client !== client) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const results = await client.captures(controller.signal)
        if (!controller.signal.aborted) {
          // Cleanup can empty Main's cache just before the terminal snapshot reaches us.
          // Keep metadata only for the bounded image bytes already verified in this viewer.
          const known = new Map(results.map((capture) => [capture.captureId, capture]))
          for (const capture of retained.captures)
            if (retained.images.has(capture.captureId) && !known.has(capture.captureId))
              known.set(capture.captureId, capture)
          const captures = [...known.values()]
          retained.captures = captures
          setResult({ client, captures })
        }
      } catch {
        /* Recorded Notebook evidence remains usable if the short-lived frame cache expires. */
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void poll()
        }, 1500)
    }
    void poll()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [client, active])
  const readImage = useCallback(
    async (id: string) => {
      const retained = cache.current
      if (!retained || retained.client !== client || retained.disposed) return null
      const capture = retained.captures.find((item) => item.captureId === id)
      if (!capture) return null
      const cached = retained.images.get(id)
      if (
        cached &&
        cached.checksum === capture.checksum &&
        cached.sizeBytes === capture.sizeBytes
      ) {
        retained.images.delete(id)
        retained.images.set(id, cached)
        return cached.src
      }
      // Main may already have released the process-local capture cache. Historical viewing
      // never reopens a project or retries network reads after observation stops.
      if (!active) return null
      const src = await client.captureImage(capture)
      // captureImage verifies the exact checksum/size before returning an image data URL.
      if (retained.disposed || !src) return null
      const bytes = src.length * 2
      if (bytes <= IMAGE_CACHE_BYTES) {
        const previous = retained.images.get(id)
        if (previous) {
          retained.bytes -= previous.src.length * 2
          retained.images.delete(id)
        }
        while (
          retained.images.size &&
          (retained.images.size >= IMAGE_CACHE_COUNT || retained.bytes + bytes > IMAGE_CACHE_BYTES)
        ) {
          const [oldest, image] = retained.images.entries().next().value!
          retained.bytes -= image.src.length * 2
          retained.images.delete(oldest)
        }
        retained.images.set(id, { checksum: capture.checksum, sizeBytes: capture.sizeBytes, src })
        retained.bytes += bytes
      }
      return src
    },
    [client, active]
  )
  return { captures: result?.client === client ? result.captures : [], readImage }
}
