# AGENTS.md

## Repository

Standard Server: transport-agnostic request and response adapters, in a pnpm monorepo.

- `packages/*`: the published packages
- `tests/`: e2e tests; `tests/bun` runs with `bun test`
- `playgrounds/*`: example apps
- `benches/`: benchmarks

## Commands

```bash
pnpm install
pnpm test                    # bun tests + vitest
pnpm vitest run <path>       # one test file
pnpm check                   # lint and type check, including *.test-d.ts
pnpm fix                     # check, applying fixes
pnpm format                  # format with oxfmt
pnpm repo:fix                # fix monorepo issues (sherif)
pnpm bench
pnpm --filter @standard-server/core prepack  # build one package; tests don't need a build
```

Before finishing, run `pnpm format`, `pnpm check` and `pnpm test`. CI doesn't check formatting.

## Pull requests

Titles follow Conventional Commits, scoped by the affected packages, separated by a comma and a space: `fix(node): ...`, `fix(node, fastify): ...`. Leave out the scope when the change is too broad.
