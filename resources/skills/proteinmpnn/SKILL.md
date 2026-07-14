---
name: proteinmpnn
description: >
  Inverse-fold a protein backbone (PDB structure) into amino-acid sequence with
  ProteinMPNN (Dauparas et al. 2022, github.com/dauparas/ProteinMPNN). Reach
  for this skill to run sequence design on RFdiffusion backbones, to redesign
  one chain of a PDB while holding interface residues fixed, or to generate a
  temperature-swept set of sequences for downstream folding.
license: Apache-2.0
category: biomodels
metadata:
  display-name: ProteinMPNN
  # github.com/dauparas/ProteinMPNN/blob/main/LICENSE: MIT (© 2022 Justas
  # Dauparas). verified 2026-06-30
  third_party:
    - kind: weights
      name: ProteinMPNN
      license: MIT
      terms_url: https://github.com/dauparas/ProteinMPNN/blob/main/LICENSE
---

# ProteinMPNN

ProteinMPNN is the default inverse-folding step in the binder pipeline: a
message-passing network that sees backbone geometry only, so it is the right
choice when the design surface is protein–protein and the wrong one as soon as
a ligand, nucleic acid, or metal is part of the interface — `ligandmpnn` adds
those atoms to the graph with a near-identical CLI, and `solublempnn` swaps in
weights trained on soluble structures for an expression-biased prior. Code and
weights are MIT (github.com/dauparas/ProteinMPNN). The model is small enough
to run on CPU — for a handful of sequences on one backbone that is seconds and
usually faster than dispatching a remote job; a GPU helps for batched
campaigns (hundreds of backbones or large `--num_seq_per_target`). Either way
the repo is cloned in-job — there is no PyPI dist and the checkpoints are
bundled in the repo.

## Running it

```bash
pip install torch numpy   # if not already present
git clone --depth 1 https://github.com/dauparas/ProteinMPNN.git proteinmpnn
cd proteinmpnn
python protein_mpnn_run.py \
  --pdb_path backbone.pdb --pdb_path_chains "A" \
  --out_folder out --num_seq_per_target 16 --sampling_temp "0.1"
```

Two flags trip almost everyone the first time. `--sampling_temp` is parsed as a
space-separated string so one run can sweep several temperatures; a single
value needs no quoting, but a multi-value sweep must be quoted
(`"0.1 0.2 0.3"`), and commas never split — `"0.1,0.2"` fails the float cast. `--pdb_path_chains` is also space-separated inside
one quoted argument (`"A B"`); a comma is kept as part of the chain ID.

Designs land in `out/seqs/<pdb_stem>.fa`. The first record is the input
sequence; each design header carries `score=` (mean negative log-likelihood —
lower is more confident), `global_score=`, and `seq_recovery=`. ProteinMPNN
writes sequences only — it does not thread them back onto the backbone; if you
need designed-sequence PDBs, the `ligandmpnn` runner writes them to
`backbones/` automatically and accepts `--model_type protein_mpnn` for the
same weights.

## A flat chain map in `--fixed_positions_jsonl` silently redesigns every residue

`--fixed_positions_jsonl` expects one JSON object per line keyed by the **PDB
stem** first, then chain, then a list of 1-indexed residue numbers:
`{"backbone": {"A": [10, 11, 12], "B": []}}`. Passing the inner
`{"A": [...]}` directly — the obvious guess — is silently treated as "no PDB
matched," and every position is redesigned. The bundled
`helper_scripts/make_fixed_positions_dict.py` writes the correct shape from a
chain and range string and is worth the extra call; the same outer-stem rule
applies to `--chain_id_jsonl` and `--tied_positions_jsonl`.

## Checkpoints — which one to pick

| `--model_name` | training noise | use |
|---|---|---|
| `v_48_002` | 0.02 Å | highest recovery; close-to-native redesigns |
| `v_48_020` (default) | 0.20 Å | de novo backbones — tolerates RFdiffusion imperfection |
| `v_48_030` | 0.30 Å | very rough backbones; lowest recovery |
| `--use_soluble_model` | — | swaps to the soluble-trained set; see `solublempnn` |

## Errors worth recognizing

| You see | It means / do this |
|---|---|
| `KeyError: 'A'` | Chain letter not in the PDB — `grep '^ATOM' file.pdb \| cut -c22 \| sort -u` to see what is. |
| `JSONDecodeError` on a `*_jsonl` flag | The flag wants a file path, not inline JSON; write the file first. |
| All positions redesigned despite `--fixed_positions_jsonl` | Outer PDB-stem key missing — see the gotcha above. |
| `ModuleNotFoundError` for relative imports | Script run from the wrong cwd — `cd` into the cloned repo first; the imports are repo-relative. |

---

**Next:** fold the designs in complex with the target via `boltz`, `chai1`, or
`esmfold2` and filter on ipTM.
