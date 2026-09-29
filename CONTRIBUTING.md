# Contributing

## Tests

Merge-queue logic is TypeScript that runs directly on plain Node via type
stripping, with no install and no build step:

```bash
cd actions/merge-queue
node --test priority.test.ts state.test.ts
```

`npm run build` is a typecheck (`tsc --noEmit`); `npm test` runs the full
suite with the 100% coverage gate.

## Releasing

Tag a `v1.x` commit when the change is ready for callers. Move the floating
`v1` tag to that same commit only when you want every `@v1` caller to pick it
up. A caller that pins a commit SHA does not follow `v1` until that pin moves.

Do not move `v1` in the same step as a repository rename. Confirm
`howdycom/merge-queue` resolves, then retag.
