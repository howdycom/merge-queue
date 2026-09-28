# Contributing

## Tests

Merge-queue logic is plain Node, with no install:

```bash
cd actions/merge-queue
node --test priority.test.mjs state.test.mjs
```

Project board sync tests live under `actions/project-sync/tests`.

## Releasing

Tag a `v1.x` commit when the change is ready for callers. Move the floating
`v1` tag to that same commit only when you want every `@v1` caller to pick it
up. A caller that pins a commit SHA does not follow `v1` until that pin moves.

Do not move `v1` in the same step as a repository rename. Confirm
`howdycom/merge-queue` resolves, then retag.
