"""Bundled provider-scoped medical and molecular data engine."""
import argparse
from pathlib import Path
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from core import Store, PROVIDERS
from research import register_research
from access import access_guidance, access_tool


def create_server(store):
    app = FastMCP(f'medical-{store.provider}', log_level='WARNING', instructions=(
        'Work only with this database provider and personally authorized data. '
        'Call provider_info first. Download and import tools return a job_id; poll get_job until ready. '
        'Explain access_guidance to the user before credentialed downloads or when API keys are missing. '
        'Use access_requirements for application links and configuration presence; never equate configured credentials with approved access. '
        'Do not bypass access, approve agreements, supply credentials in tool arguments, or treat local results as dataset availability evidence. '
        'Queries return at most 1000 rows and may be truncated. Credentialed patient rows remain local by default.'
    ))
    read = ToolAnnotations(readOnlyHint=True, destructiveHint=False)
    write = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False)
    tool = access_tool(app, store)

    @tool(annotations=read)
    def access_requirements(include_related_services: bool = False) -> dict:
        """Check API/data access requirements and official application links. Shows credential presence only, never values. Optionally explain related service requirements; their credentials are not checked here."""
        return access_guidance(store.provider, include_related_services)

    @tool(annotations=read)
    def provider_info() -> dict:
        """Show verified provider scope, official entry points, supported formats and limitations."""
        return {**store.info(), 'access_guidance': access_guidance(store.provider)}

    @tool(annotations=read)
    def list_tables() -> dict:
        """List imported tables with source version, checksum and variable labels; no patient rows."""
        return store.list_tables()

    @tool(annotations=read)
    def describe_table(table_name: str) -> dict:
        """Inspect local table columns, data types and available variable labels."""
        return store.describe_table(table_name)

    @tool(annotations=write)
    def import_data(path: str, table_name: str, delimiter: str = '', encoding: str = 'utf-8', source_version: str = '') -> dict:
        """Import an authorized file in incoming/downloads as a new local table. Returns a job; existing tables are never replaced. TXT requires a delimiter. ZIP must be extracted first."""
        return store.submit('import', store.import_table, path, table_name, delimiter, encoding, source_version)

    @tool(annotations=write)
    def query_local(sql: str, max_rows: int = 100, export_csv: bool = False) -> dict:
        """Run one SELECT/WITH against local imported tables; filesystem and network SQL are disabled. May write a result CSV. Credentialed row values remain local unless explicitly enabled at startup."""
        return store.query(sql, max_rows, export_csv)

    @tool(annotations=read)
    def get_job(job_id: str) -> dict:
        """Check the same queued download/import/extract job; do not start a duplicate job to wait."""
        return store.get_job(job_id)

    @tool(annotations=read)
    def inspect_archive(path: str, limit: int = 200) -> dict:
        """List members of an authorized ZIP in incoming/downloads without extracting its contents."""
        if not 1 <= limit <= 500:
            raise ValueError('Use limit 1–500.')
        return store.inspect_archive(path, limit)

    @tool(annotations=write)
    def extract_archive_member(path: str, member: str) -> dict:
        """Extract one selected ZIP data member into incoming; checks paths and expansion limits."""
        return store.submit('extract', store.extract_member, path, member)

    if store.config['download']:
        @tool(annotations=write)
        def download_file(url: str, filename: str, expected_sha256: str = '') -> dict:
            """Download one real official file URL using configured secrets; returns a job. No login pages, registration, access bypass, automatic retry, or bulk resume. Max 5 GiB/file."""
            return store.submit('download', store.download, url, filename, expected_sha256)

    if store.provider == 'nhanes':
        @tool(annotations=read)
        def list_nhanes_files(cycle_begin_year: int, component: str = 'Demographics') -> dict:
            """Discover official NHANES XPT file URLs for a cycle/component, before download."""
            return store.nhanes_files(cycle_begin_year, component)

    if store.provider == 'europepmc':
        @tool(annotations=read)
        def search_europepmc(query: str, page_size: int = 20, cursor: str = '*') -> dict:
            """Search Europe PMC with its Boolean query syntax. Returns core records/abstracts, total count and next cursor. One page is not an exhaustive search, and a full-text URL is not proof of retrieved full text."""
            return store.europepmc_search(query, page_size, cursor)

    if store.provider in {'mimic', 'eicu'}:
        @tool(annotations=read)
        def list_physionet_files(directory_url: str) -> dict:
            """List a provider-scoped PhysioNet directory using personal credentials, or a public demo."""
            return store.physionet_files(directory_url)

    if store.provider == 'faers':
        @tool(annotations=write)
        def query_faers(search: str = '', count: str = '', limit: int = 10, skip: int = 0) -> dict:
            """Query/count openFDA adverse event reports and save the complete returned page to JSON. Pagination is explicit and not an exhaustive export."""
            return store.faers_query(search, count, limit, skip)

        @tool(annotations=read)
        def list_faers_bulk_files(limit: int = 50) -> dict:
            """Get the official openFDA drug/event bulk partition manifest for downloading selected files."""
            return store.faers_downloads(limit)
    register_research(app, store, read, write)
    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--provider', choices=PROVIDERS, required=True)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--return-rows', action='store_true', help='Explicitly allow authorized non-public row data to be returned to the model.')
    args = parser.parse_args()
    create_server(Store(args.provider, args.data_root, args.return_rows)).run(transport='stdio')
