---
name: openfold3
description: >
  Structure prediction using OpenFold3, an open-weights PyTorch reproduction of
  AlphaFold3 from the AlQuraishi Lab.
  Use this skill when predicting protein/nucleic-acid/ligand complex
  structures with an Apache-2.0-licensed AF3 reimplementation.
license: Apache-2.0
category: biomodels
requirements: [gpu]
metadata:
  display-name: OpenFold3
  # github.com/aqlaboratory/openfold-3/blob/main/LICENSE: Apache-2.0. HF model
  # card and gated prompt confirm. verified 2026-06-30
  third_party:
    - kind: weights
      name: OpenFold3
      provider: OpenFold Consortium
      license: Apache-2.0
      terms_url: https://github.com/aqlaboratory/openfold-3/blob/main/LICENSE
    # SKILL.md — `--use-msa-server` DEFAULTS to true (MSA server is
    # api.colabfold.com), so the sequence leaves the machine unless opted out.
    # No published ToS — wiki is the closest data-use reference.
    - kind: service
      name: ColabFold MSA server (api.colabfold.com)
      provider: Steinegger Lab
      info_url: https://github.com/sokrypton/ColabFold/wiki
---

# OpenFold3 Structure Prediction

## Prerequisites

| Requirement | Minimum | Recommended |
| ----------- | ------- | ----------- |
| Python      | 3.10+   | 3.11        |
| CUDA        | 12.1+   | 12.4+       |
| GPU VRAM    | 24GB    | 80GB (H100) |
| RAM         | 32GB    | 64GB        |
| Disk (weights) | 3GB  | -           |

## How to run

### Installation

```bash
pip install 'openfold3[cuequivariance]==0.4.1'
```

The default attention kernel is DeepSpeed `DS4Sci_EvoformerAttention`. If
DeepSpeed is unavailable, switch to the cuEquivariance triangle kernels (no
build-from-source) by overriding the eval memory settings in
`model_config.py` (`use_deepspeed_evo_attention: False`,
`use_cueq_triangle_kernels: True`). Some pre-built environments already ship
this override; check before re-patching.

### Weights

Apache-2.0, ~2.3 GB from HF `OpenFold/OpenFold3`. The repo is **gated** (auto-approval) — accept the access form on the HF model page and authenticate (`huggingface-cli login` or `HF_TOKEN`) before downloading:

```bash
export OPENFOLD_CACHE=~/.openfold3
huggingface-cli download OpenFold/OpenFold3 checkpoints/of3-p2-155k.pt \
  --local-dir "$OPENFOLD_CACHE"
```

`run_openfold` will also auto-download to `$OPENFOLD_CACHE` on first run if
egress is open and HF credentials are available (either `HF_TOKEN` or a prior
`huggingface-cli login`) with repo access granted. The interactive
`setup_openfold` helper exists but prompts on stdin; prefer the explicit
download above for non-interactive runs.

### Running

```bash
export OPENFOLD_CACHE=/path/to/cache
run_openfold predict \
  --query_json=queries.json \
  --output-dir out/ \
  --use-msa-server false \
  --use-templates false
```

`run_openfold` discovers the checkpoint under `$OPENFOLD_CACHE` automatically.
Only pass `--inference-ckpt-path <file.pt>` if you have a non-standard layout
or multiple checkpoints and need to pin one explicitly.

For MSA + templates (slower, higher accuracy), drop the two `false` flags. The
MSA server is `api.colabfold.com`; template chain-ID remap hits
`data.rcsb.org` (GraphQL) — both must be reachable.

## Query JSON format

OpenFold3 does **not** read FASTA. Queries are a JSON object validated by
`InferenceQuerySet` (pydantic, `extra: forbid` — unknown keys reject):

```json
{
  "queries": {
    "my_complex": {
      "chains": [
        {"molecule_type": "protein", "chain_ids": ["A"], "sequence": "MQIFVK…"},
        {"molecule_type": "protein", "chain_ids": ["B", "C"], "sequence": "MVLSPA…"},
        {"molecule_type": "ligand",  "chain_ids": ["L"], "smiles": "CC(=O)Oc1ccccc1C(=O)O"}
      ],
      "use_msas": true
    }
  },
  "seeds": [42]
}
```

| `molecule_type` | required field |
| -------- | ---- |
| `protein` / `dna` / `rna` | `sequence` |
| `ligand` | `smiles` **or** `ccd_codes: ["HEM"]` |

`chain_ids` is a list — repeat the same sequence across multiple chain IDs
for homo-oligomers. Per-chain `paired_msa_file_paths` / `main_msa_file_paths`
let you supply your own a3m instead of the server.

## Key parameters

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--num-diffusion-samples` | 5 | Structures per (query, seed) |
| `--num-model-seeds` | 1 | Number of model seeds per query (multiplies output count alongside JSON `seeds` and diffusion samples) |
| `--use-msa-server` | true | ColabFold MMseqs2 server for MSA |
| `--use-templates` | true | ColabFold template search + RCSB remap |
| `--inference-ckpt-path` | auto-discovered under `$OPENFOLD_CACHE` | Override only — for non-standard layouts or to pin a specific checkpoint file |

## Output format

```
out/
├── summary.txt
├── model_config.json / experiment_config.json
├── inference_query_set.json
└── <query_name>/seed_<N>/
    ├── <query>_seed_<N>_sample_<k>_model.cif
    ├── <query>_seed_<N>_sample_<k>_confidences.json           # full PAE/pLDDT
    ├── <query>_seed_<N>_sample_<k>_confidences_aggregated.json
    └── timing.json
```

`*_confidences_aggregated.json` is the small one to read first:

```json
{
  "avg_plddt": 78.96, "ptm": 0.667, "iptm": 0.0, "gpde": 0.73,
  "has_clash": 0.0, "sample_ranking_score": 0.133,
  "chain_ptm": {"A": 0.667}, "chain_pair_iptm": {}
}
```

## What good output looks like

- `summary.txt` shows `Successful Queries: N` matching your input count
- avg_plddt > 70 (single-seq) / > 80 (with MSA)
- ptm > 0.6; for complexes, iptm > 0.5
- `has_clash: 0.0`
- `.cif` ~50-150 KB per sample for a small protein

## Verify

```bash
grep -E 'Successful|Failed' out/summary.txt
find out -name '*_model.cif' | wc -l   # = queries x json_seeds x num-model-seeds x num-diffusion-samples
```

---

## Troubleshooting

| Error | Cause | Fix |
| ----- | ----- | --- |
| `_deepspeed_evo_attn requires that DeepSpeed be installed` | default eval kernel is DS4Sci on CUDA | install `deepspeed` (needs nvcc + CUTLASS), **or** in `model_config.py` eval block set `use_deepspeed_evo_attention: False` + `use_cueq_triangle_kernels: True` (cuEq path; no build) |
| `CUTLASS_PATH ... not set ... cutlass_library is not installed` | cuEq path still needs the python `cutlass_library` shim | `pip install nvidia-cutlass` |
| `libXrender.so.1: cannot open shared object file` | rdkit (via pdbeccdutils) needs X11 render libs | `apt-get install libxrender1 libxext6 libsm6` |
| `ModuleNotFoundError: boto3` (or `awscrt`) | `openfold3.core.data.io.s3` is eager-imported even when weights are local | `pip install boto3 awscrt` |
| `ValidationError: queries / Field required` or `Input should be an object` | wrong JSON shape | top-level is `{"queries": {"<name>": {...}}}` (a dict, not a list) |
| `ValidationError ... settings / Extra inputs are not permitted` | tried to override model config via `--runner-yaml` | `--runner-yaml` is `InferenceExperimentConfig` only; kernel/memory settings live in `model_config.py` |
| `Failed to fetch chain ID mappings from RCSB for N entries` | `data.rcsb.org` unreachable (allowlist/offline) | run with `--use-templates false`, or open egress to `data.rcsb.org` |
| `CUDA out of memory` | large complex / many samples | reduce `--num-diffusion-samples`; the `low_mem` preset (`model_setting_presets.yml`) offloads more aggressively |
