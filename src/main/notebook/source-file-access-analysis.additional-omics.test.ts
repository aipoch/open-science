import { expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

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
    writes: ['results/differential-peaks.csv', 'results/qc-report.html'],
    readState: 'partial',
    writeState: 'partial',
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
    writes: ['results/metagenome-report.html', 'results/taxon-abundance.parquet'],
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
  expect(access.writes).toEqual(['results/gene-burden.parquet', 'results/variant-qc.json'])
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
    writes: ['results/radiomics-features.parquet', 'results/radiomics-report.html'],
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
    writeState: 'complete',
    externalState: 'partial'
  })
})
