import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { z } from 'zod'
import {
  RESEARCH_FILM_BUSY_MESSAGE,
  researchFilmModeSchema,
  researchFilmRevisionSchema,
  researchVideoFilename,
  researchVideoPresentationRequestSchema,
  type ResearchVideoPresentation,
  type ResearchVideoPresentationStatus
} from '../../shared/research-video-presentation'
import type { createResearchVideoPresentationOwner } from '../research-video/presentation'
import { TaskApiError } from './task-api'

const scopeSchema = researchVideoPresentationRequestSchema.extend({ mode: researchFilmModeSchema })
const generationScopeSchema = scopeSchema.extend({
  narrationReview: z.literal('advisory').optional()
})
const startSchema = generationScopeSchema.extend({
  installNarration: z.boolean().optional(),
  resume: z.boolean().optional()
})
const revisionSchema = generationScopeSchema.extend(researchFilmRevisionSchema.shape)
const playerSchema = scopeSchema.extend({ filmId: z.string().uuid() })

export type TaskResearchFilmPort = Pick<
  ReturnType<typeof createResearchVideoPresentationOwner>,
  'start' | 'status' | 'cancel'
>

type PublicResearchFilmStatus = Omit<ResearchVideoPresentationStatus, 'result'> & {
  result?: Omit<ResearchVideoPresentation, 'playerPath' | 'sourcePath'>
}

type FilmStatusAction = (request: unknown) => Promise<PublicResearchFilmStatus>
type OpenFilmPlayer = { handle: FileHandle; size: number; filename: string }

export type TaskResearchFilmApi = {
  start: FilmStatusAction
  status: FilmStatusAction
  revise: FilmStatusAction
  cancel: FilmStatusAction
  openPlayer(request: unknown): Promise<OpenFilmPlayer>
}

function parseRequest<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const field = result.error.issues[0]?.path.join('.')
    throw new TaskApiError(
      'invalid_request',
      field ? `Invalid Research Film request field: ${field}.` : 'Invalid Research Film request.'
    )
  }
  return result.data
}

function assertNarrationReviewMode(request: z.infer<typeof generationScopeSchema>): void {
  if (request.narrationReview && request.mode !== 'research-explanation') {
    throw new TaskApiError(
      'invalid_request',
      'Advisory narration review applies only to Research explanation.'
    )
  }
}

function publicStatus(status: ResearchVideoPresentationStatus): PublicResearchFilmStatus {
  if (status.generationBlock === 'unavailable') {
    throw new TaskApiError(
      'session_not_found',
      'The Research Film Session or branch is unavailable.'
    )
  }
  const { result, ...rest } = status
  const state = status.reviewFailure ? { ...rest, canResume: false } : rest
  if (!result) return state
  const { id, title, duration, scriptScore, sessionAppMode, narrationReview } = result
  return { ...state, result: { id, title, duration, scriptScore, sessionAppMode, narrationReview } }
}

async function runFilmOperation(
  operation: () => Promise<ResearchVideoPresentationStatus>
): Promise<PublicResearchFilmStatus> {
  try {
    return publicStatus(await operation())
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'film_review_conflict') {
      throw new TaskApiError('film_review_conflict', error.message)
    }
    if (error instanceof Error && error.message === RESEARCH_FILM_BUSY_MESSAGE) {
      throw new TaskApiError('film_busy', error.message)
    }
    throw error
  }
}

export function createTaskResearchFilmApi(owner: TaskResearchFilmPort): TaskResearchFilmApi {
  return {
    start(raw: unknown) {
      const request = parseRequest(startSchema, raw)
      assertNarrationReviewMode(request)
      return runFilmOperation(() => owner.start({ ...request, headless: true }))
    },
    status(raw: unknown) {
      const request = parseRequest(scopeSchema, raw)
      return runFilmOperation(() => owner.status(request))
    },
    revise(raw: unknown) {
      const { attemptId, feedback, ...request } = parseRequest(revisionSchema, raw)
      assertNarrationReviewMode(request)
      return runFilmOperation(() =>
        owner.start({ ...request, headless: true, revision: { attemptId, feedback } })
      )
    },
    async cancel(raw: unknown) {
      let request = parseRequest(scopeSchema, raw)
      if (!request.branchId) {
        const current = publicStatus(await owner.status(request))
        request = { ...request, branchId: current.branchId }
      }
      owner.cancel(request)
      return runFilmOperation(() => owner.status(request))
    },
    async openPlayer(raw: unknown) {
      const { filmId, ...request } = parseRequest(playerSchema, raw)
      const status = await owner.status(request)
      if (status.generationBlock === 'unavailable' || status.result?.id !== filmId) {
        throw new TaskApiError(
          'film_not_found',
          'The requested Research Film player is unavailable.'
        )
      }
      const handle = await open(
        status.result.playerPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ELOOP') {
          throw new TaskApiError(
            'film_not_found',
            'The requested Research Film player is unavailable.'
          )
        }
        throw error
      })
      try {
        const info = await handle.stat()
        if (!info.isFile() || !info.size) {
          throw new TaskApiError(
            'film_not_found',
            'The requested Research Film player is unavailable.'
          )
        }
        return {
          handle,
          size: info.size,
          filename: researchVideoFilename(status.result.title, 'html')
        }
      } catch (error) {
        await handle.close()
        throw error
      }
    }
  }
}
