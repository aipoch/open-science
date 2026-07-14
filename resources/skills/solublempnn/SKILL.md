---
name: solublempnn
description: >
  Inverse-fold a backbone with SolubleMPNN — ProteinMPNN retrained on a
  soluble-PDB subset (Dauparas et al. 2022) — for sequences biased toward
  cytosolic expression and reduced aggregation. Reach for this skill when designs from vanilla
  ProteinMPNN are aggregating or going to inclusion bodies, when redesigning a
  membrane-adjacent fold for soluble expression, or when an E. coli expression
  screen is the next step.
license: Apache-2.0
category: biomodels
metadata:
  display-name: SolubleMPNN
  # github.com/dauparas/ProteinMPNN/blob/main/LICENSE: MIT (© 2022 Justas
  # Dauparas). soluble_model_weights ship in the same repo with no separate
  # license. verified 2026-06-30
  third_party:
    - kind: weights
      name: SolubleMPNN
      license: MIT
      terms_url: https://github.com/dauparas/ProteinMPNN/blob/main/LICENSE
---

# SolubleMPNN

SolubleMPNN is not a separate package — it is the ProteinMPNN architecture
retrained on a soluble-PDB subset, which shifts the output distribution away
from the surface hydrophobics that the full-PDB model happily places (because
many of them are buried at crystallographic or membrane interfaces in the
training set). Reach for it when the goal is soluble yield in a heterologous
host; stick with `proteinmpnn` when native-like recovery matters more, since
the soluble prior trades a few points of recovery for the surface bias. Code
and weights are MIT (github.com/dauparas/ProteinMPNN, `soluble_model_weights`;
also exposed via github.com/dauparas/LigandMPNN). The model is small enough to
run on CPU — for a handful of sequences on one backbone that is seconds and
usually faster than dispatching; a GPU helps for batched campaigns. Either way
the repo is cloned in-job (no PyPI dist; checkpoints bundled).

## Running it

```bash
pip install torch numpy   # if not already present
git clone --depth 1 https://github.com/dauparas/ProteinMPNN.git proteinmpnn
cd proteinmpnn
python protein_mpnn_run.py \
  --pdb_path backbone.pdb --pdb_path_chains "A" \
  --out_folder out --num_seq_per_target 16 \
  --sampling_temp "0.1" --use_soluble_model
```

The runner uses repo-relative imports, so the `cd` line is load-bearing —
invoking the script by absolute path from elsewhere fails with
`ModuleNotFoundError`. If you want threaded designed-sequence PDBs as well,
the LigandMPNN runner accepts `--model_type soluble_mpnn` (see `ligandmpnn`
for that path; it needs ProDy in addition to torch). The flag surface is
otherwise identical to `proteinmpnn` (or `ligandmpnn` for the second form),
including the string-typed temperature and the fixed-position JSONL keyed by
PDB stem — see `proteinmpnn` for the parsing quirks. The repo
ships soluble weights at `v_48_010` and `v_48_020` only; asking for
`--model_name v_48_002 --use_soluble_model` errors on a missing checkpoint, so
leave `--model_name` at its default.

Output is `out/seqs/<stem>.fa` with `score=` and `seq_recovery=` in each
header. Expect recovery against a native structure to drop a few points
relative to vanilla — that is the prior working, not a bug.

## Hydrophobic surface patches still recur where the fold needs them

Soluble weights shift the distribution; they do not enforce a hydrophobicity
ceiling. If a particular surface patch keeps coming back hydrophobic, that
patch is likely structurally load-bearing and the network is paying the
solubility cost to keep the fold. Layering `--omit_AAs "CW"` or a per-position
bias on top is fine, but check that the resulting designs still fold (via
`boltz` or `esmfold2`) before assuming the constraint was free.

## "Crystallisable" training set ≠ "soluble in your host" — keep an orthogonal filter

The training set is "structures that were soluble enough to crystallise," which
correlates with but is not the same as "expresses solubly in E. coli at 37 °C."
For campaigns where expression yield is the bottleneck, rank the soluble-MPNN
output by an orthogonal sequence-based predictor before committing wet-lab
slots; treat the MPNN bias as widening the funnel, not replacing the filter.

---

**Next:** fold the designs with `boltz` or `esmfold2` to confirm the backbone
is still recovered, then carry survivors into the expression screen.
