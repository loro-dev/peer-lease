# tslib-template

Minimal TypeScript library starter powered by pnpm, tsdown, Vitest, oxlint, Biome, and release-please.

## Setup checklist

1. **Rename the project**
   - Update `package.json` fields: `name`, `description`, `repository.url`, `bugs.url`, and `homepage`.
   - Update `.github/workflows/release-please.yml` `package-name` input.
   - Change the heading of this README and any textual mentions of `tslib-template`.
2. **Install dependencies**
   - Run `pnpm install` (keeps Corepack downloads inside the repo)
3. **Verify tooling**
   - Run `pnpm check` (runs type check, lint, snapshot update, and tests) and `pnpm build` before committing.
   - Keep `tsdown.config.ts` `format` to JavaScript outputs (e.g. `['esm', 'cjs']`) and rely on `dts: true` for declaration files.
4. **Configure CI/CD**
   - Add an `NPM_TOKEN` secret to the GitHub repository for the publish workflow.
   - Ensure commits follow [Conventional Commits](https://www.conventionalcommits.org/) so Release Please can generate changelog entries.
   - Confirm the default branch is `main` to match workflow triggers.

## Commands

- `pnpm install` – install dependencies
- `pnpm build` – produce ESM/CJS/d.ts bundles via tsdown
- `pnpm dev` – run tsdown in watch mode
- `pnpm test` – run Vitest
- `pnpm lint` – run oxlint
- `pnpm format` – apply Biome formatting
- `pnpm typecheck` – run the TypeScript compiler without emitting files
- `pnpm check` – type check, lint, update snapshots, and test

## Release workflow

- Push Conventional Commits to `main`; Release Please opens or updates a release PR with the changelog and semver bump.
- Merging that PR tags the release and triggers `.github/workflows/publish-on-tag.yml`, which publishes to npm using `NODE_AUTH_TOKEN` derived from the `NPM_TOKEN` secret.
- Publish provenance is enabled via `.npmrc` and `publishConfig.provenance`.

## Continuous integration

The `CI` workflow installs dependencies, lints, type-checks, runs Vitest in run mode, and builds the library on pushes and pull requests.
