"""
scvi-tools kernel helpers. Load these definitions as described in SKILL.md:

    h5ad_safe_obs
    prepare_scvi_counts

Module top level is definition-only (functions + literal constants) and
stdlib-only so the sidecar AST gate accepts it and it loads under the
``python3 -I -S`` skeleton check; numpy/pandas/scipy are imported lazily inside
function bodies.
"""


def prepare_scvi_counts(adata):
    """Validate existing counts, using X only when the counts layer is absent.

    Numerical checks cannot establish raw-count provenance. The caller must
    identify the source from dataset documentation or preprocessing code.
    Existing counts are never overwritten. No rounding, exponentiation, or
    sparse-to-dense conversion is used to make an invalid input pass.
    """
    import numpy as np
    from scipy import sparse

    if adata.isbacked or adata.is_view:
        raise ValueError("Use an in-memory AnnData object, copying a view before preparation.")
    source = "counts" if "counts" in adata.layers else "X"
    matrix = adata.layers["counts"] if source == "counts" else adata.X
    if matrix is None or matrix.shape != adata.shape or 0 in matrix.shape:
        raise ValueError("Counts must be a nonempty cell-by-gene matrix aligned with AnnData.")
    if sparse.issparse(matrix):
        # CSR/CSC data can be checked directly; other SciPy formats remain sparse.
        values = matrix.data if matrix.format in ("csr", "csc") else matrix.tocoo().data
    elif isinstance(matrix, np.ndarray):
        values = matrix
    else:
        raise ValueError("Load counts as a NumPy array or SciPy sparse matrix before validation.")
    if values.dtype.kind not in "iuf":
        raise ValueError("Raw counts must contain real numeric values, not booleans or strings.")
    # Bound temporary allocations even for large dense expression matrices.
    positive = False
    for start in range(0, values.size, 65536):
        block = values.flat[start:start + 65536]
        if not np.isfinite(block).all() or (block < 0).any():
            raise ValueError("Raw counts must be finite and nonnegative.")
        if values.dtype.kind == "f" and (block != np.floor(block)).any():
            raise ValueError("Fractional values are not raw integer counts; do not round or invert normalization.")
        positive = positive or bool((block > 0).any())
    if not positive:
        raise ValueError("The count matrix contains no positive counts; check the input and QC.")
    if "counts" not in adata.layers:
        adata.layers["counts"] = matrix.copy()
    return {"source": source, "checks": "finite, nonnegative, integer-valued"}


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
