"""Bounded Census queries for the existing Notebook Python runtime.

No process management, package installation, network grants or persistent state.
Imports stay inside functions so registered helper loading requires no scientific packages.
"""

def error_message(error):
    import os
    from urllib.parse import urlparse, unquote
    # Some native constructor errors include their entire configuration map.
    # The command-local proxy credentials must never become a tool result.
    message = str(error)
    proxy_value = os.environ.get("HTTPS_PROXY", "")
    secrets = [proxy_value]
    try:
        proxy = urlparse(proxy_value)
        secrets.extend([proxy.username, proxy.password, unquote(proxy.username or ""), unquote(proxy.password or "")])
    except ValueError:
        pass
    for secret in secrets:
        if secret:
            message = message.replace(secret, "[redacted]")
    return message

TILEDB_CONFIG = {
    "sm.skip_checksum_validation": "false",
    "vfs.s3.region": "us-west-2",
    "vfs.s3.no_sign_request": "true",
    # Bound metadata buffers instead of using Census's 1 GiB default.
    "py.init_buffer_bytes": 8 * 1024 * 1024,
    "soma.init_buffer_bytes": 8 * 1024 * 1024,
}


def tiledb_config():
    import os
    from urllib.parse import urlparse, unquote
    # TileDB uses the AWS C++ SDK, which does not consume HTTPS_PROXY itself.
    # Forward only the command-local gateway provided by Notebook sandbox wrap().
    proxy = urlparse(os.environ.get("HTTPS_PROXY", ""))
    if proxy.scheme != "http" or not proxy.hostname or not proxy.port:
        raise RuntimeError("Census requires the Notebook sandbox HTTP proxy")
    config = dict(TILEDB_CONFIG)
    config.update({
        "vfs.s3.proxy_host": proxy.hostname,
        "vfs.s3.proxy_port": str(proxy.port),
        "vfs.s3.proxy_scheme": proxy.scheme,
        "vfs.s3.proxy_username": unquote(proxy.username or ""),
        "vfs.s3.proxy_password": unquote(proxy.password or ""),
    })
    ca_file = os.environ.get("SSL_CERT_FILE")
    if not ca_file:
        # Match the Requests trust roots used by Census release discovery. Some
        # native TileDB wheels have no usable default CA path on macOS.
        import certifi
        ca_file = certifi.where()
    config["ssl.ca_file"] = ca_file
    return config


def jsonable(value):
    import numpy as np
    if value is None:
        return None
    if isinstance(value, float) and not np.isfinite(value):
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, np.generic):
        return jsonable(value.item())
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return str(value)


def resolve_version(version):
    import cellxgene_census
    version = str(version or "stable")
    if version not in ("stable", "latest"):
        return version
    description = cellxgene_census.get_census_version_description(version)
    resolved = description.get("release_build") if isinstance(description, dict) else None
    if not resolved:
        raise ValueError(f"Census release {version!r} did not provide a build date")
    return str(resolved)


def organism_key(value):
    value = str(value or "homo_sapiens").strip().lower()
    aliases = {
        "human": "homo_sapiens",
        "homo sapiens": "homo_sapiens",
        "mouse": "mus_musculus",
        "mus musculus": "mus_musculus",
    }
    return aliases.get(value, value)


def text_filter(column, value):
    if value is None:
        return None
    value = str(value).strip()
    if not value:
        raise ValueError(f"nonblank value required for {column}")
    # These values become a SOMA value_filter, never executable Python. Restricting the
    # character set keeps quoting predictable and avoids accepting an expression.
    if any(ch in value for ch in "\n\r\\'"):
        raise ValueError(f"invalid value for {column}")
    return f"{column} == '{value}'"


OBSERVATION_FILTER_COLUMNS = (
    ("tissue", "tissue_general"),
    ("cell_type", "cell_type"),
    ("disease", "disease"),
)


DEFAULT_OBSERVATION_COLUMNS = [
    "soma_joinid",
    "dataset_id",
    "assay",
    "cell_type",
    "tissue_general",
    "disease",
    "sex",
    "development_stage",
]


def observation_filter(args, available_columns=None):
    clauses = []
    for field, column in OBSERVATION_FILTER_COLUMNS:
        if args.get(field) is not None and available_columns is not None and column not in available_columns:
            raise ValueError(f"Census release does not provide the {column} field")
        clause = text_filter(column, args.get(field))
        if clause:
            clauses.append(clause)
    return " and ".join(clauses) or None


def observations(census, args, limit, columns=None):
    import pandas as pd
    import pyarrow as pa
    organism = organism_key(args.get("organism"))
    dataframe = census["census_data"][organism]["obs"]
    schema = getattr(dataframe, "schema", None)
    schema_names = getattr(schema, "names", None)
    # Real SOMA dataframes always expose schema names. The fallback keeps the offline bridge
    # fixtures focused on query semantics without weakening the production path.
    available_columns = set(schema_names) if schema_names is not None else None
    value_filter = observation_filter(args, available_columns)
    if not value_filter:
        raise ValueError("at least one of tissue, cell_type, or disease is required")
    requested_columns = columns or DEFAULT_OBSERVATION_COLUMNS
    projected_columns = (
        requested_columns
        if available_columns is None
        else [column for column in requested_columns if column in available_columns]
    )
    if not projected_columns:
        raise ValueError(f"Census release does not provide cell metadata columns for {organism}")
    get_enumerations = getattr(dataframe, "get_enumeration_values", None)
    if get_enumerations is not None:
        categorical = {
            column: str(args[field]).strip()
            for field, column in OBSERVATION_FILTER_COLUMNS
            if args.get(field) is not None and str(args[field]).strip()
            and available_columns is not None
            and column in available_columns
            and isinstance(dataframe.schema.field(column).type, pa.DictionaryType)
        }
        if categorical:
            # An absent dictionary value cannot match an exact equality filter.
            # Use this release's complete enum, never a cached or sampled cohort.
            enumerations = get_enumerations(list(categorical))
            if any(value not in enumerations[column].to_pylist() for column, value in categorical.items()):
                return organism, pd.DataFrame(columns=projected_columns)
    reader = dataframe.read(
        value_filter=value_filter,
        column_names=projected_columns,
        result_order="row-major",
        # Only this bounded cell scan needs a small first batch.
        platform_config={"soma.init_buffer_bytes": "65536"},
    )
    frames = []
    rows = 0
    try:
        for table in reader:
            frame = table.slice(0, limit - rows).to_pandas()
            if frame.empty:
                continue
            remaining = limit - rows
            frames.append(frame.head(remaining))
            rows += min(len(frame), remaining)
            if rows >= limit:
                break
    finally:
        close = getattr(reader, "close", None)
        if close:
            close()
    frame = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=projected_columns)
    return organism, frame.head(limit)


def list_datasets(census, args, census_version):
    frame = census["census_info"]["datasets"].read().concat().to_pandas()
    query = str(args.get("query") or "").strip().lower()
    if query:
        searchable = ["dataset_id", "dataset_title", "collection_name", "citation"]
        searchable = [column for column in searchable if column in frame.columns]
        if not searchable:
            raise ValueError("Census release does not provide searchable dataset metadata")
        mask = frame[searchable].fillna("").astype(str).apply(
            lambda row: row.str.lower().str.contains(query, regex=False).any(), axis=1
        )
        frame = frame[mask]
    limit = int(args.get("limit", 25))
    columns = [
        "dataset_id",
        "dataset_version_id",
        "dataset_title",
        "collection_id",
        "collection_name",
        "collection_doi",
        "dataset_total_cell_count",
    ]
    available = [column for column in columns if column in frame.columns]
    rows = frame[available].head(limit).to_dict(orient="records")
    return {"census_version": census_version, "total": int(len(frame)), "datasets": jsonable(rows)}


def query_cells(census, args, census_version):
    limit = int(args.get("limit", 25))
    organism, frame = observations(census, args, limit)
    return {
        "census_version": census_version,
        "organism": organism,
        "total_returned": int(len(frame)),
        "cells": jsonable(frame.to_dict(orient="records")),
    }


def _query(request):
    import cellxgene_census
    import tiledbsoma
    action = request.get("action")
    # Reject invalid cohorts before release resolution or any remote handle opens.
    if action == "query_cells" and not observation_filter(request):
        raise ValueError("at least one of tissue, cell_type, or disease is required")
    version = str(request.get("census_version") or "stable")
    census_version = resolve_version(version)
    for attempt in range(2):
        try:
            # No cross-call cache: close every SOMA handle before reporting success.
            # A truncated S3 transfer can surface as a non-retryable checksum
            # error in the AWS SDK. Start a new read; never disable checksums.
            with cellxgene_census.open_soma(
                census_version=census_version, tiledb_config=tiledb_config()
            ) as census:
                if action == "list_datasets":
                    return list_datasets(census, request, census_version)
                if action == "query_cells":
                    return query_cells(census, request, census_version)
                raise ValueError(f"unknown Census action: {action}")
        except tiledbsoma.SOMAError as error:
            message = str(error)
            if attempt or "S3:" not in message or "Response checksums mismatch" not in message:
                raise
            # All actions are read-only, use the same resolved release, and share
            # the parent's original deadline. Persistent mismatches still fail.
            continue



def _run_query(action, *, limit, census_version, **filters):
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("limit must be an integer from 1 to 100")
    if not isinstance(census_version, str) or not census_version.strip():
        raise ValueError("census_version must be a nonblank string")
    for name, value in filters.items():
        if value is not None and not isinstance(value, str):
            raise ValueError(f"{name} must be a string")
    request = dict(filters, action=action, limit=limit, census_version=census_version)
    if action == "query_cells" and not observation_filter(request):
        raise ValueError("at least one of tissue, cell_type, or disease is required")
    try:
        return _query(request)
    except Exception as error:
        raise RuntimeError(error_message(error)) from None


def census_list_datasets(*, query="", limit=25, census_version="stable"):
    """Search dataset metadata, returning the resolved release and at most 100 rows."""
    return _run_query("list_datasets", query=query, limit=limit, census_version=census_version)


def census_query_cells(*, organism="homo_sapiens", tissue=None, cell_type=None,
                       disease=None, limit=25, census_version="stable"):
    """Read the first bounded observation rows matching exact metadata values."""
    return _run_query("query_cells", organism=organism, tissue=tissue, cell_type=cell_type,
                      disease=disease, limit=limit, census_version=census_version)
