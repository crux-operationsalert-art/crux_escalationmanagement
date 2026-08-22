# Tests

`node test/security.test.js`

Runs the real `src/*.gs` sources in a Node sandbox (`gas-harness.js`) with the
Apps Script globals stubbed and the exported sheet data behind an in-memory table
layer. No spreadsheet is touched and no email is sent.

Sheet fixtures are read from `$CRUX_CSV_DIR` (default `/tmp/db/csv`), one CSV per
tab with a header row. Regenerate them by exporting the datastore spreadsheet to
XLSX and splitting each sheet to CSV.

`security.test.js` covers the 2026-08-22 authentication incident. Section 1
deliberately reproduces the vulnerability against the *old* logic so the test
proves the flaw was real rather than asserting it away; every later section
exercises the current code and must pass.

## Layout tests

`node test/layout.test.js` needs Chromium (found automatically at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, or set `CHROME`). It skips
with exit 0 if Chromium is absent rather than failing a run that cannot do better.

`layout/build-harness.js` assembles the real `Styles.html` + `App.html` into a
standalone page with `google.script.run` stubbed and a probe appended, then
`layout/measure.sh` renders it headless and prints the probe's JSON. The generated
`layout/harness.html` is not committed.

The RPC fixtures must match the shapes the views actually consume —
`paginate_` returns `{total, page, size, rows}`, and a view handed `{items}`
silently renders its empty state, which would make a layout test pass while
measuring nothing. `layout.test.js` guards against that by asserting some table
genuinely overflows.
