/** A host-observed truncation; partial model output must never be accepted as a complete file. */
export class ResearchFilmIncompleteError extends Error {}
export class ResearchFilmOutputLimitError extends ResearchFilmIncompleteError {}

export type FilmAuthoringCheckpoint = {
  read(key: string): Promise<string | undefined>
  save(key: string, value: string): Promise<void>
}

export type ResearchFilmCorrection = { draft: string; error: string }

/** Transport failures are terminal. Truncation and validation share one replacement attempt. */
export async function writeWithResearchFilmCorrection<T>(
  write: (correction?: ResearchFilmCorrection) => Promise<string>,
  validate: (output: string) => T | Promise<T>,
  signal: AbortSignal,
  checkpoint?: FilmAuthoringCheckpoint,
  key = 'screenplay'
): Promise<T> {
  const saved = await checkpoint?.read(key)
  if (saved !== undefined) {
    try {
      return await validate(saved)
    } catch {
      signal.throwIfAborted()
    }
  }
  let correction: ResearchFilmCorrection | undefined
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    let parsed: T
    let output: string | undefined
    try {
      output = await write(correction)
      signal.throwIfAborted()
      parsed = await validate(output)
    } catch (error) {
      signal.throwIfAborted()
      const incomplete = error instanceof ResearchFilmIncompleteError
      if (attempt > 0 || (output === undefined && !incomplete)) throw error
      correction = {
        draft: incomplete ? '' : output!,
        error: incomplete
          ? 'The previous response was incomplete. Return a substantially shorter, complete replacement. Simplify presentation and code, preserve evidence and qualifications, and omit commentary. Do not continue the partial response.'
          : error instanceof Error
            ? error.message
            : String(error)
      }
      continue
    }
    await checkpoint?.save(key, output!)
    return parsed
  }
}
