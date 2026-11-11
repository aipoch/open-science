import { describe, expect, it } from 'vitest'
import { buildVideoTimeline, resolveVideoCue, type VideoSpec } from './timeline.js'
const spec: VideoSpec = {
  scenes: [
    {
      id: 'claim',
      msg: 0,
      lines: [{ caption: 'Heat needs 4.687 square metres.' }],
      panels: [{ type: 'stats', items: [{ value: '4.687', label: 'area', at: '0:4.687' }] }]
    }
  ]
}
const voices = {
  claim_0: {
    duration: 3,
    words: [
      [0, 0.4],
      [0.4, 0.8],
      [0.8, 1.6],
      [1.6, 2.3],
      [2.3, 3]
    ] as Array<[number, number]>
  }
}
describe('research video timeline', () => {
  it('supplies a finite background veil when authoring omits it and preserves explicit levels', () => {
    expect(buildVideoTimeline(spec, voices).scenes[0].veil).toBe(0.6)
    for (const veil of [0, 0.8, 1])
      expect(
        buildVideoTimeline({ scenes: [{ ...spec.scenes[0], veil }] }, voices).scenes[0].veil
      ).toBe(veil)
    for (const veil of [-1, 2, NaN, Infinity, '0.6'])
      expect(() => buildVideoTimeline({ scenes: [{ ...spec.scenes[0], veil }] }, voices)).toThrow(
        'Scene veil'
      )
  })
  it('pins quantitative reveals to the corresponding spoken caption word', () => {
    const result = buildVideoTimeline(spec, voices)
    expect(result.duration).toBe(5.3)
    expect(result.frames).toBe(159)
    expect(result.scenes[0].panels[0].items?.[0].t_in).toBe(1.1)
    expect(resolveVideoCue('0.end+0.2', result.scenes[0])).toBeCloseTo(3.5)
    expect(result.captions['16x9'][0].words[2]).toEqual(['4.687', 1.1, 1.9])
  })
  it('requires voice for production and makes estimation opt-in', () => {
    expect(() => buildVideoTimeline(spec, {})).toThrow('Missing narration')
    expect(buildVideoTimeline(spec, {}, true).scenes[0].lines[0].voiced).toBe(false)
  })
  it('rejects unknown cues and invalid measured alignment', () => {
    const result = buildVideoTimeline(spec, voices)
    expect(() => resolveVideoCue('0:3.191', result.scenes[0])).toThrow('not found')
    expect(() => resolveVideoCue('end.end', result.scenes[0])).toThrow('Invalid end')
    expect(() => buildVideoTimeline(spec, { claim_0: { duration: 3, words: [[0, 3]] } })).toThrow(
      'word count'
    )
    expect(() =>
      buildVideoTimeline(spec, { claim_0: { ...voices.claim_0, duration: NaN } })
    ).toThrow('duration')
  })
  it('does not mutate sources and rejects duplicate identities', () => {
    const before = structuredClone(spec)
    buildVideoTimeline(spec, voices)
    expect(spec).toEqual(before)
    expect(() => buildVideoTimeline({ scenes: [...spec.scenes, ...spec.scenes] }, voices)).toThrow(
      'duplicate'
    )
  })
})
