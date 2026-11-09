/** A host-observed truncation; partial model output must never be accepted as a complete file. */
export class ResearchFilmOutputLimitError extends Error {}

export type ResearchFilmCorrection = { draft: string; error: string }

/** Transport failures are terminal. Truncation and validation share one replacement attempt. */
export async function writeWithResearchFilmCorrection<T>(
  write: (correction?: ResearchFilmCorrection) => Promise<string>,
  validate: (output: string) => T | Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let correction: ResearchFilmCorrection | undefined
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    let output: string | undefined
    try {
      output = await write(correction)
      signal.throwIfAborted()
      return await validate(output)
    } catch (error) {
      signal.throwIfAborted()
      const truncated = error instanceof ResearchFilmOutputLimitError
      if (attempt > 0 || (output === undefined && !truncated)) throw error
      correction = {
        draft: truncated ? '' : output!,
        error: truncated
          ? 'The previous response exceeded the output limit. Return a substantially shorter, complete replacement. Simplify presentation and code, preserve evidence and qualifications, and omit commentary. Do not continue the partial response.'
          : error instanceof Error
            ? error.message
            : String(error)
      }
    }
  }
}
