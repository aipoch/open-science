"""Portable helper admission/validation checks; no scientific dependencies or network."""
import importlib.util
import os
import sys
from types import SimpleNamespace
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('census_helper', Path(__file__).with_name('kernel.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class CensusHelperTest(unittest.TestCase):
    def test_rejects_unbounded_or_invalid_queries_before_sdk_import(self):
        with patch.object(helper, '_query') as query:
            for limit in (0, 101, True, 1.5, '5'):
                with self.subTest(limit=limit), self.assertRaises(ValueError):
                    helper.census_list_datasets(limit=limit)
            for args in ({}, {'tissue': ' '}, {'disease': "normal' or True"}, {'cell_type': 123}):
                with self.subTest(args=args), self.assertRaises(ValueError):
                    helper.census_query_cells(**args)
            with self.assertRaises(ValueError):
                helper.census_list_datasets(census_version='')
            query.assert_not_called()

    def test_routes_public_functions_without_process_or_environment_selection(self):
        with patch.object(helper, '_query', return_value={'census_version': '2025-11-08'}) as query:
            helper.census_list_datasets(query='liver', limit=2, census_version='2025-11-08')
            self.assertEqual(query.call_args.args[0], {
                'action': 'list_datasets', 'query': 'liver', 'limit': 2, 'census_version': '2025-11-08'
            })
            helper.census_query_cells(tissue='liver')
            self.assertEqual(query.call_args.args[0]['organism'], 'homo_sapiens')
            self.assertEqual(query.call_args.args[0]['action'], 'query_cells')

    def test_uses_only_inherited_gateway_and_ca_for_native_s3(self):
        env = {'HTTPS_PROXY': 'http://user:secret%40value@127.0.0.1:1234', 'SSL_CERT_FILE': '/test/ca.pem'}
        with patch.dict(os.environ, env, clear=True):
            config = helper.tiledb_config()
        self.assertEqual(config['vfs.s3.proxy_host'], '127.0.0.1')
        self.assertEqual(config['vfs.s3.proxy_port'], '1234')
        self.assertEqual(config['vfs.s3.proxy_password'], 'secret@value')
        self.assertEqual(config['ssl.ca_file'], '/test/ca.pem')
        self.assertEqual(config['sm.skip_checksum_validation'], 'false')
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(RuntimeError, 'sandbox HTTP proxy'):
            helper.tiledb_config()

    def test_uses_requests_trust_roots_when_no_custom_bundle_is_configured(self):
        with patch.dict(os.environ, {'HTTPS_PROXY': 'http://localhost:1234'}, clear=True), patch.dict(
            sys.modules, {'certifi': SimpleNamespace(where=lambda: '/sdk/cacert.pem')}
        ):
            self.assertEqual(helper.tiledb_config()['ssl.ca_file'], '/sdk/cacert.pem')

    def test_redacts_native_config_errors_before_the_notebook_displays_them(self):
        proxy = 'http://census-user:secret%40value@127.0.0.1:1234'
        with patch.dict(os.environ, {'HTTPS_PROXY': proxy}), patch.object(
            helper, '_query', side_effect=RuntimeError(proxy + ' secret@value census-user')
        ):
            with self.assertRaises(RuntimeError) as raised:
                helper.census_query_cells(tissue='liver')
            self.assertNotIn('secret', str(raised.exception))
            self.assertNotIn('census-user', str(raised.exception))
            self.assertNotIn(proxy, str(raised.exception))


if __name__ == '__main__':
    unittest.main()
