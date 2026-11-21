[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/nuraliana/brisk-otter-91/rank.svg?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/nuraliana/brisk-otter-91/reward.svg?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

# Fast drop-in for csv-reader 1.0.0

A faster drop-in for make.fun's own csv-reader 1.0.0, written for the
[csv-reader-speed-01-run-20261121](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
bounty. It returns exactly the same `{columns, rows, errors}` answer as
csv-reader 1.0.0 on every case, and does it faster.

## How it is faster

The reference reads one character at a time and grows each field a
character at a time. This reader instead jumps with `indexOf` to the next
thing that can end a field and cuts fields out with `slice`, so the common
field costs a few native scans instead of a loop over its characters:

- A whole plain line (no quote, no stray CR) splits in C++ with
  `String.split(',')`.
- Unquoted fields reuse the line end found once per record instead of
  searching for the next LF again per field.
- A quoted field's closing quote is found with `indexOf`, skipping doubled
  `""` pairs; a simple quoted field is one `slice`.
- Only the rare broken shapes (a stray CR inside an unquoted field, doubled
  quotes or a line break inside a quoted field, junk after a closing quote,
  a quote that never closes) take a slower path.

Measured on the kit's practice set (6 cases, ~10.2 MB of CSV), local CPU
time is about 4.5x the reference's, and the answers match the reference
(and the kit's expected output) on all 6 cases.

## Files

- `solve.js` — the entry: `run(input)` returns csv-reader 1.0.0's answer
  for `{text, header}`. Dependency-free ES module.
- `main.ts` — the harness driver (from the kit's baseline): reads every
  case from `/input/cases.json`, answers each with `run`, writes
  `/output/answers.json`.

## License

MIT — see [LICENSE](LICENSE).
