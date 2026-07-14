---
name: borzoi
description: >
  Predict genome-wide functional tracks (RNA-seq, CAGE, DNase, ChIP) from DNA
  sequence with Borzoi. Use this skill when:
  (1) Scoring the regulatory effect of a variant on expression/accessibility,
  (2) Generating predicted coverage tracks for a locus,
  (3) Prioritising non-coding variants by predicted track delta.
license: Apache-2.0
category: biomodels
requirements: [gpu]
metadata:
  # SKILL.md loads `johahi/borzoi-replicate-0` — a PyTorch port of Calico's
  # Borzoi ("ported weights (with permission)"). The HuggingFace model card
  # for that exact artifact states `License: cc-by-4.0`. Calico's CODE repo is
  # Apache-2.0, but the weights the skill downloads carry CC-BY-4.0. The model
  # card is where the license is declared (info_url — not a ToU page).
  # verified 2026-06-30
  third_party:
    - kind: weights
      name: Borzoi (PyTorch port)
      provider: Calico Life Sciences
      license: CC-BY-4.0
      info_url: https://huggingface.co/johahi/borzoi-replicate-0
---

# Borzoi — DNA → Functional Track Prediction

## Prerequisites

| Requirement | Minimum | Recommended |
| ----------- | ------- | ----------- |
| Python      | 3.10+   | 3.11        |
| CUDA        | 12.1+   | 12.4+       |
| GPU VRAM    | 16 GB   | 24 GB+      |

## How to run

```python
from borzoi_pytorch import Borzoi

model = Borzoi.from_pretrained("johahi/borzoi-replicate-0").cuda().eval()
# input: (batch, 4, 524288) one-hot DNA  → output: (batch, tracks, 6144) bins
```

Borzoi consumes ~524 kb one-hot windows and emits binned predictions across
7,611 human tracks (the separate 2,608-track mouse head is off by default;
enable via `enable_mouse_head=True` and select with
`forward(..., is_human=False)`). For variant scoring, run ref/alt windows
centred on the variant and compare per-track output.

## Output format

`(B, T, L)` tensor — `T` tracks × `L` 32-bp bins. Track metadata (assay,
biosample) is in `borzoi_pytorch.pytorch_borzoi_model.TRACKS_DF` (or `model.tracks_df` when using the `AnnotatedBorzoi` subclass) — the base `Borzoi` model has no `targets` attribute.


## Remote compute

Needs ≥24 GB VRAM and either pre-cached HF weights or egress to
`huggingface.co`. Read `compute_details({provider, mode:'read'})` for an
environment with `borzoi-pytorch`, then:

```python
c = host.compute.create(provider)
job = c.submit_job(
    intent="Borzoi track prediction for 1 locus — 1×GPU, ~2 min",
    inputs=[{"src": "borzoi_run.py", "dst_filename": "borzoi_run.py"}],
    command="python3 borzoi_run.py",   # env selection is host-specific — see compute_details for your provider
    outputs=["tracks.npz"],
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

If the provider exposes a weight-cache mount, point `HF_HOME` at it inside
`borzoi_run.py` (path is in `compute_details`).


## Troubleshooting

| Symptom                        | Cause                    | Fix                                  |
| ------------------------------ | ------------------------ | ------------------------------------ |
| `module has no __version__`    | Package exposes no attr  | Use `importlib.metadata.version("borzoi-pytorch")` |
| Shape mismatch on input        | Wrong window length      | Pad/crop to 524288 bp (fixed; not exposed as a model attribute) |

---

**Next**: combine track deltas with `evo2` likelihood deltas for a
two-axis variant prioritisation.
