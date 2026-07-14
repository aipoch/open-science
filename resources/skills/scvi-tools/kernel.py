"""
scvi-tools kernel helpers. Auto-loaded into the python kernel by the host
when the skill loads:

    h5ad_safe_obs

Module top level is definition-only (functions + literal constants) and
stdlib-only so the sidecar AST gate accepts it and it loads under the
``python3 -I -S`` skeleton check; numpy/pandas are imported lazily inside
the function body.
"""


def h5ad_safe_obs(df):
    """Return a copy of `df` with index + string-like columns coerced so
    anndata can `.write_h5ad()` without
    ``IORegistryError: No method registered for writing
    <class 'pandas.arrays.ArrowStringArray'>`` (anndata #2377).

    anndata 0.11.x's HDF5 writer has no registered method for
    pyarrow-backed string columns (dtype ``string[pyarrow]`` /
    ``large_string[pyarrow]`` / dictionary-encoded), and
    ``anndata.settings.allow_write_nullable_strings`` gates only the
    Python-backed ``pd.arrays.StringArray`` — it does not cover Arrow.

    ``.astype(str)`` alone is NOT enough: on a pyarrow-backed
    Index/Series it returns another Arrow-backed array. Round-trip
    through ``np.asarray(..., dtype=object)`` to force a plain object
    array, then to ``Categorical``. Nulls are preserved (NA stays NA in
    the categorical, not the literal string ``"<NA>"``/``"nan"``).

    Typical use::

        adata.obs = h5ad_safe_obs(adata.obs)
        adata.var = h5ad_safe_obs(adata.var)
        adata.write_h5ad("out.h5ad")
    """
    import numpy as np
    import pandas as pd

    out = df.copy()
    out.index = pd.Index(
        np.asarray(out.index, dtype=object).astype(str), name=out.index.name
    )
    for c in out.columns:
        dt = str(out[c].dtype)
        # "string" substring covers string / string[python] / string[pyarrow]
        # / large_string[pyarrow] / dictionary<values=string,...>[pyarrow]
        # without sweeping in int64[pyarrow], double[pyarrow], bool[pyarrow],
        # timestamp[...][pyarrow] etc.
        if dt == "object" or "string" in dt:
            mask = out[c].notna()
            vals = np.asarray(out[c].astype(object).where(mask, None), dtype=object)
            vals[mask.to_numpy()] = np.asarray(out[c][mask].astype(str), dtype=object)
            out[c] = pd.Categorical(vals)
    return out
