/* eslint-disable @typescript-eslint/explicit-function-return-type */

// One job owns these sessions. Single-page detection outputs have already been
// copied and disposed before afterDetection permits structure to allocate.
export function createOnnxSessionLifecycle(create, singlePage) {
  const pending = new Map()
  const releasing = new Set()
  let closed = false,
    detectionFinished = false,
    closing
  const release = (name) => {
    const entry = pending.get(name)
    pending.delete(name)
    const work = (async () => {
      const session = await entry?.catch(() => undefined)
      await session?.release()
    })()
    releasing.add(work)
    void work.finally(() => releasing.delete(work)).catch(() => undefined)
    return work
  }
  return {
    async get(name) {
      if (
        closed ||
        !['detection', 'structure'].includes(name) ||
        (singlePage && name === 'detection' && detectionFinished) ||
        (singlePage && name === 'structure' && !detectionFinished)
      )
        throw Error('Invalid ONNX session lifecycle')
      if (!pending.has(name)) {
        const entry = (async () => {
          const session = await create(name)
          if (closed) {
            await session.release()
            throw Error('ONNX session owner closed')
          }
          return session
        })()
        pending.set(name, entry)
        void entry.catch(() => {
          if (pending.get(name) === entry) pending.delete(name)
        })
      }
      return pending.get(name)
    },
    async afterDetection() {
      if (!singlePage) return
      await release('detection')
      detectionFinished = true
    },
    close() {
      if (closing) return closing
      closed = true
      const entries = [...pending.values()]
      pending.clear()
      closing = (async () => {
        const results = await Promise.allSettled([
          ...releasing,
          ...entries.map(async (entry) => {
            // A failed creation has no resource to release; its original caller
            // already receives that error. Close still releases every other session.
            const session = await entry.catch(() => undefined)
            await session?.release()
          })
        ])
        const failed = results.find((result) => result.status === 'rejected')
        if (failed) throw failed.reason
      })()
      return closing
    }
  }
}
