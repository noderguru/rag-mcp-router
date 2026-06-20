# Releasing

Publishing is automated: pushing a `v*` git tag runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which builds, tests,
and publishes to npm.

## One-time setup

1. Create an **automation** access token on npm
   (npmjs.com → Access Tokens → Generate New Token → *Automation*).
2. Add it to the repo as a secret named `NPM_TOKEN`
   (GitHub → Settings → Secrets and variables → Actions → *New repository secret*).
3. Make sure the package name `rag-mcp-router` is available / owned by you on npm.

## Cutting a release

```bash
# 1. Bump the version (updates package.json, creates a commit + tag)
npm version patch   # or: minor | major

# 2. Move the new entries under "Unreleased" in CHANGELOG.md to the new version,
#    then amend the version commit if needed.

# 3. Push the commit and the tag
git push origin main --follow-tags
```

The tag push triggers the Release workflow, which publishes to npm. Verify with:

```bash
npx rag-mcp-router@latest --help   # or point a client at it
```

## Manual fallback

If you'd rather not use the workflow (or the secret isn't set up yet):

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
npm login
npm publish --access public
```

Versioning follows [SemVer](https://semver.org/). Keep
[`CHANGELOG.md`](CHANGELOG.md) up to date with each release.
