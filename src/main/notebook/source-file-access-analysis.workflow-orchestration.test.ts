import { expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

it('captures a configuration-driven clinical workflow with dynamic cohort stages', async () => {
  const source = `from pathlib import Path
import json
import subprocess
import pandas as pd
from lifelines import CoxPHFitter
import joblib

root = Path("inputs")
config = json.loads((root / "workflow.json").read_text())
cohorts = pd.read_csv(root / "cohorts.csv")
results = Path("results")
results.mkdir(exist_ok=True)
models = []
for cohort in cohorts.itertuples():
    expression = root / cohort.expression_file
    clinical = root / cohort.clinical_file
    subprocess.run(["normalizer", "--input", str(expression), "--output", "work/normalized.tsv"], check=True)
    frame = pd.read_csv("work/normalized.tsv", sep="\\t").merge(pd.read_csv(clinical), on="patient_id")
    frame.to_parquet(results / f"{cohort.name}-features.parquet")
    model = CoxPHFitter().fit(frame, duration_col=config["duration"], event_col=config["event"])
    joblib.dump(model, results / f"{cohort.name}-cox.joblib")
    models.append(model)
summary = pd.DataFrame({"cohort": cohorts.name, "models": len(models)})
summary.to_csv(results / "survival-summary.csv", index=False)
(results / "run-manifest.json").write_text(json.dumps({"cohorts": len(models), "config": config}))
Path("reports").mkdir(exist_ok=True)
(Path("reports") / "survival.html").write_text("<html>report</html>")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/cohorts.csv', 'inputs/workflow.json', 'work/normalized.tsv'],
    writes: ['reports/survival.html', 'results/run-manifest.json', 'results/survival-summary.csv'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})
