---
name: scvi-tools
description: >
  Probabilistic single-cell RNA-seq with scvi-tools — scVI for a
  batch-corrected latent space, scANVI for semi-supervised label transfer,
  and Bayesian differential expression. Reach for this skill to integrate
  scRNA-seq batches, embed cells for clustering, transfer annotations from a
  reference onto a query, or score differentially expressed genes per cluster.
  For spatial deconvolution / mapping use the cell2location, DestVI, or
  Tangram methods instead.
license: Apache-2.0
requirements: [gpu]
metadata:
  display-name: scvi-tools
---

# scvi-tools — scVI / scANVI

scvi-tools (Gayoso et al. 2022, github.com/scverse/scvi-tools, BSD-3-Clause)
wraps a family
of deep generative models for single-cell omics. The scRNA-seq core is **scVI**
(unsupervised batch-corrected latent embedding) and **scANVI** (scVI + a
classifier head for semi-supervised cell-type label transfer). Both expect
**raw integer UMI counts** and emit a low-dimensional `X_scVI` / `X_scANVI`
that drops into the scanpy neighbors → leiden → umap pipeline.

## Setup (any agent, no API key)

This is a **pure skill** — `kernel.py` is deterministic Python and *you* (the
base model) do all the reasoning. There is no `host` runtime and no LLM API.
The only helper here is `h5ad_safe_obs`, which coerces an obs/var frame so
`anndata.write_h5ad()` succeeds. Load it once per session in a Python cell:

```python
exec(open("scvi-tools/kernel.py").read())   # path to this skill's kernel.py
```

Nothing auto-loads it outside Claude Science. Then call `h5ad_safe_obs(...)`
directly. If it raises `NameError`, you haven't exec'd kernel.py.

Dependencies: `pip install scvi-tools scanpy anndata`. Training needs a
CUDA-capable GPU — see [Remote compute](#remote-compute-rent-a-gpu) to fall out
to a rented GPU when you don't have one locally.

## How to run

### scVI — batch-corrected latent space

```python
import scanpy as sc
import scvi

adata = sc.read_h5ad("dataset.h5ad")
adata.layers["counts"] = adata.X.copy()          # preserve raw BEFORE any normalize/log1p
sc.pp.normalize_total(adata); sc.pp.log1p(adata) # optional, for HVG / plotting only
sc.pp.highly_variable_genes(adata, n_top_genes=2000, batch_key="batch", subset=True)

scvi.model.SCVI.setup_anndata(adata, layer="counts", batch_key="batch")
model = scvi.model.SCVI(adata, n_latent=30)
model.train(max_epochs=200, early_stopping=True, accelerator="gpu", devices=1)

adata.obsm["X_scVI"] = model.get_latent_representation()
adata.layers["scvi_normalized"] = model.get_normalized_expression(library_size=1e4)
```

### scANVI — label transfer from a partially-annotated reference

```python
lvae = scvi.model.SCANVI.from_scvi_model(
    model, labels_key="cell_type", unlabeled_category="Unknown",
)
lvae.train(max_epochs=20, n_samples_per_label=100, accelerator="gpu", devices=1)

adata.obsm["X_scANVI"] = lvae.get_latent_representation()
adata.obs["pred_cell_type"] = lvae.predict()
```

`accelerator="gpu", devices=1` is the PyTorch-Lightning spelling; the legacy
`use_gpu=` kwarg was **removed** in scvi-tools 1.x and now raises `TypeError`.

## Differential expression

```python
de = model.differential_expression(
    groupby="leiden", group1="3",   # group2=None → vs. all other cells
    mode="change", delta=0.25,
)
top = de.sort_values("proba_de", ascending=False).head(50)
```

For one-vs-rest leave `group2` out — `"rest"` is scanpy's
`rank_genes_groups` convention, not scvi-tools'; here `group2` is a literal
category name and `"rest"` would match zero cells.

scvi-tools ≥1.4 defaults to `mode="vanilla"`, whose result columns are
exactly:

```
['proba_m1', 'proba_m2', 'bayes_factor', 'scale1', 'scale2', 'raw_mean1',
 'raw_mean2', 'non_zeros_proportion1', 'non_zeros_proportion2',
 'raw_normalized_mean1', 'raw_normalized_mean2', 'comparison', 'group1',
 'group2']
```

— no `lfc_*`, no `proba_de`, no `is_de_fdr_*`. **Pass `mode="change"`** to
get `lfc_mean` / `lfc_median` / `proba_de` / `is_de_fdr_0.05`. Sort on
`proba_de` (or on `bayes_factor` if you deliberately stayed in vanilla
mode).

## Output format

| Key                            | What                                                   |
| ------------------------------ | ------------------------------------------------------ |
| `adata.obsm["X_scVI"]`         | `n_cells × n_latent` batch-corrected embedding         |
| `adata.obsm["X_scANVI"]`       | label-aware embedding (better separates known classes) |
| `adata.obs["pred_cell_type"]`  | scANVI predicted label per cell                        |
| `adata.layers["scvi_normalized"]` | decoded expression, library-size normalized         |
| DE dataframe                   | per-gene `lfc_*` / `proba_de` (with `mode="change"`)   |

## Remote compute (rent a GPU)

An A100-class GPU is recommended for >50k cells. Training is a plain Python
script (`pipeline.py`) that reads counts, trains scVI/scANVI, and writes the
output `.h5ad` — run it on whatever GPU you have (a local/cluster CUDA box, or a
serverless GPU host such as Modal). There is no Claude-Science compute broker
here; drive the GPU host directly.

**Modal** (serverless GPU) — wrap `pipeline.py` in a Modal app and run it with
the Modal CLI (`modal run pipeline.py`), which blocks until the job finishes, so
you read the result synchronously (no notification tool needed):

```python
# pipeline.py — run with:  modal run pipeline.py
import modal
image = (modal.Image.debian_slim()
         .pip_install("scvi-tools==1.4.2", "scanpy==1.11.5", "anndata==0.11.4"))
app = modal.App("scvi-run", image=image)
vol = modal.Volume.from_name("scvi-data", create_if_missing=True)  # holds dataset.h5ad / out.h5ad

@app.function(gpu="A100", timeout=3600, volumes={"/data": vol})
def train():
    import scanpy as sc, scvi   # noqa
    adata = sc.read_h5ad("/data/dataset.h5ad")
    # ... setup_anndata / scVI / scANVI / DE — see the recipe above ...
    adata.obs = h5ad_safe_obs(adata.obs)   # paste the helper into THIS script (below)
    adata.write_h5ad("/data/out.h5ad")
    vol.commit()

@app.local_entrypoint()
def main():
    train.remote()   # blocks until done; then read /data/out.h5ad from the volume
```

`h5ad_safe_obs` is loaded via `exec` in your **local** session (see **Setup**);
inside `pipeline.py` running remotely it is not defined, so paste the helper at
the top of that script (or inline the `pd.Index(np.asarray(..., dtype=object))`
coercion) before `.write_h5ad()`.

For a local/cluster GPU, just run `pipeline.py` directly where CUDA is visible —
no wrapper needed. (For a fuller Modal workflow see the `remote-compute-modal`
skill.)

## Gotchas

| Gotcha | What happens / fix |
|---|---|
| `differential_expression()` defaults to `mode="vanilla"` (scvi-tools ≥1.4) | `KeyError: 'lfc_mean'` / `'proba_de'` when sorting — pass `mode="change"` to get `lfc_*`/`proba_de`/`is_de_fdr_*`; in vanilla mode sort on `bayes_factor`. |
| `adata.obs` index/columns are `string[pyarrow]` (`ArrowStringArray`) | `.write_h5ad()` dies with `IORegistryError: No method registered for writing <class 'pandas.arrays.ArrowStringArray'>` (anndata #2377). Coerce before writing: `adata.obs = h5ad_safe_obs(adata.obs)` (kernel helper — load it via `exec` locally, see Setup; inline the coercion in a remote `pipeline.py`). **`.astype(str)` alone is not enough** — on a pyarrow-backed Index/Series it returns another Arrow-backed array; round-trip through `np.asarray(..., dtype=object)`. `anndata.settings.allow_write_nullable_strings = True` does **not** cover Arrow-backed strings. |
| `use_gpu=` kwarg | Removed in 1.x → `TypeError: train() got an unexpected keyword argument 'use_gpu'`. Use `accelerator="gpu", devices=1`. |
| Log-normalized data fed to `setup_anndata` | Silent garbage — scVI's NB likelihood needs raw integer counts. Stash counts in `adata.layers["counts"]` *before* normalize/log1p and pass `layer="counts"`. |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `KeyError: 'lfc_mean'` (or `'proba_de'`, `'is_de_fdr_0.05'`) on DE result | Add `mode="change"` to `differential_expression()`; the default vanilla mode has no LFC columns. |
| `IORegistryError: No method registered for writing <class 'pandas.arrays.ArrowStringArray'>` on `.write_h5ad()` | `adata.obs = h5ad_safe_obs(adata.obs)` (and `adata.var` if needed) before writing. The `allow_write_nullable_strings` flag does not help here. |
| `TypeError: ... unexpected keyword argument 'use_gpu'` | Replace with `accelerator="gpu", devices=1`. |
| `ValueError: ... non-negative integers` / NB loss explodes | `layer="counts"` points at log/float data — restore raw counts. |
| `MisconfigurationException: No supported gpu backend found` | No CUDA visible — drop `accelerator`/`devices` to fall back to CPU, or dispatch via Remote compute. |
| `UnicodeEncodeError: 'ascii' codec can't encode character ...` writing a summary / printing | Container has no `LANG` so Python defaults to ASCII. Open files with `encoding="utf-8"` and/or `sys.stdout.reconfigure(encoding="utf-8")` at script top, or set `PYTHONIOENCODING=utf-8` in the image. |

---

**Next**: cluster on `X_scVI` with scanpy (`sc.pp.neighbors(use_rep="X_scVI")`
→ `sc.tl.leiden` → `sc.tl.umap`); for spatial deconvolution train
cell2location / DestVI / Tangram on the scRNA-seq reference.
