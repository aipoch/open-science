# ESMFold2-Experimental* — design hook

The four `biohub/ESMFold2-Experimental*` repos load as `ESMFold2ExperimentalModel`
(separate class, `modeling_esmfold2_experimental.py`). Unlike `ESMFold2Model`,
its `forward()` is **not** `@torch.inference_mode()`-decorated and exposes a
`res_type_soft` kwarg ("Used in design to provide a soft sequence input"):

```python
out = model(**features, res_type_soft=soft_oh,  # [1,L,NUM_RES_TYPES], requires_grad
            num_loops=1, num_sampling_steps=1, num_diffusion_samples=1)
D = out['distogram_logits']  # carries grad; trunk runs under
                             # torch.set_grad_enabled(res_type_soft is not None)
```

Diffusion + confidence-head run under `torch.no_grad()`, so only `distogram_logits`
carries the graph. **Design (Alg 11) must use an Experimental variant** — the
release `ESMFold2`/`ESMFold2-Fast` `forward()` is `@torch.inference_mode()` and
cannot be back-propagated through.

## Gotcha: `set_kernel_backend("fused")` on Experimental models

**Do not call `set_kernel_backend` on Experimental models.** The confidence head
runs outside the bf16 autocast block, so its fused matmul sees fp32 inputs and throws:

```
RuntimeError: self and mat2 must have the same dtype, but got BFloat16 and Float
```

The reference path is correct (the paper's design loop never calls it). The fused
backend is only validated for release `ESMFold2Model` / `ESMFold2-Fast` via
`builder.fold()`.
