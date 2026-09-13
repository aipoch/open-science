import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

describe('clinical statistical file readers', () => {
  it.each([
    ['"inputs/partitions"', 'inputs/partitions'],
    ['source="inputs/cohort.parquet"', 'inputs/cohort.parquet'],
    ['"inputs/partitions", filesystem=None', 'inputs/partitions']
  ])('keeps parquet dataset discovery partial: %s', async (args, path) => {
    const result = await analyzeNotebookSourceFileAccess(
      'python',
      `import pyarrow.parquet as pq\ntable = pq.read_table(${args})`
    )
    expect(result.reads).toEqual([path])
    expect(result.readState).toBe('partial')
  })

  it.each([
    'pq.read_table(path)',
    'pq.read_table("inputs/partitions", filesystem=filesystem)',
    'pq.read_table("inputs/partitions", **options)',
    'pq.read_table("s3://bucket/partitions")'
  ])('does not invent local parquet inputs for unproven sources: %s', async (call) => {
    expect(
      await analyzeNotebookSourceFileAccess('python', `import pyarrow.parquet as pq\n${call}`)
    ).toMatchObject({ reads: [], readState: 'partial' })
  })

  it.each([
    'pyarrow = custom\npyarrow.parquet.read_table("inputs/partitions")',
    'import pyarrow.parquet as pq\npq.read_table = custom\npq.read_table("inputs/partitions")'
  ])('does not trust replaced parquet readers: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({ reads: [] })
  })

  it.each([
    '"inputs/a.tsv.gz", "sample", "outputs/a", NULL, genes, genome, 4, 1000, 100000, 10, 2000, "outputs/qc"',
    '"inputs/a.tsv.gz", QC="outputs/qc", outputNames="outputs/a"',
    'sampleNames="sample", "inputs/a.tsv.gz", "outputs/a", NULL, genes, genome, 4, 1000, 100000, 10, 2000, "outputs/qc"'
  ])('captures matched QC directory arguments: %s', async (args) => {
    expect(
      await analyzeNotebookSourceFileAccess('r', `ArchR::createArrowFiles(${args})`)
    ).toMatchObject({
      writes: ['outputs/a.arrow', 'outputs/qc'],
      writeScopes: [{ kind: 'directory', path: 'outputs/qc' }],
      writeState: 'partial'
    })
  })

  it.each([
    'inputFiles="inputs/a.tsv.gz", QC=qc_path',
    'inputFiles="inputs/a.tsv.gz", o="outputs/ambiguous", QC="outputs/qc"',
    '"inputs/a.tsv.gz", "sample", NULL, NULL, genes, genome, 4, 1000, 100000, 10, "outputs/not-qc"'
  ])('does not invent QC outputs from unproven arguments: %s', async (args) => {
    expect(
      await analyzeNotebookSourceFileAccess('r', `ArchR::createArrowFiles(${args})`)
    ).toMatchObject({ writes: [], writeState: 'partial' })
  })

  it.each([
    ['"inputs/regions.gz", "r"', ['inputs/regions.gz']],
    [
      '"inputs/regions.gz", "r", None, "inputs/regions.csi"',
      ['inputs/regions.csi', 'inputs/regions.gz']
    ],
    [
      '"inputs/regions.gz", "r", None, index="inputs/regions.csi"',
      ['inputs/regions.csi', 'inputs/regions.gz']
    ],
    [
      'filename="inputs/regions.gz", mode="r", parser=None, index="inputs/regions.csi"',
      ['inputs/regions.csi', 'inputs/regions.gz']
    ]
  ])('separates tabix mode, parser and index: %s', async (args, reads) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `import pysam\nhandle = pysam.TabixFile(${args})`
      )
    ).toMatchObject({ reads, writes: [], externalState: 'partial' })
  })

  it.each(['"w"', '"rb"', 'mode'])(
    'does not infer tabix writes for unsupported modes: %s',
    async (mode) => {
      expect(
        await analyzeNotebookSourceFileAccess(
          'python',
          `import pysam\nhandle = pysam.TabixFile("outputs/regions.gz", ${mode})`
        )
      ).toMatchObject({ reads: [], writes: [], readState: 'partial', writeState: 'partial' })
    }
  )

  it.each([
    ['compression="snappy"', true],
    ['compression="snappy", compute=True', true],
    ['"snappy"', false],
    ['"snappy", compute=False', false],
    ['"snappy", True, False, False, False, None, None, None, None, False', false],
    ['"snappy", True, False, False, False, None, None, None, None, True', false],
    ['"snappy", compute=enabled', false],
    ['*options', false],
    ['"snappy", **options', false],
    ['"snappy", filesystem=filesystem', false]
  ])('tracks parquet output only for supported method arguments: %s', async (options, eager) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `import dask.dataframe as dd\nframe = dd.read_parquet("inputs/partitions")\nframe.to_parquet("outputs/partitions", ${options})`
      )
    ).toMatchObject({
      reads: ['inputs/partitions'],
      writes: eager ? ['outputs/partitions'] : [],
      writeState: 'partial'
    })
  })

  it('records Arrow outputs before returning from static input collections', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'ArchR::createArrowFiles(inputFiles=c("inputs/a.tsv.gz", "inputs/b.tsv.gz"), outputNames=c("outputs/a", "outputs/b"), QCDir="outputs/qc")'
      )
    ).toMatchObject({
      reads: ['inputs/a.tsv.gz', 'inputs/b.tsv.gz'],
      writes: ['outputs/a.arrow', 'outputs/b.arrow', 'outputs/qc'],
      writeScopes: [{ kind: 'directory', path: 'outputs/qc' }],
      writeState: 'partial'
    })
  })

  it('preserves Arrow write uncertainty without explicit output names', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'ArchR::createArrowFiles(inputFiles=c("inputs/a.tsv.gz"))'
      )
    ).toMatchObject({ reads: ['inputs/a.tsv.gz'], writes: [], writeState: 'partial' })
  })

  it('records project input collections and directory output scope', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'ArchR::ArchRProject(ArrowFiles=c("inputs/a.arrow", "inputs/b.arrow"), outputDirectory="outputs/project")'
      )
    ).toMatchObject({
      reads: ['inputs/a.arrow', 'inputs/b.arrow'],
      writes: ['outputs/project'],
      writeScopes: [{ kind: 'directory', path: 'outputs/project' }]
    })
  })

  it.each([
    'other::createArrowFiles(inputFiles="inputs/a.tsv.gz", QCDir="outputs/qc")',
    'other::Read10X("inputs/matrix")',
    'other::ArchRProject("inputs/a.arrow", "outputs/project")',
    'other::readVcf("inputs/variants.vcf")',
    'other::read.vcfR("inputs/variants.vcf")'
  ])('does not apply scientific contracts to unrelated packages: %s', async (source) => {
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: [],
      writes: []
    })
  })

  it.each([
    ['read_sav', 'inputs/registry.sav'],
    ['read_dta', 'inputs/registry.dta'],
    ['read_sas7bdat', 'inputs/registry.sas7bdat'],
    ['read_xport', 'inputs/registry.xpt']
  ])('captures the explicit pyreadstat %s input', async (reader, path) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `import pyreadstat\nframe, metadata = pyreadstat.${reader}(filename_path="${path}")`
      )
    ).toMatchObject({ reads: [path], writes: [] })
  })

  it('captures lineage across a complete single-cell analysis workflow', async () => {
    const source = `import scanpy as sc
import pandas as pd
import matplotlib.pyplot as plt
from pathlib import Path

ROOT = Path("inputs")
OUT = Path("outputs")
meta = pd.read_csv(ROOT / "sample_metadata.csv")
adata = sc.read_h5ad(ROOT / "cells.h5ad")
adata.obs = adata.obs.join(meta.set_index("cell_id"), how="left")
adata = adata[adata.obs["qc_pass"]].copy()
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)
sc.tl.pca(adata, n_comps=20)
sc.pl.pca(adata, color="diagnosis", show=False)
plt.savefig(OUT / "pca.png")
adata.write_h5ad(OUT / "filtered_cells.h5ad")
adata.obs.to_csv(OUT / "cell_summary.csv")`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      reads: [join('inputs', 'cells.h5ad'), join('inputs', 'sample_metadata.csv')].sort(),
      writes: [
        join('outputs', 'cell_summary.csv'),
        join('outputs', 'filtered_cells.h5ad'),
        join('outputs', 'pca.png')
      ].sort()
    })
  })

  it.each([
    {
      name: 'bulk RNA-seq quantification',
      language: 'r' as const,
      source:
        'files <- c(A="inputs/A/quant.sf", B="inputs/B/quant.sf")\nmap <- read.csv("inputs/tx2gene.csv")\ntxi <- tximport::tximport(files, type="salmon", tx2gene=map, dropInfReps=TRUE)\nwrite.csv(txi$counts, "outputs/counts.csv")',
      reads: ['inputs/A/quant.sf', 'inputs/B/quant.sf', 'inputs/tx2gene.csv'],
      writes: ['outputs/counts.csv']
    },
    {
      name: 'variant filtering',
      language: 'python' as const,
      source:
        'from cyvcf2 import VCF, Writer\nvcf = VCF("inputs/cohort.vcf.gz")\nout = Writer("outputs/filtered.vcf", vcf)\nfor variant in vcf:\n    if variant.QUAL >= 30:\n        out.write_record(variant)\nout.close()',
      reads: ['inputs/cohort.vcf.gz'],
      writes: ['outputs/filtered.vcf']
    },
    {
      name: 'clinical imaging mask',
      language: 'python' as const,
      source:
        'import SimpleITK as sitk\nimage = sitk.ReadImage("inputs/ct.nii.gz")\nmask = sitk.ReadImage("inputs/tumor_mask.nii.gz")\nresult = sitk.Mask(image, mask)\nsitk.WriteImage(result, "outputs/tumor.nii.gz")',
      reads: ['inputs/ct.nii.gz', 'inputs/tumor_mask.nii.gz'],
      writes: ['outputs/tumor.nii.gz']
    },
    {
      name: 'BAM coverage summary',
      language: 'python' as const,
      source:
        'import pysam\nwith pysam.AlignmentFile("inputs/sample.bam", "rb") as bam:\n    rows = [(c, bam.count(c)) for c in bam.references]\nwith open("outputs/coverage.tsv", "w") as handle:\n    handle.write("chrom\\treads\\n")\n    handle.writelines(f"{c}\\t{n}\\n" for c, n in rows)',
      reads: ['inputs/sample.bam'],
      writes: ['outputs/coverage.tsv']
    },
    {
      name: 'survival cohort export',
      language: 'r' as const,
      source:
        'cohort <- readr::read_csv("inputs/patients.csv")\nfit <- survival::coxph(survival::Surv(time, status) ~ age + treatment, data=cohort)\nsummary <- broom::tidy(fit)\nreadr::write_csv(summary, "outputs/cox-summary.csv")',
      reads: ['inputs/patients.csv'],
      writes: ['outputs/cox-summary.csv']
    }
  ])('captures generated workflow: $name', async ({ language, source, reads, writes }) => {
    expect(await analyzeNotebookSourceFileAccess(language, source)).toMatchObject({ reads, writes })
  })

  it.each([
    {
      name: 'ATAC-seq peak annotation',
      language: 'r' as const,
      source:
        'peaks <- rtracklayer::import("inputs/peaks.bed.gz")\ngenes <- rtracklayer::import("inputs/genes.gtf.gz")\nannotated <- GenomicRanges::findOverlaps(peaks, genes)\nrtracklayer::export(peaks, "outputs/peaks-annotated.bed")',
      reads: ['inputs/genes.gtf.gz', 'inputs/peaks.bed.gz'],
      writes: ['outputs/peaks-annotated.bed']
    },
    {
      name: 'protein quantification matrix',
      language: 'python' as const,
      source:
        'import pandas as pd\nimport numpy as np\nraw = pd.read_csv("inputs/protein_intensity.tsv", sep="\\t")\nqc = raw.loc[raw["missing_fraction"] < 0.5].copy()\nqc["log2_intensity"] = np.log2(qc["intensity"].clip(lower=1))\nqc.to_parquet("outputs/protein-qc.parquet")',
      reads: ['inputs/protein_intensity.tsv'],
      writes: ['outputs/protein-qc.parquet']
    }
  ])('captures generated extended workflow: $name', async ({ language, source, reads, writes }) => {
    expect(await analyzeNotebookSourceFileAccess(language, source)).toMatchObject({ reads, writes })
  })

  it('captures generated HDF5 and torch checkpoint lineage', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import h5py\nimport torch\nwith h5py.File(name="inputs/features.h5", mode="r") as source:\n    values = source["matrix"][:]\ntorch.save(values, f="outputs/features.pt")'
      )
    ).toMatchObject({ reads: ['inputs/features.h5'], writes: ['outputs/features.pt'] })
  })

  it('captures Dask cohort table lineage', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import dask.dataframe as dd\nframe = dd.read_parquet("inputs/cohort/*.parquet")\nframe.to_parquet("outputs/cohort")'
      )
    ).toMatchObject({
      reads: [],
      readState: 'partial',
      writes: ['outputs/cohort'],
      writeScopes: [{ kind: 'directory', path: 'outputs/cohort' }],
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it.each([['muon.read_10x_h5("inputs/multiome.h5", extended=False)', 'inputs/multiome.h5']])(
    'captures Muon multi-omics input: %s',
    async (expression, path) => {
      expect(
        await analyzeNotebookSourceFileAccess('python', `import muon\ndata = ${expression}`)
      ).toMatchObject({
        reads: [path],
        readState: 'complete'
      })
    }
  )

  it('captures explicit WFDB record and annotation roots conservatively', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import wfdb\nrecord = wfdb.rdrecord("inputs/patient01")\nann = wfdb.rdann("inputs/patient01", "atr")\nwfdb.wrsamp("patient01", fs=record.fs, units=record.units, sig_name=record.sig_name, p_signal=record.p_signal, write_dir="outputs")'
      )
    ).toMatchObject({
      reads: [],
      writes: [],
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
  })

  it('captures an R genome annotation input', async () => {
    const expression = 'rtracklayer::import("inputs/peaks.bed.gz")'
    const path = 'inputs/peaks.bed.gz'
    expect(await analyzeNotebookSourceFileAccess('r', `annotation <- ${expression}`)).toMatchObject(
      {
        reads: [path]
      }
    )
  })

  it.each([
    [
      'Seurat::Read10X(data.dir="inputs/filtered_feature_bc_matrix")',
      'inputs/filtered_feature_bc_matrix'
    ],
    [
      'Seurat::Read10X_h5(filename="inputs/filtered_feature_bc_matrix.h5")',
      'inputs/filtered_feature_bc_matrix.h5'
    ]
  ])('captures a Seurat 10x input: %s', async (expression, path) => {
    expect(await analyzeNotebookSourceFileAccess('r', `counts <- ${expression}`)).toMatchObject({
      reads: [path]
    })
  })

  it('maps positional ArchR project output directories', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'r',
        'project <- ArchRProject(arrows, "outputs/archr-project")\nsaveArchRProject(project, "outputs/archr-project")'
      )
    ).toMatchObject({
      reads: [],
      writes: ['outputs/archr-project']
    })
  })

  it('captures a pyreadstat clinical export as an output', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import pyreadstat\npyreadstat.write_sav(frame, dst_path="outputs/registry.sav")'
      )
    ).toMatchObject({ reads: [], writes: ['outputs/registry.sav'] })
  })

  it('captures explicit Arrow parquet read and write paths', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import pyarrow.parquet as pq\ntable = pq.read_table("inputs/cohort.parquet")\npq.write_table(table, where="outputs/cohort.parquet")'
      )
    ).toMatchObject({
      reads: ['inputs/cohort.parquet'],
      writes: ['outputs/cohort.parquet']
    })
  })

  it.each([
    ['pyfaidx.Fasta("inputs/reference.fa")', 'inputs/reference.fa'],
    ['pyranges.read_bed("inputs/regions.bed")', 'inputs/regions.bed'],
    ['pyranges.read_gtf(f="inputs/genes.gtf")', 'inputs/genes.gtf']
  ])('captures a reference annotation reader: %s', async (expression, path) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `import pyfaidx, pyranges\nvalue = ${expression}`
      )
    ).toMatchObject({
      reads: [path]
    })
  })

  it.each([
    ['VariantFile', 'inputs/variants.bcf'],
    ['TabixFile', 'inputs/regions.bed.gz']
  ])('captures the explicit pysam %s input', async (reader, path) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `import pysam\nhandle = pysam.${reader}("${path}")`
      )
    ).toMatchObject({ reads: [path], writes: [] })
  })

  it('captures an explicit pysam TabixFile index', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import pysam\nhandle = pysam.TabixFile("inputs/regions.bed.gz", index="inputs/regions.csi")'
      )
    ).toMatchObject({ reads: ['inputs/regions.bed.gz', 'inputs/regions.csi'], writes: [] })
  })

  it('retains a known pyreadstat input when the filename is dynamic', async () => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        'import pyreadstat\nframe, metadata = pyreadstat.read_sav(filename_path=resolve_input())'
      )
    ).toMatchObject({ reads: [], readState: 'partial' })
  })

  it.each([
    [
      'VariantAnnotation::readVcf(file="inputs/variants.vcf.gz", genome="hg38")',
      'inputs/variants.vcf.gz'
    ],
    ['vcfR::read.vcfR("inputs/variants.vcf")', 'inputs/variants.vcf']
  ])('captures the explicit R variant reader input', async (source, path) => {
    expect(await analyzeNotebookSourceFileAccess('r', `variants <- ${source}`)).toMatchObject({
      reads: [path],
      writes: []
    })
  })

  it('captures a complete spatial transcriptomics workflow', async () => {
    const source = `library(Seurat)
library(ggplot2)
sample <- Load10X_Spatial(data.dir = "inputs/visium_sample", filename = "filtered_feature_bc_matrix.h5")
sample <- SCTransform(sample, assay = "Spatial", verbose = FALSE)
sample <- RunPCA(sample, assay = "SCT")
sample <- FindNeighbors(sample, dims = 1:20)
sample <- FindClusters(sample, resolution = 0.5)
p <- SpatialDimPlot(sample, label = TRUE)
ggsave("outputs/spatial-clusters.png", p, width = 8, height = 6)
saveRDS(sample, "outputs/spatial-object.rds")`
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      reads: ['inputs/visium_sample'],
      writes: ['outputs/spatial-clusters.png', 'outputs/spatial-object.rds'],
      readState: 'partial'
    })
  })

  it.each([
    {
      name: 'methylation beta matrix',
      language: 'python' as const,
      source:
        'import pandas as pd\nfrom pathlib import Path\nbeta = pd.read_parquet(Path("inputs") / "beta.parquet")\npheno = pd.read_csv("inputs/phenotype.csv")\nmerged = beta.join(pheno.set_index("sample_id"), how="inner")\nmerged.to_parquet("outputs/methylation-analysis.parquet")',
      reads: [join('inputs', 'beta.parquet'), 'inputs/phenotype.csv'].sort(),
      writes: ['outputs/methylation-analysis.parquet']
    },
    {
      name: 'ChIP-seq peak table',
      language: 'r' as const,
      source:
        'library(rtracklayer)\npeaks <- import("inputs/chip_peaks.narrowPeak")\nblacklist <- import("inputs/blacklist.bed")\nkept <- peaks[!overlapsAny(peaks, blacklist)]\nexport(kept, "outputs/filtered_peaks.bed")',
      reads: ['inputs/blacklist.bed', 'inputs/chip_peaks.narrowPeak'],
      writes: ['outputs/filtered_peaks.bed']
    },
    {
      name: 'proteomics spectral conversion',
      language: 'r' as const,
      source:
        'library(MSnbase)\nraw <- readMSData(files = c("inputs/sample-a.mzML", "inputs/sample-b.mzML"), mode = "onDisk")\nfiltered <- filterMz(raw, mz = c(500, 1000))\nsummary <- data.frame(retention_time = rtime(filtered), total_intensity = tic(filtered))\nwrite.csv(summary, "outputs/peaks.csv")',
      reads: ['inputs/sample-a.mzML', 'inputs/sample-b.mzML'],
      writes: ['outputs/peaks.csv']
    }
  ])('captures generated omics modality: $name', async ({ language, source, reads, writes }) => {
    expect(await analyzeNotebookSourceFileAccess(language, source)).toMatchObject({ reads, writes })
  })
})

it('captures a complete Python survival analysis report', async () => {
  const source = `import pandas as pd
import matplotlib.pyplot as plt
from lifelines import KaplanMeierFitter, CoxPHFitter
cohort = pd.read_csv("inputs/followup.csv")
cohort = cohort.dropna(subset=["duration", "event", "treatment"])
km = KaplanMeierFitter(label="all participants")
km.fit(cohort["duration"], event_observed=cohort["event"])
km.plot()
plt.savefig("outputs/kaplan-meier.png", dpi=160)
model = CoxPHFitter()
model.fit(cohort[["duration", "event", "age", "treatment"]], duration_col="duration", event_col="event")
model.summary.to_csv("outputs/cox-coefficients.csv")
cohort.to_parquet("outputs/analysis-cohort.parquet")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/followup.csv'],
    writes: [
      'outputs/analysis-cohort.parquet',
      'outputs/cox-coefficients.csv',
      'outputs/kaplan-meier.png'
    ],
    readState: 'complete',
    writeState: 'complete'
  })
})

it('captures a multi-sample spatial integration workflow', async () => {
  const source = `library(Seurat)
library(ggplot2)
control <- Load10X_Spatial(data.dir = "inputs/control", filename = "filtered_feature_bc_matrix.h5", slice = "control")
treated <- Load10X_Spatial(data.dir = "inputs/treated", filename = "filtered_feature_bc_matrix.h5", slice = "treated")
control <- SCTransform(control, assay = "Spatial", verbose = FALSE)
treated <- SCTransform(treated, assay = "Spatial", verbose = FALSE)
anchors <- FindIntegrationAnchors(object.list = list(control, treated), dims = 1:30)
integrated <- IntegrateData(anchorset = anchors, dims = 1:30)
integrated <- RunPCA(integrated, assay = "integrated")
integrated <- FindNeighbors(integrated, dims = 1:20)
integrated <- FindClusters(integrated, resolution = 0.4)
plot <- SpatialDimPlot(integrated, group.by = "seurat_clusters")
ggsave("outputs/integrated-spatial.png", plot, width = 10, height = 6)
saveRDS(integrated, "outputs/integrated-spatial.rds")`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/control', 'inputs/treated'],
    writes: ['outputs/integrated-spatial.png', 'outputs/integrated-spatial.rds'],
    readState: 'partial',
    writeState: 'partial'
  })
})

it('captures remote survival input and model serialization paths', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      `import pandas as pd
from lifelines import CoxPHFitter
cohort = pd.read_csv("https://data.example.test/cohort.csv")
fit = CoxPHFitter().fit(cohort, "duration", "event")
fit.save("outputs/remote-model.json")`
    )
  ).toMatchObject({
    reads: ['https://data.example.test/cohort.csv'],
    writes: ['outputs/remote-model.json'],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it('captures a bulk RNA differential-expression workflow', async () => {
  const source = `library(DESeq2)
counts <- read.csv("inputs/gene-counts.csv", row.names = 1, check.names = FALSE)
metadata <- read.csv("inputs/sample-sheet.csv", row.names = 1)
metadata <- metadata[colnames(counts), , drop = FALSE]
stopifnot(identical(rownames(metadata), colnames(counts)))
dds <- DESeqDataSetFromMatrix(countData = round(as.matrix(counts)), colData = metadata, design = ~ batch + condition)
dds <- dds[rowSums(counts(dds) >= 10) >= 2, ]
dds <- DESeq(dds)
res <- results(dds, contrast = c("condition", "treated", "control"))
rld <- rlog(dds, blind = FALSE)
write.csv(as.data.frame(res), "outputs/deseq2-results.csv")
write.table(assay(rld), "outputs/rlog-matrix.tsv", sep = "\\t", quote = FALSE)
saveRDS(dds, "outputs/deseq2-object.rds")`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/gene-counts.csv', 'inputs/sample-sheet.csv'],
    writes: ['outputs/deseq2-object.rds', 'outputs/deseq2-results.csv', 'outputs/rlog-matrix.tsv'],
    readState: 'partial',
    writeState: 'partial'
  })
})

it('captures a scVI latent-embedding workflow', async () => {
  const source = `import scanpy as sc
import scvi
import pandas as pd
adata = sc.read_h5ad("inputs/normalized-cells.h5ad")
metadata = pd.read_csv("inputs/cell-batches.csv")
adata.obs = adata.obs.join(metadata.set_index("cell_id"), how="left")
sc.pp.highly_variable_genes(adata, n_top_genes=2000, batch_key="batch")
scvi.model.SCVI.setup_anndata(adata, layer="counts", batch_key="batch")
model = scvi.model.SCVI(adata, n_latent=20)
model.train(max_epochs=100)
adata.obsm["X_scVI"] = model.get_latent_representation()
adata.layers["scvi_normalized"] = model.get_normalized_expression(library_size=1e4)
adata.write_h5ad("outputs/scvi-embedded.h5ad")
model.save("outputs/scvi-model", overwrite=True)
pd.DataFrame(adata.obsm["X_scVI"]).to_csv("outputs/scvi-latent.csv", index=False)`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/cell-batches.csv', 'inputs/normalized-cells.h5ad'],
    writes: ['outputs/scvi-embedded.h5ad', 'outputs/scvi-latent.csv', 'outputs/scvi-model'],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it('keeps Squidpy Visium companions unresolved', async () => {
  const source = `import scanpy as sc
import squidpy as sq
adata = sq.datasets.visium_hne_adata()
sc.pp.normalize_total(adata)
sq.gr.spatial_neighbors(adata, coord_type="generic")
sq.gr.spatial_autocorr(adata, mode="moran", genes=["CXCL9", "GZMB"])
sq.pl.spatial_scatter(adata, color=["CXCL9", "GZMB"], save="_markers.png")
adata.write_h5ad("outputs/visium-spatial.h5ad")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [],
    writes: ['outputs/visium-spatial.h5ad'],
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial'
  })
})

it('captures a methylation array normalization workflow', async () => {
  const source = `library(minfi)
library(limma)
targets <- read.csv("inputs/idat-sample-sheet.csv", stringsAsFactors = FALSE)
base <- dirname(targets$Basename[1])
rg <- read.metharray.exp(targets = targets)
rg <- detectionP(rg)
keep <- rowMeans(rg < 0.01) > 0.95
mset <- preprocessFunnorm(rg)
mvals <- getM(mset)[keep, , drop = FALSE]
design <- model.matrix(~ 0 + targets$condition)
fit <- eBayes(lmFit(mvals, design))
contrasts <- makeContrasts(treated - control, levels = design)
result <- topTable(contrasts.fit(fit, contrasts), number = Inf)
write.csv(result, "outputs/methylation-differential.csv")
saveRDS(mset, "outputs/normalized-methylation.rds")`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/idat-sample-sheet.csv'],
    writes: ['outputs/methylation-differential.csv', 'outputs/normalized-methylation.rds'],
    readState: 'partial',
    writeState: 'partial'
  })
})

it('captures an ArchR chromatin-accessibility workflow', async () => {
  const source = `library(ArchR)
addArchRGenome("hg38")
addArchRThreads(threads = 4)
arrow_files <- createArrowFiles(inputFiles = c("inputs/sample-a-fragments.tsv.gz", "inputs/sample-b-fragments.tsv.gz"), sampleNames = c("A", "B"), filterTSS = 4, filterFrags = 1000)
proj <- ArchRProject(ArrowFiles = arrow_files, outputDirectory = "outputs/archr-project", copyArrows = TRUE)
proj <- addDoubletScores(input = proj, k = 10, knnMethod = "UMAP", LSIMethod = 1)
proj <- addIterativeLSI(proj, useMatrix = "TileMatrix", name = "IterativeLSI", iterations = 2)
proj <- addClusters(proj, reducedDims = "IterativeLSI", method = "Seurat", resolution = 0.8)
proj <- addGroupCoverages(proj, groupBy = "Clusters")
proj <- addReproduciblePeakSet(proj, groupBy = "Clusters", pathToMacs2 = "tools/macs2")
markers <- getMarkerFeatures(proj, useMatrix = "PeakMatrix", groupBy = "Clusters", bias = c("TSSEnrichment", "log10(nFrags)"))
write.csv(as.data.frame(markers$Markers), "outputs/archr-peak-markers.csv")
saveArchRProject(proj, outputDirectory = "outputs/archr-project")`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/sample-a-fragments.tsv.gz', 'inputs/sample-b-fragments.tsv.gz'],
    writes: ['outputs/archr-peak-markers.csv', 'outputs/archr-project'],
    readState: 'partial',
    writeState: 'partial'
  })
})

it('captures a two-image registration and radiomics workflow', async () => {
  const source = `import SimpleITK as sitk
import pandas as pd
fixed = sitk.ReadImage("inputs/fixed_ct.nii.gz", sitk.sitkFloat32)
moving = sitk.ReadImage("inputs/followup_ct.nii.gz", sitk.sitkFloat32)
mask = sitk.ReadImage("inputs/fixed_mask.nii.gz", sitk.sitkUInt8)
registration = sitk.ImageRegistrationMethod()
registration.SetMetricAsMattesMutualInformation(numberOfHistogramBins=50)
registration.SetOptimizerAsGradientDescent(learningRate=1.0, numberOfIterations=100)
registration.SetInterpolator(sitk.sitkLinear)
initial = sitk.CenteredTransformInitializer(fixed, moving, sitk.Euler3DTransform())
registration.SetInitialTransform(initial)
transform = registration.Execute(fixed, moving)
registered = sitk.Resample(moving, fixed, transform, sitk.sitkLinear, 0.0, moving.GetPixelID())
masked = sitk.Mask(registered, mask)
sitk.WriteTransform(transform, "outputs/followup-to-baseline.tfm")
sitk.WriteImage(masked, "outputs/registered-tumor.nii.gz")
pixels = sitk.GetArrayViewFromImage(masked)
pd.DataFrame({"mean": [pixels.mean()], "p95": [pd.Series(pixels.ravel()).quantile(0.95)]}).to_csv("outputs/radiomics-summary.csv", index=False)`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/fixed_ct.nii.gz', 'inputs/fixed_mask.nii.gz', 'inputs/followup_ct.nii.gz'],
    writes: [
      'outputs/followup-to-baseline.tfm',
      'outputs/radiomics-summary.csv',
      'outputs/registered-tumor.nii.gz'
    ],
    readState: 'complete',
    writeState: 'complete'
  })
})

it('captures a multi-sample single-cell integration workflow', async () => {
  const source = `from pathlib import Path
import scanpy as sc
import pandas as pd
import harmonypy as hm

root = Path("inputs/processed")
sample_sheet = pd.read_csv("inputs/sample-sheet.csv")
objects = []
for sample in sample_sheet.itertuples():
    adata = sc.read_h5ad(root / f"{sample.sample_id}.h5ad")
    adata.obs["sample_id"] = sample.sample_id
    adata.obs["condition"] = sample.condition
    objects.append(adata)
merged = objects[0].concatenate(objects[1:], batch_key="batch")
sc.pp.highly_variable_genes(merged, batch_key="batch")
sc.pp.scale(merged, max_value=10)
sc.tl.pca(merged, n_comps=50)
harmonized = hm.run_harmony(merged.obsm["X_pca"], merged.obs, "batch")
merged.obsm["X_harmony"] = harmonized.Z_corr.T
sc.tl.umap(merged)
merged.write_h5ad("outputs/integrated-atlas.h5ad")
merged.obs.to_csv("outputs/integrated-cell-metadata.csv")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/sample-sheet.csv'],
    writes: ['outputs/integrated-atlas.h5ad', 'outputs/integrated-cell-metadata.csv'],
    readState: 'partial',
    writeState: 'complete'
  })
})

it('captures a clinical genomics survival and subgroup report workflow', async () => {
  const source = `library(TCGAbiolinks)
library(survival)
library(survminer)
library(readr)

clinical <- GDCquery_clinic(project = "TCGA-COHORT", type = "clinical")
expression <- read_csv("inputs/tcga-expression.csv")
genes <- read_csv("inputs/signature-genes.csv")
cohort <- merge(clinical, expression, by = "patient_id")
cohort$risk <- rowMeans(cohort[genes$symbol], na.rm = TRUE)
cohort$risk_group <- ifelse(cohort$risk >= median(cohort$risk), "high", "low")
fit <- coxph(Surv(days_to_last_follow_up, vital_status) ~ risk_group + age_at_diagnosis, data = cohort)
plot <- ggsurvplot(survfit(Surv(days_to_last_follow_up, vital_status) ~ risk_group, data = cohort))
ggplot2::ggsave("outputs/survival-curve.png", plot$plot)
write_csv(broom::tidy(fit), "outputs/cox-risk-results.csv")
saveRDS(cohort, "outputs/clinical-risk-cohort.rds")`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/signature-genes.csv', 'inputs/tcga-expression.csv'],
    writes: [
      'outputs/clinical-risk-cohort.rds',
      'outputs/cox-risk-results.csv',
      'outputs/survival-curve.png'
    ],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('captures a metabolomics QC batch correction and annotation workflow', async () => {
  const source = `from pathlib import Path
import pandas as pd
import numpy as np
from pycombat import Combat

table = pd.read_csv("inputs/feature-table.csv")
metadata = pd.read_csv("inputs/sample-metadata.csv")
library = pd.read_json("inputs/compound-library.json")
features = table.drop(columns=["sample_id"]).fillna(table.median(numeric_only=True))
corrected = Combat().fit_transform(features, metadata["batch"])
log_intensity = np.log2(np.maximum(corrected, 1e-6))
annotated = pd.DataFrame(log_intensity, columns=features.columns).T.reset_index(names="feature")
annotated = annotated.merge(library, on="feature", how="left")
annotated.to_parquet("outputs/batch-corrected-metabolomics.parquet")
annotated.to_csv("outputs/annotated-metabolites.csv", index=False)
Path("outputs").joinpath("qc-complete.flag").write_text("ok")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [
      'inputs/compound-library.json',
      'inputs/feature-table.csv',
      'inputs/sample-metadata.csv'
    ],
    writes: [
      'outputs/annotated-metabolites.csv',
      'outputs/batch-corrected-metabolomics.parquet',
      'outputs/qc-complete.flag'
    ],
    readState: 'complete',
    writeState: 'complete'
  })
})

it('captures a QIIME2 amplicon denoising and differential abundance workflow', async () => {
  const source = `import qiime2
from qiime2 import Artifact, Metadata
from qiime2.plugins import demux, dada2, feature_table, taxa, diversity

manifest = Metadata.load("inputs/sample-metadata.tsv")
demultiplexed = Artifact.import_data("SampleData[PairedEndSequencesWithQuality]", "inputs/manifest.csv", view_type="PairedEndFastqManifestPhred33V2")
trimmed = demux.methods.emp_paired(demultiplexed)
denoised = dada2.methods.denoise_paired(trimmed.per_sample_sequences, trunc_len_f=240, trunc_len_r=200)
table = denoised.table
taxonomy = Artifact.load("inputs/reference-taxonomy.qza")
filtered = feature_table.methods.filter_samples(table, metadata=manifest, where="treatment IS NOT NULL")
classified = taxa.methods.collapse(filtered.filtered_table, taxonomy=taxonomy, level=6)
distance = diversity.pipelines.beta_phylogenetic(table=filtered.filtered_table, phylogeny=Artifact.load("inputs/tree.qza"), metric="unweighted_unifrac")
table.save("outputs/feature-table.qza")
classified.collapsed_table.save("outputs/genus-table.qza")
distance.distance_matrix.save("outputs/beta-distance.qza")
denoised.stats.save("outputs/denoising-stats.qza")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/reference-taxonomy.qza', 'inputs/sample-metadata.tsv', 'inputs/tree.qza'],
    writes: [
      'outputs/beta-distance.qza',
      'outputs/denoising-stats.qza',
      'outputs/feature-table.qza',
      'outputs/genus-table.qza'
    ],
    readState: 'partial',
    writeState: 'complete'
  })
})

it('captures a paper-style multi-stage TCGA survival and validation workflow', async () => {
  const source = `from pathlib import Path
import pandas as pd
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.linear_model import LogisticRegression
from lifelines import CoxPHFitter

root = Path("inputs")
clinical = pd.read_excel(root / "TCGA-CDR-SupplementalTable.xlsx", sheet_name="BRCA")
expression = pd.read_csv(root / "brca-expression.csv", index_col=0)
signature = pd.read_csv(root / "risk-signature.csv")
cohort = clinical.merge(expression, left_on="bcr_patient_barcode", right_index=True)
features = cohort[signature["gene"].tolist()].fillna(0)
cohort["risk_score"] = features.mul(signature["weight"].to_numpy(), axis=1).sum(axis=1)
cohort[["bcr_patient_barcode", "risk_score", "vital_status"]].to_parquet("outputs/brca-risk-cohort.parquet")
model = CoxPHFitter().fit(cohort[["days_to_death", "vital_status", "risk_score", "age_at_diagnosis"]], "days_to_death", "vital_status")
model.summary.to_csv("outputs/cox-summary.csv")
X = StandardScaler().fit_transform(features)
y = cohort["vital_status"]
pred = cross_val_predict(LogisticRegression(max_iter=2000), X, y, cv=StratifiedKFold(5), method="predict_proba")[:, 1]
pd.DataFrame({"patient": cohort["bcr_patient_barcode"], "death_probability": pred}).to_csv("outputs/validation-predictions.csv", index=False)`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [
      'inputs/TCGA-CDR-SupplementalTable.xlsx',
      'inputs/brca-expression.csv',
      'inputs/risk-signature.csv'
    ],
    writes: [
      'outputs/brca-risk-cohort.parquet',
      'outputs/cox-summary.csv',
      'outputs/validation-predictions.csv'
    ],
    readState: 'complete',
    writeState: 'complete'
  })
})

it('captures an agent-generated multi-stage RNA-seq reproduction script', async () => {
  const source = `library(data.table)
library(DESeq2)
project <- normalizePath(commandArgs(trailingOnly = TRUE)[1], mustWork = FALSE)
inputs <- file.path(project, "inputs")
work <- file.path(project, "work", format(Sys.time(), "%Y%m%d_%H%M%S"))
outputs <- file.path(project, "outputs")
dir.create(work, recursive = TRUE)
dir.create(outputs, recursive = TRUE)
samples <- fread(file.path(inputs, "sample_sheet.tsv"))
samples[, trimmed := file.path(work, paste0(sample_id, ".trimmed.fastq.gz"))]
for (i in seq_len(nrow(samples))) system2("fastp", c("-i", fastq_r1[i], "-o", trimmed[i]))
system2("multiqc", c(file.path(work, "qc"), "-o", file.path(outputs, "multiqc")))
counts <- fread(file.path(inputs, "gene_counts.tsv"))
write.table(counts, file.path(work, "filtered_counts.tsv"), sep = "\\t")
dds <- DESeq(DESeqDataSetFromMatrix(as.matrix(counts[, -1]), samples, ~ condition))
write.table(counts(dds, normalized = TRUE), file.path(outputs, "normalized_counts.tsv"), sep = "\\t")
fwrite(as.data.table(results(dds)), file.path(outputs, "differential_expression.tsv"), sep = "\\t")`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: [],
    writes: [],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('captures an agent-generated metagenome classification and ML script', async () => {
  const source = `from pathlib import Path
import json, subprocess
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.ensemble import RandomForestClassifier

project = Path(".").resolve()
inputs, outputs = project / "inputs", project / "outputs"
work = project / "work" / "run_dynamic"
work.mkdir(parents=True, exist_ok=True); outputs.mkdir(exist_ok=True)
metadata = pd.read_csv(inputs / "sample_metadata.tsv", sep="\\t")
reads = sorted((inputs / "reads").glob("*.fastq.gz"))
reports = []
for read in reads:
    report = work / (read.stem + ".kraken.report")
    subprocess.run(["kraken2", "--db", str(inputs / "taxonomy_db"), "--report", str(report), str(read)], check=True)
    reports.append(pd.read_csv(report, sep="\\t"))
classified = pd.concat(reports)
classified.to_csv(work / "classified_taxa.tsv", sep="\\t", index=False)
relative = classified.pivot_table(index="taxon", columns="sample_id", values="reads", aggfunc="sum", fill_value=0)
relative.to_csv(work / "relative_abundance.tsv", sep="\\t")
coordinates = PCA(n_components=3).fit_transform(relative.T)
pd.DataFrame(coordinates).to_csv(outputs / "pca_coordinates.tsv", sep="\\t", index=False)
RandomForestClassifier(n_estimators=300).fit(relative.T, metadata["group"])
(outputs / "run_manifest.json").write_text(json.dumps({"reports": [str(p) for p in reports]}))`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [],
    writes: [],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('preserves uncertainty for an agent-generated config-driven pipeline', async () => {
  const source = `from pathlib import Path
import json, subprocess, yaml
import pandas as pd
from sklearn.ensemble import RandomForestRegressor

def load_config(path):
    return yaml.safe_load(path.open())

def run_qc(sample, report, tool):
    report.parent.mkdir(parents=True, exist_ok=True)
    with report.open("w") as handle:
        subprocess.run([tool, "--input", str(sample)], stdout=handle, check=True)

config_path = Path("inputs/pipeline.yaml").resolve()
config = load_config(config_path)
project = config_path.parent.parent
input_dir = (project / config["input_dir"]).resolve()
work_dir = (project / config["work_dir"]).resolve()
output_dir = (project / config["output_dir"]).resolve()
samples = sorted((input_dir / "samples").glob("*.tsv"))
summaries = []
for sample in samples:
    report = work_dir / "qc" / f"{sample.stem}.txt"
    run_qc(sample, report, config["external_tool"])
    table = pd.read_csv(sample, sep="\\t")
    summary = table.describe().T
    summary.to_csv(work_dir / "summaries" / f"{sample.stem}.tsv", sep="\\t")
    summaries.append(summary)
features = pd.concat(summaries).fillna(0)
model = RandomForestRegressor(n_estimators=250).fit(features, features.iloc[:, 0])
pd.Series(model.feature_importances_).to_csv(output_dir / "model_feature_importance.tsv")
(output_dir / "final_report.json").write_text(json.dumps({"config": str(config_path)}))`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [],
    writes: [],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('preserves uncertainty for an agent-generated R multi-stage study pipeline', async () => {
  const source = `suppressPackageStartupMessages({library(yaml); library(data.table); library(edgeR)})
cfg <- yaml.load_file("inputs/study.yml")
root <- normalizePath(cfg$project_root, mustWork = FALSE)
raw <- file.path(root, cfg$raw_dir)
work <- file.path(root, cfg$work_dir)
out <- file.path(root, cfg$output_dir)
dir.create(work, recursive = TRUE); dir.create(out, recursive = TRUE)
manifest <- fread(file.path(root, cfg$sample_sheet))
for (i in seq_len(nrow(manifest))) {
  bam <- file.path(raw, manifest$sample_id[i], "aligned.bam")
  counts <- file.path(work, paste0(manifest$sample_id[i], ".counts.tsv"))
  system2(cfg$counter, c("--bam", bam, "--gtf", file.path(root, cfg$annotation), "--out", counts))
  saveRDS(fread(counts), file.path(work, paste0(manifest$sample_id[i], ".rds")))
}
tables <- lapply(manifest$sample_id, function(id) readRDS(file.path(work, paste0(id, ".rds"))))
matrix <- do.call(cbind, lapply(tables, function(x) x$count))
y <- DGEList(counts = matrix, samples = manifest)
y <- calcNormFactors(y)
fit <- glmQLFit(y, model.matrix(~ condition, manifest))
res <- topTags(glmQLFTest(fit, coef = 2), n = Inf)$table
fwrite(res, file.path(out, "differential-expression.tsv"), sep = "\\t")
saveRDS(y, file.path(out, "normalized-dge-object.rds"))
writeLines(capture.output(sessionInfo()), file.path(out, "session-info.txt"))`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/study.yml'],
    writes: [],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('captures an agent-generated clinical prediction training pipeline', async () => {
  const source = `from pathlib import Path
import joblib
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

root = Path("inputs")
train = pd.read_parquet(root / "development-cohort.parquet")
external = pd.read_parquet(root / "external-validation.parquet")
schema = pd.read_json(root / "feature-schema.json")
features = schema["feature"].tolist()
target = "outcome_90d"
numeric = train[features].select_dtypes(include="number").columns
categorical = [c for c in features if c not in numeric]
preprocess = ColumnTransformer([
    ("num", Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())]), numeric),
    ("cat", Pipeline([( "impute", SimpleImputer(strategy="most_frequent")), ("encode", OneHotEncoder(handle_unknown="ignore"))]), categorical),
])
model = Pipeline([( "preprocess", preprocess), ("classifier", LogisticRegression(max_iter=2000, class_weight="balanced"))])
folds = StratifiedKFold(n_splits=5, shuffle=True, random_state=7)
oof = cross_val_predict(model, train[features], train[target], cv=folds, method="predict_proba")[:, 1]
model.fit(train[features], train[target])
external["prediction"] = model.predict_proba(external[features])[:, 1]
Path("outputs").mkdir(exist_ok=True)
joblib.dump(model, "outputs/clinical-risk-model.joblib")
pd.DataFrame({"patient_id": train["patient_id"], "oof_prediction": oof}).to_csv("outputs/oof-predictions.csv", index=False)
external[["patient_id", "prediction"]].to_csv("outputs/external-validation.csv", index=False)
Path("outputs/metrics.json").write_text(str({"oof_auc": roc_auc_score(train[target], oof)}))`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [
      'inputs/development-cohort.parquet',
      'inputs/external-validation.parquet',
      'inputs/feature-schema.json'
    ],
    writes: [
      'outputs/clinical-risk-model.joblib',
      'outputs/external-validation.csv',
      'outputs/metrics.json',
      'outputs/oof-predictions.csv'
    ],
    readState: 'partial',
    writeState: 'partial'
  })
})

it('captures an agent-generated longitudinal clinical feature workflow', async () => {
  const source = `import pandas as pd
import numpy as np
from pathlib import Path
from lifelines import CoxTimeVaryingFitter

root = Path("inputs")
visits = pd.read_csv(root / "patient-visits.csv", parse_dates=["visit_date"])
labs = pd.read_csv(root / "laboratory-results.csv")
medications = pd.read_parquet(root / "medication-exposure.parquet")
visits = visits.merge(labs, on=["patient_id", "visit_date"], how="left")
visits = visits.sort_values(["patient_id", "visit_date"])
visits["prior_admission"] = visits.groupby("patient_id")["admission"].shift(1).fillna(0)
visits["rolling_creatinine"] = visits.groupby("patient_id")["creatinine"].transform(lambda x: x.rolling(3, min_periods=1).mean())
long = visits.merge(medications, on="patient_id", how="left")
Path("work/features").mkdir(parents=True, exist_ok=True)
for patient_id, frame in long.groupby("patient_id"):
    frame.to_parquet(Path("work/features") / f"{patient_id}.parquet")
model = CoxTimeVaryingFitter().fit(long, id_col="patient_id", start_col="start", stop_col="stop", event_col="event")
model.summary.to_csv("outputs/time-varying-cox.csv")
long.to_csv("outputs/longitudinal-feature-table.csv", index=False)`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [
      'inputs/laboratory-results.csv',
      'inputs/medication-exposure.parquet',
      'inputs/patient-visits.csv'
    ],
    writes: ['outputs/longitudinal-feature-table.csv', 'outputs/time-varying-cox.csv'],
    readState: 'partial',
    writeState: 'partial'
  })
})

it('preserves uncertainty for an agent-generated alignment wrapper', async () => {
  const source = `from pathlib import Path
import json, subprocess
import pandas as pd

project = Path(".").resolve()
config = json.loads((project / "inputs" / "alignment-config.json").read_text())
annotation = project / config["annotation"]
sample_sheet = pd.read_csv(project / "inputs" / "sample-sheet.csv")
work = project / "work" / "alignment"
out = project / "outputs"
work.mkdir(parents=True, exist_ok=True); out.mkdir(exist_ok=True)
for row in sample_sheet.itertuples():
    bam = project / row.bam_path
    sorted_bam = work / f"{row.sample_id}.sorted.bam"
    subprocess.run(["samtools", "sort", "-o", str(sorted_bam), str(bam)], check=True)
    subprocess.run(["samtools", "index", str(sorted_bam)], check=True)
bams = [str(work / f"{sample}.sorted.bam") for sample in sample_sheet.sample_id]
subprocess.run(["featureCounts", "-a", str(annotation), "-o", str(out / "gene-counts.tsv"), *bams], check=True)
counts = pd.read_csv(out / "gene-counts.tsv", sep="\\t", comment="#")
counts.to_parquet(out / "gene-counts.parquet")
(out / "run.json").write_text(json.dumps({"samples": len(bams)}))`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: [],
    writes: [],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('captures a paper-style spatial model training and evaluation workflow', async () => {
  const source = `from pathlib import Path
import pandas as pd
import torch
import scanpy as sc

data = Path("data")
results = Path("results")
results.mkdir(exist_ok=True)
train = sc.read_h5ad(data / "slice-train.h5ad")
test = sc.read_h5ad(data / "slice-test.h5ad")
labels = pd.read_csv(data / "layer-labels.csv")
train.obs = train.obs.join(labels.set_index("spot_id"), how="left")
model = torch.nn.Sequential(torch.nn.Linear(train.n_vars, 32), torch.nn.ReLU(), torch.nn.Linear(32, 8))
optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
for _ in range(10):
    optimizer.zero_grad(); loss = model(torch.as_tensor(train.X)).pow(2).mean(); loss.backward(); optimizer.step()
torch.save(model.state_dict(), results / "spatial-model.pt")
embedding = model(torch.as_tensor(test.X)).detach().numpy()
pd.DataFrame(embedding).to_csv(results / "test-embedding.csv", index=False)
pd.DataFrame({"metric": [float(embedding.mean())]}).to_csv(results / "evaluation.csv", index=False)`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['data/layer-labels.csv', 'data/slice-test.h5ad', 'data/slice-train.h5ad'],
    writes: ['results/evaluation.csv', 'results/spatial-model.pt', 'results/test-embedding.csv'],
    readState: 'partial',
    writeState: 'partial'
  })
})

it('preserves uncertainty for a declarative R single-cell workflow', async () => {
  const source = `library(targets)
library(SingleCellExperiment)
library(scater)
library(scran)

config <- yaml::read_yaml("inputs/project.yml")
samples <- read.csv("inputs/samples.csv", stringsAsFactors = FALSE)
tar_option_set(packages = c("DropletUtils", "scater", "scran"))
list(
  targets::tar_target(sample_table, samples),
  targets::tar_target(raw_paths, file.path(config$input_root, sample_table$sample_id, "matrix")),
  targets::tar_target(raw_sce, DropletUtils::read10xCounts(raw_paths), pattern = map(raw_paths)),
  targets::tar_target(qc_sce, scater::addPerCellQC(raw_sce)),
  targets::tar_target(filtered_sce, qc_sce[, qc_sce$sum > config$min_counts]),
  targets::tar_target(norm_sce, scuttle::logNormCounts(filtered_sce)),
  targets::tar_target(reduced_sce, scater::runPCA(norm_sce, ncomponents = 30)),
  targets::tar_target(markers, scran::findMarkers(reduced_sce, groups = reduced_sce$cluster)),
  targets::tar_target(serialized, saveRDS(reduced_sce, "outputs/filtered-sce.rds")),
  targets::tar_target(report, rmarkdown::render("reports/single-cell-summary.Rmd", output_dir = "outputs"))
)`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/project.yml', 'inputs/samples.csv'],
    writes: [],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('captures a multi-sample spatial registration and figure pipeline', async () => {
  const source = `from pathlib import Path
import json
import pandas as pd
import torch
import scanpy as sc

root = Path("inputs")
cfg = json.loads((root / "params.json").read_text())
sample_sheet = pd.read_csv(root / "samples.csv")
out = Path("results")
out.mkdir(exist_ok=True)
embeddings = []
for row in sample_sheet.itertuples():
    source = sc.read_h5ad(root / row.expression_h5ad)
    image = torch.load(root / row.image_tensor, weights_only=True)
    coords = pd.read_csv(root / row.coordinates_csv)
    source.obsm["spatial"] = coords[["x", "y"]].to_numpy()
    source.obsm["image_features"] = image.numpy()
    source.write_h5ad(out / f"{row.sample_id}.registered.h5ad")
    embeddings.append(pd.DataFrame(source.obsm["image_features"]))
combined = pd.concat(embeddings, ignore_index=True)
combined.to_parquet(out / "registered-embeddings.parquet")
combined.to_csv(out / "figure-data.csv", index=False)
(out / "run-manifest.json").write_text(json.dumps({"parameters": cfg, "samples": len(embeddings)}))`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/params.json', 'inputs/samples.csv'],
    writes: [
      'results/figure-data.csv',
      'results/registered-embeddings.parquet',
      'results/run-manifest.json'
    ],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it('preserves uncertainty for a dynamic proteomics QC pipeline', async () => {
  const source = `from pathlib import Path
import pandas as pd
from pyteomics import mzml

root = Path("inputs")
out = Path("outputs")
out.mkdir(exist_ok=True)
records = []
for raw_path in sorted((root / "mzml").glob("*.mzML")):
    tic = 0.0; ms2 = 0
    with mzml.read(str(raw_path)) as reader:
        for spectrum in reader:
            tic += float(spectrum.get("intensity array", []).sum())
            ms2 += int(spectrum.get("ms level", 1) == 2)
    records.append({"sample_id": raw_path.stem, "tic": tic, "ms2_spectra": ms2})
qc = pd.DataFrame(records).merge(pd.read_csv(root / "sample-metadata.csv"), on="sample_id")
qc.to_csv(out / "proteomics-qc.csv", index=False)
qc.to_parquet(out / "proteomics-qc.parquet")
qc.describe(include="all").to_json(out / "proteomics-qc-summary.json")`
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    reads: ['inputs/sample-metadata.csv'],
    writes: [
      'outputs/proteomics-qc-summary.json',
      'outputs/proteomics-qc.csv',
      'outputs/proteomics-qc.parquet'
    ],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})
