import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'resources' / 'medical-data'))

"""Exercise the real stdio MCP protocol for every generated provider config."""
import asyncio
import json
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from core import PROVIDERS


def payload(result):
    assert not result.isError, result
    if result.structuredContent:
        return result.structuredContent
    return json.loads(result.content[0].text)


async def main():
    root = Path(__file__).resolve().parents[2] / 'resources' / 'medical-data'
    qa = root.parent.parent / 'test-output/builtin-medical-data/protocol-data'
    results = []
    for provider in PROVIDERS:
        params = StdioServerParameters(command=sys.executable,
            args=[str(root/'bootstrap.py'), '--provider', provider, '--data-root', str(qa)],
            env={'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUTF8': '1'})
        async with stdio_client(params) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                await session.initialize()
                tools = await session.list_tools()
                names = {t.name for t in tools.tools}
                assert {'provider_info', 'import_data', 'query_local', 'get_job', 'describe_table'} <= names
                assert 'access_requirements' in names
                access = payload(await session.call_tool('access_requirements', {'include_related_services': True}))
                assert access['provider'] == provider
                assert len(access['related_builtin_services']) == 3
                assert access['related_credentials_status'] == 'not_checked_managed_by_host_app'
                query_tool = next(t for t in tools.tools if t.name == 'query_local')
                assert 'sql' in query_tool.inputSchema['properties']
                if access['kind'] != 'public':
                    assert 'Access:' in query_tool.description
                assert ('download_file' in names) == (provider != 'seer')
                info = payload(await session.call_tool('provider_info', {}))
                assert info['provider'] == provider
                assert info['access_guidance']['provider'] == provider
                source = Path(info['incoming_directory']) / 'protocol-fixture.csv'
                source.write_text('group,value\na,2\na,4\nb,10\n', encoding='utf-8')
                tables = payload(await session.call_tool('list_tables', {}))
                if not tables['tables']:
                    job = payload(await session.call_tool('import_data', {'path': str(source), 'table_name': 'protocol_fixture', 'source_version': 'synthetic-test'}))
                    for _ in range(200):
                        status = payload(await session.call_tool('get_job', {'job_id': job['job_id']}))
                        if status['status'] in {'ready', 'error'}:
                            break
                        await asyncio.sleep(.05)
                    assert status['status'] == 'ready', status
                result = payload(await session.call_tool('query_local', {'sql': 'SELECT count(*) AS n FROM protocol_fixture'}))
                assert result['returned_rows'] == 1
                if info['return_row_data_to_model']:
                    assert result['rows'] == [[3]]
                else:
                    assert 'rows' not in result and Path(result['csv_path']).exists()
                forbidden = await session.call_tool('query_local', {'sql': 'DROP TABLE protocol_fixture'})
                assert forbidden.isError
                results.append({'provider': provider, 'tools': len(names), 'stdio_initialize': 'passed',
                                'import_job_and_query': 'passed', 'write_sql_rejected': True})
    target = qa.parent / 'mcp-validation.json'
    target.write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
