# ESMC language model (Biohub)

ESMC is the Biohub successor to ESM-2: pre-norm transformer + RoPE + SwiGLU +
QK-LayerNorm + bias-free, trained on 2.8 B sequences (UniRef+MGnify+JGI) with
15% MLM. Three sizes: 300M (30L, d=960), 600M (36L, d=1152), 6B (80L, d=2560).
Contact P@L-LR: ESMC-6B 0.725 (+/- 0.002) vs ESM2-15B 0.593. ESMC-6B weights
= 6 safetensors shards, 25.41 GB total.

## MLM logits + hidden states

```python
import torch
from transformers import AutoModelForMaskedLM, AutoTokenizer

model = AutoModelForMaskedLM.from_pretrained(
    "biohub/ESMC-6B", dtype=torch.bfloat16, device_map="auto"
).eval()
tok = AutoTokenizer.from_pretrained("biohub/ESMC-6B")

inp = tok([seq], return_tensors="pt", padding=True)
inp = {k: v.to(model.device) for k, v in inp.items()}
with torch.inference_mode():
    out = model(**inp, output_hidden_states=True)
# out.logits: [B, L+2, 64]  (vocab=64; BOS/EOS bracket)
# out.hidden_states: tuple of 81 tensors [B, L+2, 2560]  (6B has 80 layers + input emb)
```

**Mask token is `<mask>`** (id 32) — use `tok.mask_token`. The native-SDK `_`
convention does NOT apply to the HF tokenizer: `_` is not in the vocab and
encodes to `<unk>`, silently corrupting mutation scores.
Best layers for downstream tasks: 50-60 for function
(paper section A.1.4.2-3); contact head reads final layer.

## Mutation scoring (zero-shot LLR / pseudo-PPL)

Paper Alg 14 (used as the LM regularizer in binder design): for M passes,
mask 15% of mutable positions, compute CE of true tokens against ESMC logits,
average. Zero-shot single-mutant LLR = `logp(mut) - logp(wt)` at the masked
position (Biohub cookbook `esmc_mutation_scoring.ipynb`).

## SAE features (layer 60, k=64, codebook 16384)

```python
from transformers import AutoModel, AutoTokenizer
model = AutoModel.from_pretrained("biohub/ESMC-6B", device_map="auto").eval()
tok   = AutoTokenizer.from_pretrained("biohub/ESMC-6B")
sae   = AutoModel.from_pretrained(
    "biohub/ESMC-6B-sae-k64-codebook16384",
    allow_patterns=["config.json","layer_60.safetensors"],
    device=model.device,
)
sae.initialize_layers([60])
model.add_sae_models([sae.layers["60"]])

inp = tok(seq, return_tensors="pt"); inp = {k:v.to(model.device) for k,v in inp.items()}
with torch.inference_mode():
    out = model(**inp)
feat = out["sae_outputs"]["layer60"].to_dense()[0, 1:-1]   # [L, 16384], strip BOS/EOS
```

Example output (Src, 536 aa): shape [536,16384], nnz=34432 (~64/residue).
Paper's atlas SAE = layer 60. Feature metadata API (alpha — endpoint may
change; check biohub.ai/esm docs):
`https://biohub.ai/esm/protein/api/v1alpha1/features/{idx}` returns
`{description, top_100_uniref_ids, ...}`. 5,382 features classified as
"functional_site" in the paper.

## Contact prediction

Paper section A.1.4.1: 20,775 chains at 40% mmseqs cluster, sep>=24, Cbeta<8A.
P@L-LR (95% CI bootstrap n=5000): ESMC-6B 0.725 (+/- 0.002), ESMC-600M 0.589,
ESM2-15B 0.593. The contact head is read from the final attention/logits —
see the `esm.models.esmc` module for the regression head.
