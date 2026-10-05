/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { isNativeFrontMatterRegion } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-front-matter.mjs')).href
)

const token = (text: string, x: number, y: number, width = 80) => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true
})
const table = (grid: string[][] = []) => ({ cropRect: [0, 0, 600, 500], grid })

it('rejects an uncaptioned first-page author and affiliation band', () => {
  const items = [
    token('Ada Lovelace', 20, 20),
    token('Grace Hopper', 220, 20),
    token('Alan Turing', 420, 20),
    token('Example University', 20, 50, 120),
    token('Example Department', 220, 50, 130),
    token('Example Institute', 420, 50, 110),
    token('ada@example.test', 20, 80, 100),
    token('grace@example.test', 220, 80, 110),
    token('alan@example.test', 420, 80, 100)
  ]
  expect(isNativeFrontMatterRegion(table(), items, 1, undefined, [])).toBe(true)
})

it('rejects an author/contact band that continues into an abstract prose block', () => {
  const items = [
    token('Ada Lovelace', 20, 20),
    token('Example University', 20, 50, 120),
    token('ada@example.test', 20, 80, 100),
    token('Abstract', 200, 110),
    token(
      'We study a method whose behavior is stable under perturbations and report consistent improvements across several evaluation settings.',
      20,
      140,
      550
    )
  ]
  expect(isNativeFrontMatterRegion(table(), items, 1, undefined, [])).toBe(true)
})

it('rejects compact author and affiliation metadata with an abstract when emails are absent', () => {
  const items = [
    token('Ada Lovelace1,2', 20, 20, 130),
    token('Grace Hopper2', 220, 20, 110),
    token('Department of Computing, Example University', 20, 50, 260),
    token('Example Institute', 20, 70, 130),
    token('Abstract', 20, 110),
    token(
      'We present a compact method for recovering structure from scientific documents and evaluate it across several public benchmarks.',
      20,
      140,
      550
    )
  ]
  expect(isNativeFrontMatterRegion(table(), items, 1, undefined, [])).toBe(true)
})

it('rejects a compact first-page author-list grid without contacts', () => {
  const authorGrid = table([
    ['Zhengming Yu1,2, Junkun Yuan2', 'Haotian Yang2, Gordon Qian2'],
    ['Yizhi Wang2, Angtian Wang2', 'Yiding Yang2, Bo Liu2, Xin Li1']
  ])
  const items = [
    token('Zhengming Yu1,2, Junkun Yuan2', 20, 20, 180),
    token('Haotian Yang2, Gordon Qian2', 220, 20, 180),
    token('Yizhi Wang2, Angtian Wang2', 20, 40, 180),
    token('Yiding Yang2, Bo Liu2, Xin Li1', 220, 40, 180)
  ]
  expect(isNativeFrontMatterRegion(authorGrid, items, 1, undefined, [])).toBe(true)
})

it('rejects author and institution pairs emitted as one source token', () => {
  const items = [
    token('Ada Lovelace Example University', 20, 20, 180),
    token('Grace Hopper Columbia College', 220, 20, 180),
    token('Alan Turing UChicago', 420, 20, 150),
    token('Katherine Johnson UC Berkeley', 20, 50, 180),
    token('A', 260, 80),
    token('BSTRACT', 275, 80)
  ]
  expect(isNativeFrontMatterRegion(table(), items, 1, undefined, [])).toBe(true)
})

it('rejects a multi-row roster grid with merged Unicode contribution markers and institutions', () => {
  const roster = table([
    ['Barret Zoph∗ Google Brain', 'Irwan Bello∗† Google Brain', ''],
    ['Sameer Kumar Google', 'Nan Du Google Brain', 'Yanping Huang Google Brain'],
    ['Jeff Dean Google Research', 'Noam Shazeer† Google Brain', 'William Fedus‡ Google Brain']
  ])
  const items = [
    token('Barret Zoph∗ Google Brain', 20, 20, 180),
    token('Irwan Bello∗† Google Brain', 220, 20, 180),
    token('Sameer Kumar Google', 20, 45, 160),
    token('Nan Du Google Brain', 220, 45, 160),
    token('Yanping Huang Google Brain', 420, 45, 170),
    token('Jeff Dean Google Research', 20, 70, 180),
    token('Noam Shazeer† Google Brain', 220, 70, 180),
    token('William Fedus‡ Google Brain', 420, 70, 180),
    token('A', 260, 110),
    token('BSTRACT', 275, 110),
    token(
      'We study a sparse model and evaluate transfer performance across several language tasks.',
      20,
      140,
      550
    )
  ]
  expect(isNativeFrontMatterRegion(roster, items, 1, undefined, [])).toBe(true)
})

it('rejects a multi-row author grid with affiliations emitted on separate lines', () => {
  const roster = table([
    ['Ada Lovelace∗', 'Grace Hopper†'],
    ['Alan Turing‡', 'Katherine Johnson'],
    ['Noam Shazeer', 'William Fedus∗']
  ])
  const items = [
    token('Ada Lovelace∗', 20, 20),
    token('Grace Hopper†', 220, 20),
    token('Alan Turing‡', 20, 45),
    token('Katherine Johnson', 220, 45),
    token('Noam Shazeer', 20, 70),
    token('William Fedus∗', 220, 70),
    token('Google Brain', 20, 92, 100),
    token('Google Research', 220, 92, 120),
    token('Google Brain', 20, 110, 100),
    token('Google Brain', 220, 110, 100),
    token('Abstract', 260, 140),
    token(
      'We report stable results across multiple evaluation settings and describe the training procedure.',
      20,
      165,
      550
    )
  ]
  expect(isNativeFrontMatterRegion(roster, items, 1, undefined, [])).toBe(true)
})

it('rejects a tall author roster grid with one shared institution and abstract heading', () => {
  const roster = table([
    ['Ada Lovelace∗', 'Grace Hopper∗', 'Alan Turing∗', 'Katherine Johnson∗', ''],
    ['Dorothy Vaughan', 'Mary Jackson', 'Evelyn Boyd', 'Annie Easley', ''],
    ['Barbara Liskov', 'Radia Perlman', 'Margaret Hamilton', 'Frances Allen', ''],
    ['Donald Knuth', 'Edsger Dijkstra', 'Claude Shannon', 'John McCarthy', ''],
    ['Linus Torvalds', 'Guido van Rossum', 'James Gosling', 'Bjarne Stroustrup', ''],
    ['Grace Murray Hopper', 'Tim Berners-Lee', 'Dennis Ritchie', 'Ken Thompson', ''],
    ['', '', '', 'OpenAI', ''],
    ['', '', '', 'Abstract', '']
  ])
  const items = [
    token('Ada Lovelace∗', 20, 20),
    token('Grace Hopper∗', 120, 20),
    token('Alan Turing∗', 220, 20),
    token('Katherine Johnson∗', 320, 20),
    token('OpenAI', 320, 170),
    token('Abstract', 320, 190),
    token('We describe the model and report results across multiple language tasks.', 20, 220, 550)
  ]
  expect(isNativeFrontMatterRegion(roster, items, 1, undefined, [])).toBe(true)
})

it('rejects a compact author band with separately emitted affiliations', () => {
  const items = [
    token('Ada Lovelace', 20, 20),
    token('Example University', 20, 35, 140),
    token('Grace Hopper', 220, 20),
    token('Columbia College', 220, 35, 140),
    token('Alan Turing', 420, 20),
    token('UChicago', 420, 35),
    token('Katherine Johnson', 20, 65, 120),
    token('UC Berkeley', 20, 80, 100)
  ]
  expect(isNativeFrontMatterRegion(table(), items, 1, undefined, [])).toBe(true)
})

it('keeps captioned or source-proved numeric tables eligible', () => {
  const items = [
    token('Example University', 20, 20, 120),
    token('Example Department', 20, 50, 130),
    token('contact@example.test', 20, 80, 120),
    token('12', 220, 110, 15),
    token('34.5', 320, 110, 30),
    token('18', 220, 130, 15),
    token('29.1', 320, 130, 30)
  ]
  const numericTable = table([
    ['Institution', 'n', 'Mean'],
    ['Example University', '12', '34.5'],
    ['Example Department', '18', '29.1']
  ])
  expect(isNativeFrontMatterRegion(numericTable, items, 1, undefined, [])).toBe(false)
  expect(isNativeFrontMatterRegion(table(), items, 1, { lines: ['Table 1. Results'] }, [])).toBe(
    false
  )
})

it('keeps model-numbered institution rows eligible as data tables', () => {
  const modelTable = table([
    ['Model 3 Results University', 'Model 4 Results University'],
    ['Model 5 Results University', 'Model 6 Results University']
  ])
  const items = [
    token('Model 3 Results University', 20, 20, 180),
    token('Model 4 Results University', 220, 20, 180),
    token('Model 5 Results University', 20, 45, 180),
    token('Model 6 Results University', 220, 45, 180)
  ]
  expect(isNativeFrontMatterRegion(modelTable, items, 1, undefined, [])).toBe(false)
})

it('keeps a closed native frame eligible and limits the gate to page one', () => {
  const items = [
    token('Ada Lovelace', 20, 20),
    token('Example University', 20, 50, 120),
    token('ada@example.test', 20, 80, 100),
    token('Grace Hopper', 220, 20),
    token('Example Institute', 220, 50, 110),
    token('grace@example.test', 220, 80, 110)
  ]
  const rules = [
    [0, 0, 600, 0],
    [0, 500, 600, 500],
    [0, 0, 0, 500],
    [600, 0, 600, 500]
  ]
  expect(isNativeFrontMatterRegion(table(), items, 1, undefined, rules)).toBe(false)
  expect(isNativeFrontMatterRegion(table(), items, 2, undefined, [])).toBe(false)
})
