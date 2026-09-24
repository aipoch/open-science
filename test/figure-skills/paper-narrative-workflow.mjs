/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

// Execute the published examples, so the tested workflow is the one agents read.
const skill = readFileSync(
  new URL('../../resources/skills/paper-narrative/SKILL.md', import.meta.url),
  'utf8'
)
const examples = [...skill.matchAll(/```javascript\n([\s\S]*?)```/g)].map((match) => match[1])
const initialize = examples[2]
const plan = `(function () { ${examples[3]}; return compositionQueue })()`
const publish = examples[4]

function fixture() {
  const context = vm.createContext({
    brief: {
      figures: [
        { key: 'Fig1', claim: 'claim 1', composite_vid: 'figure-1' },
        { key: 'Fig2', claim: 'claim 2', composite_vid: 'figure-2' }
      ]
    },
    figureDataVersionIds: { Fig1: ['data-1'], Fig2: ['data-2'] },
    figureWidthMmByFigure: { Fig1: 180, Fig2: 180 },
    acceptedMissingPanelRecommendations: [],
    publishedMissingAnalysisVersionIdsByRecommendation: new Map(),
    acceptedKillActions: [],
    explicitlyReviewedRecomposeFigures: [],
    narrativeRound: 1,
    review: {
      arc: [
        { fig: 'Fig1', one_line: 'claim 1' },
        { fig: 'Fig2', one_line: 'claim 2' }
      ],
      figure_moves: [],
      missing_panels: [],
      kill_list: []
    }
  })
  vm.runInContext(initialize, context)
  return context
}

function queue(context) {
  return JSON.parse(JSON.stringify(vm.runInContext(plan, context)))
}

test('later redraw retains transferred and published analysis data', () => {
  const context = fixture()
  const analysis = { target_fig: 'Fig1', what_to_show: 'robustness' }
  context.acceptedMissingPanelRecommendations = [analysis]
  context.publishedMissingAnalysisVersionIdsByRecommendation.set(analysis, 'analysis-1')
  context.review.figure_moves = [{ from_fig: 'Fig2', to_fig: 'Fig1', what: 'evidence' }]
  const first = queue(context).find((entry) => entry.figure === 'Fig1')
  assert.deepEqual(first.dataVersionIds, ['data-1', 'data-2', 'analysis-1'])
  context.entry = first
  context.publishedComposite = { version_id: 'composite-revised' }
  vm.runInContext(publish, context)
  context.review.figure_moves = []
  context.acceptedMissingPanelRecommendations = []
  context.review.arc[0].one_line = 'revised claim'
  context.narrativeRound = 2
  assert.deepEqual(queue(context)[0].dataVersionIds, ['data-1', 'data-2', 'analysis-1'])
})

test('accepted kill action redraws unchanged claim and reaches composer', () => {
  const context = fixture()
  const action = {
    target_fig: 'Fig1',
    what: 'redundant panel',
    why: 'redundant',
    demote_to: 'supplement'
  }
  context.acceptedKillActions = [action]
  const result = queue(context)
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].killActions, [action])
  assert.equal(result[0].figure, 'Fig1')
})

test('unaccepted kill recommendations leave existing figures unchanged', () => {
  const context = fixture()
  context.review.kill_list = [{ what: 'Fig1 panel', demote_to: 'delete' }]
  assert.deepEqual(queue(context), [])
})

test('accepted action with unresolved target cannot silently disappear', () => {
  const context = fixture()
  context.acceptedKillActions = [{ target_fig: 'unknown', what: 'panel', demote_to: 'delete' }]
  assert.throws(() => queue(context), /accepted kill action needs an arc figure/)
})

test('unpublished accepted analysis blocks composition', () => {
  const context = fixture()
  context.acceptedMissingPanelRecommendations = [{ target_fig: 'Fig1', what_to_show: 'new result' }]
  assert.throws(() => queue(context), /has no published Version/)
})
