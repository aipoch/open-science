# DiffDock — batch and sequence-only workflows

The main `SKILL.md` covers the single-complex path. Two further entry points
share the same `inference` module and the same YAML-overwrites-CLI caveat.

## Batch / small-library docking

Prepare one CSV row per complex and hand it to `--protein_ligand_csv`:

```csv
complex_name,protein_path,ligand_description,protein_sequence
6lu7_frag001,6lu7.pdb,CC(=O)Nc1ccc(O)cc1,
6lu7_frag002,6lu7.pdb,COc1ccc(C#N)cc1,
```

```bash
cd $DIFFDOCK_REPO
python3 -m inference \
  --config default_inference_args.yaml \
  --protein_ligand_csv batch.csv \
  --out_dir out/
```

Each row gets its own subdirectory under `--out_dir`. `complex_name` may be
left empty (an index is used). `ligand_description` accepts a SMILES string or
a path to an `.sdf`/`.mol2`; one ligand per row, so a multi-ligand SDF needs to
be split first.

For libraries beyond a few hundred ligands, raise `samples_per_complex` only
in a copied YAML (see the CLI-overwrite gotcha) and shard the CSV across jobs —
the embedding step holds ESM-2 650M in GPU memory for the whole run.

## Sequence-only receptor (ESMFold first)

If a receptor structure is not available, leave `protein_path` empty and fill
`protein_sequence`; DiffDock folds the chain with ESMFold before docking. That
path needs `fair-esm` installed; the `esm2_t33_650M_UR50D` checkpoint is
fetched on first use into `~/.cache/torch/hub/checkpoints`. Expect the fold to
dominate wall-clock for receptors over ~400
residues, and treat poses against an ESMFold model with more scepticism than
against a crystal structure: pocket geometry inherits the fold's pLDDT.

## Reading confidence across a library

Confidence logits are calibrated *within* a complex, not across ligands. To
compare ligands, rescore each `rank1.sdf` with an external scorer; using the
raw DiffDock confidence as a virtual-screening ranker conflates "well-placed
pose" with "tight binder" and the upstream FAQ explicitly warns against it.
