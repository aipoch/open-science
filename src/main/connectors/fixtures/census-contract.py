"""Offline contract tests: real pandas/Arrow, mocked Census network boundary."""
import io
import os
import re
import sys
import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd
import pyarrow as pa

source = Path(__file__).parents[1].joinpath('census-runtime.ts').read_text()
program = re.search(r'const PYTHON_PROGRAM = String.raw`(.*?)`\n', source, re.S).group(1)
bridge = {}
with patch('sys.stdin', io.StringIO('')):
    exec(compile(program, 'census-bridge.py', 'exec'), bridge)
api = bridge['cellxgene_census']

class Reader:
    def __init__(self, frames):
        self.frames = frames
        self.closed = False
    def __iter__(self):
        yield from (pa.Table.from_pandas(frame) for frame in self.frames)
    def close(self):
        self.closed = True

class Contract(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {"HTTPS_PROXY": "http://user:p%40ss@localhost:4567"})
        env.start()
        self.addCleanup(env.stop)
        self.obs = pd.DataFrame({'soma_joinid': [11, 19, 40], 'dataset_id': ['a'] * 3,
            'assay': ['10x'] * 3, 'cell_type': ['hepatocyte'] * 3,
            'tissue_general': ['liver'] * 3, 'disease': ['normal'] * 3,
            'sex': ['female'] * 3, 'development_stage': ['adult'] * 3})

    def test_tiledb_uses_command_proxy_and_trust_bundle(self):
        with patch.dict(os.environ, {"SSL_CERT_FILE": "/fixture/ca.pem"}):
            config = bridge['tiledb_config']()
        self.assertEqual(config['vfs.s3.proxy_host'], 'localhost')
        self.assertEqual(config['vfs.s3.proxy_port'], '4567')
        self.assertEqual(config['vfs.s3.proxy_scheme'], 'http')
        self.assertEqual(config['vfs.s3.proxy_password'], 'p@ss')
        self.assertEqual(config['vfs.s3.ca_file'], '/fixture/ca.pem')
        self.assertEqual(config['soma.init_buffer_bytes'], 8 * 1024 * 1024)
        self.assertEqual(config['py.init_buffer_bytes'], 8 * 1024 * 1024)
        self.assertEqual(config['sm.skip_checksum_validation'], 'false')
        with patch.dict(os.environ, {"HTTPS_PROXY": ""}):
            with self.assertRaises(RuntimeError): bridge['tiledb_config']()

    def test_optional_and_unsafe_filters(self):
        self.assertEqual(bridge['observation_filter']({'tissue': 'liver'}), "tissue_general == 'liver'")
        self.assertIsNone(bridge['observation_filter']({}))
        for value in ["x' or True", 'x\\y', 'x\ny']:
            with self.assertRaises(ValueError): bridge['text_filter']('tissue_general', value)
        self.assertEqual(bridge['observation_filter']({'disease': 'a || b'}), "disease == 'a || b'")

    def test_invalid_cohorts_fail_before_network_access(self):
        requests = [{}]
        for field in ('tissue', 'cell_type', 'disease'):
            for value in ('', '  ', '\t\n', '\u3000'):
                requests.extend([{field: value}, {'tissue': 'liver', field: value}])
        with patch.object(api, 'get_census_version_description') as resolve, patch.object(api, 'open_soma') as opened:
            for args in requests:
                with self.subTest(args=args), self.assertRaises(ValueError):
                    bridge['handle']({'action': 'query_cells', **args})
            resolve.assert_not_called()
            opened.assert_not_called()

    def test_bounded_arrow_batches_and_close(self):
        reader = Reader([self.obs.iloc[:2], self.obs.iloc[2:]])
        seen = {}
        def read(**kwargs):
            # Arrow's upstream column projection rejects unknown names.
            pa.Table.from_pandas(self.obs).select(kwargs['column_names'])
            seen.update(kwargs)
            return reader
        census = {'census_data': {'homo_sapiens': {'obs': SimpleNamespace(read=read)}}}
        organism, result = bridge['observations'](census, {'tissue': 'liver'}, 2)
        self.assertEqual(organism, 'homo_sapiens')
        self.assertEqual(result.soma_joinid.tolist(), [11, 19])
        self.assertEqual(seen['value_filter'], "tissue_general == 'liver'")
        self.assertEqual(seen['result_order'], 'row-major')
        self.assertEqual(seen['platform_config'], {'soma.init_buffer_bytes': '65536'})
        # Per-read options reach the native constructor without the Python
        # context wrapper's int-to-string conversion. Exercise that contract.
        bridge['tiledbsoma'].pytiledbsoma.SOMAContext(seen['platform_config'])
        self.assertTrue(reader.closed)

    def test_native_errors_never_return_command_proxy_credentials(self):
        text = "bad config http://user:p%40ss@localhost:4567 username=user password=p@ss encoded=p%40ss"
        message = bridge['error_message'](TypeError(text))
        for secret in ('p%40ss', 'p@ss', 'username=user'):
            self.assertNotIn(secret, message)
        self.assertIn('bad config', message)

    def test_empty_cells(self):
        reader = Reader([])
        census = {'census_data': {'homo_sapiens': {'obs': SimpleNamespace(read=lambda **kw: reader)}}}
        result = bridge['query_cells'](census, {'tissue': 'absent'}, 'fixed')
        self.assertEqual(result['cells'], [])
        self.assertEqual(result['total_returned'], 0)
        self.assertTrue(reader.closed)

    def test_dataset_search_is_literal_and_total_precedes_limit(self):
        frame = pd.DataFrame({'dataset_id': ['a', 'b', 'c'], 'dataset_title': ['Liver', 'LIVER', 'heart'], 'collection_name': ['', '', ''], 'citation': ['', '', '']})
        table = pa.Table.from_pandas(frame)
        census = {'census_info': {'datasets': SimpleNamespace(read=lambda: SimpleNamespace(concat=lambda: table))}}
        result = bridge['list_datasets'](census, {'query': 'liver', 'limit': 1}, 'fixed')
        self.assertEqual(result['total'], 2)
        self.assertEqual(len(result['datasets']), 1)
        self.assertEqual(bridge['list_datasets'](census, {'query': '.*'}, 'fixed')['total'], 0)

    def test_repeated_dataset_queries_empty_and_recovery(self):
        frame = pd.DataFrame({'dataset_id': ['a', 'b'], 'dataset_title': ['Liver', 'Heart'], 'collection_name': ['', ''], 'citation': ['', '']})
        census = {'census_info': {'datasets': SimpleNamespace(read=lambda: SimpleNamespace(concat=lambda: pa.Table.from_pandas(frame)))}}
        expected = bridge['list_datasets'](census, {'query': 'liver', 'limit': 1}, 'fixed')
        for _ in range(3):
            actual = bridge['list_datasets'](census, {'query': 'liver', 'limit': 1}, 'fixed')
            self.assertEqual(actual, expected)
            actual['datasets'][0]['dataset_title'] = 'caller mutation'
        empty = bridge['list_datasets'](census, {'query': 'CENSUS_TEST_UNKNOWN_DATASET'}, 'fixed')
        self.assertEqual(empty, {'census_version': 'fixed', 'total': 0, 'datasets': []})
        self.assertEqual(bridge['list_datasets'](census, {'query': 'liver', 'limit': 1}, 'fixed'), expected)

    def test_repeated_cell_queries_empty_and_recovery(self):
        readers = []
        def read(**kwargs):
            frame = self.obs if kwargs['value_filter'] == "tissue_general == 'liver'" else self.obs.iloc[:0]
            reader = Reader([frame[kwargs['column_names']]])
            readers.append(reader)
            return reader
        census = {'census_data': {'homo_sapiens': {'obs': SimpleNamespace(read=read)}}}
        args = {'tissue': 'liver', 'limit': 2}
        expected = bridge['query_cells'](census, args, 'fixed')
        self.assertEqual([cell['soma_joinid'] for cell in expected['cells']], [11, 19])
        for _ in range(3):
            actual = bridge['query_cells'](census, args, 'fixed')
            self.assertEqual(actual, expected)
            actual['cells'][0]['cell_type'] = 'caller mutation'
        empty = bridge['query_cells'](census, {'tissue': 'CENSUS_TEST_UNKNOWN_TISSUE'}, 'fixed')
        self.assertEqual(empty, {'census_version': 'fixed', 'organism': 'homo_sapiens', 'total_returned': 0, 'cells': []})
        self.assertEqual(bridge['query_cells'](census, args, 'fixed'), expected)
        self.assertTrue(all(reader.closed for reader in readers))

    def test_real_categorical_enum_rejects_unknown_without_scanning(self):
        soma = bridge['tiledbsoma']
        table = pa.table({'soma_joinid': pa.array([0], type=pa.int64()),
                          'tissue_general': pa.array(['liver']).dictionary_encode(),
                          'disease': pa.array(['normal'])})
        with tempfile.TemporaryDirectory() as root:
            uri = str(Path(root) / 'obs')
            with soma.DataFrame.create(uri, schema=table.schema, domain=((0, 10),)) as frame:
                frame.write(table)
            with soma.DataFrame.open(uri) as frame:
                census = {'census_data': {'homo_sapiens': {'obs': frame}}}
                with patch.object(soma.DataFrame, 'read') as read:
                    result = bridge['query_cells'](census, {'tissue': 'unknown'}, 'fixed')
                read.assert_not_called()
                self.assertEqual(result['cells'], [])
                self.assertEqual(result['total_returned'], 0)
                with patch.object(soma.DataFrame, 'read', return_value=Reader([self.obs])) as read:
                    result = bridge['query_cells'](census, {'tissue': ' liver ', 'limit': 2}, 'fixed')
                read.assert_called_once()
                self.assertEqual(result['total_returned'], 2)
                self.assertEqual(read.call_args.kwargs['value_filter'], "tissue_general == 'liver'")
                with patch.object(soma.DataFrame, 'read', return_value=Reader([self.obs])) as read:
                    result = bridge['query_cells'](census, {'disease': 'normal', 'limit': 2}, 'fixed')
                read.assert_called_once()
                self.assertEqual(result['total_returned'], 2)

    def test_enumeration_failure_is_not_an_empty_result(self):
        schema = pa.schema([pa.field('tissue_general', pa.dictionary(pa.int32(), pa.string()))])
        def broken(columns):
            raise bridge['tiledbsoma'].SOMAError('upstream enumeration unavailable')
        frame = SimpleNamespace(schema=schema, get_enumeration_values=broken)
        census = {'census_data': {'homo_sapiens': {'obs': frame}}}
        with self.assertRaisesRegex(bridge['tiledbsoma'].SOMAError, 'upstream enumeration unavailable'):
            bridge['query_cells'](census, {'tissue': 'unknown'}, 'fixed')

    def test_each_call_closes_census_on_success_and_failure(self):
        from contextlib import contextmanager
        closed = []
        @contextmanager
        def opened(**kwargs):
            try: yield None
            finally: closed.append(kwargs['census_version'])
        with patch.object(api, 'get_census_version_description', return_value={'release_build': '2025-11-08'}), patch.object(api, 'open_soma', side_effect=opened), patch.dict(bridge, query_cells=lambda *a: {'ok': True}):
            bridge['handle']({'action': 'query_cells', 'tissue': 'liver'})
            with self.assertRaises(ValueError): bridge['handle']({'action': 'invalid'})
        self.assertEqual(closed, ['2025-11-08', '2025-11-08'])

    def test_checksum_retry_closes_then_reopens_and_keeps_resolved_release(self):
        from contextlib import contextmanager
        for action in ('list_datasets', 'query_cells'):
            with self.subTest(action=action):
                events = []
                reads = []
                @contextmanager
                def opened(**kwargs):
                    handle = object()
                    events.append('open')
                    self.assertEqual(kwargs['census_version'], '2025-11-08')
                    self.assertEqual(kwargs['tiledb_config']['sm.skip_checksum_validation'], 'false')
                    try: yield handle
                    finally: events.append('close')
                def read(handle, args, release):
                    events.append('read')
                    reads.append(handle)
                    if len(reads) == 1:
                        raise bridge['tiledbsoma'].SOMAError('S3: Response checksums mismatch')
                    return {'release': release}
                with patch.object(api, 'get_census_version_description', return_value={'release_build': '2025-11-08'}) as version, patch.object(api, 'open_soma', side_effect=opened), patch.dict(bridge, {action: read}):
                    self.assertEqual(bridge['handle']({'action': action, 'tissue': 'liver'}), {'release': '2025-11-08'})
                version.assert_called_once_with('stable')
                self.assertEqual(events, ['open', 'read', 'close', 'open', 'read', 'close'])
                self.assertIsNot(reads[0], reads[1])

    def test_persistent_checksum_failure_stops_after_one_retry(self):
        from contextlib import contextmanager
        closed = []
        @contextmanager
        def opened(**kwargs):
            try: yield None
            finally: closed.append(True)
        def read(*args):
            raise bridge['tiledbsoma'].SOMAError('S3: Response checksums mismatch')
        with patch.object(api, 'open_soma', side_effect=opened) as op, patch.dict(bridge, query_cells=read):
            with self.assertRaisesRegex(bridge['tiledbsoma'].SOMAError, 'Response checksums mismatch'):
                bridge['handle']({'action': 'query_cells', 'tissue': 'liver', 'census_version': '2025-11-08'})
        self.assertEqual(op.call_count, 2)
        self.assertEqual(len(closed), 2)

    def test_other_errors_are_never_retried(self):
        for error in (bridge['tiledbsoma'].SOMAError('S3: access denied'), bridge['tiledbsoma'].SOMAError('local Response checksums mismatch'), ValueError('S3: Response checksums mismatch')):
            with self.subTest(error=str(error)), patch.object(api, 'open_soma', side_effect=error) as op:
                with self.assertRaises(type(error)):
                    bridge['handle']({'action': 'query_cells', 'tissue': 'liver', 'census_version': '2025-11-08'})
                op.assert_called_once()

    def test_checksum_failure_during_open_also_gets_one_fresh_attempt(self):
        from contextlib import nullcontext
        error = bridge['tiledbsoma'].SOMAError('S3: Response checksums mismatch')
        with patch.object(api, 'open_soma', side_effect=[error, nullcontext(None)]) as op, patch.dict(bridge, query_cells=lambda *a: {'ok': True}):
            self.assertEqual(bridge['handle']({'action': 'query_cells', 'tissue': 'liver', 'census_version': '2025-11-08'}), {'ok': True})
        self.assertEqual(op.call_count, 2)

if __name__ == '__main__': unittest.main()
