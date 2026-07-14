---
name: fair-esm2
description: >
  Embed proteins with Meta AI's ESM-2 (`fair-esm` package). Use this skill
  when: (1) Extracting per-residue or per-sequence embeddings for downstream
  ML, (2) Masked-LM likelihood / mutation effect scoring, (3) Contact
  prediction from a sequence.
license: Apache-2.0
category: biomodels
requirements: [gpu]
metadata:
  display-name: ESM-2
  # github.com/facebookresearch/esm/blob/main/LICENSE: MIT (© Meta Platforms,
  # Inc. and affiliates). verified 2026-06-30
  third_party:
    - kind: weights
      name: ESM-2
      provider: Meta AI
      license: MIT
      terms_url: https://github.com/facebookresearch/esm/blob/main/LICENSE
---

# fair-esm2 — ESM-2 (Meta AI)

ESM-2 code and weights are MIT (Meta AI, github.com/facebookresearch/esm).

> **Package disambiguation.** `pip install fair-esm` gives you `import esm`
> with `esm.pretrained.*` (ESM-1/2). Biohub's github.com/Biohub/esm fork
> (MIT) gives you `from esm.models.esmfold2 import ESMFold2InputBuilder` —
> see the **`esmfold2`** skill. Both share the `esm` namespace but are
> different libraries. This skill covers **fair-esm** (the Meta package).

## Prerequisites

| Requirement | Minimum | Recommended |
| ----------- | ------- | ----------- |
| Python      | 3.8+    | 3.11        |
| CUDA        | 11.7+   | 12.x        |
| GPU VRAM    | 8 GB (8M), 16 GB (650M) | 24 GB+ (650M / 3B) |

## How to run

### Embeddings

```python
import torch, esm

model, alphabet = esm.pretrained.esm2_t33_650M_UR50D()
model = model.eval().cuda()
bc = alphabet.get_batch_converter()

_, _, toks = bc([("ubq", "MQIFVKTLTGKTITLEVEPSDTIENVK")])
with torch.no_grad():
    out = model(toks.cuda(), repr_layers=[33])
emb = out["representations"][33]      # (1, L+2, 1280) — includes BOS/EOS
seq_emb = emb[0, 1:-1].mean(0)        # per-sequence mean
```

### Masked-LM scoring

```python
with torch.no_grad():
    out = model(toks.cuda(), repr_layers=[33])
logits = out["logits"][0, 1:-1]       # (L, |vocab|)
# WT marginal log-likelihood; for mutation scoring, mask the position and
# compare logit[mut] − logit[wt].
```

### Contact prediction

```python
with torch.no_grad():
    out = model(toks.cuda(), repr_layers=[33], return_contacts=True)
contacts = out["contacts"][0]         # (L, L)
```

## Models

| Name                       | Layers | Dim  | Params | Use                        |
| -------------------------- | ------ | ---- | ------ | -------------------------- |
| `esm2_t6_8M_UR50D`         | 6      | 320  | 8 M    | Fast smoke / tiny embeddings |
| `esm2_t33_650M_UR50D`      | 33     | 1280 | 650 M  | Default embedding model    |
| `esm2_t36_3B_UR50D`        | 36     | 2560 | 3 B    | Best embeddings, 24 GB+    |

## Output format

`out["representations"][layer]` is `(B, L+2, D)`; slice `[ :, 1:-1, : ]` to
drop BOS/EOS. `out["contacts"]` (when `return_contacts=True`) is `(B, L, L)`.


## Remote compute

Needs ≥16 GB VRAM (650M model) and either pre-cached `.pt` checkpoints or
egress to `dl.fbaipublicfiles.com`. Read
`compute_details({provider, mode:'read'})` for an environment with `fair-esm`
and a torch-hub weight cache, then:

```python
c = host.compute.create(provider)
job = c.submit_job(
    intent="ESM-2 650M embeddings for 200 sequences — 1×GPU, ~2 min",
    inputs=[
        {"src": "seqs.fasta", "dst_filename": "seqs.fasta"},
        {"src": "embed_esm2.py", "dst_filename": "embed_esm2.py"},
    ],
    command="python3 embed_esm2.py",
    environment=...,   # env name from compute_details
    outputs=["embeddings.pt"],
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

Inside `embed_esm2.py`, set `TORCH_HOME` to the provider's torch-hub cache
mount (path is in `compute_details`) so `esm.pretrained.*` resolves locally.


## Troubleshooting

| Symptom                                       | Cause                              | Fix                                   |
| --------------------------------------------- | ---------------------------------- | ------------------------------------- |
| `ModuleNotFoundError: No module named 'esm.models'` | You want Biohub's `esm` fork, not `fair-esm` | See `esmfold2` skill; this skill uses `esm.pretrained.*` |
| Slow first call                               | Downloading weights via torch.hub  | Set `TORCH_HOME` to a cached location |

---

**Next**: feed embeddings to a classifier. For structure prediction, use
`esmfold2`.
