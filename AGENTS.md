# Repository agent guide

Guidance for coding agents working in this repository.

This repository is **public**. Never commit secrets, tokens, or internal-only
references (private issue links, employee names, internal hostnames). Nothing
in this repo is confidential, but everything in it ships to consumers — treat
all action inputs as untrusted and keep the runtime dependency-free.

## Project overview

Public composite GitHub Action (plus a reusable workflow) for a single-flight
merge queue. Consumers pin releases (`@v1` or a tag), so every change here is
a public API change — see Releasing in `CONTRIBUTING.md`.

`actions/merge-queue/` is the only action left: a zero-dependency TypeScript
state machine (`queue.ts` + `state/priority/pagination/errors.ts`).
Former companion actions (free-disk-space, slack-notification,
claude-remediation-prepare, open-remediation-pr, project-sync) each live in
their own `howdycom/<name>` repository now — this repo holds no copy of them.

TypeScript here runs **directly on Node via type stripping** — there is no
build step and no emitted output. `npm run build` is a typecheck
(`tsc --noEmit`), and every `.ts` file must stick to erasable syntax (see
TypeScript below).

## Environment & runtime

- **Node:** 22 (CI and the composite action pin `node-version: 22`).
- **Package manager:** npm (`package-lock.json`). Never edit the lockfile by
  hand; change dependencies with `npm install`.
- **Never install a new dependency without asking the user first.** The
  TypeScript action is deliberately zero-dependency so it runs on a bare
  runner; `node_modules` is dev tooling only (lint, typecheck, coverage).

## Key commands

```bash
# TypeScript merge queue (repo root)
npm ci                                        # install dev tooling
npm run lint                                  # eslint (merge-queue)
npm run build                                 # tsc --noEmit (typecheck, no emit)
npm test                                      # node --test with the 100% c8 gate

# Scoped runs while iterating
node --test actions/merge-queue/priority.test.ts actions/merge-queue/state.test.ts
npx eslint --fix actions/merge-queue/queue.ts  # one file you changed
```

## Validation loop

### After every edit (mandatory, no exceptions)

The instant you finish editing a `.ts` file, run ESLint on that exact file
before moving on to the next change:

```bash
npx eslint --fix path/to/changed-file.ts
```

This repo has no formatter — match the surrounding style by hand (2-space
indent, single quotes, no semicolons). Running the fixer per edit catches
problems while context is fresh. Do not batch this to "the end".

`tsc --noEmit` is repo-wide (there is no per-file typecheck); run
`npm run build` after each file you convert or touch, plus the scoped tests
that cover it.

If `eslint` or `tsc` reports errors in files you did **not** edit, ignore
them. Scope is the files you touched, not the whole repo.

## Completion gates

After generating or changing code, tests, or configuration, do not mark the
task complete until verified with:

1. `npm run lint`
2. `npm run build`
3. `npm test`

These are priorities, not optional polish. Run them after the work is in
place, fix any failures, and rerun the failing command until it passes.

## Coverage standard

The merge queue must stay at **100% coverage** across statements, branches,
functions, and lines. `npm test` enforces this via `c8 --100` — **a bare
`node --test` run tells you nothing about coverage**, so the final check is
always `npm test`, never the scoped runner alone.

Do not lower coverage thresholds to make a run pass. If coverage drops, add
or update tests until the suite is back to 100% across the board.

## Testing philosophy

- **No test framework.** Tests use `node:test` + `node:assert/strict` only.
- **Pure modules** (`errors`, `pagination`, `priority`, `state`) are tested
  directly, every branch.
- **`queue.ts` is tested through `fake-gh.ts`**, a stateful stand-in for the
  `gh` CLI driven by scenario JSON: each test builds a world (`pr()` +
  `world()` + `claimed()` helpers), spawns `queue.ts` as a subprocess with a
  fake `gh` on `PATH`, and asserts on stdout/stderr plus the mutated
  scenario. Every code change must be accompanied by sufficient tests to
  cover the new or modified behavior.
- **Bug fix** → add a regression test that fails on the original code and
  passes on the fix. **Modified logic** → extend the existing tests; do not
  delete tests to make coverage pass.

## TypeScript

Be strict. The `.ts` files are parsed by Node's type stripper at runtime,
which is stricter than `tsc` about syntax — `tsconfig.json` enforces both
halves (`erasableSyntaxOnly`, `verbatimModuleSyntax`, `strict`,
`allowImportingTsExtensions`).

### Hard rules for new and modified code

- **Erasable syntax only.** No enums, namespaces, parameter properties, or
  any other runtime-emitted TypeScript. If `tsc` accepts it but Node refuses
  to strip it, it does not ship.
- **Relative imports use `.ts` extensions** (`from './errors.ts'`), and
  **type-only imports use `import type`**. Both are required for NodeNext
  resolution plus type stripping; `tsc` enforces them.
- **Never use `any`.** New code must not introduce `any` (including
  `as any`; `no-explicit-any` is enforced). If a value is genuinely untyped
  at a boundary (`gh` CLI JSON, `JSON.parse`, catch clauses), type the
  binding as `unknown` and **narrow with a type guard** before reading from
  it. Where a call site knows the exact `--json` shape it asked `gh` for, a
  single `as T` at that boundary (see `ghJson<T>` in `queue.ts`, `read<T>`
  in `state.ts`) is the established pattern — one cast, at the boundary,
  never threaded through logic.
- **No cast escape hatches to silence the compiler.** New code must not
  introduce `as unknown as T` / `as any as T` double casts, `as never`, or
  non-null assertions used to hide bad types (`value!` on something that
  should be narrowed or typed). If two real types do not assign, fix the
  type at the source.
- **`never` is for exhaustiveness and impossible states only** (e.g. the
  `fail(): never` helper in `fake-gh.ts`), not for "I don't want to type
  this."
- **Do not call array methods on untyped values.** At untrusted boundaries
  (`unknown`, `JSON.parse`, `gh` output), narrow with `Array.isArray`
  before `.filter` / `.map` / `.find`. `x ?? []` is not a type check.
- Name types for the domain (`PrSnapshot`, `GhCheck`, `TimelineEvent`), not
  vague names (`Data`, `Item`, `Result`). Keep shared `gh` shapes in the
  module that owns them; `queue.test.ts` shares the fake's contract via a
  type-only import rather than redeclaring it.

## Code style

- **Variable declarations:** prefer `const`. Use `let` only when
  reassignment is genuinely required and keep its scope tight.
- **Constants:** `UPPER_SNAKE_CASE` for module-level constants. Extract all
  magic strings and numbers into named constants — never inline them.
- **Comments explain why, with evidence.** Subtle behavior keeps the
  production incident or failure mode that motivated it (see `queue.ts`).
  Do not restate what the code says.

## Error handling

- Never swallow errors silently. Every `catch` either logs via `log()` with
  the `errorText()` helper (which centralizes the stderr / message /
  thrown-value fallbacks) or deliberately degrades with a comment saying why.
- **Fail closed on config errors** (`requireEnv`, unknown command) — exit
  non-zero. **Stay green on transient `gh` failures** — log, keep the claim,
  and let the next trigger or watchdog tick retry. Each call site documents
  which one it is; match the existing arm, do not invent a third.

## Dead code

Remove unused code and commented-out blocks before merging. Do not leave
TODO comments without a linked GitHub issue.

## Git & PR conventions

- **Commit messages** follow Conventional Commits (`feat:`, `fix:`,
  `chore:`, `test:`, `refactor:` — see `git log`). `[TECH] - ...` titles
  mark genuinely off-issue work.
- **PR bodies** describe the behavior change plus the verification (lint,
  build, and test results). After opening a PR, run `gh pr checks <number>`
  and confirm CI is green before considering it done.
- **Merge strategy:** squash-and-merge. **Releasing:** tag a `v1.x` commit
  when the change is ready for callers; move the floating `v1` tag only
  when every `@v1` caller should pick it up (see `CONTRIBUTING.md`). Agents
  do not move release tags unless explicitly asked.
- This repo's own PRs run through the merge queue itself — a ready-labeled
  PR with failing required checks will be evicted, not merged.

## Agent behavior rules

### Only touch task-related files

Never modify files unrelated to the current task. If lint reports errors in
other files, do not fix them. Your changes must be scoped strictly to the
files needed to achieve the task goals.

### Investigate before fixing

When debugging or fixing bugs, investigate the root cause thoroughly before
proposing or applying any fix. Trace through the actual code path — don't
speculate. Present findings with `file:line` references before editing.

### Minimal changes only

Make only the changes necessary for the task. Do not make cosmetic edits,
add unrequested refactors, or clean up surrounding code unless explicitly
asked. Before applying each change, ask: "Is this strictly necessary for
the request?"

### Don't argue with domain knowledge

When the user pushes back on an approach or says a fix is needed, do not
argue. Trust the user's domain knowledge and move to an alternative
immediately.

### Audit multi-file changes

A `gh` call-site change spans three files — the caller (`queue.ts` /
`state.ts`), the fake (`fake-gh.ts`), and the scenario builders in the
tests. Grep all of them before considering the task complete.

### Stop after repeated failures

If a validation step fails multiple times with the same error, stop. Do not
attempt the same fix repeatedly. Report the full error output and ask for
human intervention.

### Never modify these files

- `package-lock.json` — managed by `npm install`, never edit manually
- `coverage/`, `node_modules/` — generated output, never edit
- Release tags (`v1*`) — see Releasing above
