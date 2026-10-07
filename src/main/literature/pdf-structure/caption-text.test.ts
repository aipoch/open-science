import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
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
  findCaptionCandidates
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
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
    const moduleUrl = pathToFileURL(
      resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')
    ).href
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
  // 12270199.pdf, page 11, Table 5 note: the stream paints w after the sentence.
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
  const page = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/wrapped-figure-reference.jsonl')
  )
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
