"""
Literature-review helpers — pure-skill, provider-agnostic.

    verify_dois, crossref_lookup, search_openalex, expand_citations,
    extract_dois, style_pass

There is no ``host`` runtime here: these are plain HTTP/stdlib helpers. Load
once per session by exec-ing this file in a Python cell (nothing auto-injects
it outside Claude Science):

    exec(open("<this-skill-dir>/kernel.py").read())

Configuration is via the environment, not a host:
    OPENALEX_API_KEY   required for the OpenAlex-backed steps (search_openalex
                       / expand_citations); free at
                       https://openalex.org/settings/api
    HOST_USER_EMAIL    optional contact email for the CrossRef/doi.org polite
                       pool (falls back to ``git config user.email``)
"""

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request


DOI_PATTERN = r"10\.\d{4,9}/[^\s\"'`\]\}—–&|]+"


def litrev_contact() -> str | None:
    """User contact email for polite-pool API headers (CrossRef/doi.org
    ONLY — never sent to OpenAlex, which does not take a contact email);
    None if unavailable.

    Reads ``HOST_USER_EMAIL`` (or ``CONTACT_EMAIL``) from the environment,
    then falls back to the local git identity (``git config user.email``).
    The ``mailto:`` polite-pool suffix is best-effort — a missing email
    never fails a fetch. Set ``HOST_USER_EMAIL`` to override, or set it to an
    empty string to opt out of the git fallback."""
    e = os.environ.get("HOST_USER_EMAIL")
    if e is not None:  # explicitly set (empty string = opt-out)
        e = e.strip()
        return e or None
    e = os.environ.get("CONTACT_EMAIL")
    if e and e.strip():
        return e.strip()
    try:
        import subprocess
        out = subprocess.run(
            ["git", "config", "user.email"],
            capture_output=True, text=True, timeout=5,
        )
        e = (out.stdout or "").strip()
        return e or None
    except Exception:
        return None


def litrev_openalex_key() -> str:
    """The OpenAlex API key — REQUIRED on every api.openalex.org request
    (keyless calls fail with 409/429; OpenAlex takes no mailto parameter).
    Read from the ``OPENALEX_API_KEY`` environment variable. Raises
    RuntimeError with actionable guidance when unset — callers must NOT fall
    back to anonymous calls; skip the OpenAlex-backed steps instead."""
    k = os.environ.get("OPENALEX_API_KEY")
    if k:
        return k
    raise RuntimeError(
        "OpenAlex requires a free API key and none is set. Export "
        "OPENALEX_API_KEY and re-run — keyless calls are unsupported. Get a "
        "free key at https://openalex.org/settings/api, or skip the "
        "OpenAlex-backed steps (search_openalex / expand_citations) and "
        "continue with CrossRef/PubMed/web sources."
    )


def litrev_openalex_key_ok(key: str, timeout: float = 10) -> bool | None:
    """Cheap key-aliveness probe: GET /rate-limit carrying ONLY api_key.
    With no other query parameters, a 4xx here cannot be a bad-parameter
    refusal (status matrix: core/src/ops/credentialAsk.ts), so it cleanly
    disambiguates a dual-cause request-path 403. Returns True when the
    key authenticates (2xx, or 429 = authenticated but over budget),
    False when the key is refused (other 4xx), None when unknown
    (network trouble) — callers treat None like True (soft-degrade)."""
    url = ("https://api.openalex.org/rate-limit?api_key="
           + urllib.parse.quote(key, safe=""))
    req = urllib.request.Request(
        url, headers={"User-Agent": "ClaudeScience-literature-review/1.0"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return True
        return False if 400 <= e.code < 500 else None
    except Exception:
        return None


def litrev_openalex_get(url: str, timeout: float = 15) -> dict | None:
    """GET an api.openalex.org URL with the required ``api_key=`` appended
    (and NO ``mailto`` anywhere — param or UA). Raises RuntimeError with an
    actionable message on 401/409 (key rejected/required) and on a 429
    that survives one 2 s retry (usage limit — most commonly the daily
    budget, which resets at 00:00 UTC). A 403 is dual-cause on request
    paths — key rejected OR invalid query parameters (bad ``filter=``/
    ``select=`` values; matrix: core/src/ops/credentialAsk.ts) — so it is
    disambiguated with one tiny /rate-limit probe: key confirmed dead →
    raise (otherwise a sweep silently continues with a dead key); key
    alive or probe inconclusive → return None (soft-degrade, so callers'
    fallbacks, e.g. the authorless ``select`` retry in expand_citations,
    still run). Returns None on all other errors."""
    key = litrev_openalex_key()
    sep = "&" if "?" in url else "?"
    full = url + sep + "api_key=" + urllib.parse.quote(key, safe="")
    for attempt in (0, 1):
        req = urllib.request.Request(
            full, headers={"User-Agent": "ClaudeScience-literature-review/1.0"}
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (401, 409):
                raise RuntimeError(
                    "OpenAlex rejected the API key (HTTP %d). Re-check it "
                    "under Customize → Credentials → OpenAlex against "
                    "https://openalex.org/settings/api — do not retry "
                    "anonymously." % e.code
                ) from None
            if e.code == 403:
                # Dual-cause status: disambiguate with the probe (see
                # docstring). Only a CONFIRMED-dead key raises; a live or
                # unverifiable key means the 403 was parameter-shaped.
                if litrev_openalex_key_ok(key, timeout) is False:
                    raise RuntimeError(
                        "OpenAlex rejected the API key (HTTP 403, and the "
                        "key also failed a direct /rate-limit check). "
                        "Re-check it under Customize → Credentials → "
                        "OpenAlex against "
                        "https://openalex.org/settings/api — do not retry "
                        "anonymously."
                    ) from None
                return None
            if e.code == 429:
                # One short retry: a burst 429 (the key is shared with the
                # literature MCP server) clears in seconds; a budget 429
                # does not.
                if attempt == 0:
                    time.sleep(2)
                    continue
                raise RuntimeError(
                    "The OpenAlex API key is over its usage limit (HTTP "
                    "429) — most commonly the daily budget is exhausted "
                    "(resets at 00:00 UTC). Do not retry anonymously; "
                    "continue with non-OpenAlex sources."
                ) from None
            return None
        except Exception:
            return None
    return None


def litrev_get(url: str, timeout: float = 15) -> dict | None:
    """GET `url` and JSON-decode. One 2s retry on HTTP 429; None on any error."""
    c = litrev_contact()
    ua = "ClaudeScience-literature-review/1.0" + (f" (mailto:{c})" if c else "")
    ua = ua.encode("ascii", "ignore").decode("ascii")
    for attempt in (0, 1):
        req = urllib.request.Request(url, headers={"User-Agent": ua})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt == 0:
                time.sleep(2)
                continue
            return None
        except Exception:
            return None
    return None


def quote_doi_path(doi: str) -> str:
    """URL-encode a DOI path; unquote each segment first so a pre-encoded
    %28 stays single-encoded (caller may pass either form)."""
    return "/".join(
        urllib.parse.quote(urllib.parse.unquote(seg), safe="") for seg in doi.split("/")
    )


def crossref_year(m: dict) -> int | None:
    """Safely extract the publication year from a CrossRef `message` record."""
    dp = (m.get("published") or {}).get("date-parts") or [[None]]
    return (dp[0] or [None])[0]


def short_authors(names: list[str]) -> str | None:
    """Collapse an author list to note form: first three names,
    semicolon-separated (names may carry internal commas), then 'et al.'
    when more authors exist or any entry is nameless. Returns None when the
    record carries no author names at all.

    Authors ride in every helper's default output so that working notes built
    from them keep the name next to the DOI and year — an `(Author Year)`
    citation written from an authorless note gets its names from parametric
    memory, which supplies plausible names, not the paper's."""
    kept = [n.strip() for n in names if n and n.strip()]
    if not kept:
        return None
    more = len(names) > 3 or len(kept) < len(names)
    return "; ".join(kept[:3]) + (" et al." if more else "")


def crossref_authors(m: dict) -> str | None:
    """Note-form author names (family names) from a CrossRef `message` record."""
    return short_authors(
        [a.get("family") or a.get("name") or "" for a in (m.get("author") or [])]
    )


def openalex_authors(w: dict) -> str | None:
    """Note-form author names (full display names) from an OpenAlex work record."""
    return short_authors(
        [((a.get("author") or {}).get("display_name") or "") for a in (w.get("authorships") or [])]
    )


def litrev_head(url: str, timeout: float = 10) -> int | None:
    """HEAD `url` WITHOUT following redirects; return the origin server's own
    status (so doi.org returns 302 for a registered DOI and 404 for an
    unregistered one — not the publisher's status). One 2s retry on 429.
    Returns None only when no status could be obtained (connection/timeout)."""
    c = litrev_contact()
    ua = ("ClaudeScience-literature-review/1.0" + (f" (mailto:{c})" if c else "")).encode(
        "ascii", "ignore"
    ).decode("ascii")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib.request.build_opener(NoRedirect)
    for attempt in (0, 1):
        req = urllib.request.Request(url, headers={"User-Agent": ua}, method="HEAD")
        try:
            with opener.open(req, timeout=timeout) as r:
                return r.status
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt == 0:
                time.sleep(2)
                continue
            return e.code
        except Exception:
            return None
    return None


def verify_dois(dois: list[str]) -> dict[str, dict]:
    """Resolve each DOI against CrossRef, with a doi.org HEAD fallback for
    DataCite/mEDRA/arXiv DOIs. Returns {doi: {ok, title?, authors?, year?,
    journal?, retracted?, registry?, error?}} where:
      ok=True  — resolves (CrossRef hit, or doi.org 2xx/3xx);
      ok=False — does NOT resolve (doi.org 404; likely fabricated or typo);
      ok=None  — could not be verified (network/transient/5xx); do not flag as
                 fabricated.
    `retracted` is True/False only on a CrossRef hit; None when the registry
    is non-CrossRef or the lookup was unverified."""
    out: dict[str, dict] = {}
    for d in dois:
        d = d.strip()
        # No registration agency uses `.`/`..`/empty path segments in a DOI
        # suffix; reject up-front so a server/CDN that dot-segment-normalizes
        # can't make a fabricated identifier appear to resolve. Decode the WHOLE
        # string first then split, so encoded `..` (`%2E%2E`) and encoded
        # slashes carrying `..` (`a%2F..%2Fb`) both surface as a `..` segment.
        segs = urllib.parse.unquote(d).split("/")
        if any(seg in ("", ".", "..") for seg in segs[1:]):
            out[d] = {"ok": False, "error": "dot-segment in DOI"}
            continue
        enc = quote_doi_path(d)
        j = litrev_get(f"https://api.crossref.org/works/{enc}")
        time.sleep(0.06)
        if j and "message" in j:
            m = j["message"]
            title = (m.get("title") or [""])[0]
            upd = [u.get("type", "") for u in (m.get("update-to") or [])]
            retracted = (
                any("retract" in t.lower() for t in upd)
                or str(m.get("subtype") or "").lower() == "retraction"
                or title.upper().startswith("RETRACTED")
            )
            out[d] = {
                "ok": True,
                "title": title,
                "authors": crossref_authors(m),
                "year": crossref_year(m),
                "journal": (m.get("container-title") or [""])[0],
                "retracted": retracted,
                "registry": "crossref",
            }
            continue
        # CrossRef miss OR transient — doi.org is the authoritative resolver
        # across all registration agencies, so its verdict decides ok.
        code = litrev_head(f"https://doi.org/{enc}")
        if code is not None and 200 <= code < 400:
            out[d] = {"ok": True, "registry": "non-crossref", "retracted": None}
        elif code == 404:
            out[d] = {"ok": False}
        else:
            out[d] = {"ok": None, "error": "unverified (network)", "retracted": None}
    return out


def crossref_lookup(ref_string: str) -> dict | None:
    """Find a DOI from a free-text citation (author/title/year). Returns the
    top CrossRef match as {doi, title, authors, year, score} or None. Use when you have
    a citation's details but not its DOI — this is the alternative to guessing."""
    q = urllib.parse.quote(ref_string)
    j = litrev_get(f"https://api.crossref.org/works?query.bibliographic={q}&rows=1")
    items = (j or {}).get("message", {}).get("items", [])
    if not items:
        return None
    m = items[0]
    return {
        "doi": m.get("DOI"),
        "title": (m.get("title") or [""])[0],
        "authors": crossref_authors(m),
        "year": crossref_year(m),
        "score": m.get("score"),
    }


def search_openalex(query: str, n: int = 10, filters: str = "") -> list[dict]:
    """Search OpenAlex (open scholarly index, ~250M works). Returns up to n
    hits as [{doi, title, authors, year, cited_by, venue, oa_url}]. `filters` is an
    OpenAlex filter string, e.g. 'from_publication_date:2022-01-01'.
    Raises RuntimeError when no API key is available or OpenAlex rejects
    it / reports the daily budget exhausted — do not retry anonymously;
    continue the sweep with the non-OpenAlex sources."""
    q = urllib.parse.quote(query)
    flt = f"&filter={filters}" if filters else ""
    j = litrev_openalex_get(
        f"https://api.openalex.org/works?search={q}&per-page={min(n, 25)}"
        f"&sort=cited_by_count:desc{flt}"
    )
    out = []
    for w in (j or {}).get("results", [])[:n]:
        loc = w.get("primary_location") or {}
        venue = ((loc.get("source") or {}) or {}).get("display_name")
        out.append(
            {
                "doi": (w.get("doi") or "").replace("https://doi.org/", ""),
                "title": w.get("title"),
                "authors": openalex_authors(w),
                "year": w.get("publication_year"),
                "cited_by": w.get("cited_by_count"),
                "venue": venue,
                "oa_url": (w.get("open_access") or {}).get("oa_url"),
            }
        )
    return out


def expand_citations(doi: str, n_backward: int = 50, n_forward: int = 15) -> dict:
    """One citation-graph step in both directions via OpenAlex.
    `references` is the backward step — the paper's own bibliography (outgoing
    citations), via `filter=cited_by:<id>`, sorted most-cited first.
    `cited_by` is the forward step — papers that cite this one (incoming
    citations), via `filter=cites:<id>`. Each entry is {doi, title, authors,
    year, cited_by}. Three OpenAlex requests total (up to five when a degraded
    list query retries without `authorships`); returns empty lists when the
    DOI is unknown to OpenAlex or a transient error hit the list endpoint.
    Raises RuntimeError with actionable guidance when no API key is
    available, OpenAlex rejects it (401/409), or the key is over its
    usage limit (429 after one retry) — do not retry anonymously."""
    enc = quote_doi_path(doi)
    work = litrev_openalex_get(
        f"https://api.openalex.org/works/doi:{enc}?select=id"
    )
    work_id = ((work or {}).get("id") or "").rsplit("/", 1)[-1]
    if not work_id:
        return {"references": [], "cited_by": []}

    def _rows(results: list) -> list[dict]:
        out = []
        for w in results or []:
            out.append(
                {
                    "doi": (w.get("doi") or "").replace("https://doi.org/", ""),
                    "title": w.get("title"),
                    "authors": openalex_authors(w),
                    "year": w.get("publication_year"),
                    "cited_by": w.get("cited_by_count"),
                }
            )
        return out

    def _list(filter_expr: str, n: int) -> list[dict]:
        base = (
            f"https://api.openalex.org/works?filter={filter_expr}"
            f"&sort=cited_by_count:desc&per-page={min(n, 100)}"
        )
        j = litrev_openalex_get(base + "&select=doi,title,publication_year,cited_by_count,authorships")
        if j is None:
            # litrev_openalex_get maps a select rejection and a transient
            # error to the same None; one retry without `authorships` makes
            # the worst case an authorless expansion, not an empty one.
            j = litrev_openalex_get(base + "&select=doi,title,publication_year,cited_by_count")
        return _rows((j or {}).get("results", []))

    return {
        "references": _list(f"cited_by:{work_id}", n_backward),
        "cited_by": _list(f"cites:{work_id}", n_forward),
    }


def html_decode(s: str) -> str:
    """Minimal HTML entity decode for DOI extraction (lt/gt/amp/nbsp/slash)."""
    for a, b in (("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&"), ("&nbsp;", " "), ("&#x2F;", "/"), ("&#47;", "/")):
        s = s.replace(a, b)
    return s


def extract_dois(text: str) -> list[str]:
    """Pull every DOI-looking string from `text` (for feeding to verify_dois).
    HTML-decoded, balanced-paren SICI, `</`-truncated, markdown/punct-stripped."""
    decoded = html_decode(text)
    out: set[str] = set()
    for m in re.findall(DOI_PATTERN, decoded):
        d = m.split("</")[0]
        if d.count("<") != d.count(">"):
            d = d.split("<")[0]
        d = re.sub(r"(?:\*\*|__|[_\]\*>`,;:])+$", "", d)
        if d.endswith("."):
            d = d[:-1]
        while d.endswith(")") and d.count("(") < d.count(")"):
            d = d[:-1]
        if len(d) > 8:
            out.add(d)
    return sorted(out)


def style_pass(draft: str, model: str | None = None) -> dict:
    """Deterministic prose lint. Returns {ok, issues:[{code,note}]} where each
    code is one of EMDASH/HONEST/PROCNOTE/PARENDOI/LONGHEAD/FLATSTRUCT.

    No LLM call by design: drafts routinely quote web/paper-retrieved
    third-party text, and a free-text fix hint the agent is instructed to
    apply would be an indirect-injection channel. The deterministic regex
    codes are the load-bearing checks. `model` is accepted and ignored."""
    del model
    issues: list[dict] = []
    w = len(draft.split()) or 1
    em = draft.count("—")
    if em > 6 and 1000 * em / w > 8:
        issues.append({"code": "EMDASH", "note": f"{em} em-dashes ({1000*em/w:.0f}/1kw); replace most with comma/colon/period, keep at most one per paragraph"})
    m = re.search(r"\b(the\s+|an?\s+)?honest(ly)?\s+(answer|summary|read|reading|look|perspective|assessment|appraisal|take|view)\b", draft, re.I)
    if m:
        issues.append({"code": "HONEST", "note": f"{m.group(0)!r}: drop the framing, write the sentence it was guarding"})
    if re.search(r"(DOIs?\s+(were\s+)?verif|verified against (CrossRef|PubMed)|no retraction|current as of)", draft, re.I):
        issues.append({"code": "PROCNOTE", "note": "process-narration line present; delete it"})
    if re.search(r"\]\(https://doi\.org/[^)\s]*\([^)\s]*\)", draft):
        issues.append({"code": "PARENDOI", "note": "DOI href contains literal ( ); URL-encode as %28 %29 so the markdown link survives simpler renderers"})
    h2 = [ln for ln in draft.split("\n") if ln.startswith("## ")]
    long_h2 = [ln for ln in h2 if len(ln.split()) > 8]
    if len(long_h2) >= 2:
        issues.append({"code": "LONGHEAD", "note": f"{len(long_h2)} headings read as sentences; shorten to <=6-word noun phrases"})
    if len(h2) >= 7 and not any(ln.startswith("### ") for ln in draft.split("\n")):
        issues.append({"code": "FLATSTRUCT", "note": f"{len(h2)} top-level sections, no subsections; group related ## under a parent and demote to ###"})
    return {"ok": len(issues) == 0, "issues": issues}
