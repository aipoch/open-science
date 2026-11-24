// A replacement draft was unavailable. An already checked playable draft can still be used.
export class ResearchFilmDraftError extends Error {}

/** A host-observed truncation; partial model output must never be accepted as a complete file. */
export class ResearchFilmIncompleteError extends ResearchFilmDraftError {}
export class ResearchFilmOutputLimitError extends ResearchFilmIncompleteError {}

export class ResearchFilmReviewFailure extends Error {
  constructor(
    readonly stage: 'script' | 'visual' | 'replay',
    readonly findings: string[],
    message: string
  ) {
    super(message)
  }
}

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
  key = 'screenplay',
  feedback?: string,
  review?: {
    guidance?: string
    previousDraft?: () => Promise<string | undefined>
    invalidOutput?: (error: unknown) => Error
  }
): Promise<T> {
  const saved = await checkpoint?.read(key)
  if (saved !== undefined && !feedback) {
    try {
      return await validate(saved)
    } catch {
      signal.throwIfAborted()
    }
  }
  const guidance = [feedback, review?.guidance].filter(Boolean).join('\n\n')
  let correction: ResearchFilmCorrection | undefined = guidance
    ? { draft: saved ?? (await review?.previousDraft?.()) ?? '', error: guidance }
    : undefined
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
      if (attempt > 0 && output !== undefined && !incomplete) {
        const failure = review?.invalidOutput?.(error) ?? error
        if (feedback)
          throw new ResearchFilmDraftError(
            failure instanceof Error ? failure.message : String(failure),
            { cause: failure }
          )
        throw failure
      }
      if (attempt > 0 || (output === undefined && !incomplete)) throw error
      correction = {
        draft: incomplete ? '' : output!,
        error: incomplete
          ? 'The previous response was incomplete. Return a complete replacement. Simplify presentation and code where possible, preserve evidence and qualifications, and omit commentary. Do not continue the partial response.'
          : error instanceof Error
            ? error.message
            : String(error)
      }
      if (guidance) correction.error += `\nAdditional guidance: ${guidance}`
      continue
    }
    await checkpoint?.save(key, output!)
    return parsed
  }
}
