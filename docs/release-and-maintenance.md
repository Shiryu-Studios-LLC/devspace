# DevSpace release, rollback, and maintenance

DevSpace is allowed to help develop DevSpace, but the running production process must never be the only recovery path. Production promotion uses an independently managed service plus versioned releases so a bad build can be rolled back without relying on the DevSpace process being replaced.

## Source layout

For the Shiryu Studios Linux deployment:

- `/home/okashi/Projects/DevSpace` is the clean canonical checkout of `main`.
- Feature and maintenance work should use isolated managed Git worktrees.
- `/home/okashi/Projects/DevSpace-preserved/devspace` is a preserved historical checkout and must not be reset or cleaned as part of normal development.
- `backup/pre-modular-revamp-20260921` preserves the pre-modular production Git state at `584a2d0`.

Do not develop by editing the installed production directory.

## Required release gates

Before promoting a candidate, run the gates from a clean worktree with lockfile-exact dependencies:

```bash
npm ci
npm run typecheck
npm test
npm run build
git diff --check
```

For a core release, also run an isolated authenticated MCP end-to-end test on a non-production port. The test must cover OAuth client registration, owner approval, token exchange, MCP connection, `tools/list`, `get_devspace_module_status`, and `open_workspace`.

Optional integrations such as Unity, Unreal, Blockbench, browser CDP, and other application adapters may be unavailable. Their absence may degrade only their optional module; it must not make the core unhealthy.

## Versioned production releases

Builds are staged beside production rather than copied over the running installation:

```text
~/.local/share/devspace-linux-releases/<commit>/
```

Each staged release contains the built `dist`, `package.json`, `package-lock.json`, and lockfile-installed `node_modules`. Validate the staged directory itself by launching its compiled `dist/cli.js` on an isolated port before promotion.

The stable production path is:

```text
~/.local/share/devspace-linux
```

It points to the currently promoted versioned release. The system-level `devspace.service` continues using that stable path.

## Safe promotion

Core promotion must be performed by an independent systemd/admin action, not by the DevSpace process that is about to be replaced.

The promotion flow is:

1. Verify the current production `/healthz` endpoint is healthy.
2. Verify the staged release passed all release gates and isolated E2E.
3. Preserve the current production installation as a rollback directory.
4. Atomically switch `~/.local/share/devspace-linux` to the staged release.
5. Restart the system-level `devspace.service` once.
6. Poll `http://127.0.0.1:7676/healthz`.
7. Verify the new service PID resolves its working directory into the expected versioned release.
8. If either health or working-directory verification fails, stop the failed service, restore the previous production directory, restart `devspace.service`, and verify rollback health.

The promotion watchdog must run outside `devspace.service`'s cgroup so it remains alive while DevSpace restarts.

After a successful core promotion, recycle the Desktop Agent so it also runs code from the newly promoted release. Confirm its protocol version and capability states before removing any temporary validation infrastructure.

## Rollback

Never delete the immediately previous release during the same promotion that replaces it. Keep both a filesystem rollback copy and a Git backup ref until the new release has had sufficient real-world use.

Current rollback assets created during the modular-awareness promotion are:

```text
/home/okashi/.local/share/devspace-linux.rollback-584a2d0-20260921
backup/pre-modular-revamp-20260921
```

A rollback should restore the previous live path, restart `devspace.service`, verify `/healthz`, and then verify MCP connectivity. Do not regenerate `~/.devspace` configuration, owner credentials, OAuth state, or the DevSpace database as part of rollback.

## Dependency maintenance

Treat dependency upgrades as a separate release from feature or infrastructure work.

As reviewed on September 21, 2026, `npm audit` reported 15 advisories: 6 high, 8 moderate, 1 low, and 0 critical. `npm audit fix --dry-run` proposed no changes, so these cannot be resolved safely by a routine automatic patch.

The main migration boundary is `@earendil-works/pi-coding-agent`: the current direct range is `^0.80.3`, while the audit fix points to `0.86.1`, which npm classifies as a semver-major fix. Its nested Pi AI/core dependencies also carry advisories. Additional transitive advisories include packages such as `undici`, `protobufjs`, `fast-uri`, `qs`, Hono, `ip-address`, `nanoid`, `postcss`, and `brace-expansion`.

For dependency remediation:

1. Create an isolated maintenance worktree from current `main`.
2. Update the Pi adapter and vulnerable overrides intentionally; do not use `npm audit fix --force` against production.
3. Re-run the complete local-agent/provider tests because Pi is an adapter boundary, not a leaf dependency.
4. Run the full release gates and authenticated isolated MCP E2E.
5. Compare `npm audit` before and after.
6. Promote only if compatibility tests and the production build remain green.

Dependency advisories should be re-audited periodically because upstream fixes and advisory data change independently of DevSpace source changes.

## Cleanup after promotion

After a release has passed production smoke testing:

- stop and remove obsolete transient E2E services;
- delete their isolated config/state only after production is verified healthy;
- remove obsolete managed development worktrees after confirming they contain no unique commits or uncommitted work;
- keep the current canonical checkout, the active maintenance worktree if one is in use, the previous rollback release, and the backup Git branch;
- do not delete unrelated user files that happen to live beside an old checkout.

This keeps DevSpace able to update itself without making DevSpace itself the single point of recovery.
