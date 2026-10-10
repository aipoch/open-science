import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const analyzedPythonPath = (value: string): string =>
  process.platform === 'win32' ? value.replaceAll('/', '\\') : value

it('captures partitioned pandas Parquet output as a directory scope', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'import pandas as pd',
      'frame = pd.read_csv("inputs/measurements.csv")',
      'frame.to_parquet("results/measurements", partition_cols=["group"], index=False)'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: ['inputs/measurements.csv'],
    writes: ['results/measurements'],
    writeScopes: [{ kind: 'directory', path: 'results/measurements' }],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it('keeps dynamic Parquet partition outputs uncertain', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'import pandas as pd',
      'columns = get_partition_columns()',
      'frame = pd.read_csv("inputs/measurements.csv")',
      'frame.to_parquet("results/measurements", partition_cols=columns, index=False)'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: ['inputs/measurements.csv'],
    writes: ['results/measurements'],
    writeState: 'partial',
    externalState: 'partial'
  })
  expect(result.writeScopes).toBeUndefined()
})

it('treats pathlib output-directory setup as local notebook scaffolding', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'from pathlib import Path',
      'import pandas as pd',
      'Path("work").mkdir(parents=True, exist_ok=True)',
      'Path("outputs").mkdir(parents=True, exist_ok=True)',
      'frame = pd.read_csv("inputs/measurements.csv")',
      'frame.to_parquet("work/measurements.parquet")'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: ['inputs/measurements.csv'],
    writes: ['work/measurements.parquet'],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})

it('captures local metadata copied into an analysis workspace', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'from pathlib import Path',
      'import shutil',
      'import pandas as pd',
      'source = Path("inputs/atlas/metadata.json")',
      'shutil.copy2(source, "work/metadata.json")',
      'frame = pd.read_csv("inputs/counts.csv")',
      'frame.to_csv("outputs/counts.csv", index=False)'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: expect.arrayContaining([join('inputs', 'atlas', 'metadata.json'), 'inputs/counts.csv']),
    writes: expect.arrayContaining(['work/metadata.json', 'outputs/counts.csv']),
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})

it('keeps recursive input coverage partial while retaining copied directory lineage', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'import shutil',
      'import pandas as pd',
      'shutil.copytree("inputs/reference", "work/reference", dirs_exist_ok=True)',
      'frame = pd.read_csv("work/reference/annotations.csv")',
      'frame.to_csv("outputs/annotated.csv", index=False)'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: expect.arrayContaining(['inputs/reference', 'work/reference/annotations.csv']),
    writes: expect.arrayContaining(['work/reference', 'outputs/annotated.csv']),
    writeScopes: [{ kind: 'directory', path: 'work/reference' }],
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial',
    reasonCodes: expect.arrayContaining([
      'dynamic-path-unresolved',
      'source-analysis-unsupported-call'
    ])
  })
})

it.each([
  'copy_function=custom_copy',
  'ignore=custom_ignore',
  '**options',
  'False, None, custom_copy'
])('keeps copytree effects partial with %s', async (extraArguments) => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    `import shutil\nshutil.copytree("inputs/reference", "work/reference", ${extraArguments})`
  )
  expect(result).toMatchObject({
    reads: ['inputs/reference'],
    writes: ['work/reference'],
    writeScopes: [{ kind: 'directory', path: 'work/reference' }],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('captures a wearable sensor QC workflow with compressed and JSON inputs', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'from pathlib import Path',
      'import gzip',
      'import json',
      'import matplotlib.pyplot as plt',
      'import numpy as np',
      'import pandas as pd',
      'work = Path("work")',
      'outputs = Path("outputs")',
      'work.mkdir(parents=True, exist_ok=True)',
      'outputs.mkdir(parents=True, exist_ok=True)',
      'sensors = pd.read_csv("inputs/sensors.csv")',
      'with gzip.open("inputs/reference.csv.gz", "rt") as handle:',
      '    reference = pd.read_csv(handle)',
      'calibration = json.loads(Path("inputs/calibration.json").read_text())',
      'sensors["calibrated"] = sensors["raw"] * calibration["scale"] + calibration["offset"]',
      'sensors.to_parquet("work/calibrated_sensor_data.parquet", index=False)',
      'summary = {"missing": int(sensors.isna().sum().sum()), "reference_rows": len(reference)}',
      'Path("outputs/qc_summary.json").write_text(json.dumps(summary))',
      'plt.plot(np.arange(len(sensors)), sensors["calibrated"].to_numpy())',
      'plt.savefig("outputs/qc.png")'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: expect.arrayContaining([
      'inputs/sensors.csv',
      'inputs/reference.csv.gz',
      join('inputs', 'calibration.json')
    ]),
    writes: expect.arrayContaining([
      'work/calibrated_sensor_data.parquet',
      join('outputs', 'qc_summary.json'),
      'outputs/qc.png'
    ]),
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})

it('captures archive extraction before downstream table analysis', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'import tarfile',
      'import pandas as pd',
      'with tarfile.open("inputs/batch.tar.gz", "r:gz") as archive:',
      '    archive.extractall("work/batch")',
      'frame = pd.read_csv("work/batch/measurements.csv")',
      'frame.to_csv("outputs/summary.csv", index=False)'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: expect.arrayContaining(['inputs/batch.tar.gz', 'work/batch/measurements.csv']),
    writes: expect.arrayContaining(['work/batch', 'outputs/summary.csv']),
    writeScopes: [{ kind: 'directory', path: 'work/batch' }],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})

it('captures a real agent-generated ZIP batch workflow', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    [
      'from zipfile import ZipFile',
      'from pathlib import Path',
      'import csv',
      'import statistics',
      'import json',
      '',
      'archive = Path("inputs/batch.zip")',
      'extract_dir = Path("work/batch")',
      'output_dir = Path("outputs")',
      '',
      'extract_dir.mkdir(parents=True, exist_ok=True)',
      'output_dir.mkdir(parents=True, exist_ok=True)',
      '',
      'with ZipFile(archive) as batch:',
      '    batch.extractall(extract_dir)',
      '',
      'observations_path = extract_dir / "observations.csv"',
      'with observations_path.open(newline="", encoding="utf-8") as file:',
      '    rows = list(csv.DictReader(file))',
      '',
      'temperatures = [float(row["temperature"]) for row in rows]',
      'humidities = [float(row["humidity"]) for row in rows]',
      '',
      'summary = {',
      '    "row_count": len(rows),',
      '    "mean_temperature": statistics.mean(temperatures),',
      '    "mean_humidity": statistics.mean(humidities),',
      '}',
      '',
      'with (output_dir / "summary.json").open("w", encoding="utf-8") as file:',
      '    json.dump(summary, file, indent=2)',
      '',
      'print(len(rows))'
    ].join('\n')
  )
  expect(result).toMatchObject({
    reads: expect.arrayContaining([
      analyzedPythonPath('inputs/batch.zip'),
      analyzedPythonPath('work/batch/observations.csv')
    ]),
    writes: expect.arrayContaining([
      analyzedPythonPath('work/batch'),
      analyzedPythonPath('outputs/summary.json')
    ]),
    writeScopes: [{ kind: 'directory', path: analyzedPythonPath('work/batch') }],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})

it('captures a real agent-generated FASTQ QC workflow', async () => {
  const source = String.raw`from pathlib import Path
import gzip
import csv
import json

input_path = Path("inputs/sample_R1.fastq.gz")
output_dir = Path("outputs")
output_dir.mkdir(parents=True, exist_ok=True)

read_count = 0
total_read_length = 0
total_gc_bases = 0
total_bases = 0
total_phred = 0

with gzip.open(input_path, "rt", encoding="ascii", newline="") as fastq:
    record_number = 0
    while True:
        header = fastq.readline()
        if header == "":
            break

        record_number += 1
        sequence = fastq.readline()
        separator = fastq.readline()
        quality = fastq.readline()

        if sequence == "" or separator == "" or quality == "":
            raise ValueError(f"Incomplete FASTQ record {record_number}")
        if not header.rstrip("\r\n").startswith("@"):
            raise ValueError(f"Invalid FASTQ header in record {record_number}")
        if not separator.rstrip("\r\n").startswith("+"):
            raise ValueError(f"Invalid FASTQ separator in record {record_number}")

        sequence = sequence.rstrip("\r\n")
        quality = quality.rstrip("\r\n")

        if len(sequence) != len(quality):
            raise ValueError(f"Sequence and quality lengths differ in record {record_number}")

        read_length = len(sequence)
        read_count += 1
        total_read_length += read_length
        total_bases += read_length
        total_gc_bases += sum(base in "GgCc" for base in sequence)
        total_phred += sum(ord(score) - 33 for score in quality)

summary = {
    "read_count": read_count,
    "mean_read_length": total_read_length / read_count if read_count else 0.0,
    "gc_fraction": total_gc_bases / total_bases if total_bases else 0.0,
    "mean_phred_quality": total_phred / total_bases if total_bases else 0.0,
}

with (output_dir / "fastq_qc.json").open("w", encoding="utf-8", newline="\n") as json_file:
    json.dump(summary, json_file, indent=2)
    json_file.write("\n")

with (output_dir / "fastq_qc.tsv").open("w", encoding="utf-8", newline="") as tsv_file:
    writer = csv.writer(tsv_file, delimiter="\t", lineterminator="\n")
    writer.writerow(["metric", "value"])
    for metric, value in summary.items():
        writer.writerow([metric, value])`

  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [analyzedPythonPath('inputs/sample_R1.fastq.gz')],
    writes: [
      analyzedPythonPath('outputs/fastq_qc.json'),
      analyzedPythonPath('outputs/fastq_qc.tsv')
    ],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})

it('retains a real agent-generated FASTQ glob as partial batch input lineage', async () => {
  const source = String.raw`from pathlib import Path
import gzip
import csv
import json
import statistics

input_files = sorted(Path("inputs").glob("*.fastq.gz"))
records = []

for path in input_files:
    read_count = 0
    read_lengths = []
    total_bases = 0
    gc_bases = 0
    total_phred = 0

    with gzip.open(path, "rt", encoding="ascii", newline="") as handle:
        while True:
            header = handle.readline()
            if header == "":
                break

            sequence = handle.readline()
            separator = handle.readline()
            quality = handle.readline()

            if sequence == "" or separator == "" or quality == "":
                raise ValueError(f"Incomplete FASTQ record in {path}")

            header = header.rstrip("\r\n")
            sequence = sequence.rstrip("\r\n")
            separator = separator.rstrip("\r\n")
            quality = quality.rstrip("\r\n")

            if not header.startswith("@"):
                raise ValueError(f"Invalid FASTQ header in {path}")
            if not separator.startswith("+"):
                raise ValueError(f"Invalid FASTQ separator in {path}")
            if len(sequence) != len(quality):
                raise ValueError(f"Sequence and quality lengths differ in {path}")

            read_count += 1
            read_length = len(sequence)
            read_lengths.append(read_length)
            total_bases += read_length
            gc_bases += sum(base in "GCgc" for base in sequence)
            total_phred += sum(ord(char) - 33 for char in quality)

    records.append(
        {
            "file": path.as_posix(),
            "read_count": read_count,
            "mean_read_length": statistics.mean(read_lengths) if read_lengths else 0.0,
            "gc_fraction": gc_bases / total_bases if total_bases else 0.0,
            "mean_phred_quality": total_phred / total_bases if total_bases else 0.0,
        }
    )

outputs = Path("outputs")
outputs.mkdir(parents=True, exist_ok=True)

with (outputs / "fastq_batch_qc.json").open("w", encoding="utf-8", newline="\n") as handle:
    json.dump(records, handle, indent=2)
    handle.write("\n")

fields = ["file", "read_count", "mean_read_length", "gc_fraction", "mean_phred_quality"]
with (outputs / "fastq_batch_qc.tsv").open("w", encoding="utf-8", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=fields, delimiter="\t", lineterminator="\n")
    writer.writeheader()
    writer.writerows(records)`

  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [analyzedPythonPath('inputs/*.fastq.gz')],
    writes: [
      analyzedPythonPath('outputs/fastq_batch_qc.json'),
      analyzedPythonPath('outputs/fastq_batch_qc.tsv')
    ],
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial',
    reasonCodes: expect.arrayContaining([
      'dynamic-path-unresolved',
      'source-analysis-unsupported-call'
    ])
  })
})

it('captures a real agent-generated ELISA calibration workflow', async () => {
  const source = String.raw`from pathlib import Path
import csv
import json
import math
import statistics

blank_values = []
standard_values = {}
unknown_values = {}

with Path("inputs/plate.csv").open("r", encoding="utf-8-sig", newline="") as handle:
    reader = csv.DictReader(handle)
    for row in reader:
        role = row["role"].strip()
        absorbance = float(row["absorbance"])
        if not math.isfinite(absorbance):
            raise ValueError("Nonfinite absorbance")
        if role == "blank":
            blank_values.append(absorbance)
        elif role == "standard":
            concentration = float(row["concentration_ng_ml"])
            standard_values.setdefault(concentration, []).append(absorbance)
        else:
            unknown_values.setdefault(row["sample_id"].strip(), []).append(absorbance)

if not blank_values or len(standard_values) < 3:
    raise ValueError("Missing calibration controls")
blank_mean = statistics.mean(blank_values)
standard_concentrations = sorted(standard_values)
x_values = [math.log10(value) for value in standard_concentrations]
y_values = [statistics.mean(value - blank_mean for value in standard_values[key]) for key in standard_concentrations]
x_mean = statistics.mean(x_values)
y_mean = statistics.mean(y_values)
sxx = math.fsum((value - x_mean) ** 2 for value in x_values)
sxy = math.fsum((x - x_mean) * (y - y_mean) for x, y in zip(x_values, y_values))
slope = sxy / sxx
if not math.isfinite(slope) or slope == 0:
    raise ValueError("Calibration slope must be finite and nonzero")
intercept = y_mean - slope * x_mean
results = []
for sample_id in sorted(unknown_values):
    mean_corrected_absorbance = statistics.mean(value - blank_mean for value in unknown_values[sample_id])
    try:
        concentration = 10.0 ** ((mean_corrected_absorbance - intercept) / slope)
    except OverflowError as exc:
        raise ValueError("Concentration overflow") from exc
    results.append({"sample_id": sample_id, "mean_corrected_absorbance": mean_corrected_absorbance, "concentration_ng_ml": concentration})

Path("outputs").mkdir(parents=True, exist_ok=True)
with Path("outputs/calibration.json").open("w", encoding="utf-8", newline="\n") as handle:
    json.dump({"slope": slope, "intercept": intercept, "blank_mean": blank_mean}, handle)
with Path("outputs/concentrations.csv").open("w", encoding="utf-8", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=["sample_id", "mean_corrected_absorbance", "concentration_ng_ml"], lineterminator="\n")
    writer.writeheader()
    writer.writerows(results)`

  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [analyzedPythonPath('inputs/plate.csv')],
    writes: [
      analyzedPythonPath('outputs/calibration.json'),
      analyzedPythonPath('outputs/concentrations.csv')
    ],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reasonCodes: []
  })
})

it('captures a multi-stage ATAC and peak annotation workflow', async () => {
  const source = `from pathlib import Path
import subprocess
import pandas as pd
samples = pd.read_csv("inputs/atac-samples.csv")
Path("work").mkdir(exist_ok=True)
for row in samples.itertuples():
    subprocess.run(["aligner", "-1", row.fastq_r1, "-2", row.fastq_r2, "-o", f"work/{row.sample}.bam"], check=True)
    subprocess.run(["peakcaller", "--bam", f"work/{row.sample}.bam", "--out", f"work/{row.sample}.narrowPeak"], check=True)
peaks = pd.read_csv("inputs/consensus-peaks.bed", sep="\\t")
counts = pd.read_csv("work/peak-counts.tsv", sep="\\t")
peaks.merge(counts, on="peak_id").to_csv("results/differential-peaks.csv", index=False)
Path("results/qc-report.html").write_text("<html>qc</html>")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/atac-samples.csv', 'inputs/consensus-peaks.bed', 'work/peak-counts.tsv'],
    writes: ['results/differential-peaks.csv', join('results', 'qc-report.html')],
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial'
  })
})

it('captures a metagenomic assembly and abundance workflow', async () => {
  const source = `from pathlib import Path
import subprocess
import pandas as pd
manifest = pd.read_csv("inputs/metagenome-manifest.csv")
for row in manifest.itertuples():
    subprocess.run(["assembler", row.reads, "--output", f"work/{row.sample}/contigs.fasta"], check=True)
    subprocess.run(["classifier", f"work/{row.sample}/contigs.fasta", "--database", "inputs/taxonomy-db"], check=True)
tables = [pd.read_csv(f"work/{row.sample}/abundance.tsv", sep="\\t") for row in manifest.itertuples()]
pd.concat(tables).to_parquet("results/taxon-abundance.parquet")
Path("results/metagenome-report.html").write_text("<html>report</html>")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/metagenome-manifest.csv'],
    writes: [join('results', 'metagenome-report.html'), 'results/taxon-abundance.parquet'].sort(),
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial'
  })
})

it('captures multimodal h5mu integration and export', async () => {
  const source = `import muon as mu
import pandas as pd
multi = mu.read_h5mu("inputs/multiome.h5mu")
clinical = pd.read_csv("inputs/cell-clinical.csv")
multi.obs = multi.obs.join(clinical.set_index("cell_id"), on="cell_id")
multi.mod["rna"].write_h5ad("results/rna-annotated.h5ad")
multi.mod["atac"].write_h5ad("results/atac-annotated.h5ad")
multi.write_h5mu("results/integrated.h5mu")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/cell-clinical.csv', 'inputs/multiome.h5mu'],
    writes: ['results/atac-annotated.h5ad', 'results/rna-annotated.h5ad'],
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial'
  })
})

it('captures methylation normalization and differential report outputs', async () => {
  const source = `library(minfi)
library(limma)
targets <- read.csv("inputs/idat-sample-sheet.csv")
rg <- read.metharray.exp(targets = targets)
mset <- preprocessNoob(rg)
beta <- getBeta(mset)
design <- model.matrix(~ targets$condition)
fit <- eBayes(lmFit(beta, design))
dmr <- topTable(fit, number = Inf)
write.csv(dmr, "results/differential-methylation.csv")
saveRDS(mset, "results/normalized-methylation.rds")`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/idat-sample-sheet.csv'],
    writes: ['results/differential-methylation.csv', 'results/normalized-methylation.rds'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('captures a VCF annotation and cohort burden workflow', async () => {
  const source = `from pathlib import Path
import pandas as pd
import subprocess
from cyvcf2 import VCF
manifest = pd.read_csv("inputs/variant-manifest.csv")
rows = []
for sample in manifest.itertuples():
    subprocess.run(["variant-annotator", sample.vcf, "--reference", "inputs/reference.fa", "--output", f"work/{sample.sample}.annotated.vcf.gz"], check=True)
    for variant in VCF(f"work/{sample.sample}.annotated.vcf.gz"):
        rows.append({"sample": sample.sample, "gene": variant.INFO.get("GENE"), "impact": variant.INFO.get("IMPACT")})
burden = pd.DataFrame(rows).groupby(["sample", "gene"]).size().reset_index(name="count")
burden.to_parquet("results/gene-burden.parquet")
Path("results/variant-qc.json").write_text("{}")`
  const access = await analyzeNotebookSourceFileAccess('python', source)
  expect(access.writes).toEqual(['results/gene-burden.parquet', join('results', 'variant-qc.json')])
  expect(access.reads).toContain('inputs/variant-manifest.csv')
  expect(access.externalState).toBe('partial')
})

it('captures an R proteomics quantification and pathway workflow', async () => {
  const source = `library(MSnbase)
library(xcms)
library(limma)
metadata <- read.csv("inputs/proteomics-samples.csv")
raw <- readMSData(metadata$file, mode = "onDisk")
peaks <- findChromPeaks(raw, param = CentWaveParam())
aligned <- adjustRtime(peaks, param = ObiwarpParam())
features <- featureValues(aligned, value = "into")
design <- model.matrix(~ metadata$condition)
fit <- eBayes(lmFit(log2(features + 1), design))
hits <- topTable(fit, number = Inf)
write.csv(hits, "results/differential-proteins.csv")
saveRDS(aligned, "results/aligned-features.rds")
writeLines(capture.output(sessionInfo()), "results/proteomics-session.txt")`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/proteomics-samples.csv'],
    writes: [
      'results/aligned-features.rds',
      'results/differential-proteins.csv',
      'results/proteomics-session.txt'
    ],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('captures a phyloseq microbiome differential abundance workflow', async () => {
  const source = `library(phyloseq)
library(DESeq2)
counts <- read.csv("inputs/otu-counts.csv", row.names = 1)
taxonomy <- read.csv("inputs/taxonomy.csv", row.names = 1)
clinical <- read.csv("inputs/microbiome-clinical.csv")
ps <- phyloseq(otu_table(as.matrix(counts), taxa_are_rows = TRUE), tax_table(as.matrix(taxonomy)), sample_data(clinical))
dds <- phyloseq_to_deseq2(ps, ~ treatment + batch)
dds <- DESeq(dds)
results <- as.data.frame(results(dds, contrast = c("treatment", "case", "control")))
write.csv(results, "results/differential-taxa.csv")
saveRDS(ps, "results/phyloseq-object.rds")
writeLines(capture.output(plot_richness(ps)), "results/richness-report.txt")`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/microbiome-clinical.csv', 'inputs/otu-counts.csv', 'inputs/taxonomy.csv'],
    writes: [
      'results/differential-taxa.csv',
      'results/phyloseq-object.rds',
      'results/richness-report.txt'
    ],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('captures a radiomics cohort preprocessing and survival model workflow', async () => {
  const source = `from pathlib import Path
import pandas as pd
import SimpleITK as sitk
from radiomics import featureextractor
from lifelines import CoxPHFitter
manifest = pd.read_csv("inputs/radiomics-manifest.csv")
features = []
extractor = featureextractor.RadiomicsFeatureExtractor("inputs/radiomics.yaml")
for row in manifest.itertuples():
    image = sitk.ReadImage(row.image)
    mask = sitk.ReadImage(row.mask)
    values = extractor.execute(image, mask)
    features.append({"patient_id": row.patient_id, **values})
frame = pd.DataFrame(features).merge(pd.read_csv("inputs/outcomes.csv"), on="patient_id")
frame.to_parquet("results/radiomics-features.parquet")
CoxPHFitter().fit(frame, duration_col="time", event_col="event").print_summary()
Path("results/radiomics-report.html").write_text("<html>report</html>")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/outcomes.csv', 'inputs/radiomics-manifest.csv', 'inputs/radiomics.yaml'],
    writes: ['results/radiomics-features.parquet', join('results', 'radiomics-report.html')],
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial'
  })
})

it('captures an RNA velocity multi-stage export workflow', async () => {
  const source = `import scanpy as sc
import scvelo as scv
import pandas as pd
adata = scv.read("inputs/spliced-unspliced.loom", cache=True)
metadata = pd.read_csv("inputs/cell-metadata.csv")
adata.obs = adata.obs.join(metadata.set_index("cell_id"), on="cell_id")
sc.pp.filter_and_normalize(adata, min_shared_counts=20)
scv.pp.moments(adata, n_pcs=30, n_neighbors=30)
scv.tl.velocity(adata, mode="dynamical")
scv.tl.velocity_graph(adata)
scv.pl.velocity_embedding_stream(adata, basis="umap", save="-velocity.pdf")
adata.write("results/velocity.h5ad")
adata.obs.to_csv("results/velocity-cell-metadata.csv")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/cell-metadata.csv'],
    writes: ['results/velocity-cell-metadata.csv'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('retains known paths without certifying a readonly SQLite ecology workflow as complete', async () => {
  const source = String.raw`from pathlib import Path
import csv
import json
import sqlite3
import statistics

database_path = Path("inputs/field_observations.sqlite")
output_directory = Path("outputs")
json_path = output_directory / "species_summary.json"
csv_path = output_directory / "species_summary.csv"

summaries = {}
connection = sqlite3.connect(
    "file:inputs/field_observations.sqlite?mode=ro",
    uri=True,
)
try:
    rows = connection.execute("SELECT species, site, count FROM observations")
    for species, site, count in rows:
        if species is None or not str(species).strip():
            raise ValueError("species must be nonempty")
        if count is None:
            raise ValueError("count must be nonnegative")
        try:
            if count < 0 or count != count:
                raise ValueError("count must be nonnegative")
        except TypeError as error:
            raise ValueError("count must be numeric and nonnegative") from error
        species_name = str(species).strip()
        site_name = "" if site is None else str(site)
        if species_name not in summaries:
            summaries[species_name] = {
                "species": species_name,
                "total_count": 0,
                "observation_count": 0,
                "mean_count": 0,
                "median_count": 0,
                "sites": set(),
                "_counts": [],
            }
        summary = summaries[species_name]
        summary["total_count"] += count
        summary["observation_count"] += 1
        summary["_counts"].append(count)
        summary["sites"].add(site_name)
finally:
    connection.close()

species_summary = []
for species_name in sorted(summaries):
    summary = summaries[species_name]
    counts = summary.pop("_counts")
    summary["mean_count"] = statistics.mean(counts)
    summary["median_count"] = statistics.median(counts)
    summary["sites"] = sorted(summary["sites"])
    species_summary.append(summary)

output_directory.mkdir(parents=True, exist_ok=True)
with json_path.open("w", encoding="utf-8") as json_file:
    json.dump(species_summary, json_file, ensure_ascii=False, indent=2, sort_keys=True)
    json_file.write("\n")
with csv_path.open("w", encoding="utf-8", newline="") as csv_file:
    writer = csv.DictWriter(csv_file, fieldnames=["species", "total_count", "observation_count", "mean_count", "median_count", "sites"])
    writer.writeheader()
    for summary in species_summary:
        row = dict(summary)
        row["sites"] = json.dumps(row["sites"], ensure_ascii=False, separators=(",", ":"))
        writer.writerow(row)`

  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/field_observations.sqlite'],
    writes: [
      analyzedPythonPath('outputs/species_summary.csv'),
      analyzedPythonPath('outputs/species_summary.json')
    ],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial',
    reasonCodes: ['dynamic-path-unresolved', 'source-analysis-unsupported-call']
  })
})

it('keeps writable or dynamic SQLite access conservative', async () => {
  const source = String.raw`import sqlite3
connection = sqlite3.connect("inputs/field_observations.sqlite")
table = get_table_name()
rows = connection.execute("SELECT * FROM " + table)
connection.close()`

  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/field_observations.sqlite'],
    writes: ['inputs/field_observations.sqlite'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial',
    reasonCodes: expect.arrayContaining([
      'source-analysis-unsupported-call',
      'dynamic-path-unresolved'
    ])
  })
})

configureTestRuntimeMetadata()
