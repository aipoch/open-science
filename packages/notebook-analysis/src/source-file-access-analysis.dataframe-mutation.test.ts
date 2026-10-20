import { expect, it } from 'vitest'

import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

it.each(['risk', 'to_csv'])(
  'retains file writers after assigning a DataFrame column named %s',
  async (column) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import pandas as pd
cohort = pd.read_csv("inputs/cohort.csv")
cohort["${column}"] = 1
cohort.to_csv("outputs/cohort.csv", index=False)
pd.DataFrame({"score": [1]}).to_csv("outputs/scores.csv", index=False)`
    )
    expect(result).toMatchObject({
      reads: ['inputs/cohort.csv'],
      writes: ['outputs/cohort.csv', 'outputs/scores.csv'],
      writeState: 'complete'
    })
  }
)

it.each([
  'cohort.to_csv = replacement',
  'alias = cohort\nalias.to_csv = replacement',
  'pd.DataFrame.to_csv = replacement'
])('keeps a replaced DataFrame writer uncertain: %s', async (replacement) => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    `import pandas as pd
cohort = pd.read_csv("inputs/cohort.csv")
${replacement}
cohort.to_csv("outputs/not-a-proven-write.csv")`
  )
  expect(result.writes).not.toContain('outputs/not-a-proven-write.csv')
  expect(result.externalState).toBe('partial')
})

it('retains the column mutation and writer identities across cells', async () => {
  const prepared = await analyzePythonNotebookSource(`import pandas as pd
cohort = pd.read_csv("inputs/cohort.csv")
cohort["risk"] = 1`)
  expect(prepared.facts.mutatedNames).toContain('cohort')
  expect(prepared.fileAccess?.context?.pythonTaintedNamespaces ?? []).not.toContain('pandas')
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    'cohort.to_csv("outputs/cohort.csv", index=False)',
    prepared.fileAccess?.context
  )
  expect(result.writes).toEqual(['outputs/cohort.csv'])
})
