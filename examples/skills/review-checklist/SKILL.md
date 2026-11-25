---

name: review-checklist
description: Checklist for reviewing a code change. Use before writing review findings, to make sure nothing important was skipped.
---

# Review checklist

Go through each point for the change under review. Skip a point only when it cannot apply, and say which ones you skipped.

1. **Scope**: does the change do what was asked, and nothing else? List files that changed without a reason.
2. **Callers**: for every changed function, type or file format, find who uses it and check that they still work.
3. **Edge cases**: empty input, missing files, wrong types, repeated calls, two sessions at the same time.
4. **Errors**: is a failure reported where someone will see it, or swallowed?
5. **Tests**: is there a test for the new behaviour that would fail without the change? Did the project's checks pass, and who ran them?
6. **Project rules**: read CLAUDE.md and check the change against the rules written there.
7. **Leftovers**: debugging output, commented-out code, notes to self, files that should not be committed.

Report a finding only when you can name the file and line and say what goes wrong. Put everything else under "not checked" or "questions".
