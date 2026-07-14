---
name: alphafold2
description: >
  Predict protein structure for monomers and multimers with AlphaFold2 via the
  ColabFold runner (Mirdita et al. 2022, github.com/sokrypton/ColabFold;
  AlphaFold2 Jumper et al. 2021). Reach for this skill to fold a sequence or
  complex with the AF2/AF2-Multimer evoformer, to validate designed sequences
  by self-consistency pLDDT, ipTM, and RMSD, or to run a quick MSA-backed
  prediction using the public MMseqs2 server.
license: Apache-2.0
category: biomodels
requirements: [gpu]
metadata:
  display-name: AlphaFold2
  # README #model-parameters-license: "AlphaFold parameters … CC BY 4.0".
  # SKILL.md body: "the public MMseqs2 server" (api.colabfold.com — user's
  # sequence is POSTed there for MSA). verified 2026-06-30
  third_party:
    - kind: weights
      name: AlphaFold2
      provider: Google DeepMind
      license: CC-BY-4.0
      terms_url: https://github.com/google-deepmind/alphafold#model-parameters-license
    # api.colabfold.com has no published ToS or privacy policy. The GitHub
    # wiki is the closest data-use reference (info_url, not terms_url).
    # Hostname in `name` so the user sees exactly where their sequence goes.
    - kind: service
      name: ColabFold MSA server (api.colabfold.com)
      provider: Steinegger Lab
      info_url: https://github.com/sokrypton/ColabFold/wiki
---

# AlphaFold2 (ColabFold runner)

This skill wraps AlphaFold2 and AlphaFold2-Multimer through `colabfold_batch`,
which replaces DeepMind's local-database MSA pipeline with a call to the public
MMseqs2 server — so a prediction is one command and one FASTA, not a 2 TB
database mount. AF2 remains the reference monomer predictor and the multimer
model is still a strong protein–protein validator, but it does not handle
ligands or nucleic acids; for those, route to `boltz`, `chai1`, or `openfold3`.
The ColabFold code is MIT (github.com/sokrypton/ColabFold) and the AlphaFold2
code is Apache-2.0 (github.com/google-deepmind/alphafold); the AF2 model
parameters are CC-BY-4.0 with DeepMind's terms of use.

## Running it

```bash
colabfold_batch input.fasta out \
  --num-recycle 3 \
  --model-type alphafold2_multimer_v3
```

The input is a plain FASTA. For a complex, put every chain on one sequence
line separated by `:` — `colabfold_batch` builds a paired MSA per segment and
runs the multimer model when it sees the colon (so the explicit `--model-type
alphafold2_multimer_v3` above is belt-and-braces). For monomers omit
`--model-type` and the colon. `--templates` and `--amber` add PDB templates
and OpenMM relaxation respectively; both are off by default and both add
minutes per model.

ColabFold runs all five AF2 model weights by default and ranks them by pLDDT
(pTM/ipTM for multimer), so output per query lands in `out/` as five ranked
PDBs `<name>_unrelaxed_rank_00{1..5}_*.pdb` (b-factor column carries pLDDT)
and a matching `<name>_scores_rank_00{N}_*.json` with `plddt`, `ptm`, and — for
multimer — `iptm` and the `pae` matrix. Rank-1 is the model to read first;
ipTM > 0.5 is the usual soft pass for an interface.

## Unified-memory defaults loop forever under gVisor — the env patches them out

`colabfold/batch.py` hard-sets `TF_FORCE_UNIFIED_MEMORY=1` and
`XLA_PYTHON_CLIENT_MEM_FRACTION=4.0` on import. Under a gVisor sandbox unified
memory is unsupported, so JAX's `device_put` loops indefinitely allocating
host RAM during AF2 parameter load — the job appears hung, never errors.
Override both before the import (`TF_FORCE_UNIFIED_MEMORY=0`, fraction
`0.95`), or `sed`-patch the two assignments out of `batch.py` in the image
build, or the first fold never starts.

## The MSA server is the wall-clock bottleneck, and it is shared

`colabfold_batch` defaults to `--msa-mode mmseqs2_uniref_env`, which posts your
sequence to `api.colabfold.com`. That server is a public, rate-limited
resource: the wait dominates short folds and occasionally times out under load.
For campaigns, run the MSA stage once with `--msa-only`, keep the resulting
`.a3m` files, and feed the directory back as the input on subsequent runs — the
GPU stage then starts immediately and the server is not hit again.

## Errors worth recognizing

| You see | It means / do this |
|---|---|
| Job hangs silently during "Running model_1" with host RAM climbing | Unified-memory loop under gVisor — see the gotcha above; override or patch `batch.py`. |
| `RESOURCE_EXHAUSTED` / OOM during XLA compile | `XLA_PYTHON_CLIENT_MEM_FRACTION` too high for the GPU — drop below the `0.95` default to `0.9` or so. |
| MSA stage hangs at `Submitting job` | Public MMseqs2 server is rate-limiting — wait, or pre-compute with `--msa-only` and re-run from the cached `.a3m`. |

---

**Next:** for designed-sequence validation, superpose the rank-1 model onto
the design backbone with US-align and gate on pLDDT/ipTM thresholds; for
ligand-bearing complexes, hand the same chains to `boltz` or `chai1`.
