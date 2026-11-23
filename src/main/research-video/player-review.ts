import {
  assertResearchVideoPlayerSize,
  filmVisualCheckSchema,
  RESEARCH_VIDEO_PLAYER_SIZE_ERROR,
  type FilmVisualResult
} from '@aipoch/research-film/contracts'

export const filmPlayerCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"

export type FilmAspect = '16x9' | '9x16'
export type FilmStage = { duration: number; W: number; H: number }

export class FilmDraftVisualError extends Error {
  constructor(
    message: string,
    readonly scene?: string
  ) {
    super(message)
  }
}

export function filmStageSize(aspect: FilmAspect): { width: number; height: number } {
  return aspect === '9x16' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }
}

export function verifyFilmPlayerHtml(html: string): void {
  try {
    assertResearchVideoPlayerSize(Buffer.byteLength(html))
  } catch {
    throw new FilmDraftVisualError(RESEARCH_VIDEO_PLAYER_SIZE_ERROR)
  }
  if (!html.includes('<meta name="open-science-research-video" content="1">'))
    throw new FilmDraftVisualError('Not a supported research video player')
}

export function readFilmStage(metadata: unknown, aspect: FilmAspect): FilmStage {
  const { width, height } = filmStageSize(aspect)
  const stage = metadata as Partial<FilmStage> | null | undefined
  if (
    stage?.W !== width ||
    stage.H !== height ||
    typeof stage.duration !== 'number' ||
    !Number.isFinite(stage.duration) ||
    stage.duration <= 0 ||
    stage.duration > 3600
  )
    throw new FilmDraftVisualError('Invalid research video stage')
  return { W: width, H: height, duration: stage.duration }
}

export function readFilmObservations(
  observations: unknown,
  aspect: FilmAspect,
  stage: FilmStage
): ReturnType<typeof filmVisualCheckSchema.parse> {
  const parsed = filmVisualCheckSchema.safeParse(observations)
  if (!parsed.success)
    throw new FilmDraftVisualError('The player did not produce a valid layout review.')
  const { issues, frames } = parsed.data
  const invalidFrame = frames.find(({ time }) => time > stage.duration)
  if (invalidFrame)
    throw new FilmDraftVisualError(
      'Film review time lies outside the player duration.',
      invalidFrame.scene
    )
  return {
    issues: issues.map((issue) => ({
      ...issue,
      message: `${aspect}: ${issue.message}`.slice(0, 500)
    })),
    frames
  }
}

export async function inspectFilmPlayer({
  aspect,
  stage,
  includeFrames,
  check,
  capture
}: {
  aspect: FilmAspect
  stage: FilmStage
  includeFrames: boolean
  check(): Promise<unknown>
  capture(time: number): Promise<string>
}): Promise<FilmVisualResult> {
  const result = readFilmObservations(await check(), aspect, stage)
  const frames: FilmVisualResult['frames'] = []
  if (aspect === '16x9' && includeFrames && !result.issues.length) {
    for (const { scene, time } of result.frames) {
      const jpeg = await capture(time)
      if (!jpeg) throw new Error('The HTML review frame was empty.')
      frames.push({ scene, time, jpeg })
    }
  }
  return { issues: result.issues, frames }
}
