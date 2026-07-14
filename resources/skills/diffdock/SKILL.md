---
name: diffdock
description: >
  Predict small-molecule binding poses with DiffDock-L (Corso et al. 2023/2024,
  github.com/gcorso/DiffDock) — blind diffusion docking that places a ligand
  into a protein pocket without a predefined search box and ranks the samples
  with a learned confidence model. Reach for this skill to dock a
  SMILES or SDF against a PDB, to generate ranked 3D poses for a small
  fragment library, or to get a starting pose for downstream rescoring.
  DiffDock predicts geometry, not affinity.
license: Apache-2.0
category: biomodels
requirements: [gpu]
metadata:
  display-name: DiffDock
  # github.com/gcorso/DiffDock/blob/main/LICENSE: MIT (© 2022 Corso, Stärk,
  # Jing). verified 2026-06-30
  third_party:
    - kind: weights
      name: DiffDock-L
      license: MIT
      terms_url: https://github.com/gcorso/DiffDock/blob/main/LICENSE
---

# DiffDock-L

DiffDock-L is a blind pose predictor: given a protein structure and a ligand,
it samples ligand placements over the whole surface with a diffusion model and
ranks them with a separately trained confidence head. The confidence score
correlates with pose correctness, not with binding free energy — DiffDock does
not predict whether or how tightly the ligand binds, so for hit triage you
still pair it with a scorer (GNINA, MM-GBSA) or with `boltz`'s affinity head.
For protein–protein and nucleic-acid co-folding, route to `boltz` or `chai1`.
Code and weights are MIT (github.com/gcorso/DiffDock).

## Running it

```bash
cd $DIFFDOCK_REPO   # a clone of github.com/gcorso/DiffDock
python3 -m inference \
  --config default_inference_args.yaml \
  --protein_path target.pdb \
  --ligand_description "COc1ccc(C#N)cc1" \
  --out_dir out
```

For more than one complex, give `--protein_ligand_csv batch.csv` instead of the
two single-complex flags; the CSV has four columns — `complex_name`,
`protein_path`, `ligand_description` (SMILES or an `.sdf`/`.mol2` path), and
`protein_sequence`. Leave `protein_path` empty and fill `protein_sequence` to
have DiffDock fold the receptor with ESMFold first; that path and a
larger-library screening recipe are in `references/workflows.md`.

Under `--out_dir/<complex_name>/` each sample is written as
`rank{N}_confidence{score}.sdf`, plus a copy of `rank1.sdf` for convenience.
The confidence value in the filename is a logit, so it is unbounded and can be
negative; among samples for the *same* complex higher is better, but values are
not comparable across different complexes or ligands.

## The YAML config overwrites your CLI flags

`inference.py` loads `--config default_inference_args.yaml` *after* argparse
and replaces every key it finds, so passing `--samples_per_complex 40` or
`--model_dir ...` on the command line is silently ignored if the same key sits
in the YAML. To change sampling depth or any other key the YAML defines, copy
the YAML, edit the copy, and point `--config` at it.

## The first run is silent for ~11 minutes and needs ≥32 GB host RAM

Before the first complex, DiffDock precomputes SO(3) and torus lookup tables.
That step is silent on stderr, takes ~11 minutes, and on the default Modal
tier runs out of host memory and SIGKILLs mid-precompute. Set
`provider_params.modal.memory: 65536` (or your provider's equivalent), and do
not assume a hang means a crash.

## The README's `--ligand` works on the CLI by accident — use `--ligand_description`

The upstream README shows `--ligand`, which only works because argparse
prefix-matches it to the real flag `--ligand_description`. That shortcut is
CLI-only: as a CSV column header or YAML key, `ligand` matches nothing and the
row is silently treated as having no ligand. Spell the flag and the column
header out in full.

## Errors worth recognizing

| You see | It means / do this |
|---|---|
| `ValueError: not allowed to raise maximum limit` at startup | `setrlimit(NOFILE, 64000)` exceeds the sandbox hard limit — `sed` the constant in `inference.py` to `min(64000, rlimit[1])`. |
| Silent SIGKILL a few minutes into the SO(3) precompute | Host RAM exhausted — see the gotcha above. |
| `python3: not found` | You are on the upstream `rbgcsail/diffdock` image — that one runs from `/home/appuser/DiffDock` under `micromamba`. |

---

**Next:** rescore the `rank1.sdf` poses before ranking ligands against each
other — `boltz`'s affinity head is the in-tree option — since the DiffDock
confidence head alone is not an affinity predictor.
