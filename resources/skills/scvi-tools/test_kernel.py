"""Run from the repository root: python -m unittest discover -s resources/skills/scvi-tools -v"""
import tempfile
import unittest
from pathlib import Path

import anndata as ad
import numpy as np
from scipy import sparse

from kernel import prepare_scvi_counts


class PrepareCountsTests(unittest.TestCase):
    def test_existing_counts_survive_normalized_x_and_h5ad_roundtrip(self):
        counts = np.array([[0, 2], [3, 1]])
        data = ad.AnnData(np.log1p(counts), layers={"counts": counts.copy()})
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "input.h5ad"
            data.write_h5ad(path)
            loaded = ad.read_h5ad(path)
            existing = loaded.layers["counts"]
            prepare_scvi_counts(loaded)
            self.assertIs(loaded.layers["counts"], existing)
            np.testing.assert_array_equal(loaded.X, np.log1p(counts))
            np.testing.assert_array_equal(loaded.layers["counts"], counts)
            loaded.X = loaded.layers["counts"].copy()
            loaded.X[0, 0] = 99
            np.testing.assert_array_equal(loaded.layers["counts"], counts)
            # Preparation does not write back to the user's input file.
            np.testing.assert_array_equal(ad.read_h5ad(path).X, np.log1p(counts))

    def test_sparse_counts_remain_sparse_without_toarray(self):
        from unittest.mock import patch
        for cls in (sparse.csr_matrix, sparse.csc_matrix, sparse.csr_array, sparse.csc_array):
            with self.subTest(format=cls.__name__):
                matrix = cls(np.array([[0, 2], [3, 0]]))
                data = ad.AnnData(matrix)
                with patch.object(cls, "toarray", side_effect=AssertionError("densified")):
                    prepare_scvi_counts(data)
                self.assertIsInstance(data.layers["counts"], cls)
                self.assertEqual((data.layers["counts"] != matrix).nnz, 0)

    def test_rejects_fractional_value_beyond_first_chunk(self):
        matrix = np.ones((2, 40000))
        matrix[-1, -1] = 0.5
        data = ad.AnnData(matrix)
        with self.assertRaisesRegex(ValueError, "Fractional"):
            prepare_scvi_counts(data)
        self.assertNotIn("counts", data.layers)

    def test_invalid_existing_counts_do_not_fall_back_to_x(self):
        data = ad.AnnData(np.ones((2, 2)), layers={"counts": np.full((2, 2), 0.5)})
        with self.assertRaisesRegex(ValueError, "Fractional"):
            prepare_scvi_counts(data)
        np.testing.assert_array_equal(data.layers["counts"], np.full((2, 2), 0.5))

    def test_absent_counts_defaults_to_x_without_using_raw(self):
        for sparse_input in (False, True):
            with self.subTest(sparse=sparse_input):
                matrix = np.array([[1., 0.], [2., 3.]])
                data = ad.AnnData(sparse.csr_matrix(matrix) if sparse_input else matrix.copy())
                data.raw = ad.AnnData(np.full((2, 2), 99))
                record = prepare_scvi_counts(data)
                self.assertEqual(record["source"], "X")
                if sparse_input:
                    self.assertTrue(sparse.issparse(data.layers["counts"]))
                    self.assertEqual((data.layers["counts"] != data.X).nnz, 0)
                    self.assertFalse(np.shares_memory(data.X.data, data.layers["counts"].data))
                else:
                    np.testing.assert_array_equal(data.layers["counts"], matrix)
                    self.assertFalse(np.shares_memory(data.X, data.layers["counts"]))

    def test_absent_counts_with_invalid_x_does_not_create_counts(self):
        for value in (0.25, -1, float("nan"), float("inf")):
            for sparse_input in (False, True):
                with self.subTest(value=value, sparse=sparse_input):
                    matrix = np.array([[1., 0.], [2., value]])
                    data = ad.AnnData(sparse.csr_matrix(matrix) if sparse_input else matrix)
                    data.raw = ad.AnnData(np.ones((2, 2)))
                    with self.assertRaises(ValueError):
                        prepare_scvi_counts(data)
                    self.assertNotIn("counts", data.layers)

    def test_rejects_empty_zero_and_nonnumeric_counts(self):
        for matrix in (np.empty((0, 2)), np.zeros((2, 2)), np.ones((2, 2), dtype=bool),
                       np.ones((2, 2), dtype=complex), np.full((2, 2), "1")):
            with self.subTest(dtype=matrix.dtype, shape=matrix.shape):
                data = ad.AnnData(matrix)
                with self.assertRaises(ValueError):
                    prepare_scvi_counts(data)
                self.assertNotIn("counts", data.layers)

    def test_rejects_views_and_backed_objects(self):
        data = ad.AnnData(np.ones((2, 2)))
        with self.assertRaisesRegex(ValueError, "in-memory"):
            prepare_scvi_counts(data[:1])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "input.h5ad"
            data.write_h5ad(path)
            backed = ad.read_h5ad(path, backed="r")
            try:
                with self.assertRaisesRegex(ValueError, "in-memory"):
                    prepare_scvi_counts(backed)
            finally:
                backed.file.close()


if __name__ == "__main__":
    unittest.main()
