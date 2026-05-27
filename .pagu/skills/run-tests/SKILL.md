---
name: run-tests
description: >
  Run the pagu test suite. Use when asked to run tests, verify the suite,
  check that things are working, or confirm nothing is broken.
files:
  - deno.json
scripts:
  - name: run-tests
    description: Run the full pagu test suite via deno task test
    permissions:
      - allow-run=deno
      - allow-read=.
      - allow-write=.
      - allow-env
      - allow-net
---

When asked to run the tests, verify the suite, or check that things are working,
use the `run-tests` script. Read it from `scripts/run-tests.ts` first, then
propose it verbatim — do not modify it.
