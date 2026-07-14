---
name: esmfold2
description: >
  Biohub ESMFold2 / ESMFold2-Fast all-atom co-folding (Candido et al. 2026,
  github.com/Biohub/esm). Single-sequence and MSA modes; protein, DNA, RNA,
  ligand (CCD/SMILES), modified residues. FoldBench Ab-Ag 50-55%, PPI 70-77%
  DockQ-pass. Also covers the ESMC-{300M,600M,6B} protein language models from
  the same release: masked-LM logits, hidden states, mutation scoring, contact
  prediction, and the SAE interpretability head. MIT-licensed weights on
  HuggingFace org `biohub`. Use this skill when: (1) Predicting complex
  structures with single-sequence input, (2) Validating designed binders with
  ESMFold2-Fast, (3) Running ESMFold2 with MSA input, (4) Getting ESMC
  embeddings or per-residue mutation scores, (5) Choosing kernel backend and
  sampling-step settings for paper-faithful throughput.

license: Apache-2.0
category: biomodels
requirements: [gpu]
metadata:
  display-name: ESMFold2
  # SKILL.md body: "**License:** MIT (code github.com/Biohub/esm + weights HF
  # `biohub/*`)"
  # github.com/Biohub/esm/blob/main/LICENSE.md: MIT (© 2026 Chan Zuckerberg
  # Biohub, Inc.). verified 2026-06-30
  third_party:
    - kind: weights
      name: ESMFold2 / ESMC
      provider: Biohub
      license: MIT
      terms_url: https://github.com/Biohub/esm/blob/main/LICENSE.md
---

# ESMFold2 (Biohub)

All-atom diffusion co-folding from the Biohub ESM release (2026). ESMFold2 =
48 pair layers with MSA support; ESMFold2-Fast = 24 layers, single-sequence
only, ~1.7x faster.

**License:** MIT (code github.com/Biohub/esm + weights HF `biohub/*`).
**Paper:** "Language Modeling Materializes a World Model of Protein Biology" (2026).

## Install

CUDA 12.x GPU (H100/A100-class); Python **3.12 only**. Fresh venv; needs
egress to HF Hub, GitHub, PyPI:

```bash
pip install --no-cache-dir uv
uv venv --python 3.12 /work/venv && source /work/venv/bin/activate
uv pip install \
  "torch>=2.5,<2.8" einops "biotite>=1.0" rdkit msgpack-numpy biopython \
  scikit-learn brotli attrs pandas cloudpathlib httpx tenacity zstd pydssp \
  pygtrie accelerate huggingface_hub safetensors "numpy<3" networkx \
  sentencepiece tokenizers regex packaging filelock pyyaml typing_extensions \
  "transformers @ git+https://github.com/Biohub/transformers.git@3a8956fb4d4ea16b0ec8e71deef2c2909b6a5cbf"
uv pip install --no-deps "esm @ git+https://github.com/Biohub/esm.git@f652b471"
# OPTIONAL — only affects ESMC attention; trunk speedup comes from set_kernel_backend("fused")
uv pip install ninja packaging wheel setuptools
MAX_JOBS=8 uv pip install --no-deps --no-build-isolation "flash-attn<3"
# Do NOT install transformer-engine — RuntimeError (not ImportError) on import
# slips ESMC's guard and kills ESMFold2Model import.
```

The bundled `esmfold2_gpu` Modal env (remote-compute-modal skill) is the
canonical, version-pinned recipe.

**Gotchas:**
- **Default kernel backend is `None`** (reference PyTorch, ~12x slower than paper). Call `model.set_kernel_backend('fused')` after `from_pretrained()`. See section below.
- Match torch CUDA build to your driver; the pin `<2.8` targets CUDA 12.2.
- Weights via Xet bridge ~300 MB/s: ESMFold2 1.36 GB, ESMFold2-Fast 0.76 GB. Set `HF_HOME=/work/hf_cache`.

## Usage — local model

```python
from esm.models.esmfold2 import (
    ESMFold2InputBuilder, StructurePredictionInput,
    ProteinInput, DNAInput, RNAInput, LigandInput, Modification,
)
from transformers.models.esmfold2.modeling_esmfold2 import ESMFold2Model

model = ESMFold2Model.from_pretrained("biohub/ESMFold2").cuda().eval()
# or "biohub/ESMFold2-Fast" (24 layers, no MSA, ~1.7x faster)
# or "biohub/ESMFold2-Experimental{,-Fast}{,-Cutoff2025}" (4 design-critic models)

spi = StructurePredictionInput(sequences=[
    ProteinInput(id="A", sequence=target_seq),
    ProteinInput(id="B", sequence=binder_seq),
    # DNAInput(id="C", sequence="ACGT", modifications=[Modification(position=5, ccd="C36")]),
    # RNAInput(id="D", sequence="ACGU"),
    # LigandInput(id="L", ccd=["SAH"]),  # or smiles="..."
])
# Homodimer: ProteinInput(id=["A","B"], sequence=seq)

results = ESMFold2InputBuilder().fold(
    model, spi,
    num_loops=10,             # paper FoldBench eval: 10; 20-loop variant: 20
    num_sampling_steps=68,    # paper eval: 68 (truncated EDM)
    num_diffusion_samples=5,  # paper eval: 5/seed
    seed=0,
)
# fold() returns list[Prediction], one per diffusion sample. Each carries
# .plddt [L], .ptm, .iptm, .pae [L,L], .pair_chains_iptm, .complex.to_mmcif().
# Rank by ipTM for complexes / mean pLDDT for monomers:
best = max(results, key=lambda r: float(r.iptm if r.iptm is not None
                                        else r.plddt.mean()))
open("pred.cif", "w").write(best.complex.to_mmcif())
```

**Paper-faithful FoldBench settings:** 10 loops, 68 sampling steps, 25 seeds
x 5 diffusion samples; rank by ipTM (complexes) or pLDDT (monomers); MSA mode
adds `msa_depth=1024` with 10% column masking and ESMC dropout 0.3.

## Model variants on HF `biohub/`

| repo | size | pair layers | MSA | use |
|---|---|---|---|---|
| `ESMFold2` | 0.94 GB + ccd.pkl 0.42 GB | 48 | yes | full eval |
| `ESMFold2-Fast` | 0.76 GB | 24 | no | fast single-seq |
| `ESMFold2-Experimental{,-Fast}` | 0.90 / 0.72 GB | 48 / 24 | — | design search (Alg 11) |
| `ESMFold2-Experimental{,-Fast}-Cutoff2025` | 0.90 / 0.72 GB | — | — | design search + critic |
| `ESMFold2-Experimental-Fast-base{300M,600M,6B}-step{250k..1500k}` | — | — | — | 15 critic ensemble |

## Throughput: `set_kernel_backend("fused")` is REQUIRED

**Default is the slow path.** `ESMFold2Model.from_pretrained(...)` loads with
`_kernel_backend=None` (reference PyTorch) and `chunk_size=64`. You MUST call:

```python
model = ESMFold2Model.from_pretrained("biohub/ESMFold2").cuda().eval()
model.set_kernel_backend("fused")   # vendored Triton TriMul/LN+SwiGLU/pair-bias kernels
model.set_chunk_size(None)           # optimal & OOM-safe L<=1024; use 256 above
```

`"fused"` gives ~1.5–6× trunk speedup over the reference backend, growing with
L; end-to-end `fold()` is diffusion-bound at short L so fused breaks even
around L≈300–400. Fused vs reference outputs are numerically consistent (pLDDT
within noise). `"fused"` (Triton, bundled with the GPU torch wheel) is
**inference-only** — auto-disables under backprop. Above ~L=1400
(`chunk_size=128`) it hits illegal memory access — fall back to
`set_kernel_backend(None)` + `set_chunk_size(64)`; validated through L=1024.

**Do NOT use** `set_kernel_backend("cuequivariance")`: the
`cuequivariance-torch==0.10.0` wheel lacks the compiled ops and **silently
falls back** to the reference path. **`apply_torch_compile()`** is an
alternative (NOT additive — call `set_kernel_backend(None)` first).

## ESMFold2-Experimental* — design hook

Experimental variants expose `res_type_soft` for gradient-guided design — see
`references/design-hook.md`. Do NOT use the fused backend with them (fp32/bf16
dtype crash; the reference path is correct).

## Gotcha: cusolver SVD poison + structseq constructor

The Kabsch alignment in `modeling_esmfold2_common.py` calls
`torch.linalg.svd(H32, driver="gesvd")` on batched 3x3 matrices. NaN/Inf inputs
(degenerate diffusion samples) corrupt the cusolver workspace — **all subsequent
CUDA calls fail with "illegal memory access"**. Monkeypatch: redirect small
batched SVDs to CPU:

```python
_orig_svd = torch.linalg.svd
def _safe_svd(A, full_matrices=True, driver=None):
    if A.is_cuda and A.shape[-1] <= 4 and A.shape[-2] <= 4:
        Acpu = A.detach().float().cpu()
        if not torch.isfinite(Acpu).all():
            Acpu = torch.nan_to_num(Acpu, nan=0.0, posinf=1e6, neginf=-1e6)
        out = _orig_svd(Acpu, full_matrices=full_matrices)
        # torch.return_types.linalg_svd is a C structseq -> ctor takes ONE tuple.
        return type(out)(tuple(t.to(A.device, A.dtype) for t in out))
    return _orig_svd(A, full_matrices=full_matrices, driver=driver)
torch.linalg.svd = _safe_svd
```

Note `type(out)(tuple(...))`, **not** `type(out)(*(...))` — `torch.return_types.*` are
C structseqs whose constructor takes a single tuple argument.

## With-MSA mode

ESMFold2 supports per-chain MSA input via `ProteinInput(id, sequence, msa=MSA)`.
The `MSA` object lives at `esm.utils.msa.msa.MSA`:

```python
from esm.utils.msa.msa import MSA
# ProteinInput, StructurePredictionInput as imported above

msa_A = MSA.from_a3m("/path/chain_A.a3m", max_sequences=2048)
msa_B = MSA.from_a3m("/path/chain_B.a3m", max_sequences=2048)
inp = StructurePredictionInput(sequences=[
    ProteinInput(id="A", sequence=seq_A, msa=msa_A),
    ProteinInput(id="B", sequence=seq_B, msa=msa_B),
])
```

**Gotchas:**
- `MSA.from_a3m(remove_insertions=True)` asserts equal row lengths after
  insertion removal. ColabFold a3m files often carry trailing **null bytes** and
  off-by-one rows vs the query — `tr -d '\000'` and force row 0 to the exact
  query sequence (or `MSA.from_sequences` on manually cleaned, query-length rows).
- **ESMFold2-Fast does NOT support MSA** (single-seq only).
- With-MSA mode improves AbAg interface pass-rate per the paper's evaluation.

## Paper-matched inference configuration

The paper's FoldBench protocol (section A.2.11):

| Parameter | Paper default | Paper "20lp" | Notes |
|---|---|---|---|
| `num_loops` (folding-trunk recycles) | **10** | 20 | +2pp on AbAg |
| `num_sampling_steps` (diffusion) | **68** | 68 | EDM-tuned; do **NOT** use 200 |
| seeds x diffusion samples | 25 x 5 | 25 x 5 | Fig S6/S7 oracle = best-of-125 |

## Training data cutoff

ESMFold2 and ESMFold2-Fast both use a **Sept 2021** PDB training cutoff (HF
`biohub/ESMFold2` README).

## ESMC language model

ESMC is the Biohub successor to ESM-2; three sizes: 300M (30L), 600M (36L),
6B (80L, d=2560). HF path: `AutoModelForMaskedLM.from_pretrained("biohub/ESMC-6B")`.

**Mask token is `<mask>`** (id 32) — use `tok.mask_token`. The native-SDK `_`
convention does NOT apply to the HF tokenizer: `_` is not in the vocab and
encodes to `<unk>`, silently corrupting mutation scores.

Full API, mutation scoring, SAE features, contact prediction: see
`references/esmc.md`.
