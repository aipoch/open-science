---
name: ligandmpnn
description: >
  Inverse-fold a backbone with ligand, nucleic-acid, and metal context using
  LigandMPNN (Dauparas et al. 2023, github.com/dauparas/LigandMPNN). Reach for
  this skill to redesign the residues lining a binding pocket around a bound
  small molecule or cofactor, to design metal-coordinating sites where the
  geometry must be respected, or to get threaded designed-sequence PDBs out of
  any MPNN run.
license: Apache-2.0
category: biomodels
metadata:
  display-name: LigandMPNN
  # github.com/dauparas/LigandMPNN/blob/main/LICENSE: MIT (© 2024 Justas
  # Dauparas). verified 2026-06-30
  third_party:
    - kind: weights
      name: LigandMPNN
      license: MIT
      terms_url: https://github.com/dauparas/LigandMPNN/blob/main/LICENSE
---

# LigandMPNN

LigandMPNN extends the ProteinMPNN graph with non-protein atoms — small
molecules, nucleic acids, and metals are visible to the network — so it is the
right inverse-folding tool whenever the design surface includes a bound ligand
or cofactor that vanilla `proteinmpnn` would ignore. The same `run.py` is also
the most convenient runner for the other MPNN families because, unlike the
original ProteinMPNN script, it threads designs back onto the input structure
and writes PDBs alongside the FASTA. Code and weights are MIT
(github.com/dauparas/LigandMPNN). The model is small enough to run on CPU —
for a handful of designs on one structure that is seconds and usually faster
than dispatching, so the normal path is local with
`pip install torch numpy biopython ProDy ml_collections dm-tree`; a GPU helps
for batched campaigns.

## Running it

```bash
pip install torch numpy biopython ProDy ml_collections dm-tree
git clone --depth 1 https://github.com/dauparas/LigandMPNN.git ligandmpnn
cd ligandmpnn
sed -i 's/np\.int\b/np.int64/g' openfold/np/residue_constants.py   # repo pins numpy 1.23; alias removed in >=1.24
bash get_model_params.sh ./model_params
python run.py \
  --model_type ligand_mpnn \
  --checkpoint_ligand_mpnn ./model_params/ligandmpnn_v_32_010_25.pt \
  --pdb_path complex.pdb \
  --out_folder out \
  --batch_size 8 --number_of_batches 4 \
  --temperature 0.1 \
  --fixed_residues "A45 A46 A47 A48"
```

Residue selections are space-separated `{chain}{resnum}` tokens inside one
quoted string (`"A45 A46 B10"`; insertion codes append directly, `"B82A"`).
That is the format for `--fixed_residues` and `--redesigned_residues`;
`--bias_AA_per_residue` and `--omit_AA_per_residue` instead take a path to a
JSON file whose keys use the same `{chain}{resnum}` form, and
`--chains_to_design` is comma-separated (`"A,B"`). If you want to redesign only the pocket, naming the pocket residues
in `--redesigned_residues` is usually shorter than fixing everything else.

Under `--out_folder` you get `seqs/<stem>.fa` (headers carry
`overall_confidence` and `ligand_confidence`), `backbones/<stem>_{1..N}.pdb`
with the designed sequence threaded onto the input coordinates, and — with
`--pack_side_chains 1` — full-atom packed models in `packed/`. The threaded
PDBs are the reason to prefer this runner even for protein-only jobs.

## Model types — which one to pick

| `--model_type` | sees | use |
|---|---|---|
| `ligand_mpnn` | backbone + ligand/NA/metal atoms | binding-pocket or active-site design |
| `protein_mpnn` | backbone only | protein–protein; same weights as `proteinmpnn` |
| `soluble_mpnn` | backbone only, soluble-trained | expression-biased prior; see `solublempnn` |
| `*_membrane_mpnn` | backbone + membrane label | transmembrane designs |

Each model type has its own `--checkpoint_<type>` flag; the wrong pairing is
caught at load time, but the default checkpoint path is relative to the repo,
so run from inside the clone or pass the absolute path.

## ProDy compiles from source on py3.11 — `pip install` fails without a C compiler

`run.py` imports ProDy unconditionally for ligand atom parsing. On py3.11 the
prebuilt wheel is missing on PyPI, so `pip install ProDy` compiles from source
and needs a working C/C++ compiler. On Modal's `add_python` bases the default
`CXX=clang++` points at a missing binary — `apt_install("build-essential")`
and export `CC=gcc CXX=g++` before the install. On most CPU-local Python
distributions the sdist builds in ~10 s if no wheel matches your Python.

## Turning ligand context off changes the answer, not the model

`--ligand_mpnn_use_atom_context 0` keeps the ligand-aware weights but masks the
ligand atoms at inference. That is useful for an ablation — the difference
between context-on and context-off tells you how much the ligand is shaping the
design — but it is **not** equivalent to running `protein_mpnn`, which uses a
different checkpoint trained without those features. For a fair protein-only
baseline, switch `--model_type`.

## Stripped HETATM or a chain filter silently drops the ligand — the design comes back pocket-blind

LigandMPNN does not warn when no ligand atoms are found; it just runs as if
`--model_type protein_mpnn` had been picked. The two common ways this happens
are an input PDB whose HETATM records were stripped by an upstream
clean-up step, and `--parse_these_chains_only` naming the protein chains but
not the ligand's. If `ligand_confidence` in the FASTA header is missing or
zero across every design, the model never saw the ligand — fix the input, do
not trust the sequences.

## Errors worth recognizing

| You see | It means / do this |
|---|---|
| `ModuleNotFoundError: No module named 'tree'` | `pip install dm-tree` — the vendored openfold imports it unconditionally. |
| `module 'numpy' has no attribute 'int'` | Run the `sed` patch on `openfold/np/residue_constants.py`, or pin `numpy<1.24` (py≤3.11 only). |
| `error: command 'clang' failed` while `pip install ProDy` | See the ProDy gotcha above — `apt_install("build-essential")` and `env({"CC":"gcc","CXX":"g++"})`. |
| `FileNotFoundError` for `model_params/...` | Checkpoints not fetched — run `bash get_model_params.sh ./model_params` from inside the clone. |

---

**Next:** fold the designs in complex with the ligand via `boltz` or `chai1`
(both accept SMILES/CCD) and filter on ipTM and ligand placement.
