# AI Setup Guide

Follow these steps when bootstrapping a new project from this template.

## 1. Update project identity
- Replace `tslib-template` with the library name everywhere:
  - `package.json` fields: `name`, `repository.url`, `bugs.url`, `homepage`, and `publishConfig` if needed.
  - `.github/workflows/release-please.yml` `package-name` input.
  - README heading and any textual mentions.
- Adjust the description, license holder, and copyright year.

- Update `tsdown.config.ts` so `format` only lists supported JS formats (e.g. `['esm', 'cjs']`) and enable declarations with `dts: true`.
  - Supported formats are `esm`, `cjs`, `iife`, and `umd`; do not include `dts` in `format`.

## 2. Install dependencies
- Run `COREPACK_HOME=.corepack pnpm install` to create `pnpm-lock.yaml`. The sandbox often blocks Corepack from writing to global caches.
- After install, remove the temporary `.corepack` directory if it was created locally.

## 3. Validate tooling
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`, and `pnpm build` to ensure the toolchain works before committing.
- `build` runs `tsdown` (no subcommand). Use `pnpm dev` for watch mode, which calls `tsdown --watch`.
- Keep the generated `dist/` out of version control; it is excluded by default.

## 4. Configure CI/CD
- Ensure GitHub Actions secrets are present:
  - `NPM_TOKEN` for `.github/workflows/publish-on-tag.yml`.
- Confirm branch protection and default branch name (`main`) align with workflows.

## 5. Commit conventions
- Enforce Conventional Commits (`feat:`, `fix:`, `chore:`, etc.) so Release Please can infer versions and changelog entries.

## 6. Verification
- Run `pnpm check` before opening PRs to exercise type check, lint, tests (with snapshot update), and docs.
- Update this guide if new tooling or workflows are added.
