import { researchFilmResources } from './resources.js'
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { videoIllustrationSchema } from './illustration.js'
import { parseResearchVideoScreenplay } from './screenplay.js'
import { buildVideoTimeline } from './timeline.js'

const illustration = {
  type: 'illustration',
  description: 'A cloud and falling rain',
  elements: [
    { kind: 'ellipse', x: 500, y: 80, rx: 100, ry: 40, fill: 'sky', motion: 'float' },
    { kind: 'line', x: 500, y: 130, x2: 490, y2: 150, motion: 'fall', at: '0:rain' }
  ]
}
const screenplay = {
  title: 'Rain',
  scenes: [
    {
      msg: 0,
      lines: [{ caption: 'Observe the rain carefully.' }],
      panels: [{ type: 'title', text: 'Rain' }, illustration]
    }
  ]
}
describe('declarative research illustration', () => {
  it('admits subject artwork and resolves its cue against measured narration', () => {
    const spec = parseResearchVideoScreenplay(JSON.stringify(screenplay), 1)
    const timeline = buildVideoTimeline(spec, {
      'scene-1_0': {
        duration: 4,
        words: [
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 4]
        ]
      }
    })
    expect(timeline.scenes[0].panels[1].elements?.[1].t_in).toBe(2.3)
  })
  it('accepts long logical narration lines and timing on either comparison side', () => {
    const caption = Array(5).fill('Observe the rain carefully and measure its intensity.').join(' ')
    const spec = parseResearchVideoScreenplay(
      JSON.stringify({
        ...screenplay,
        scenes: [
          screenplay.scenes[0],
          {
            msg: 0,
            lines: [{ caption }, { caption: 'Compare the observations.' }],
            panels: [
              {
                type: 'compare',
                left: { title: 'Earlier', at: '1' },
                right: { title: 'Later', at: '0' }
              }
            ]
          }
        ]
      }),
      1
    )
    expect(spec.scenes[1].lines[0].caption).toBe(caption)
    const scene = buildVideoTimeline(spec, {}, true).scenes[1]
    expect(scene.panels[0].left?.t_in).toBe(scene.lines[1].t0)
    expect(scene.panels[0].right?.t_in).toBeLessThan(Number(scene.panels[0].left?.t_in))
    expect(() =>
      parseResearchVideoScreenplay(
        JSON.stringify({
          ...screenplay,
          scenes: [
            { ...screenplay.scenes[0], lines: [{ caption: Array(181).fill('rain').join(' ') }] }
          ]
        }),
        1
      )
    ).toThrow('narration limit')
  })
  it('uses default timing for malformed optional cues without dropping the artwork', () => {
    const art = videoIllustrationSchema.parse({
      ...illustration,
      at: 'start of the scene',
      until: 4,
      elements: [{ ...illustration.elements[0], at: '0:falling rain' }]
    })
    expect(art.at).toBeUndefined()
    expect(art.until).toBeUndefined()
    expect(art.elements).toHaveLength(1)
    expect(art.elements[0].at).toBeUndefined()
    const timeline = buildVideoTimeline(
      { scenes: [{ id: 's', msg: 0, lines: [{ caption: 'Rain falls.' }], panels: [art] }] },
      {},
      true
    )
    expect(timeline.scenes[0].panels[0].elements?.[0].t_in).toBe(0)
  })
  it('requests correction when the automatic opening omits its subject illustration', () => {
    expect(() =>
      parseResearchVideoScreenplay(
        JSON.stringify({
          ...screenplay,
          scenes: [{ ...screenplay.scenes[0], panels: [{ type: 'title', text: 'Rain' }] }]
        }),
        1
      )
    ).toThrow('topic-specific illustration')
  })
  it('rejects executable markup, remote references, excessive geometry and unknown cues', () => {
    for (const element of [
      { kind: 'image', href: 'https://example.com/x.svg' },
      { kind: 'path', d: '<svg onload="alert(1)"/>' },
      { kind: 'path', d: 'M 9999999999 0 L 5 5' },
      { ...illustration.elements[0], onload: 'alert(1)' },
      { ...illustration.elements[0], fill: 'url(https://example.com)' },
      { ...illustration.elements[0], x: Infinity }
    ])
      expect(() =>
        videoIllustrationSchema.parse({ ...illustration, elements: [element] })
      ).toThrow()
    expect(() =>
      videoIllustrationSchema.parse({
        ...illustration,
        elements: Array(81).fill(illustration.elements[0])
      })
    ).toThrow()
    const spec = parseResearchVideoScreenplay(
      JSON.stringify({
        ...screenplay,
        scenes: [
          {
            ...screenplay.scenes[0],
            panels: [
              { type: 'title', text: 'Rain' },
              { ...illustration, at: '1' }
            ]
          }
        ]
      }),
      1
    )
    expect(() => buildVideoTimeline(spec, {}, true)).toThrow('missing line')
  })
  it('draws reproducibly after seeking backwards and honors reduced motion', () => {
    const reduced = { matches: false }
    const window = {
      A: {
        seg: (t: number, a: number, b: number) => Math.max(0, Math.min(1, (t - a) / (b - a))),
        ease: { out: (v: number) => v }
      },
      TOKENS: {
        color: {
          ink: '#111111',
          paper: '#ffffff',
          gold: '#edb732',
          good: '#147047',
          badgeBorder: '#d8d5cc'
        },
        videoExtensions: { sky: '#bfddf0' }
      },
      matchMedia: () => reduced,
      Panels: undefined as unknown as {
        make: (type: string, box: HTMLElement, p: unknown) => (time: number) => void
      }
    }
    runInNewContext(
      readFileSync(join(researchFilmResources().stageDirectory, 'js/panels.js'), 'utf8'),
      {
        window,
        document
      }
    )
    const box = document.createElement('div')
    const draw = window.Panels.make('illustration', box, {
      ...illustration,
      elements: illustration.elements.map((e) => ({ ...e, t_in: 0 }))
    })
    draw(1)
    const first = box.innerHTML
    draw(2)
    expect(box.innerHTML).not.toBe(first)
    draw(1)
    expect(box.innerHTML).toBe(first)
    reduced.matches = true
    draw(1)
    const still = box.innerHTML
    draw(2)
    expect(box.innerHTML).toBe(still)
    expect(box.querySelector('svg')?.getAttribute('aria-label')).toBe(illustration.description)
    const horizontal = videoIllustrationSchema.parse({
      ...illustration,
      elements: [{ kind: 'line', x: 100, y: 200, x2: 300 }]
    })
    const horizontalBox = document.createElement('div')
    window.Panels.make('illustration', horizontalBox, horizontal)
    expect(horizontalBox.querySelector('line')?.getAttribute('y1')).toBe('200')
    expect(horizontalBox.querySelector('line')?.getAttribute('y2')).toBe('200')
  })
})
