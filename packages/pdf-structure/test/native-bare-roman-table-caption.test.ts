import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

type CaptionFixture = {
  page: {
    pageNumber: number
    width: number
    height: number
    rotation: number
    invalidGraphicsBounds: number
    graphicsBounds: { kind: string; normalizedRect: number[] }[]
    lines: {
      text: string
      x: number
      y: number
      width: number
      height: number
      fontSize: number
    }[]
  }
  rules: number[][]
  tables: { rect: number[] }[]
}

const makePage = (): CaptionFixture => {
  const page = {
    pageNumber: 3,
    width: 612,
    height: 792,
    rotation: 0,
    invalidGraphicsBounds: 0,
    graphicsBounds: [] as { kind: string; normalizedRect: number[] }[],
    lines: [
      { text: 'TABLE I', x: 290.809, y: 56.4679, width: 30.382, height: 7.9701, fontSize: 7.9701 },
      {
        text: 'SUMMARY OF THE EVALUATION. “ERROR ATTRIBUTION” ASKS whether A TASK IDENTIFIES A FAILED STEP,',
        x: 53.861,
        y: 65.4349,
        width: 504.281,
        height: 7.9701,
        fontSize: 7.9701
      },
      {
        text: 'AND WHAT EVIDENCE SUPPORTS THAT DECISION. “INPUT-NECESSITY CHECK” ASKS WHETHER CASES CAN BE',
        x: 49.163,
        y: 74.4009,
        width: 513.684,
        height: 7.9701,
        fontSize: 7.9701
      },
      {
        text: 'ANSWERED WITHOUT THE INPUT, AND WHAT THE STUDY REPORTS.',
        x: 94.161,
        y: 83.3669,
        width: 423.674,
        height: 7.9701,
        fontSize: 7.9701
      },
      {
        text: 'TABLE II',
        x: 420.989,
        y: 241.7809,
        width: 33.036,
        height: 7.9701,
        fontSize: 7.9701
      },
      {
        text: 'COMPLETE INPUTS FOR THE TWO CONDITIONS. THE QUESTION AND ANSWER',
        x: 334.2,
        y: 250.7469,
        width: 206.6,
        height: 7.9701,
        fontSize: 7.9701
      },
      {
        text: 'OPTIONS ARE FIXED, AND THE TEXTUAL REPRESENTATION IS PROVIDED.',
        x: 340.1,
        y: 259.7129,
        width: 194.8,
        height: 7.9701,
        fontSize: 7.9701
      }
    ]
  }
  const rules = [
    [51.066, 103.324, 560.934, 103.324],
    [51.066, 118.642, 560.934, 118.642],
    [51.066, 193.586, 560.934, 193.586],
    [51.066, 218.866, 560.934, 218.866],
    [319.653, 287.608, 555.36, 287.608],
    [319.653, 302.9, 555.36, 302.9],
    [319.653, 333.2, 555.36, 333.2],
    [319.653, 348.156, 555.36, 348.156]
  ]
  const tables = [
    { rect: [49.7327, 103.324, 562.2673, 213.685] },
    { rect: [319.653, 287.608, 555.36, 348.156] }
  ]
  return { page, rules, tables }
}

const candidates = (page: object, rules: number[][]): ReturnType<typeof findCaptionCandidates> =>
  findCaptionCandidates([page], new Map([[3, rules]]))

it('groups a bare Roman table label with its ruled centered caption body without stealing the next caption', () => {
  const { page, rules, tables } = makePage()
  const found = candidates(page, rules)
  const first = found.find((candidate: { lines: string[] }) => candidate.lines[0] === 'TABLE I')
  const second = found.find((candidate: { lines: string[] }) => candidate.lines[0] === 'TABLE II')

  expect(first?.lines).toEqual([
    'TABLE I',
    'SUMMARY OF THE EVALUATION. “ERROR ATTRIBUTION” ASKS whether A TASK IDENTIFIES A FAILED STEP,',
    'AND WHAT EVIDENCE SUPPORTS THAT DECISION. “INPUT-NECESSITY CHECK” ASKS WHETHER CASES CAN BE',
    'ANSWERED WITHOUT THE INPUT, AND WHAT THE STUDY REPORTS.'
  ])
  expect(second?.lines).toHaveLength(3)
  const owners = associateTableCaptions(page, tables, found, rules, [page])
  expect(owners.map((owner: { caption?: { lines: string[] } }) => owner.caption?.lines[0])).toEqual(
    ['TABLE I', 'TABLE II']
  )
})

it('requires the full native closure proof before joining the bare label', () => {
  const variants = [
    (fixture: ReturnType<typeof makePage>) => {
      fixture.rules = fixture.rules.filter((rule) => rule[1] !== 103.324)
    },
    (fixture: ReturnType<typeof makePage>) => {
      fixture.page.lines[2].fontSize += 1
    },
    (fixture: ReturnType<typeof makePage>) => {
      fixture.page.lines[1].x += 5
    },
    (fixture: ReturnType<typeof makePage>) => {
      fixture.page.lines[2].y += 4
    },
    (fixture: ReturnType<typeof makePage>) => {
      fixture.rules.push([51.066, 104.2, 560.934, 104.2])
    },
    (fixture: ReturnType<typeof makePage>) => {
      fixture.page.graphicsBounds.push({ kind: 'image', normalizedRect: [0.2, 0.08, 0.8, 0.11] })
    },
    (fixture: ReturnType<typeof makePage>) => {
      fixture.page.lines[1].x = -1
      fixture.page.lines[1].width = 614
    },
    (fixture: ReturnType<typeof makePage>) => {
      fixture.page.lines[2].height = 0
    },
    (fixture: ReturnType<typeof makePage>) => {
      fixture.rules[0] = [-1, 103.324, 560.934, 103.324]
    },
    (fixture: ReturnType<typeof makePage>) => {
      fixture.rules[0] = [560.934, 103.324, 51.066, 103.324]
    }
  ]
  for (const mutate of variants) {
    const fixture = makePage()
    mutate(fixture)
    const first = candidates(fixture.page, fixture.rules).find(
      (candidate: { lines: string[] }) => candidate.lines[0] === 'TABLE I'
    )
    expect(first?.lines).toEqual(['TABLE I'])
  }
})
