import { expect, it, vi } from 'vitest'
import { reviewFilmFrames } from './visual-review'

it('sends each HTML scene image once and routes feedback to its authored drawing', async () => {
  const frames = Array.from({ length: 5 }, (_, i) => ({ scene: 's' + i, time: i, jpeg: 'YQ==' }))
  const spec = {
    scenes: frames.map(({ scene }) => ({
      id: scene,
      msg: 0,
      lines: [],
      panels: [{ type: 'animation', script: 'anims/' + scene + '.js' }]
    }))
  }
  const infer = vi
    .fn()
    .mockResolvedValueOnce('{"issues":[]}')
    .mockResolvedValueOnce(
      '{"issues":[{"scene":"s4","area":"animation","message":"The axis labels overlap."}]}'
    )
  expect(await reviewFilmFrames(frames, spec, new AbortController().signal, infer)).toEqual([
    { scene: 's4', script: 'anims/s4.js', message: 'The axis labels overlap.' }
  ])
  expect(infer.mock.calls.map(([, images]) => images.length)).toEqual([4, 1])
  expect(infer.mock.calls[1][1]).toEqual([{ mimeType: 'image/jpeg', data: 'YQ==', byteLength: 1 }])
  await expect(
    reviewFilmFrames(
      frames,
      spec,
      new AbortController().signal,
      async () => '{"issues":[{"scene":"foreign","area":"layout","message":"Wrong film"}]}'
    )
  ).rejects.toThrow('unknown film scene')
})
