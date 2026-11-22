# mend — one patch tool for every AI edit format

`mend` applies an AI-written edit to a tree of text files. Models write edits
in four shapes, and this one tool reads all of them to a single contract
(`SPEC.md`):

- unified diffs, whose line numbers are often wrong;
- `SEARCH/REPLACE` blocks;
- V4A patches (`*** Begin Patch` ... `*** End Patch`);
- JSON text-editor tool calls, as one array or as JSON Lines.

Run it as `node main.ts [options] [PATCH]` with the working directory as the
root of the tree. `PATCH` is a patch file, or `-` / absent for standard input.

```sh
node main.ts fix.patch
node main.ts --format=v4a --check < patch.txt
node main.ts --strict --format=unified diff.patch
```

Options: `--format=NAME` (`auto`, `unified`, `search-replace`, `v4a`,
`json`), `--check` (report what would change, write nothing), `--strict`
(exact line matches only). Options and the patch path may come in any order;
`--` ends the options.

Old lines are found at the first of three tiers that matches — exact, then
trailing whitespace ignored, then leading and trailing whitespace ignored —
and new lines are re-indented to the file at the loosest tier. Every edit in
a patch applies in order to the tree the earlier edits left, and a patch
writes either all of its changes or none of them: any failed edit reports
`error: <code> <path>` and nothing is written. On success it prints one line
per changed file (`A`, `D`, `M`, or `R old -> new`) and `ok: <n> files`.

Node 22 and its standard library only; no install step, no network, no
model calls, and no clock or randomness, so a check always gives the same
answer twice.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's trial runner (kept as shipped); when
  `MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it.
- `check.ts` — runs `main.ts` over the kit's public practice set:

```sh
node check.ts ../program/generator/practice.json
```

- `SPEC.md` — the whole contract the checks are graded against.
- `LICENSE` — MIT.
