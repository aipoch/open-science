import { constants } from 'node:fs'
import { access, open, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { notebookOutputDirectory, notebookOutputRequestId } from './output-storage'
import { isRecord } from '../value-guards'

// Reads only captured textual results, never code, image bytes, credentials, or storage paths.
// The repository already enforces the authenticated Project/Session boundary before this projection.
export const notebookOutputPage = async (
  state: unknown,
  request: { outputRunId: string; outputOffset?: number; outputLimit?: number }
): Promise<unknown> => {
  const runs = isRecord(state) && Array.isArray(state.runs) ? state.runs : []
  const run = runs.find(
    (candidate) => isRecord(candidate) && candidate.runId === request.outputRunId
  )
  if (!isRecord(run)) throw new Error('Notebook run not found in the current Session.')
  if (run.status === 'running' || run.status === 'queued') {
    throw new Error('Notebook output is still changing. Wait for the run to finish before paging.')
  }
  if (isRecord(state) && typeof state.notebookSessionRoot === 'string') {
    const directory = notebookOutputDirectory(state.notebookSessionRoot)
    const file = join(directory, notebookOutputRequestId(request.outputRunId) + '.txt')
    try {
      const canonicalRoot = await realpath(dirname(directory))
      const canonicalDirectory = await realpath(directory)
      if (canonicalDirectory !== join(canonicalRoot, 'outputs'))
        throw new Error('Notebook output storage escaped its Session.')
      if (dirname(await realpath(file)) !== canonicalDirectory)
        throw new Error('Notebook output file escaped its Session.')
      const descriptor = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const info = await descriptor.stat()
        if (!info.isFile()) throw new Error('Notebook output is not a regular file.')
        const offset = request.outputOffset ?? 0
        if (offset > info.size)
          throw new Error('Notebook output offset is past the end of saved output.')
        const bytes = Buffer.alloc(Math.min(request.outputLimit ?? 3000, info.size - offset))
        const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, offset)
        let count = bytesRead
        // Never split a UTF-8 code point at a page boundary.
        while (count > 0 && offset + count < info.size) {
          const next = Buffer.alloc(1)
          await descriptor.read(next, 0, 1, offset + count)
          if ((next[0] & 0xc0) !== 0x80) break
          count--
        }
        if (count === 0 && bytesRead > 0)
          throw new Error('Output limit is too small for the next UTF-8 character; use at least 4.')
        const complete = await access(file.replace(/\.txt$/, '.complete')).then(
          () => true,
          () => false
        )
        const page = (): unknown => ({
          outputPage: {
            runId: request.outputRunId,
            offset,
            offsetUnit: 'utf8-bytes',
            totalBytes: info.size,
            text: bytes.subarray(0, count).toString('utf8'),
            ...(offset + count < info.size ? { nextOffset: offset + count } : {}),
            captureTruncated: !complete,
            note: complete
              ? 'Full textual output saved in the Session output file. Display preview was bounded.'
              : 'Execution did not confirm complete output capture; this file may be partial.'
          }
        })
        while (JSON.stringify(page()).length > 5000 && count > 0) {
          count = Math.floor(count * 0.75)
          while (count > 0 && (bytes[count] & 0xc0) === 0x80) count--
        }
        return page()
      } finally {
        await descriptor.close()
      }
    } catch (error) {
      if (!(isRecord(error) && error.code === 'ENOENT')) throw error
      // Historical runs have no full-output sidecar; their existing preview remains readable.
    }
  }
  const text = isRecord(run.text) ? run.text : {}
  const parts = ['stdout', 'stderr', 'traceback'].flatMap((key) =>
    typeof text[key] === 'string' ? [`[${key}]\n${text[key]}`] : []
  )
  if (Array.isArray(text.plain))
    parts.push(...text.plain.filter((part): part is string => typeof part === 'string'))
  const content = parts.join('\n')
  const offset = request.outputOffset ?? 0
  if (offset > content.length)
    throw new Error('Notebook output offset is past the end of the captured text.')
  let count = Math.min(request.outputLimit ?? 3000, content.length - offset)
  const page = (): unknown => ({
    outputPage: {
      runId: request.outputRunId,
      offset,
      totalChars: content.length,
      text: content.slice(offset, offset + count),
      ...(offset + count < content.length ? { nextOffset: offset + count } : {}),
      captureTruncated: run.truncated === true,
      note: 'Text saved in run.json. Capture is limited to 2 MiB; text discarded during capture cannot be recovered. Images are not included.'
    }
  })
  // Budget the serialized response, including escaped characters and metadata, not each field.
  while (JSON.stringify(page()).length > 5000 && count > 0) count = Math.floor(count * 0.75)
  return page()
}
