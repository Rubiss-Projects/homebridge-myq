# Releases

## Merge gate

All changes land through a pull request to `main`. The active GitHub ruleset requires the `CI` check, resolved review conversations, and linear history. Force pushes and branch deletion are blocked. Required approving reviews are zero so the sole maintainer can merge their own PR; checks cannot be bypassed. Branches do not need to be rebased after every main-branch update, so passing Dependabot PRs can auto-merge without stalling. Release CI validates the combined merged commit before publishing. CI builds and tests on Node 22/24/26 (Linux) and Node 26 (macOS), then installs the packed artifact with production dependencies and checks plugin registration. Tests never actuate a physical garage door.

## Dependency updates

Dependabot opens weekly npm updates and monthly GitHub Actions updates. All Dependabot updates, including major versions, automatically enable squash auto-merge, following the existing dependency automation in Rubiss-Projects/ai-assistant. The same required CI and resolved-conversation rules apply; auto-merge cannot bypass them. The privileged metadata workflow never checks out or runs PR code.

## Publish a version

1. Run `npm version patch --no-git-tag-version` (or `minor` / `major`), update release notes, and submit a PR with both manifests.
2. Merge only after the required CI check passes on the current PR head.
3. On the merged commit, create and push the matching annotated tag, e.g. `git tag -a v1.0.0 -m 'v1.0.0'` then `git push origin v1.0.0`.
4. The Release workflow reruns CI, requires the tag to match package.json and point to a commit in `main`, builds the tarball, and creates a GitHub release with the tarball and SHA256SUMS.
5. When npm is configured below, the same workflow publishes that exact tarball with provenance. Check both the GitHub release and npm registry before announcing availability.

The workflow can also be dispatched against a tag, never a branch. Existing releases/assets are not overwritten. If npm fails after GitHub release succeeds, rerun the failed npm job rather than recreating the release. Published npm versions are immutable; fix mistakes in a new version.

## First npm publication and Homebridge discovery

The package name is `homebridge-myq-connect`; `homebridge-myq` belongs to another maintainer. Publish this public package using an npm account you control. Bootstrap its first publication with an authenticated maintainer session if npm requires an existing package before configuring its trusted publisher.

In npm package settings, add a GitHub Actions trusted publisher with:

- Organization/user: `Rubiss-Projects`
- Repository: `homebridge-myq`
- Workflow filename: `release.yml`
- Environment: `npm`
- Allow direct npm publishing.

Then set repository variable `NPM_PUBLISH_ENABLED=true`. No permanent npm token is stored in GitHub. Until configured, GitHub release publishing works and the npm job is deliberately skipped. An npm login or GitHub release alone does not configure trusted publishing.

Homebridge discovers publicly published npm plugins with the `homebridge-plugin` keyword and the `homebridge-` package prefix; both are present here. Allow time for its registry/search index to update, then search for the exact package name. A GitHub release alone does not make a plugin appear in Homebridge search. Verification is a separate application to https://github.com/homebridge/plugins; do not claim the verified badge before approval. Our supported onboarding is currently iPhone on a Linux/macOS Homebridge host, so describe those limits clearly when applying.
