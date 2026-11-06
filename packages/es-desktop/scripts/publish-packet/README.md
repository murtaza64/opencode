# Ordinary install packets

Generate source-only packets from the adopted ordinary runner. Setup remains the sole physical executor; DD owns release acceptance and scope.

```sh
bun scripts/publish-packet/generate.mjs PROFILE.json PROFILE_SHA PARAMETERS.json PARAMETERS_SHA OUTPUT_DIR
bun scripts/publish-packet/compare.mjs PACKET_INDEX.json INDEX_SHA HAND_FROZEN_DIR
bun test scripts/publish-packet
```

## Inputs

- `lockProfile({kind, snapshot, adoption, review})` returns a `desktop-standing-runner-lock/1` candidate and normalized `programSHA`; it does not approve itself.
- Supply an independently pinned `desktop-runner-review/1` receipt with `state: approved`, `kind`, `programSHA`, `compilerSHA` and review `ref`. Both hashes must match; re-locking modified code cannot reuse the receipt.
- `desktop-release-parameters/1` binds `runnerProfileSHA`, exact host, owner, accepted artifact directory/source/release/file hashes, attempt, and pinned placement/absence/acceptance/previous-receipt references.
- `purpose` is `release` or `verification`. Setup must refuse physical use of verification records; historical reconstruction is not current admission.
- `authority` names DD acceptance, scope owner, runner review, Setup executor, current Perf and Core exclusions. A new attempt or unknown predecessor requires explicit disposition. An amended release receipt requires its DD amendment.
- Laptop parameters also bind executor-jobs equality, an explicit retained-helper qualification and the adopted Setup caller workspace. Exact absence includes the caller-state basename. The previous web request and terminal receipts are re-hashed, not synthesized.
- Laptop may explicitly set `oldAppKind: "launchd-parented"` for an app relaunched by the human. Placement must carry `keeper: null` and the actual `parent` PID1 identity (ppid0, `/sbin/launchd`, start); native must have ppid1 and plain argv. This uses the runner's existing mode, never owns/signals PID1, and needs a new compiler review receipt. Omitted mode remains strict owned-keeper; Mini cannot select launchd placement.
- `profile.manifest` is the adopted predecessor, not an uninvoked release. Source files are read as data; no adopted code is imported or executed by the generator.

## Output

- Content-addressed snapshot with legacy manifest, closure, caller, artifact/stage plans and immutable parameter/guard records.
- `packet-index.json` is written last. It binds all output hashes, compiler/profile/program/parameter hashes, host/release/source/job and required guards.
- State is always `source-ready`; physical scope is false and terminal is null. Current guard observations and DD physical scope remain required.
- Work quiet60s/max1800s, current Personal admission, seal/hydration/preservation, tool/config/host guards, one-shot journals and honest unknown outcomes remain in the adopted runner.
- Raw Setup placement bytes and their hash are preserved. Mini `qualification` remains adopted source provenance; the independent standing review binds the normalized program fingerprint separately.
- Laptop retains the adopted ancestor closure conservatively: prior ownership/state records and source dependencies remain pinned. No ancestor pruning or cleanup policy is introduced; missing retained files fail verification.
- Existing snapshots and incomplete generations refuse overwrite. No retry, rollback, fallback, transport, build or lifecycle operation exists in this module.

## Adoption

- First physical use: the next accepted cut, currently `2026-11-06.1` after00:00Z, per DD `desktop-publisher#24`; accepted artifact/host scope, parameter review and Setup adoption remain pending.
- Compare the first generated packet against an independent hand-freeze using the same logical snapshot/deploy paths. Compare raw bytes; do not normalize paths or hide metadata differences. A mismatch fails the check.
- Setup owns canonical terminal records: Mini `~/.local/state/es-desktop-installs/<host>.jsonl`, schema `es-desktop-install/1`, addressed by frozen revision plus job ID. Generation never writes that registry.
- Report source review, tests, interface adoption and physical use separately. Current `.05.1` execution/refreeze obligations take priority.
