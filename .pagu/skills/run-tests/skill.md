---
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
use the `run-tests` script. Read it from the skills directory first, then
propose it verbatim — do not modify it.
