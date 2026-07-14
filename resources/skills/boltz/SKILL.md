---
name: boltz
description: >
  Structure prediction for protein, nucleic-acid, and small-molecule complexes
  with Boltz-2 (Passaro & Wohlwend et al. 2025, github.com/jwohlwend/boltz).
  Reach for this skill to validate designed binders against a target, to
  co-fold a protein with a SMILES or CCD ligand, or to get an open-source
  AlphaFold3 alternative with optional binding-affinity prediction.
license: Apache-2.0
category: biomodels
requirements: [gpu]
metadata:
  # github.com/jwohlwend/boltz/blob/main/LICENSE: MIT (© 2024 Wohlwend, Corso,
  # Passaro). verified 2026-06-30
  third_party:
    - kind: weights
      name: Boltz-2
      license: MIT
      terms_url: https://github.com/jwohlwend/boltz/blob/main/LICENSE
    # SKILL.md — `--use_msa_server` queries api.colabfold.com; the doc says to
    # add it when a chain has no MSA. User's sequence is POSTed there. No
    # published ToS — wiki is the closest data-use reference.
    - kind: service
      name: ColabFold MSA server (api.colabfold.com)
      provider: Steinegger Lab
      info_url: https://github.com/sokrypton/ColabFold/wiki
---

# Boltz-2

Boltz-2 is the open-weights diffusion co-folder closest in surface to
AlphaFold3: a YAML describing protein, DNA, RNA, and ligand chains in, mmCIF
plus pTM/ipTM/pLDDT confidences out, with an optional small-molecule affinity
head. Among our four co-fold skills it is the default for binder-validation
campaigns — fully open MIT weights and the fastest sampler; pick `chai1` when
you want a second independent model for consensus, `openfold3` when AF3-faithful
settings matter, and `esmfold2` when you can live without an MSA. Code and
weights are MIT (PyPI `boltz`, github.com/jwohlwend/boltz).

## Running it

```yaml
# complex.yaml
version: 1
sequences:
  - protein:
      id: A
      sequence: MVTPEGNVSLVDESLLVGVTDEDRAVRS...   # target
  - protein:
      id: B
      sequence: AIQRTPKIQVYSRHPAENG...            # binder
  - ligand:
      id: L
      smiles: 'N[C@@H](Cc1ccc(O)cc1)C(=O)O'      # or  ccd: SAH
```

```bash
boltz predict complex.yaml \
    --use_msa_server --out_dir out/ --recycling_steps 3 --diffusion_samples 5
```

Each protein chain needs an MSA; without one the run exits before the model
loads. `--use_msa_server` queries `api.colabfold.com` (expect a 30–90 s pause
per chain) and is the right default unless you already have an `.a3m` to name
under `msa:` in the YAML. Setting `msa: empty` forces single-sequence mode —
that is an accuracy sacrifice, not a speed or memory optimization, because the
MSA search runs on CPU before the GPU stage starts.

Per input the output lands at `out/boltz_results_complex/predictions/complex/`.
Read `confidence_complex_model_0.json` first: `iptm` > 0.5 is the community
pass line for an interface, `complex_plddt` > 0.7 for the fold itself, and
`confidence_score` is the weighted aggregate the structures are ranked by.
Structures themselves are `complex_model_{0..N-1}.cif` (or `.pdb` with
`--output_format pdb`).

## Affinity head

Add a `properties:` block naming one `ligand` chain as the binder and Boltz-2
predicts protein–small-molecule binding affinity alongside the structure:

```yaml
properties:
  - affinity:
      binder: L            # the ligand chain id, not the protein
```

Output gains `affinity_complex.json` next to the confidence file:
`affinity_pred_value` is log10(IC50 in μM) — lower is tighter (≈0 → 1 μM,
−3 → 1 nM); `affinity_probability_binary` is the 0–1 binder-vs-non-binder
score and is what to rank hits by. One affinity ligand per input; the binder
must be a `ligand` chain (no protein–protein affinity), and Boltz v2.2.x caps
affinity ligands at 128 atoms. FASTA inputs cannot request affinity at all.

## `msa: empty` is an accuracy hit, not a memory save

Single-sequence mode has been suggested elsewhere as a way to fit smaller GPUs.
It does not help: the MSA search is CPU-side, so `--use_msa_server` versus
`msa: empty` changes nothing about peak VRAM. If you OOM, lower
`--diffusion_samples` or `--max_parallel_samples`, or move to an 80 GB tier;
do not trade away the MSA for it.

## Missing fast kernels are slow, not fatal

`ImportError` for `cuequivariance_ops_torch` or its `libcue_ops.so` means the
compiled triangle-kernel package is not on the loader path. `--no_kernels`
falls back to the reference PyTorch path — roughly 2× slower, numerically
identical, so it is the right unblock for a one-off and the wrong choice for a
campaign.

## Errors worth recognizing

| You see | It means / do this |
|---|---|
| `Missing MSA's in input and --use_msa_server flag not set` | A protein chain has no MSA — add `--use_msa_server` or set `msa:` to an `.a3m` path in the YAML. |
| `ImportError: ... cuequivariance_ops_torch` / `libcue_ops.so` | Fast-kernel wheel not visible — add `--no_kernels` (slower, correct) or fix the env's `LD_LIBRARY_PATH`. |
| `KeyError: 'iptm'` reading the confidence JSON | Single-chain input — ipTM is interface-only; read `ptm` instead. |
| No `affinity_*.json` in output | Used FASTA input, or the YAML is missing the `properties:` block — see *Affinity head* above. |

---

**Next:** compute clash and interface metrics on passing complexes, or feed
them back to `proteinmpnn` for another design round.
