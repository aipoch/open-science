import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { researchFilmResources } from './resources.js'
import { filmVisualCheckSchema } from './visual-review.js'

it('checks canvas content independently of its panel and requires a visible end card', async () => {
  const visible = { checkVisibility: () => true, getBoundingClientRect: () => ({ width: 200 }) }
  const signature = vi.fn(() => ({ ink: 0 }))
  const frames = vi.fn()
  const animation = {
    scene: 'result',
    id: 'result:anims/result.js',
    box: visible,
    signature,
    diag: {
      errors: [] as string[],
      textHits: [] as { key: string; t: number }[],
      outside: [],
      cardSpill: []
    }
  }
  const player = {
    DATA: {
      timeline: {
        scenes: [
          { id: 'result', start: 0, dur: 6, panels: [{ type: 'animation', t_in: 0 }] },
          { id: 'outro', start: 6, dur: 5, panels: [{ type: 'end_card', t_in: 0 }] }
        ]
      }
    },
    __anims: [animation],
    __seek: frames,
    __checkCaptions: () => [],
    __layout: () => ({
      missingMarks: [],
      W: 1920,
      H: 1080,
      boxes: [{ id: 'panel:result:0:animation', rect: [100, 100, 600, 400], overflow: [] }]
    }),
    __checkFilm: (): unknown => undefined
  }
  const cards = vi.fn<() => unknown[]>(() => [])
  runInNewContext(
    await readFile(join(researchFilmResources().stageDirectory, 'js/visual-check.js'), 'utf8'),
    {
      window: player,
      document: { querySelectorAll: cards },
      getComputedStyle: () => ({ opacity: '1' })
    }
  )
  const inspect = (): ReturnType<typeof filmVisualCheckSchema.parse> =>
    filmVisualCheckSchema.parse(player.__checkFilm())
  expect(inspect().issues.map((i) => [i.scene, i.renderFailure, i.message])).toEqual([
    ['result', true, expect.stringContaining('draws nothing')],
    ['outro', undefined, expect.stringContaining('end card')]
  ])
  expect(frames.mock.calls.length).toBeGreaterThan(15)
  cards.mockReturnValue([
    { ...visible, querySelector: () => ({ ...visible, tagName: 'IMG', naturalWidth: 200 }) }
  ])
  signature.mockReturnValue({ ink: 40 })
  animation.diag.textHits.push({ key: 'FINISH / Intermediate visits', t: 1.25 })
  expect(inspect().issues).toEqual([
    {
      scene: 'result',
      script: 'anims/result.js',
      textLayout: true,
      message: expect.stringContaining('FINISH / Intermediate visits')
    }
  ])
  animation.diag.textHits.length = 0
  expect(inspect().issues).toEqual([])
  animation.diag.errors.push('Cannot read drawing coordinates')
  expect(inspect().issues).toEqual([
    expect.objectContaining({
      renderFailure: true,
      script: 'anims/result.js',
      message: expect.stringContaining('Cannot read drawing coordinates')
    })
  ])
})
