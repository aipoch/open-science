import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { spawnSync } from 'node:child_process'
import { readPdfFixture } from './read-fixture'

type CaptionLine = {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}

const {
  captionKind,
  joinCaptionLines,
  groupPageLines,
  joinPdfSmallCapsLine,
  isNativeRowReference,
  findCaptionCandidates
} = await import(pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href)

it.each([
  ['Figure 1 showcases the fields at three different times.', undefined],
  ['Fig. 2 showcases the distributions for both samples.', undefined],
  ['Figure 1: Showcases of independent panels.', 'figure'],
  ['Figure 1 Showcases of independent panels.', 'figure'],
  ['Figure 1 Showcase of independent panels.', 'figure'],
  ['Figure 1 showcases of independent panels.', 'figure'],
  ['Figure 1 showcases used for demonstration.', 'figure']
])('distinguishes a finite showcase reference from a title: %s', (text, expected) => {
  expect(captionKind(text)).toBe(expected)
})

it.each([
  ['Figure 3 (for the upper panel). Since both paths are retained, the result follows.', undefined],
  [
    'Figure 3: (a) Independent paths. Since both paths are retained, the result is comparable.',
    'figure'
  ],
  ['Figure 3 (overview). Inference results for independent paths.', 'figure'],
  ['Figure 3 (for the upper panel. Since both paths are retained, the result follows.', 'figure']
])('keeps a complete parenthetical reference distinct from a caption: %s', (text, kind) => {
  expect(captionKind(text)).toBe(kind)
})

function coordinatedTableReferenceCaption(): {
  pageNumber: number
  width: number
  height: number
  invalidGraphicsBounds: number
  lines: CaptionLine[]
  graphicsBounds: { kind: string; normalizedRect: number[] }[]
} {
  const lines = [
    'Figure 2: Independent results for the measured groups in both panels.',
    'Each measurement uses the same source conditions and separate trials.',
    'The displayed bars compare the corresponding rows of',
    'Table 1 and Table 2. Each group is evaluated independently;',
    'controls remain unchanged.'
  ].map((text, i) => ({
    text,
    x: 50,
    y: 300 + i * 12,
    width: i === 4 ? 140 : 450,
    height: 10,
    fontSize: 10
  }))
  lines.push({
    text: 'An independent body paragraph starts after the caption.',
    x: 65,
    y: 390,
    width: 435,
    height: 10,
    fontSize: 10
  })
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines,
    graphicsBounds: [{ kind: 'image', normalizedRect: [50 / 600, 60 / 800, 500 / 600, 280 / 800] }]
  }
}

it('keeps a coordinated table reference inside its complete native figure caption', () => {
  const page = coordinatedTableReferenceCaption()
  const captions = findCaptionCandidates([page])
  expect(captions).toHaveLength(1)
  expect(captions[0].lines).toEqual(page.lines.slice(0, 5).map((l) => l.text))
  expect(captions[0].rect[3]).toBe(358)
})

const coordinatedReferenceRefusals: [
  string,
  (p: ReturnType<typeof coordinatedTableReferenceCaption>) => void
][] = [
  [
    'closed preceding sentence',
    (p) => {
      p.lines[2].text += '.'
    }
  ],
  [
    'different caption font',
    (p) => {
      p.lines[3].fontSize = 12
    }
  ],
  [
    'different column',
    (p) => {
      p.lines[3].x += 25
    }
  ],
  [
    'different leading',
    (p) => {
      p.lines[3].y += 4
    }
  ],
  [
    'unproved graphics',
    (p) => {
      p.invalidGraphicsBounds = 1
    }
  ],
  [
    'missing graphics inventory',
    (p) => {
      Object.defineProperty(p, 'graphicsBounds', { value: undefined })
    }
  ],
  [
    'no preceding plate',
    (p) => {
      p.graphicsBounds = []
    }
  ],
  [
    'duplicate native row',
    (p) => {
      p.lines.push({ ...p.lines[3] })
    }
  ],
  [
    'intervening paint',
    (p) => {
      p.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [50 / 600, 334 / 800, 500 / 600, 335 / 800]
      })
    }
  ],
  [
    'new table caption',
    (p) => {
      p.lines[3].text = 'Table 1: Independently measured values from the second experiment.'
    }
  ],
  [
    'unfinished final row',
    (p) => {
      p.lines[4].text = 'controls remain unchanged and'
    }
  ]
]
it.each(coordinatedReferenceRefusals)(
  'keeps an unproved table-reference caption separate: %s',
  (_label, mutate) => {
    const page = coordinatedTableReferenceCaption()
    mutate(page)
    const before = structuredClone(page)
    const figure = findCaptionCandidates([page]).find((c: { lines: string[] }) =>
      c.lines[0].startsWith('Figure 2:')
    )
    expect(figure.lines).not.toContain(page.lines[3].text)
    expect(page).toEqual(before)
  }
)

it.each([
  'Table 77-81 82.2 86.3',
  'Table 77 - S81 82.2 86.3',
  'Tab. A2–B4 10% (20/30)',
  'Figure 2 10.5, 20.3',
  'Fig. 2 +10:20%',
  'Table 82.9 82.2 86.3',
  'Table 1 -2 ',
  'Table 1 %\t%\t%\n'
])('rejects a numeric data continuation without a descriptive title: %s', (text) => {
  expect(captionKind(text)).toBeUndefined()
})

it.each([
  ['Table 77-81: Measured values.', 'table'],
  ['Table 82.9: Measured values.', 'table'],
  ['Table 2 10% improvement by condition.', 'table'],
  ['Figure 2: 10.5, 20.3', 'figure'],
  ['Figure 2 % agreement by condition.', 'figure']
])('retains a descriptive caption next to numeric row syntax: %s', (text, kind) => {
  expect(captionKind(text)).toBe(kind)
})

it.each(['table\t0\t', 'table\t0.0\t'])(
  'classifies long percent and numeric lists within a bounded child process: %s',
  (prefix) => {
    const moduleUrl = pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
    const source = `
      import assert from 'node:assert/strict';
      import { captionKind } from ${JSON.stringify(moduleUrl)};
      const prefix = ${JSON.stringify(prefix)};
      for (const values of ['%'.repeat(25000), '12.5%\t'.repeat(5000)]) {
        assert.equal(captionKind(prefix + values), undefined);
        assert.equal(captionKind(prefix + values + 'x'), 'table');
      }
    `
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      timeout: 4000,
      encoding: 'utf8',
      windowsHide: true
    })
    expect(run.error, run.stderr).toBeUndefined()
    expect(run.status, run.stderr).toBe(0)
  },
  10000
)

it('recognizes manuscript legend headings without treating past-tense references as captions', () => {
  expect(captionKind('Legend to Figure 1. Participant flow.')).toBe('figure')
  expect(captionKind('Legend to Fig. 2. Response over time.')).toBe('figure')
  expect(captionKind('Figure 4 illustrated the distribution of values.')).toBeUndefined()
  expect(captionKind('Figure 4 depicted the change over time.')).toBeUndefined()
  expect(captionKind('Figure 4 aggregates results separately within each suite.')).toBe('figure')
})

it('keeps noun-phrase figure titles distinct from finite-verb references', () => {
  expect(captionKind('Figure 1 Plot of the results.')).toBe('figure')
  expect(captionKind('Figure 1 plots the results.')).toBeUndefined()
})

it('keeps first-qualified references in prose while retaining caption titles', () => {
  for (const text of [
    'Figure 4 first shows the predicted trend.',
    'Table C.2 first lists the measured values.'
  ])
    expect(captionKind(text)).toBeUndefined()
  expect(captionKind('Figure 4. First shows and later comparisons.')).toBe('figure')
  expect(captionKind('Figure 4 First-order response.')).toBe('figure')
})

it.each([
  ['Figure 2 flips the comparison between groups.', undefined],
  ['Figure 3 clarifies in more detail the change between groups.', undefined],
  ['Figure 4 assesses the effect of the settings.', undefined],
  ['Figure C.2 assesses the effect of the settings.', undefined],
  ['Figure C.2: Assesses the effect of the settings.', 'figure'],
  ['Figure 4 Assessment of the settings.', 'figure'],
  ['Figure 2: Flips between measured states.', 'figure'],
  ['Figure 3. Clarifies the notation used below.', 'figure']
])('distinguishes finite references from punctuation-delimited captions: %s', (text, kind) => {
  expect(captionKind(text)).toBe(kind)
})

it.each([
  'Table 9 moves the evolved harnesses between two evaluation domains.',
  'Table 3 ablates the design choices of the decomposed term on the benchmark, replacing one component at a time.',
  'Table IV details the contribution of specific system components.',
  'Table 10 contrasts the raw count-deviation rate with the final protocol.',
  'Table 2 collects every attempt we made to explain the result away.',
  'Table 1. In each column of this and the following tables, the optimal value is bold.',
  'Table 2. For instance, the baseline achieves the strongest score.',
  'Table 13 scores attribution on constructed ground truth.',
  'Table 14 repeats the comparison from Table 1.',
  'Table 7 reproduces every task-level value supplied in the experiment record.',
  'Table 10 isolates restricted-pool controls.',
  'Table 11 expands the audit in Figure 4(a).',
  'Table 3 highlights the difficulty of AdsCVR: evaluated open-source single-pass models achieve average accuracy below the strongest baseline.',
  'Table 2. Equation (12) agrees with the Gram–Schmidt coefficient to round-off for three inner products at machine precision.',
  'Table 2. Unlike the script-switching mechanism in Llama-3.1-8B, this effect occurs on a multiple-choice benchmark.',
  'Table 9 consolidates the symbols defined throughout the derivation.',
  'Table 1 covers all three sizes and both targets.',
  'Table 18 buckets the tasks by sequential length.',
  'Table 16 combines the runtime summary with its measurement boundary.',
  'Table IV details the contribution of specific system components.',
  'Table 10 contrasts the raw count-deviation rate with the final protocol.',
  'Table 2 collects every attempt we made to explain the result away.'
])('rejects observed table prose references: %s', (text) => {
  expect(captionKind(text)).toBeUndefined()
})

it.each([
  'Table IV to our sign convention.',
  'Table 5. To check that they carry over, we repeat the Table 1 comparison on three benchmarks.',
  'Table 1. In each column of this and the following tables, the optimal value is highlighted.',
  'Table 2. For instance, the first model reaches the highest score on the held-out split.'
])('rejects table references with propositional sentence openings: %s', (text) => {
  expect(captionKind(text)).toBeUndefined()
})

it('rejects an abbreviated table reference in running prose', () => {
  expect(
    captionKind('Tab. 3 compares J &F and J &Fv with existing temporal metrics.')
  ).toBeUndefined()
})

it.each([
  'Table 10 (Appendix G) changes one design choice.',
  'Table 1 to the full seven-level sweep of completion levels.',
  'Table VII repeats the comparison for the fission-source case.',
  'Table VIII quantifies how much of the correlation structure lies off the diagonal.',
  'Table VIII (11.0%/3.0%). Di,j is the off-diagonal contribution.',
  'Table XIII repeats the covariance-structure diagnostics.',
  'Table 6 enumerates the two task families.',
  'Table 11 and 12 give the results for every test variant.',
  'Table 1 places that step in context with the remaining ablations.',
  'Table 3 outlines common GenAI use-cases and their evaluation settings.',
  'Table 6 changes one component at a time to isolate the effect.',
  'Table 1 records the tuned variants used in the final experiment.',
  'Table S6 generalizes the stop rule to the supplementary benchmark.',
  'Table 4 measures transfer to four standard evaluation settings.',
  'Table 3 reveals a much clearer effect at the probability level.',
  'table. First, on the community tasks the number of deciders per item is the label.',
  'Table 23. Spearman ρ=.12 over the eleven tasks, permutation p=.73.',
  'Table 35 reads the result inside each agency, with the articulated model refit.',
  'Table 2 sweeps m ∈ {3, 4, 5, 7, 10, 12} on both datasets.',
  'Table 7 groups the SGD examples by what the revised slot holds.',
  'Table 9 excludes these pairs from the saved segment-local predictions.',
  'Table 13 distinguishes explicit abstention from replies that match the superseded value.',
  'Table 2. Among these benchmarks, only PaMIR is credit-specific.',
  'Table 7. Below 300 labels the two baselines are close.',
  'Table D = (X, y)',
  'Table 8 denotes the number of shared trajectories.',
  'Table S1 details the default foundation models powering each module.',
  'Table 4 removes one component at a time.',
  'Table 1 use predicted types.',
  'Table 1 expresses a claim that is not reflected in current practice.',
  'Table 8 separates average performance from consistency.',
  'Table 11 explains how this spread develops.',
  'Table 6 tracks the dev progression: emission-level soft-vote lifts the baseline.',
  'Table 7 (Section 6.1) summarizes F1 for the three methods on both datasets;',
  'Table III collects the reformulations. Read as a checklist,',
  'Table II records the complete reward configuration.',
  'Table VII records the physics steps and drive interfaces.',
  'Table 5 trains one policy per task in the object-placement setting.',
  'Table 6 evaluates the same policies under full randomization.'
])('rejects next-batch table prose references: %s', (text) => {
  expect(captionKind(text)).toBeUndefined()
})

it('rejects figure references that open prose with an action verb', () => {
  for (const text of [
    'Figure 4 we plot the corresponding graphs for the Satellite dataset.',
    'Figure 6 ranks features according to their contribution.',
    'Figure 10 further compares the calibration strategies.',
    'Figure 5 restores the two-dimensional projection.',
    'Figure 3 traces FORESIGHT on one stream.',
    'Figure 3 stratifies the main result by domain.',
    'Figure 8 identifies the prior tasks receiving actor coefficient weight.',
    "Figure 1 over each panel's shared latency interval.",
    'Figure 2 over each panel’s shared latency interval.',
    'Figure 3 projects the same 4,000 trajectories.',
    'Figure 9 resolves the paired effects by disease.'
  ]) {
    expect(captionKind(text)).toBeUndefined()
  }
  expect(captionKind('Figure 4: Corresponding graphs for the Satellite dataset.')).toBe('figure')
})

it('keeps a likewise figure subject out of adjacent graphic ownership', () => {
  const reference = 'Figure 3 likewise displays the estimates for the selected groups.'
  expect(captionKind(reference)).toBeUndefined()
  expect(captionKind('Figure 3: Likewise displayed estimates for the selected groups.')).toBe(
    'figure'
  )
  expect(captionKind('Figure 3 Likewise calibrated estimates for the selected groups.')).toBe(
    'figure'
  )
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    graphicsBounds: [{ kind: 'image', normalizedRect: [0.12, 0.1, 0.88, 0.35] }],
    lines: [
      { text: 'Figure 2: Estimates for all groups.', x: 100, y: 300, width: 350 },
      { text: reference, x: 72, y: 350, width: 456 },
      { text: 'The selected groups are evaluated on a separate page.', x: 72, y: 364, width: 456 }
    ].map((line) => ({ ...line, height: 10, fontSize: 10 }))
  }
  expect(
    findCaptionCandidates([page]).map((candidate: { lines: string[] }) => candidate.lines)
  ).toEqual([['Figure 2: Estimates for all groups.']])
})

it('rejects next-batch figure prose actions and code-like index rows', () => {
  for (const text of [
    'Figure 2 draws the boundary of the selected region.',
    'Figure 3 places the labels beside each panel.',
    'Figure 4 dissects the response by cohort.',
    'Figure 5 magnifies the narrow transition band.',
    'Figure 6 puts the baseline below the reference.',
    'Figure 7 sitting on the lower margin is reused below.',
    'figure 1 and briefly describe the observed failure mode.',
    'fig2 remainder zoom.py'
  ]) {
    expect(captionKind(text), text).toBeUndefined()
  }
  expect(captionKind('Figure 2: Boundary of the selected region.')).toBe('figure')
})

it('rejects panel-qualified and paired figure references that open prose', () => {
  expect(captionKind('Fig. 1b. The results demonstrate exponential growth.')).toBeUndefined()
  expect(
    captionKind('figure 6 and figure 7. As shown by the black curves, the speed changes.')
  ).toBe(undefined)
  expect(
    captionKind('fig. 3 and suggests an efficient classical simulation strategy.')
  ).toBeUndefined()
})

it('keeps noun-style panel titles eligible while filtering finite-verb prose', () => {
  expect(captionKind('Figure 1a. The architecture of our model.')).toBe('figure')
  expect(captionKind('Fig. 2b. This pipeline has three steps.')).toBeUndefined()
  expect(captionKind('Figure 3c. These results show improvement.')).toBeUndefined()
  expect(captionKind('Figure 4d. Our method for image retrieval.')).toBe('figure')
  expect(captionKind('Figure 5e. Results on held-out data.')).toBe('figure')
})

it('keeps next-batch table titles eligible beside the prose guards', () => {
  expect(captionKind('Table 10: Ablations of the design choices.')).toBe('table')
  expect(captionKind('Table VII. Results for the fission-source case.')).toBe('table')
  expect(captionKind('TABLE III WE EVALUATE THE MODEL.')).toBe('table')
  expect(captionKind('Table D4. Utility threshold γ.')).toBe('table')
  expect(captionKind('Table D4: utility threshold.')).toBe('table')
  expect(captionKind('Table D4. To compare model performance across datasets.')).toBe('table')
  expect(
    captionKind(
      'Table S4 therefore reports biased-head transfer metrics directly, rather than a difference.'
    )
  ).toBeUndefined()
  expect(
    captionKind('Table S4. Therefore reports biased-head transfer metrics directly.')
  ).toBeUndefined()
  expect(captionKind('Table D4. In each row, scores increase.')).toBeUndefined()
  expect(captionKind('Table IV. Unlike the baseline, ours improves.')).toBeUndefined()
  expect(captionKind('Table S4: Retrieval results.')).toBe('table')
  expect(captionKind('Table S6. This is shown in the appendix.')).toBeUndefined()
  expect(captionKind('Table D4. This is shown in the appendix.')).toBeUndefined()
})

it.each(['4', 'S4', 'D4'])(
  'applies existing subject-reference guards before accepting table label %s',
  (ordinal) => {
    expect(captionKind(`Table ${ordinal}. ASTER exhibits a larger value.`)).toBeUndefined()
    expect(captionKind(`Tab. ${ordinal}. ASTER exhibits a larger value.`)).toBeUndefined()
    expect(captionKind(`Table ${ordinal}. Utility threshold γ.`)).toBe('table')
    expect(captionKind(`Table ${ordinal}: utility threshold.`)).toBe('table')
    expect(captionKind(`Table ${ordinal}. The table summarizes the results.`)).toBe('table')
    expect(captionKind(`Table ${ordinal}. To compare model performance across datasets.`)).toBe(
      'table'
    )
  }
)

it.each(['Supplementary', 'Supplemental'])(
  'filters existing figure-reference prose with the complete %s prefix',
  (prefix) => {
    for (const text of [
      `${prefix} Figure 4: we show the measured response.`,
      `${prefix} Fig. S4, we compare the measured response.`,
      `${prefix} Figure 4 we present the measured response.`,
      `${prefix} Figure 4 and 5 we compare the two settings.`,
      `${prefix} Fig. 3 and Appendix Tab. 7 we compare the two settings.`
    ])
      expect(captionKind(text)).toBeUndefined()
    expect(captionKind(`${prefix} Figure 4: Measurements across settings.`)).toBe('figure')
    expect(captionKind(`${prefix} Fig. S4. Our evaluation setup.`)).toBe('figure')
    expect(captionKind(`${prefix} Figure 4 and 5: Comparison across settings.`)).toBe('figure')
  }
)

it('keeps a noun title beginning with a similar word eligible', () => {
  expect(captionKind('Table 5. To-scale measurements across sessions.')).toBe('table')
  expect(captionKind('Table 6. Comparison with our baseline.')).toBe('table')
  expect(captionKind('Table 2. To compare model performance across datasets.')).toBe('table')
  expect(captionKind('Table 2 to 4. Benchmark results.')).toBe('table')
  expect(captionKind('Table IV. Elastic constants of diamond.')).toBe('table')
  expect(captionKind('Table 3: Accuracy (%) on the test split.')).toBe('table')
  expect(captionKind('Table 23: Spearman correlation.')).toBe('table')
})

it('recovers a standalone figure label with publisher spacing before punctuation', () => {
  expect(captionKind('Figure 2 .')).toBe('figure')
})

it('rejects a figure label that starts a running prose sentence', () => {
  expect(captionKind('Figure 3 for core-agg and ext-agg. We find that open')).toBeUndefined()
})

it('rejects case-insensitive sentence continuations after plain figure labels', () => {
  for (const text of [
    'Fig. 3. As shown in the figure, the treatment effect is stable.',
    'FIGURE 4. FOR each cohort, the measured response is reported.',
    'Figure 5. In our study, the baseline is unchanged.',
    'Figure 6 isolates the control cohort.',
    'Fig. 7 ISOLATES the held-out samples.',
    'Fig 7. GPT-1 paves the way for subsequent GPT models.',
    'Figure 11. Like early GPT models, GPT-4 was trained on web data.',
    'Figure 2 introduces an additional key variable: the crack normal vector.'
  ]) {
    expect(captionKind(text)).toBeUndefined()
  }
  expect(captionKind('Figure 8. Inference results across cohorts.')).toBe('figure')
})

it('rejects panelized figure and repeated table references in running prose', () => {
  for (const text of [
    'Fig. 6 (b) illustrates a systematic model performance variance.',
    'Figure 10 (b) illustrates consistency within the same model family.',
    'Figure 3 are distinctly different than those of our baseline.',
    'Figure 5 is a screenshot of the annotation interface.',
    'Table 1 and Table 2 report the performance on each split.',
    'Table 3 and 4, where the results are presented by macro- and micro-averages scores, respectively.',
    'Fig 4 qualitatively compares the textual and visual attention maps.',
    'Figure 7b. For pie charts, the value of each segment is estimated from its angle.',
    'Figure 35 displays the average accuracy scores across different grade levels.',
    'Figure 2 analyzes this dataset by domains and task categories.',
    'Table 3 provides a comparison of the document benchmarks.',
    'Figure 5 where the bounding box has a high overlap with the true box.',
    'Figure 9b. The values extracted are 200B, -2009 and -100.',
    'Table 34733 3.20 4.10 5.00',
    'Table 77-81 82.2 83.1',
    'Table 82.9 82.2 86.3 85.7 84.8 86.1',
    'Figure 96 43 23',
    'Table 9. † means symbolic method that outputs intermediate languages.',
    'Figure 1 SM 1, 2 Main text SM 8',
    'Figure 2 SM 3 Main text SM 3; Supp. Table 15',
    'Figure 3 SM 4 Supp. Tables 16, 18, 22; Supp. Figs 1–4',
    'Fig. 4. First, the situation is reversed for the held-out split.',
    'Figure 2 decomposes the benchmark tasks by domain and difficulty.',
    'Figure 5 contains the transfer performance across datasets.',
    'Figure 1 and Table 1 carry the main result.',
    'fig. 6 and the same whole-domain complex-pressure error. First, Nx = 8000, the',
    'Figure 8 extends the qualitative results of the main paper to six subjects.',
    'Figure 9 also varies the number of calibration prompts.',
    'Figure 1 outlines three factors we vary. The decision model',
    'Fig. C.2 preserves the reported standard deviations for each method.',
    'Figure 3 grounds this discussion, placing the baseline in context.',
    'Figure 1 defines the two-dimensional models used below.',
    'Figure 2 makes the ambiguity visible within the prefix family.',
    'Figure 2 sets out our experimental procedure. Every stage is identical.',
    'Fig. 8 adds diagonal-deletion PCA to the bounded and unbounded baselines.',
    'Fig. 14 complements Fig. 5 using the CNN autoencoder.',
    'Fig. 1. Results use one pretraining seed.',
    'Fig. 1 [30]. The two tasks are optimised simultaneously and share a common image representation.',
    'Fig. 3 examines utility across individual requests. In panel (a), the median score changes.',
    'fig. 3 for an overview. To summarize the results, ...',
    'figure. MODEL ALPHA, however, attempts a different strategy.',
    'Tab. 9 confirms that we can train models to high performance.',
    'Tab. 10 we see that small-model accuracies are better than tiny-model accuracies.',
    'table. Subsequently, the cells of the table are determined through cross-combination.',
    'Table I on the next page summarizes experiments comparing the model against the baseline.',
    'Table II on the following page shows the multihead attention results.',
    'Table IV on the previous page reports the ablation results.',
    'table. Also even base text features help the model generalize well.',
    'table. Moreover, the model remains stable across layouts.',
    'table. Additionally, the model handles sparse cells.',
    'table. Furthermore, the header remains readable.',
    'table. Overall, the score improves after repair.',
    'Fig. 4. ASTER exhibits a clear linear trend.',
    'Table III . ASTER achieves the highest average score.',
    'Fig. 4 (b) and (c)). The adapter uses both panels.',
    'Figure 1 (§4.7) figures/fig_aggregate_cost_distribution.py',
    'Figure 2 (§4.7)',
    'Table 7 maps each figure and data table in the body to its generating script and output file.',
    'Fig. 1:',
    'Figure S2.',
    'Table 4.',
    'Figure 14 and reference scores in Table 3 (Appendix E).',
    'Figure 4.1, we show the complete ablation sequence.',
    'Figure 8.26. Therefore, the next section evaluates the result.',
    'Fig. 3 and Appendix Tab. 7 we compare the two settings.',
    'Fig. 2 top row. Note that the baseline is repeated.',
    'Fig. 14 and 15. To visualize the change, compare the panels.'
  ]) {
    expect(captionKind(text), text).toBeUndefined()
  }
  expect(captionKind('Figure 3. (A) First panel; (B) second panel.')).toBe('figure')
  expect(captionKind('Figure 5. Screenshot of the annotation interface.')).toBe('figure')
  expect(captionKind('Figure 3 2D results.')).toBe('figure')
  expect(captionKind('Figure 1. First plot.')).toBe('figure')
  expect(captionKind('Figure 2. Second plot.')).toBe('figure')
  expect(captionKind('Table 2: We compare the performance of pretrained models.')).toBe('table')
})

it('rejects supplementary panel references closed inside a prose parenthesis', () => {
  for (const reference of [
    'Supplementary Figure S5 A + B',
    'Figure 3 A–C',
    'Fig. S4',
    'Table A2'
  ]) {
    expect(
      captionKind(`${reference}). The measurements decreased after treatment.`)
    ).toBeUndefined()
  }
  expect(captionKind('Supplementary Figure S5. A + B: Measurements after treatment.')).toBe(
    'figure'
  )
  expect(captionKind('Figure 3. (A) First panel; (B) second panel.')).toBe('figure')
})

it('recognizes dash-delimited titles with alphabetic table suffixes', () => {
  expect(captionKind('FIGURE 1—Enrolment and study flow.')).toBe('figure')
  expect(captionKind('TABLE 2A—Comparison of activity outcomes.')).toBe('table')
  expect(captionKind('FIGURE 1—2')).toBeUndefined()
  expect(captionKind('Figure 1—CONSORT flow diagram.')).toBe('figure')
  expect(captionKind('Table 2A—Comparison of activity outcomes.')).toBe('table')
  expect(captionKind('Table 3B—Adjusted sleep outcomes.')).toBe('table')
  expect(captionKind('Table 2A–Comparison of activity outcomes.')).toBe('table')
  expect(captionKind('Table 2A-Comparison of activity outcomes.')).toBe('table')
  expect(captionKind('Table 2A—3B')).toBeUndefined()
  expect(captionKind('Table 2A—')).toBeUndefined()
})

it('removes synthetic near-zero spaces between a full capital and small caps', () => {
  const items = [
    { str: 'T', height: 8, width: 4.888, fontName: 'Times', transform: [8, 0, 0, 8, 10, 100] },
    { str: ' ', height: 0, width: 0.0007, fontName: 'Times', transform: [6, 0, 0, 6, 14.888, 100] },
    {
      str: 'ABLE',
      height: 6,
      width: 15,
      fontName: 'Times',
      transform: [6, 0, 0, 6, 14.892, 99.9996]
    },
    { str: ' 1. A ', height: 8, width: 20, fontName: 'Times', transform: [8, 0, 0, 8, 32, 100] },
    { str: 'VALUE', height: 6, width: 20, fontName: 'Times', transform: [6, 0, 0, 6, 53, 100] }
  ]
  expect(joinPdfSmallCapsLine(items)).toBe('TABLE 1. A VALUE')
  expect(items[1].str).toBe(' ')
  for (const after of [
    { ...items[2], transform: [6, 0, 0, 6, 17, 100] },
    { ...items[2], transform: [6, 0, 0, 6, 14.892, 102] },
    { ...items[2], transform: [0, 6, -6, 0, 14.892, 100] },
    { ...items[2], height: 8 },
    { ...items[2], fontName: 'Other' },
    { ...items[2], str: 'able' }
  ])
    expect(joinPdfSmallCapsLine([items[0], items[1], after])).toBe('T ' + after.str)
})

it.each([
  [4.664, 594.3319, 143.2375, '²³'],
  [6.4, 595.1399, 143.2375, ' 23'],
  [8, 593.5399, 143.2375, ' 23'],
  [4.664, 594.3319, 148, ' 23']
])(
  'distinguishes raised numeric references from ordinary smaller numbers (%s, %s, %s)',
  (fontSize, y, x, expected) => {
    const lines = [
      {
        text: 'American Pathologists.',
        x: 67.815,
        y: 593.5399,
        width: 75.319,
        height: 8,
        fontSize: 8
      },
      { text: '23', x, y, width: 4.617, height: fontSize, fontSize },
      {
        text: 'According to these guidelines.',
        x: x + 6.6906,
        y: 593.6599,
        width: 110,
        height: 8,
        fontSize: 8
      }
    ]
    expect(groupPageLines({ lines })[0].text).toBe(
      `American Pathologists.${expected} According to these guidelines.`
    )
    expect(lines[1].text).toBe('23')
  }
)

it('reflows physical caption lines without losing content or inventing word breaks', () => {
  expect(
    joinCaptionLines([
      'Figure 1. Change from baseline.',
      'Patients who had',
      'both assessments were included.'
    ])
  ).toBe('Figure 1. Change from baseline. Patients who had both assessments were included.')
  expect(joinCaptionLines(['target-', 'lesion assess\u00ad', 'ments'])).toBe(
    'target-lesion assessments'
  )
})

it('reflows only line-end hyphens supported by an unbroken spelling on the source page', () => {
  const lines = ['No significant dif-', 'ferences between groups.']
  expect(joinCaptionLines(lines, new Set(['differences']))).toBe(
    'No significant differences between groups.'
  )
  expect(lines).toEqual(['No significant dif-', 'ferences between groups.'])
  for (const words of [undefined, new Set(), new Set(['differences', 'dif-ferences'])]) {
    expect(joinCaptionLines(lines, words)).toBe('No significant dif-ferences between groups.')
  }
  expect(joinCaptionLines(['Signif-', 'icant difference.'], new Set(['significant']))).toBe(
    'Significant difference.'
  )
  expect(joinCaptionLines(['target-', 'lesion assessments'], new Set(['target-lesion']))).toBe(
    'target-lesion assessments'
  )
  expect(joinCaptionLines(['Already hyphen-ated within one line.'], new Set(['hyphenated']))).toBe(
    'Already hyphen-ated within one line.'
  )
  expect(joinCaptionLines(['Group A-', 'B'], new Set(['ab']))).toBe('Group A-B')
})

it('preserves a real hyphen while removing the synthetic spaces around small caps', () => {
  const part = (str: string, x: number, width: number, height: number): object => ({
    str,
    width,
    height,
    fontName: 'Times',
    transform: [height || 8, 0, 0, height || 8, x, 100]
  })
  const items = [
    part('BASE', 0, 15, 6),
    part(' ', 15, 0.003, 0),
    part('-L', 15.027, 8, 8),
    part(' ', 23.027, 0.001, 0),
    part('INE', 23.033, 11, 6),
    part(' ', 34.033, 0.003, 0),
    part('.*', 34.055, 6, 8)
  ]
  expect(joinPdfSmallCapsLine(items)).toBe('BASE-LINE.*')
  expect(
    joinPdfSmallCapsLine([
      part('10 P', 0, 16, 8),
      part(' ', 16, 0.001, 0),
      part('ERCENT', 16.01, 25, 6)
    ])
  ).toBe('10 PERCENT')
  expect(
    joinPdfSmallCapsLine([
      part('INTENTION', 0, 30, 6),
      part(' ', 30, 0.01, 0),
      part('-', 30.08, 3, 8),
      part(' ', 33.08, 0.001, 0),
      part('TO', 33.085, 9, 6)
    ])
  ).toBe('INTENTION-TO')
  expect(
    joinPdfSmallCapsLine([part('WORD', 0, 15, 6), part(' ', 15, 0.003, 0), part('.', 17, 3, 8)])
  ).toBe('WORD .')
})

it('keeps tightly bracketed lowered subscripts in the caption line', () => {
  const lines = [
    { text: 'Table 2 Plasma (C', x: 10, y: 20, width: 80, height: 7, fontSize: 7 },
    { text: 'min', x: 90, y: 25.1, width: 7, height: 4.2, fontSize: 4.2 },
    { text: ') of treatment', x: 97, y: 20, width: 70, height: 7, fontSize: 7 }
  ]
  expect(groupPageLines({ lines }).map((l: { text: string }) => l.text)).toEqual([
    'Table 2 Plasma (Cmin) of treatment'
  ])
  expect(groupPageLines({ lines: [lines[0], { ...lines[1], y: 31 }, lines[2]] })).toHaveLength(3)
  expect(groupPageLines({ lines: [lines[0], lines[1]] })).toHaveLength(2)
  expect(lines[1]).not.toHaveProperty('inlineSubscript')
})

it('keeps same-baseline side-by-side table captions in separate runs', () => {
  const line = (text: string, x: number, y: number, width: number): CaptionLine => ({
    text,
    x,
    y,
    width,
    height: 10,
    fontSize: 10
  })
  const page = {
    pageNumber: 1,
    width: 612,
    height: 792,
    lines: [
      line('Table 1: Left-hand coverage results.', 108, 240, 218),
      line('Table 2: Right-hand success results.', 334, 240, 170),
      line('Method State Image', 111, 255, 204),
      line('Method Success (%)', 337, 255, 164)
    ]
  }
  expect(
    groupPageLines(page).filter((row: { text: string }) => /^Table\s+[12]:/.test(row.text))
  ).toEqual([
    expect.objectContaining({ text: 'Table 1: Left-hand coverage results.' }),
    expect.objectContaining({ text: 'Table 2: Right-hand success results.' })
  ])
})

it('recognizes an explicit unnumbered flow diagram caption, not an inline figure reference', () => {
  expect(captionKind('Figure n Flow diagram of participant selection.')).toBe('figure')
  expect(captionKind('Figure shows the treatment response.')).toBeUndefined()
})

it('keeps a raised numeric reference between adjoining title fragments on the same baseline', () => {
  const lines = [
    {
      text: 'Baseline characteristics by randomized group',
      x: 78,
      y: 100,
      width: 182,
      height: 10,
      fontSize: 10
    },
    { text: '1', x: 260, y: 96.5, width: 6, height: 7.5, fontSize: 7.9 },
    { text: '(N=50)', x: 266, y: 100, width: 30, height: 10, fontSize: 10 }
  ]
  expect(groupPageLines({ lines }).map((r: { text: string }) => r.text)).toEqual([
    'Baseline characteristics by randomized group¹ (N=50)'
  ])
  expect(
    groupPageLines({ lines: lines.map((l) => (l.text === '1' ? { ...l, y: 85 } : l)) })
  ).toHaveLength(2)
})

it('excludes a table reference wrapped after an explicit preceding prose reference', () => {
  const title = {
    text: 'Table 1 for accurate determination of stock solutions.',
    x: 285,
    y: 320,
    width: 216,
    height: 10,
    fontSize: 10
  }
  const before = { ...title, text: '[12] using extinction coefficients as listed in', y: 308 }
  expect(findCaptionCandidates([{ pageNumber: 1, lines: [before, title] }])).toEqual([])
  const splitArabicReference = {
    ...title,
    text: 'Table 1. Two out of 37 trainees did not participate in the guided training.'
  }
  expect(findCaptionCandidates([{ pageNumber: 1, lines: [before, splitArabicReference] }])).toEqual(
    []
  )
  for (const previous of [
    { ...before, y: 280 },
    { ...before, x: 45 },
    { ...before, text: 'The results are summarized below.' }
  ]) {
    expect(findCaptionCandidates([{ pageNumber: 1, lines: [previous, title] }])).toHaveLength(1)
  }
})

it('rejects supplementary-material lists that resemble one wrapped table caption', () => {
  const line = (text: string, x: number, y: number, fontSize = 10): object => ({
    text,
    x,
    y,
    width: text.length * 5,
    height: fontSize,
    fontSize
  })
  const page = {
    pageNumber: 9,
    lines: [
      line('Supplementary Materials', 309, 375, 12),
      line('Table S2: body composition changes between 0 and 24', 309, 397),
      line('months stratified by body mass index. Table S3: age', 309, 409),
      line('stratified changes. Figure S6: additional measurements.', 309, 421),
      line('(Supplementary Materials)', 309, 433)
    ]
  }
  expect(findCaptionCandidates([page])).toEqual([])
})

it('keeps a centered all-caps Roman table title with its detached label', () => {
  const line = (text: string, x: number, y: number, width: number, height = 8): CaptionLine => ({
    text,
    x,
    y,
    width,
    height,
    fontSize: height
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      line('TABLE II', 421, 50, 34, 8),
      line('INTER-OBSERVER CONSISTENCY MEASURED BY ICC FOR EACH SESSION.', 314, 60, 247, 8),
      line('Session Reliability(ICC) Session Reliability(ICC)', 342, 77, 189, 8),
      line('1 0.97 8 0.97', 352, 87, 160, 8)
    ]
  }
  const candidates = findCaptionCandidates([page])
  expect(candidates).toHaveLength(1)
  expect(candidates[0].lines).toEqual([
    'TABLE II',
    'INTER-OBSERVER CONSISTENCY MEASURED BY ICC FOR EACH SESSION.'
  ])
})

it('keeps an all-caps Roman table title across an interleaved body column', () => {
  const line = (text: string, x: number, y: number, width: number, height = 8): CaptionLine => ({
    text,
    x,
    y,
    width,
    height,
    fontSize: height
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      line('TABLE III', 158, 306, 36),
      line('relative errors in all tested sequences (Table III). ES-PTAM', 313, 311, 245, 10),
      line('RELATIVE TRANSLATION AND ROTATION ERRORS FOR ES-PTAM AND', 58, 318, 237),
      line('reports real-time performance on the lower-resolution', 313, 323, 245, 10),
      line('THE KEYTIME PIPELINE ON MVSEC AND DSEC. THE MAXIMUM, RMS,', 54, 330, 245),
      line('MVSEC but not on the higher-resolution DSEC, but it also', 313, 335, 245, 10),
      line('AND STANDARD DEVIATION OF THE RELATIVE ERROR IS REPORTED IN CM', 54, 344, 245, 6.4),
      line('a provides a semidense map.', 313, 347, 118, 10),
      line('(TRANSLATION) AND DEGREES (ROTATION).', 103, 354, 149)
    ]
  }
  const candidate = findCaptionCandidates([page]).find(
    (c: { lines: string[] }) => c.lines[0] === 'TABLE III'
  )
  expect(candidate?.lines).toEqual([
    'TABLE III',
    'RELATIVE TRANSLATION AND ROTATION ERRORS FOR ES-PTAM AND',
    'THE KEYTIME PIPELINE ON MVSEC AND DSEC. THE MAXIMUM, RMS,',
    'AND STANDARD DEVIATION OF THE RELATIVE ERROR IS REPORTED IN CM',
    '(TRANSLATION) AND DEGREES (ROTATION).'
  ])
})

it('places a delayed native subscript beside its source anchor before following prose', () => {
  // A delayed native subscript can be painted after its containing sentence.
  const items = [
    { str: 'κ', width: 4.448, height: 8.282314652317915, transform: [8, 0, 2.144, 8, 281.58, 163] },
    { str: ' ', width: 0.88775, height: 0, transform: [8, 0, 2.144, 8, 286.028, 163] },
    {
      str: 'values comparing the three urine collections. It is the percent agreement',
      width: 240.872,
      height: 8,
      transform: [8, 0, 0, 8, 293.13, 163]
    },
    { str: 'w', width: 3.61, height: 4.5, transform: [5, 0, 0, 4.5, 286.03, 161] }
  ]
  const original = structuredClone(items)
  expect(joinPdfSmallCapsLine(items)).toBe(
    'κw values comparing the three urine collections. It is the percent agreement'
  )
  expect(items).toEqual(original)
  for (const marker of [
    { ...items[3], height: 8 },
    { ...items[3], transform: [5, 0, 0, 4.5, 290, 161] },
    { ...items[3], transform: [5, 0, 0, 4.5, 286.03, 163] },
    { ...items[3], transform: [5, 0, 0, 4.5, 286.03, 155] }
  ])
    expect(joinPdfSmallCapsLine([...items.slice(0, 3), marker])).toBe(
      items.map((i) => i.str).join('')
    )
})

it('excludes a figure reference continuing a double-spaced manuscript paragraph', () => {
  const page = readPdfFixture(resolve('test/fixtures/wrapped-figure-reference.jsonl'))
  expect(findCaptionCandidates([page])).toEqual([])
  const withoutReference = {
    ...page,
    lines: page.lines.filter((line: { text: string }) => !line.text.endsWith('as shown in'))
  }
  expect(findCaptionCandidates([withoutReference])).toHaveLength(1)
  const differentFont = structuredClone(page)
  differentFont.lines.find((line: { text: string }) =>
    line.text.endsWith('as shown in')
  ).fontSize += 2
  expect(findCaptionCandidates([differentFont])).toHaveLength(1)
})

it.each([
  'Fig. 1 D illustrates the measured response.',
  'Fig. 1 A), can be assigned to the initial state.',
  'Fig. 1 C. The benefit of this model is a simpler fit.',
  'Fig. 4 A is explained by the fitted parameters.',
  'Figure 2 b shows the observed values.'
])('rejects a separated panel letter before a narrative verb: %s', (text) => {
  expect(captionKind(text)).toBeUndefined()
})

it.each([
  'Figure 1 A comparison of the measured responses.',
  'Figure 2 D: Measured response.',
  'Figure 3. A shows the measured response.'
])('preserves noun titles and punctuated captions: %s', (text) => {
  expect(captionKind(text)).toBe('figure')
})

it.each([
  'Figure 1 A review of the workflow.',
  'Figure 1 A display of the measured responses.',
  'Figure 1 A measure of uncertainty.',
  'Table 1 A list of model parameters.',
  'Figure 1 A review on model performance.',
  'Table 1 A report on measured values.',
  'Figure 1 A display showing the recorded values.',
  'Figure 1 A contrast between the observed groups.',
  'Figure 1 A complement to the standard model.',
  'Figure 1 a complement to the standard model.'
])('preserves article-led noun titles: %s', (text) => {
  expect(captionKind(text)).toBe(text.startsWith('Table') ? 'table' : 'figure')
})

it.each(['reviews', 'displays', 'measures', 'lists', 'reports', 'shows', 'complements', 'is'])(
  'still rejects a finite verb after panel A: %s',
  (verb) => {
    expect(captionKind(`Figure 1 A ${verb} the measured responses.`)).toBeUndefined()
  }
)

type NativeRowReferenceFixture = {
  page: {
    pageNumber: number
    width: number
    height: number
    lines: CaptionLine[]
    graphicsBounds: { normalizedRect: number[] }[]
    invalidGraphicsBounds: number
  }
  context: {
    pageNumber: number
    viewport: { width: number; height: number; transform: number[] }
    content: {
      styles: Record<string, object>
      items: {
        str: string
        dir: string
        width: number
        height: number
        transform: number[]
        fontName: string
        hasEOL: boolean
        sourceItem: { pageNumber: number; index: number; text: string }
      }[]
    }
  }
  rules: number[][]
}

const nativeRowReferenceFixture = (): NativeRowReferenceFixture => {
  const values: [string, number, number, number][] = [
    ['The preceding discussion has ended.', 70, 70, 220],
    ['The measured changes are demonstrated in the top row of', 62, 100, 388],
    ['Figure 2 using paired inputs to compare the measured effects.', 50, 114, 400],
    ['Further details explain the observations and their consequences.', 50, 128, 400]
  ]
  const lines = values.map(([text, x, y, width]) => ({
    text,
    x,
    y,
    width,
    height: 10,
    fontSize: 10
  }))
  return {
    page: {
      pageNumber: 1,
      width: 500,
      height: 600,
      lines,
      graphicsBounds: [] as { normalizedRect: number[] }[],
      invalidGraphicsBounds: 0
    },
    context: {
      pageNumber: 1,
      viewport: { width: 500, height: 600, transform: [1, 0, 0, -1, 0, 600] },
      content: {
        styles: { body: { ascent: 0.8, descent: -0.2, vertical: false } },
        items: values.map(([str, x, y, width], index) => ({
          str,
          dir: 'ltr',
          width,
          height: 10,
          transform: [10, 0, 0, 10, x, 600 - y - 10],
          fontName: 'body',
          hasEOL: true,
          sourceItem: { pageNumber: 1, index, text: str }
        }))
      }
    },
    rules: []
  }
}

it('rejects a native paragraph reference only after complete source binding', () => {
  const a = nativeRowReferenceFixture()
  const before = findCaptionCandidates([a.page])
  expect(before).toHaveLength(1)
  expect(isNativeRowReference(before[0], a.page, a.context, a.rules)).toBe(true)
})
const nativeRowReferenceNegatives: [
  string,
  (a: ReturnType<typeof nativeRowReferenceFixture>) => void
][] = [
  [
    'unknown zero-advance native ink outside the paragraph',
    (a) => {
      const index = a.context.content.items.length
      a.context.content.items.push({
        str: 'Other',
        dir: 'ltr',
        width: 0,
        height: 10,
        transform: [10, 0, 0, 10, 49, 495],
        fontName: 'unknown',
        hasEOL: true,
        sourceItem: { pageNumber: 1, index, text: 'Other' }
      })
    }
  ],
  [
    'vertical native font style',
    (a) => {
      Object.assign(a.context.content.styles.body, { vertical: true })
    }
  ],
  [
    'missing native context',
    (a) => {
      Reflect.deleteProperty(a, 'context')
    }
  ],
  [
    'missing source identity',
    (a) => {
      Reflect.deleteProperty(a.context.content.items[2], 'sourceItem')
    }
  ],
  [
    'discontinuous source index',
    (a) => {
      a.context.content.items[2].sourceItem.index = 9
    }
  ],
  [
    'different font',
    (a) => {
      a.context.content.items[1].fontName = 'other'
    }
  ],
  [
    'large leading',
    (a) => {
      a.context.content.items[1].transform[5] += 15
      a.page.lines[1].y -= 15
    }
  ],
  [
    'different column',
    (a) => {
      a.context.content.items[1].transform[4] += 120
      a.page.lines[1].x += 120
    }
  ],
  [
    'punctuated caption',
    (a) => {
      a.page.lines[2].text =
        a.context.content.items[2].str =
        a.context.content.items[2].sourceItem.text =
          'Figure 2: Using paired inputs to compare the measured effects.'
    }
  ],
  [
    'paint separator',
    (a) => {
      a.rules.push([50, 112, 450, 112])
    }
  ],
  [
    'painted image',
    (a) => {
      a.page.graphicsBounds.push({ normalizedRect: [0.1, 0.17, 0.9, 0.2] })
    }
  ],
  [
    'duplicate native owner',
    (a) => {
      a.context.content.items.push(structuredClone(a.context.content.items[2]))
    }
  ],
  [
    'absent preceding geometry source',
    (a) => {
      a.page.lines.splice(1, 1)
    }
  ],
  [
    'closed preceding sentence',
    (a) => {
      a.page.lines[1].text =
        a.context.content.items[1].str =
        a.context.content.items[1].sourceItem.text =
          'The measured changes are demonstrated in the top row.'
    }
  ],
  [
    'non-repeated leading',
    (a) => {
      a.context.content.items[3].transform[5] -= 5
      a.page.lines[3].y += 5
    }
  ],
  [
    'unknown graphics inventory',
    (a) => {
      a.page.invalidGraphicsBounds = 1
    }
  ],
  [
    'partial native row',
    (a) => {
      a.context.content.items[1].hasEOL = false
    }
  ],
  [
    'foreign overlapping native text',
    (a) => {
      const index = a.context.content.items.length
      a.context.content.items.push({
        str: 'Other',
        dir: 'ltr',
        width: 30,
        height: 10,
        transform: [10, 0, 0, 10, 200, 485],
        fontName: 'body',
        hasEOL: true,
        sourceItem: { pageNumber: 1, index, text: 'Other' }
      })
    }
  ]
]
it.each(nativeRowReferenceNegatives)(
  'retains an unproved native paragraph reference: %s',
  (_name, mutate) => {
    const a = nativeRowReferenceFixture()
    mutate(a)
    const original = structuredClone(a)
    const before = findCaptionCandidates([a.page], new Map([[a.page.pageNumber, a.rules]]))
    expect(
      before.filter((c: unknown) => !isNativeRowReference(c, a.page, a.context, a.rules))
    ).toEqual(before)
    expect(a).toEqual(original)
  }
)

const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const mixedIndependentTableCaptions = (): ReturnType<typeof JSON.parse> => {
  const captions = [
    { page: 1, rect: [280, 58, 520, 68], lines: ['Table 1: A preceding independent result.'] },
    {
      page: 1,
      rect: [280, 155, 520, 165],
      lines: ['Table 2: Complete independent numeric records.']
    },
    { page: 1, rect: [280, 325, 520, 335], lines: ['Table 3: Another complete numeric result.'] },
    { page: 1, rect: [40, 365, 250, 375], lines: ['Table 4: Independent descriptive records.'] }
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: captions.map((c) => ({
      text: c.lines[0],
      x: c.rect[0],
      y: c.rect[1],
      width: c.rect[2] - c.rect[0],
      height: 10,
      fontSize: 10
    }))
  }
  const rules: number[][] = []
  for (const top of [70, 240]) {
    for (const y of [top, top + 20, top + 80]) rules.push([300, y, 500, y])
    page.lines.push({
      text: 'Group and independent values',
      x: 310,
      y: top + 4,
      width: 160,
      height: 8,
      fontSize: 8
    })
    for (let row = 0; row < 3; row++)
      for (const [col, text] of ['1', '2'].entries())
        page.lines.push({
          text,
          x: 320 + col * 80,
          y: top + 28 + row * 14,
          width: 12,
          height: 8,
          fontSize: 8
        })
  }
  for (let row = 0; row < 4; row++)
    page.lines.push({
      text: 'A complete descriptive record',
      x: 50,
      y: 90 + row * 60,
      width: 170,
      height: 10,
      fontSize: 10
    })
  return {
    page,
    captions,
    rules,
    tables: [
      { rect: [300, 78, 500, 142] },
      { rect: [300, 248, 500, 312] },
      { rect: [40, 70, 250, 350] }
    ]
  }
}
it('keeps independently proved below captions when an unrelated descriptive table has no numeric proof', () => {
  const f = mixedIndependentTableCaptions(),
    before = structuredClone(f)
  const result = associateTableCaptions(f.page, f.tables, f.captions, f.rules)
  expect(result[0].caption).toBe(f.captions[1])
  expect(result[1].caption).toBe(f.captions[2])
  expect(f).toEqual(before)
})
it('does not reserve an otherwise proved below caption across another native caption inside its table', () => {
  const f = mixedIndependentTableCaptions()
  f.captions.push({
    page: 1,
    rect: [310, 100, 490, 110],
    lines: ['Table 5: A competing native owner.']
  })
  const result = associateTableCaptions(f.page, f.tables, f.captions, f.rules)
  expect(result[0].caption).not.toBe(f.captions[1])
})

it('reserves a proved footer once when it is also adjacent above the next table', () => {
  const f = mixedIndependentTableCaptions()
  for (const line of f.page.lines) if (line.y >= 240 && line.y < 340) line.y -= 70
  for (const rule of f.rules)
    if (rule[1] >= 240) {
      rule[1] -= 70
      rule[3] -= 70
    }
  f.tables[1].rect[1] -= 70
  f.tables[1].rect[3] -= 70
  f.captions[2].rect[1] -= 70
  f.captions[2].rect[3] -= 70
  const result = associateTableCaptions(f.page, f.tables, f.captions, f.rules)
  expect(result[0].caption).toBe(f.captions[1])
  expect(result[1].caption).toBe(f.captions[2])
  expect(result.filter((r: { caption?: unknown }) => r.caption === f.captions[1])).toHaveLength(1)
  f.captions.splice(2, 1)
  f.page.lines = f.page.lines.filter((l: { text: string }) => !l.text.startsWith('Table 3:'))
  const uncertain = associateTableCaptions(f.page, f.tables, f.captions, f.rules)
  expect(uncertain[0].caption).toBe(f.captions[0])
  expect(uncertain[1].caption).toBe(f.captions[1])
  expect(uncertain.filter((r: { caption?: unknown }) => r.caption === f.captions[1])).toHaveLength(
    1
  )
})

it('keeps a complete unique above-caption stack when a partial footer also matches the next title', () => {
  const f = mixedIndependentTableCaptions()
  f.tables = f.tables.slice(0, 2)
  f.captions = f.captions.slice(0, 2)
  f.page.lines = f.page.lines.filter(
    (line: { x: number; text: string }) => line.x >= 280 && !/^Table [34]:/.test(line.text)
  )
  for (const line of f.page.lines) if (line.y >= 240) line.y -= 70
  for (const rule of f.rules)
    if (rule[1] >= 240) {
      rule[1] -= 70
      rule[3] -= 70
    }
  f.tables[1].rect[1] -= 70
  f.tables[1].rect[3] -= 70
  const before = structuredClone(f)
  const result = associateTableCaptions(f.page, f.tables, f.captions, f.rules)
  expect(result.map((r: { caption?: unknown }) => r.caption)).toEqual(f.captions)
  expect(f).toEqual(before)
})

it('rejects a shared adjacent title when neither competing table has a complete native proof', () => {
  const caption = { page: 1, rect: [100, 110, 300, 120], lines: ['Table 1: Shared results.'] }
  const page = {
    pageNumber: 1,
    width: 400,
    height: 600,
    lines: [{ text: caption.lines[0], x: 100, y: 110, width: 200, height: 10, fontSize: 10 }]
  }
  const result = associateTableCaptions(
    page,
    [{ rect: [100, 60, 300, 100] }, { rect: [100, 130, 300, 170] }],
    [caption],
    []
  )
  expect(result).toEqual([{ reason: 'shared-table-caption' }, { reason: 'shared-table-caption' }])
})

// Native paragraph cadence is calibrated before the wrapped reference.
const nativeMeasuredReferenceFixture = (pitch = 18): NativeRowReferenceFixture => {
  const a = nativeRowReferenceFixture()
  const texts = [
    'The independently measured outcomes remain stable across repeated samples',
    'All repeated observations retain their complete source order and alignment',
    'The independent calibration paragraph has ended with the same typography.',
    'The next set of observations is presented in',
    'Figure 3. For the first group, the method exhibits reliable coverage',
    'through all repeated observations under these independent conditions.'
  ]
  a.page.lines = texts.map((text, index) => ({
    text,
    x: index === 3 ? 62 : 50,
    y: 60 + index * pitch,
    width: index === 3 ? 388 : 400,
    height: 10,
    fontSize: 10
  }))
  a.context.content.items = a.page.lines.map((l, index) => ({
    str: l.text,
    dir: 'ltr',
    width: l.width,
    height: 10,
    transform: [10.2, 0, 0, 10, l.x, 600 - l.y - 10],
    fontName: 'body',
    hasEOL: true,
    sourceItem: { pageNumber: 1, index, text: l.text }
  }))
  return a
}
const measuredReferenceCandidate = (a: NativeRowReferenceFixture): object => {
  const l = a.page.lines[4]
  return { page: 1, lines: [l.text], rect: [l.x, l.y, l.x + l.width, l.y + l.height] }
}
it.each([12, 18])(
  'uses independent native prose cadence for a punctuated wrapped reference (%s)',
  (pitch) => {
    const a = nativeMeasuredReferenceFixture(pitch)
    expect(isNativeRowReference(measuredReferenceCandidate(a), a.page, a.context, a.rules)).toBe(
      true
    )
  }
)
it.each([
  [
    'source identity',
    (a: NativeRowReferenceFixture) => {
      a.context.content.items[2].sourceItem.index = 1
    }
  ],
  [
    'independent cadence',
    (a: NativeRowReferenceFixture) => {
      a.context.content.items[1].transform[5] += 2
    }
  ],
  [
    'complete native row',
    (a: NativeRowReferenceFixture) => {
      a.page.lines.pop()
    }
  ],
  [
    'unclipped text transform',
    (a: NativeRowReferenceFixture) => {
      a.context.content.items[5].transform[2] = 1
    }
  ],
  [
    'font envelope',
    (a: NativeRowReferenceFixture) => {
      a.context.content.styles.body = {}
    }
  ],
  [
    'paint-free paragraph',
    (a: NativeRowReferenceFixture) => {
      a.page.graphicsBounds.push({ normalizedRect: [0.1, 0.2, 0.9, 0.25] })
    }
  ],
  [
    'rule-free paragraph',
    (a: NativeRowReferenceFixture) => {
      a.rules.push([50, 100, 450, 100])
    }
  ]
] as const)('retains the caption when measured paragraph proof lacks %s', (_name, edit) => {
  const a = nativeMeasuredReferenceFixture()
  const candidate = measuredReferenceCandidate(a)
  edit(a)
  expect(isNativeRowReference(candidate, a.page, a.context, a.rules)).toBe(false)
})
it('retains an explicit colon caption beside a measured native paragraph', () => {
  const a = nativeMeasuredReferenceFixture()
  const candidate = measuredReferenceCandidate(a) as { lines: string[] }
  candidate.lines[0] = candidate.lines[0].replace('3.', '3:')
  expect(isNativeRowReference(candidate, a.page, a.context, a.rules)).toBe(false)
})

it('retains a wrapped candidate when native font metrics have no measured extent', () => {
  const a = nativeMeasuredReferenceFixture()
  Object.assign(a.context.content.styles.body, { ascent: 0, descent: 0 })
  expect(isNativeRowReference(measuredReferenceCandidate(a), a.page, a.context, a.rules)).toBe(
    false
  )
})

const nativeSectionReferenceFixture = (): NativeRowReferenceFixture => {
  const a = nativeRowReferenceFixture()
  const values: [string, number, number, number, string][] = [
    ['The preceding native discussion has ended.', 50, 80, 240, 'body'],
    ['2.3', 50, 110, 20, 'heading'],
    ['Independent evaluation', 90, 110, 140, 'heading'],
    ['Figure 2 and Table 3 describe the repeated native observations', 50, 130, 400, 'body'],
    ['under independently measured conditions with original source order', 49.8, 144, 400, 'body'],
    ['and retain the complete ordinary paragraph across native source rows', 50, 158, 400, 'body'],
    ['ending with an independently observed complete sentence.', 50, 172, 270, 'body'],
    ['The following independent paragraph calibrates the native body style', 60, 190, 390, 'body'],
    ['with complete literal records in their independently measured order', 50, 204, 400, 'body'],
    ['and further ordinary observations under the same native typography', 50, 218, 400, 'body'],
    ['before the next independently measured sentence has ended.', 50, 232, 300, 'body']
  ]
  a.context.content.styles.heading = { ascent: 0.8, descent: -0.2, vertical: false }
  a.page.lines = values.map(([text, x, y, width]) => ({
    text,
    x,
    y,
    width,
    height: 10,
    fontSize: 10
  }))
  a.context.content.items = values.map(([str, x, y, width, fontName], index) => ({
    str,
    dir: 'ltr',
    width,
    height: 10,
    transform: [10, 0, 0, 10, x, 600 - y - 10],
    fontName,
    hasEOL: index > 2,
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  return a
}

it.each([
  'complete',
  'source identity',
  'font envelope',
  'paragraph end',
  'complete source row',
  'independent cadence',
  'foreign paint',
  'foreign geometric line',
  'off-page predecessor',
  'off-page cadence',
  'foreign heading line',
  'foreign predecessor lane',
  'foreign cadence lane',
  'explicit caption'
])('requires complete section paragraph evidence for a coordinated reference: %s', (variant) => {
  const a = nativeSectionReferenceFixture()
  const lines = a.page.lines.slice(3, 7)
  const candidate = {
    page: 1,
    lines: lines.map((l) => l.text),
    rect: [
      Math.min(...lines.map((l) => l.x)),
      lines[0].y,
      Math.max(...lines.map((l) => l.x + l.width)),
      lines.at(-1)!.y + 10
    ]
  }
  if (variant === 'source identity') a.context.content.items[4].sourceItem.index = 3
  if (variant === 'font envelope') a.context.content.styles.body = {}
  if (variant === 'paragraph end') candidate.lines.pop()
  if (variant === 'complete source row') a.page.lines.splice(4, 1)
  if (variant === 'independent cadence') a.context.content.items[9].transform[5] -= 2
  if (variant === 'foreign paint')
    a.page.graphicsBounds.push({ normalizedRect: [0.1, 0.2, 0.8, 0.4] })
  if (variant === 'foreign geometric line')
    a.page.lines.push({
      text: 'Independent foreign row',
      x: 80,
      y: 150,
      width: 200,
      height: 10,
      fontSize: 10
    })
  if (variant === 'off-page predecessor') {
    a.page.lines[0].y = -100
    a.context.content.items[0].transform[5] = 690
  }
  if (variant === 'off-page cadence') {
    for (let index = 7; index < 11; index++) {
      a.page.lines[index].y += 1000
      a.context.content.items[index].transform[5] -= 1000
    }
  }
  if (variant === 'foreign heading line')
    a.page.lines.push({
      text: 'Foreign heading row',
      x: 240,
      y: 112,
      width: 100,
      height: 10,
      fontSize: 10
    })
  if (variant === 'foreign predecessor lane') {
    a.page.lines[0].x += 200
    a.context.content.items[0].transform[4] += 200
  }
  if (variant === 'foreign cadence lane') {
    for (let index = 8; index < 11; index++) {
      a.page.lines[index].x += 40
      a.page.lines[index].width -= 40
      a.context.content.items[index].transform[4] += 40
      a.context.content.items[index].width -= 40
    }
  }
  if (variant === 'explicit caption')
    candidate.lines[0] = candidate.lines[0].replace('2 and', '2: and')
  const before = structuredClone(a)
  expect(isNativeRowReference(candidate, a.page, a.context, a.rules)).toBe(variant === 'complete')
  expect(a).toEqual(before)
})

const nativeImageCreditFixture = (): {
  fixture: NativeRowReferenceFixture
  candidate: { page: number; lines: string[]; rect: number[] }
} => {
  const fixture = nativeRowReferenceFixture()
  fixture.page.lines = []
  fixture.context.content.items = []
  fixture.context.content.styles = Object.fromEntries(
    ['body', 'reference', 'title'].map((font) => [
      font,
      { ascent: 0.8, descent: -0.2, vertical: false }
    ])
  )
  const add = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName: string,
    size = 10
  ): void => {
    const index = fixture.context.content.items.length
    fixture.context.content.items.push({
      str,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, 600 - y - size],
      fontName,
      hasEOL: true,
      sourceItem: { pageNumber: 1, index, text: str }
    })
  }
  fixture.page.lines.push({
    text: 'Image credits',
    x: 50,
    y: 60,
    width: 120,
    height: 14,
    fontSize: 14
  })
  add('Image credits', 50, 60, 120, 'body', 14)
  for (let group = 0; group < 3; group++) {
    const y = 100 + group * 59
    const prefix = group === 2 ? 'Fig. 5A:' : `Figs. ${group + 1} and ${group + 2}:`
    const title = '“Independent plate” by Example Author'
    const texts = [
      prefix + ' ' + title,
      'https://example.invalid/source, licensed under a permissive licence.',
      'The licence terms are at https://example.invalid/licence and remain unchanged.',
      'The credited source retains its original attribution.'
    ]
    texts.forEach((text, row) =>
      fixture.page.lines.push({
        text,
        x: 50,
        y: y + row * 14,
        width: row === 3 ? 200 : 400,
        height: 10,
        fontSize: 10
      })
    )
    add(prefix, 50, y, 80, 'reference')
    add(' ', 130, y, 4, 'reference')
    add(title, 134, y, 316, 'title')
    for (let row = 1; row < 4; row++)
      add(texts[row], 50, y + row * 14, row === 3 ? 200 : 400, 'body')
  }
  const rows = fixture.page.lines.slice(-4)
  return {
    fixture,
    candidate: {
      page: 1,
      lines: rows.map((l) => l.text),
      rect: [50, rows[0].y, 450, rows.at(-1)!.y + 10]
    }
  }
}

it.each([
  'complete',
  'source identity',
  'font envelope',
  'section heading',
  'foreign paint',
  'foreign heading line',
  'complete source row',
  'licensed source'
])(
  'requires complete native credit-list evidence before refusing a phantom caption: %s',
  (variant) => {
    const { fixture: a, candidate } = nativeImageCreditFixture()
    if (variant === 'source identity') a.context.content.items.at(-1)!.sourceItem.index--
    if (variant === 'font envelope') a.context.content.styles.body = {}
    if (variant === 'section heading') a.page.lines[0].text = 'Illustrated results'
    if (variant === 'foreign paint')
      a.page.graphicsBounds.push({ normalizedRect: [0.1, 0.3, 0.9, 0.5] })
    if (variant === 'foreign heading line')
      a.page.lines.push({
        text: 'Independent heading',
        x: 100,
        y: 62,
        width: 120,
        height: 10,
        fontSize: 10
      })
    if (variant === 'complete source row') a.page.lines.splice(a.page.lines.length - 2, 1)
    if (variant === 'licensed source') {
      const item = a.context.content.items.at(-3)!
      const before = item.str
      item.str = item.str.replace('licensed under', 'discussed under')
      item.sourceItem.text = item.str
      a.page.lines.find((l) => l.text === before)!.text = item.str
      candidate.lines[1] = item.str
    }
    const before = structuredClone({ a, candidate })
    expect(isNativeRowReference(candidate, a.page, a.context, a.rules)).toBe(variant === 'complete')
    expect({ a, candidate }).toEqual(before)
  }
)

it.each([
  'upper heading fringe',
  'lower heading fringe',
  'unbounded viewport',
  'nonfinite unrelated line',
  'negative unrelated width',
  'missing unrelated text'
])('keeps a credit candidate when its ambient proof is incomplete: %s', (variant) => {
  const { fixture: a, candidate } = nativeImageCreditFixture()
  if (variant.endsWith('heading fringe')) {
    const y = variant.startsWith('upper') ? 57.5 : 75
    const size = variant.startsWith('upper') ? 1 : 2
    if (variant.startsWith('upper'))
      a.context.content.styles.body = { ascent: 1.2, descent: -0.2, vertical: false }
    const str = 'Independent heading fringe'
    a.context.content.items.splice(1, 0, {
      str,
      dir: 'ltr',
      width: 70,
      height: size,
      transform: [size, 0, 0, size, 80, 600 - y - size],
      fontName: 'body',
      hasEOL: true,
      sourceItem: { pageNumber: 1, index: 1, text: str }
    })
    a.context.content.items.forEach((item, index) => {
      item.sourceItem = { pageNumber: 1, index, text: item.str }
    })
    a.page.lines.splice(1, 0, { text: str, x: 80, y, width: 70, height: size, fontSize: size })
  } else if (variant === 'unbounded viewport') {
    a.page.width = a.context.viewport.width = Infinity
  } else {
    const line: CaptionLine = {
      text: 'Independent row',
      x: 10,
      y: 20,
      width: 70,
      height: 10,
      fontSize: 10
    }
    if (variant === 'nonfinite unrelated line') line.x = NaN
    if (variant === 'negative unrelated width') line.width = -1
    if (variant === 'missing unrelated text') Object.assign(line, { text: undefined })
    a.page.lines.unshift(line)
  }
  const before = structuredClone({ a, candidate })
  expect(isNativeRowReference(candidate, a.page, a.context, a.rules)).toBe(false)
  expect({ a, candidate }).toEqual(before)
})

function wrappedPanelReferencePage(): {
  pageNumber: number
  width: number
  height: number
  invalidGraphicsBounds: number
  graphicsBounds: { kind: string; normalizedRect: number[] }[]
  lines: CaptionLine[]
} {
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    graphicsBounds: [{ kind: 'path', normalizedRect: [0.1, 0.03, 0.9, 0.15] }],
    lines: [
      'The independent estimates for the measured groups are shown in',
      'Fig. 4.a and the density in Fig. 4.b. The bands show a common',
      'confidence interval computed over independent repetitions in each group.'
    ].map((text, i) => ({ text, x: 50, y: 200 + 21 * i, width: 450, height: 12, fontSize: 12 }))
  }
}

function retainsWrappedPanelCaption(page: ReturnType<typeof wrappedPanelReferencePage>): boolean {
  const start = page.lines.find((l) => /^Fig\. /.test(l.text))
  return findCaptionCandidates([page]).some((c) => c.lines[0] === start?.text)
}

it('keeps a complete wrapped panel reference in its native body paragraph', () => {
  const page = wrappedPanelReferencePage()
  const before = structuredClone(page)
  expect(retainsWrappedPanelCaption(page)).toBe(false)
  expect(page).toEqual(before)
})

it('keeps native mathematical paint inside the following complete body row', () => {
  const page = wrappedPanelReferencePage()
  page.graphicsBounds.push({
    kind: 'path',
    normalizedRect: [300 / 600, 244 / 800, 310 / 600, 250 / 800]
  })
  expect(retainsWrappedPanelCaption(page)).toBe(false)
})

const wrappedPanelRefusals: [
  string,
  (page: ReturnType<typeof wrappedPanelReferencePage>) => void
][] = [
  [
    'complete preceding sentence',
    (p) => {
      p.lines[0].text += '.'
    }
  ],
  [
    'different preceding font',
    (p) => {
      p.lines[0].fontSize = 14
    }
  ],
  [
    'independent caption punctuation',
    (p) => {
      p.lines[1].text = 'Fig. 4.a: Density estimates for independent repeated measurements.'
    }
  ],
  [
    'missing preceding source',
    (p) => {
      p.lines.shift()
    }
  ],
  [
    'different column',
    (p) => {
      p.lines[0].x += 15
    }
  ],
  [
    'uneven physical leading',
    (p) => {
      p.lines[2].y += 3
    }
  ],
  [
    'foreign native source in corridor',
    (p) => {
      p.lines.push({ text: 'External witness', x: 100, y: 215, width: 60, height: 5, fontSize: 5 })
    }
  ],
  [
    'foreign graphic across corridor',
    (p) => {
      p.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 214 / 800, 0.5, 220 / 800] })
    }
  ],
  [
    'vertical foreign image',
    (p) => {
      p.graphicsBounds.push({ kind: 'image', normalizedRect: [0.2, 0.24, 0.25, 0.33] })
    }
  ],
  [
    'invalid native graphics',
    (p) => {
      p.invalidGraphicsBounds = 1
    }
  ],
  [
    'missing graphics inventory',
    (p) => {
      Reflect.deleteProperty(p, 'graphicsBounds')
    }
  ],
  [
    'missing page extent',
    (p) => {
      Reflect.deleteProperty(p, 'width')
    }
  ],
  [
    'unknown graphics kind',
    (p) => {
      p.graphicsBounds[0].kind = 'unknown'
    }
  ],
  [
    'different following font',
    (p) => {
      p.lines[2].fontSize = 14
    }
  ],
  [
    'independent following sentence',
    (p) => {
      p.lines[2].text = 'Confidence intervals are given separately for the measured groups.'
    }
  ],
  [
    'different preceding relation',
    (p) => {
      p.lines[0].text = 'The independent estimates for measured groups use different conditions'
    }
  ]
]

it.each(wrappedPanelRefusals)(
  'retains a panel caption without complete continuation proof: %s',
  (_, change) => {
    const page = wrappedPanelReferencePage()
    change(page)
    const before = structuredClone(page)
    expect(retainsWrappedPanelCaption(page)).toBe(true)
    expect(page).toEqual(before)
  }
)

// Complete finite prose grammar; noun titles and printed punctuation retain captions.
it.each([
  ['Figure 1 tests the assay.', null],
  ['Fig. 2 on the upper left compares the traces.', null],
  ['Figure 3 on the lower right shows the controls.', null],
  ['Figure 4 on the left presents our models.', null],
  ['Figure 1. Tests of the method.', 'figure'],
  ['Figure 1: Tests of the method.', 'figure'],
  ['Figure 1 Tests of the method', 'figure'],
  ['Figure 1 tests', 'figure'],
  ['Figure 1 Testing the method', 'figure'],
  ['Figure 1 on the upper left: comparisons', 'figure'],
  ['Figure 1 on the upper left comparisons of assays', 'figure'],
  ['Fig. 1. On the upper left, compare the controls.', 'figure'],
  ['Figure 1 Results on the left', 'figure'],
  ['Table 1 tests the method.', 'table']
])('distinguishes bounded finite figure prose: %s', (text, expected) => {
  expect(captionKind(text)).toBe(expected ?? undefined)
})
