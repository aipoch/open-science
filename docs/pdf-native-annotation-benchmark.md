# Native PDF annotation import and rendering benchmark

## Reproduce the import comparison

Use real PDFs with exactly the stated page counts. The test asserts the actual page count, runs
three alternating current-thread/worker comparisons, and exercises a real Node worker built from
the production parser. Missing samples are reported as **skipped**, not successful measurements.
A separate one-page fixture always checks that the worker preserves a native sticky note.

```bash
PDF_BENCHMARK_100=/path/to/100-page.pdf \
PDF_BENCHMARK_500=/path/to/500-page.pdf \
PDF_BENCHMARK_1000=/path/to/1000-page.pdf \
PDF_BENCHMARK_OUTPUT=/tmp/pdf-import-results.json \
npx vitest run src/main/pdf-annotations/native-import.benchmark.test.ts
```

`processCpuMs` includes worker CPU; moving parsing to a worker does not remove the parsing work.
The event-loop metric samples timer lateness at 10 ms intervals. Timings are observations, not
machine-independent pass/fail budgets.

## Measured on 2026-09-20

macOS arm64; Node 22.23.2 for the three-run import comparison; Electron 39.8.10 for the isolated
desktop run. The renderer uses the actual `PdfPreviewContent` with a fixture content-range bridge,
not the full authenticated application or its production SQLite database. The desktop main process
runs the production native parser. This separates rendering/parser costs from upload/network/DB costs.

Source: [PGF manual, CTAN](https://ctan.math.illinois.edu/graphics/pgf/base/doc/generic/pgf/pgfmanual.pdf),
1324 pages, SHA-256 `32cef61a3161754763a6368ea9ed67d07127dd37b7576db7c2cbefa56faf087c`.
The samples contain the first 100/500/1000 **distinct real pages**, copied with pdf-lib. Controlled
Text and Highlight annotations were added every 10 pages, and one unsupported Sound annotation
every 100 pages. These are real-content subsets with controlled marks, not three independently
sourced documents or blank/repeated-page stress fixtures.

| Pages |     Bytes | Supported marks | Unsupported marks |
| ----- | --------: | --------------: | ----------------: |
| 100   | 1,181,125 |              20 |                 1 |
| 500   | 3,878,686 |             100 |                 5 |
| 1000  | 7,353,234 |             200 |                10 |

Three-run median Node import comparison:

| Pages | Current-thread wall / CPU | Worker wall / CPU | Maximum event-loop delay, current / worker |
| ----- | ------------------------- | ----------------- | ------------------------------------------ |
| 100   | 567 / 825 ms              | 808 / 1280 ms     | 21 / 1 ms                                  |
| 500   | 2317 / 2754 ms            | 2697 / 3595 ms    | 72 / 1 ms                                  |
| 1000  | 4940 / 5446 ms            | 5300 / 7116 ms    | 208 / 4 ms                                 |

Single desktop main-process comparison (cold-start/order effects apply):

| Pages | Current-thread wall | Worker wall | Maximum main-loop delay, current / worker |
| ----- | ------------------: | ----------: | ----------------------------------------- |
| 100   |              830 ms |      643 ms | 198 / 4 ms                                |
| 500   |             1809 ms |     1952 ms | 70 / 3 ms                                 |
| 1000  |             3585 ms |     3714 ms | 187 / 3 ms                                |

Desktop rendering: 1280 × 900 window; actual wheel input, 80 steps of 240 px with 20 ms spacing,
three runs from the top of each document. The table shows medians across those runs; ready time
is the first visible canvas, not a claim that every pixel or all pages have finished rendering.

| Pages | First canvas | Frame interval p95 | Renderer task time per run | Long tasks >50 ms | Retained canvases / DOM nodes |
| ----- | -----------: | -----------------: | -------------------------: | ----------------: | ----------------------------- |
| 100   |      1003 ms |            33.3 ms |                    1418 ms |                 0 | 3 / 659                       |
| 500   |       993 ms |            49.9 ms |                    1853 ms |                 0 | 3 / 1059                      |
| 1000  |      1471 ms |            48.9 ms |                    2290 ms |                 0 | 3 / 1559                      |

## Decision and limitations

- All production native-annotation parsing runs in a worker. A file-size-only threshold is unsafe:
  the real 1000-page sample is only 7 MB. Worker startup adds latency/total CPU in the three-run
  comparison, but main-loop stalls fall sharply. Do not describe this as a reduction in total CPU.
- Release per-page parsing caches; extract text only for pages with text markup; notify progress
  at most every 100 ms plus the final page; terminate and join cancelled workers before closing
  the immutable content lease. Imported rows are written in one batch; only that write and its
  authority checks acquire the Session mutation barrier, not the long parsing phase.
- Keep the existing 240 px overscan and lazy canvas mounting. Only about three canvases survive
  during scrolling, with no observed long tasks. Lowering overscan risks blank pages; a new page
  virtualizer needs stronger evidence than this sample. These frame intervals do not establish
  a 60 FPS guarantee.
- This is one technical manual on one Mac, not coverage of image-heavy scans, every page position,
  Windows/Linux graphics drivers, or an end-to-end production upload latency benchmark.
