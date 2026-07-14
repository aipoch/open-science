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

| Requirement | Minimum | Recommended      |
| ----------- | ------- | ---------------- |
| Python      | 3.11    | 3.12 (<3.13)     |
| CUDA        | 12.1+   | 12.4+            |
| GPU VRAM    | 24 GB (7B bf16) | 80 GB (40B) |
| RAM         | 32 GB   | 128 GB           |

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

| Name        | Params | Context | VRAM (bf16) | Notes                              |
| ----------- | ------ | ------- | ----------- | ---------------------------------- |
| `evo2_7b`   | 7 B    | 1 M nt  | ~22 GB      | Default; fits on a single 24 GB+ GPU |
| `evo2_40b`  | 40 B   | 1 M nt  | ~78 GB      | H100 80 GB or multi-GPU            |
| `evo2_1b_base` | 1 B | 8 K nt  | ~6 GB       | FP8 path requires sm_89+ (H100)    |

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

7B/40B inference is GPU-bound (≥24 GB / 80 GB VRAM). Read
`compute_details({provider, mode:'read'})` for an environment with `evo2` +
`flash-attn` and a pre-cached HF weight mount, then submit:

```python
c = host.compute.create(provider)
job = c.submit_job(
    intent="Evo2-7B score 200bp variant window — 1×GPU, ~2 min",
    inputs=[{"src": "score_evo2.py", "dst_filename": "score_evo2.py"}],
    command="python3 score_evo2.py",   # env selection is host-specific — see compute_details for your provider
    outputs=["scores.json"],
    timeout_seconds=1800,
)
print(job.job_id)   # cell ends here — kernel never blocks on compute
```

Then call the `wait_for_notification` brain-tool. When the
`compute_done` notification arrives, act on its payload:

```python
save_artifacts(payload["featured_files"])   # paths under hpc/<job_id>/
```

For the full result dict (`output_files`, `remote_workdir`, …), re-enter the
kernel: `c.attach_job(job_id).result()` then `c.close()`. See the
`remote-compute-ssh` / `remote-compute-modal` skill for the orchestration
details.

Inside `score_evo2.py`, point `HF_HOME` at the provider's weight-cache mount
(path is in `compute_details`) and set `HF_HUB_OFFLINE=1` so the loader
doesn't try to write `refs/` into a read-only mount. Weight footprint:
~15 GB (7B), ~80 GB (40B).


## Typical performance

| Task                        | 7B on H100 | Notes                       |
| --------------------------- | ---------- | --------------------------- |
| Model load (cached)         | ~5-7 min   | First call hydrates weights |
| `score_sequences`, 200×200bp| ~10-20 s   | After load                  |
| `generate`, 1×512 nt        | ~15 s      |                             |

## Troubleshooting

| Symptom                              | Cause                          | Fix                                        |
| ------------------------------------ | ------------------------------ | ------------------------------------------ |
| `Transformer Engine not installed`   | No FP8 — falls back to bf16    | Informational only on non-H100; ignore     |
| OOM on load                          | 40B on <80 GB GPU              | Use `evo2_7b` or shard with `device_map`   |
| HF tries to write `refs/main`        | `HF_HOME` points at RO mount   | Set `HF_HUB_OFFLINE=1`                     |
| `dtype mismatch` in `score_sequences`| Passing tensors not strings    | Pass `list[str]`; the API tokenises for you |

---

**Next**: pair with `borzoi` to predict track-level effects of the same
variants.
