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
