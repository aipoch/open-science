---
name: evo2
description: >
  Score, embed, and generate DNA sequences with Evo 2, a long-context genomic
  foundation model. Use this skill when:
  (1) Computing per-nucleotide or per-sequence likelihoods for variant effect
      scoring,
  (2) Embedding genomic windows for downstream classification,
  (3) Generating DNA conditioned on a prefix,
  (4) Scoring regulatory or coding regions across species.
license: Apache-2.0
category: biomodels
requirements: [gpu]
metadata:
  display-name: Evo 2
  # github.com/ArcInstitute/evo2/blob/main/LICENSE: Apache-2.0 boilerplate.
  # HuggingFace model cards `arcinstitute/evo2_{40b_base,20b}` declare
  # `license: apache-2.0`. verified 2026-06-30
  third_party:
    - kind: weights
      name: Evo 2
      provider: Arc Institute
      license: Apache-2.0
      terms_url: https://github.com/ArcInstitute/evo2/blob/main/LICENSE
---

# Evo 2 — DNA Language Model

## Prerequisites

| Requirement | Minimum         | Recommended  |
| ----------- | --------------- | ------------ |
| Python      | 3.11            | 3.12 (<3.13) |
| CUDA        | 12.1+           | 12.4+        |
| GPU VRAM    | 24 GB (7B bf16) | Multiple H100 GPUs (40B) |
| RAM         | 32 GB           | 128 GB       |

## How to run

### Installation

```bash
pip install evo2
# Weights pulled from Hugging Face on first model load.
```

### Loading and scoring

```python
from evo2 import Evo2

model = Evo2("evo2_7b")        # or "evo2_40b" — see model table
seqs = ["ATCG" * 50, "GGGCTTAA" * 25]
ll = model.score_sequences(seqs)   # → list[float], mean per-token log-likelihood
print(ll)
```

### Generation

```python
out = model.generate(
    prompt_seqs=["ATGAAAGCT"],
    n_tokens=256,
    temperature=0.7,
)
print(out.sequences[0])
```

## Models

| Name           | Params | Context | VRAM (bf16) | Notes                                |
| -------------- | ------ | ------- | ----------- | ------------------------------------ |
| `evo2_7b`      | 7 B    | 1 M nt  | ~22 GB      | Default; fits on a single 24 GB+ GPU |
| `evo2_40b`     | 40 B   | 1 M nt  | Multi-GPU   | Requires TE/FP8; multiple H100 GPUs |
| `evo2_1b_base` | 1 B    | 8 K nt  | ~6 GB       | Requires TE/FP8 and a supported GPU |

## Output format

`score_sequences` returns a `list[float]` (or `np.ndarray`) of mean log-likelihoods,
one per input sequence. More negative ⇒ less likely under the model. For variant
effect, compute `Δll = ll_alt - ll_ref` over a fixed window.

`generate` returns a `GenerationOutput` with `.sequences` (list[str]), `.logits`
(list[Tensor]), and `.logprobs_mean` (list[float]) — always populated, no flag required.

## Decision tree

```
Need a DNA model?
│
├─ Per-base/per-sequence likelihood, generation → Evo 2 ✓
├─ Predict experimental tracks (expression, accessibility) → borzoi
└─ Protein, not DNA → fair-esm2 / esmfold2
```

## Remote compute

7B/40B inference is GPU-bound (7B: ≥24 GB VRAM; 40B: multiple H100 GPUs). Read
`compute_details({provider, mode:'read'})` for an environment with `evo2` +
`flash-attn` and a pre-cached HF weight mount, then submit:

```python
c = host.compute.create(provider)
job = c.submitJob(
    intent="Evo2-7B score 200bp variant window — 1×GPU, ~2 min",
    inputs=[{"src": "score_evo2.py", "dstFilename": "score_evo2.py"}],
    command="python3 score_evo2.py",   # env selection is host-specific — see compute_details for your provider
    outputs=["scores.json"],
    timeoutSeconds=1800,
)
print(job.job_id)   # cell ends here — kernel never blocks on compute
```

Retain the exact returned `job_id`. Query that saved ID with the non-blocking
`c.attachJob(job_id).status()` or `.result()` when its state or result is relevant; do not scan Job
history. A final `.result()` read reports whether its follow-up was `suppressed` or had already been
`committed`; otherwise the app starts the later analysis turn for an unread final result. See the
`remote-compute-ssh` skill for details.

Inside `score_evo2.py`, point `HF_HOME` at the provider's weight-cache mount
(path is in `compute_details`) and set `HF_HUB_OFFLINE=1` so the loader
doesn't try to write `refs/` into a read-only mount. Weight footprint:
~15 GB (7B), ~80 GB (40B).

## Typical performance

| Task                         | 7B on H100 | Notes                       |
| ---------------------------- | ---------- | --------------------------- |
| Model load (cached)          | ~5-7 min   | First call hydrates weights |
| `score_sequences`, 200×200bp | ~10-20 s   | After load                  |
| `generate`, 1×512 nt         | ~15 s      |                             |

## Troubleshooting

| Symptom                               | Cause                        | Fix                                         |
| ------------------------------------- | ---------------------------- | ------------------------------------------- |
| `Transformer Engine not installed` | TE is unavailable | In Evo2 0.6.0, only 7B variants fall back to bf16 projections. 40B/20B/1B variants raise `ImportError`; install TE on supported hardware or choose a 7B model. |
| OOM on load | Insufficient GPU memory for the selected model | Use `evo2_7b` or provide sufficient supported GPUs. Vortex handles placement across GPUs visible to the process. For direct execution, select available GPUs with `CUDA_VISIBLE_DEVICES` before starting Python if needed. Under Slurm, request GPUs using the provider's required job directives and preserve the scheduler-set `CUDA_VISIBLE_DEVICES`; setting this variable does not allocate GPUs. Evo2 0.6.0 does not accept `device_map`; do not manually call `.to(device)` on a model split across GPUs. |
| HF tries to write `refs/main`         | `HF_HOME` points at RO mount | Set `HF_HUB_OFFLINE=1`                      |
| `dtype mismatch` in `score_sequences` | Passing tensors not strings  | Pass `list[str]`; the API tokenises for you |

Loading guidance above follows the [Evo2 0.6.0 package](https://pypi.org/project/evo2/0.6.0/)
and its `Evo2` loader. Consult the [upstream installation requirements](https://github.com/ArcInstitute/evo2#installation)
for TE/GPU compatibility; installing TE alone does not establish hardware support.

---

**Next**: pair with `borzoi` to predict track-level effects of the same
variants.
