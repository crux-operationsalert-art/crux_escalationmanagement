#!/usr/bin/env bash
# Run every suite. Exits non-zero if any fails.
set -u
cd "$(dirname "$0")/.."
rc=0
for t in test/lint.test.js test/security.test.js test/matrix.test.js test/scoring.test.js test/email.test.js; do
  [ -f "$t" ] || continue
  echo "########## $t ##########"
  node "$t" || rc=1
done
echo
[ $rc -eq 0 ] && echo "ALL SUITES PASSED" || echo "SOME SUITES FAILED"
exit $rc
