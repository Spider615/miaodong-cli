# Canvas Layout Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in the current session. Work remains in the existing isolated branch.

**Goal:** Any pulled canvas can produce an event-aware layout and preview without a handwritten script.

**Architecture:** Pure graph normalization, dot layout and event placement produce an immutable envelope and report. A local-only command stages the result and writes sanitized SVG/HTML. Existing confirmed push/restore handles layout persistence.

**Tech Stack:** ESM, Node >=18, pinned @viz-js/viz WASM, existing node:test fake-server suite.

**Spec:** `docs/specs/2026-10-15-canvas-layout-design.md`

## Global Constraints

- Only positions and obsolete vertices change; no remote writes from layout.
- Preserve single-file Node >=18 distribution, no extra runtime installation.
- Never use bot names or IDs in the algorithm.
- Tests use fake servers and local artifacts only.
- Version 1.6.0; development build never writes dist.

## Review Focus

- Remote event ID changes with identical node size must invalidate old layout.
- Shared/multiple event triggers must not be duplicated or matched by name.
- Nested container movement must preserve child offsets and all sizes.
- Preview names containing HTML must render as text; prompts never leave the envelope.
- Layout failure must not stage partial coordinates or silently target --bot instead of --ws.

## Task 1: General layout engine

Files: `src/layout-graph.mjs`, `src/layout-dot.mjs`, `src/layout-geometry.mjs`, `src/layout-events.mjs`, `src/layout.mjs`; `test/layout.test.mjs`.

Interfaces: `optimizeLayout(envelope) -> Promise<{envelope, report}>`; graph units keep member offsets, real ports and event links. Geometry shares one port/curve model between collision checks and preview.

- [ ] Write tests asserting no overlap, unchanged non-geometry fields, ordered branches and short event handoffs; run and observe missing feature failure.
- [ ] Normalize IDs, dimensions, hierarchy, edges, event IDs. Fail invalid graphs before mutation.
- [ ] Add dot structural grouping and deterministic ranks with original port order.
- [ ] Add event placement using all incident links, rigid component translation and geometric collision checks.
- [ ] Run engine tests; use a cloned real canvas for offline geometry checks.

```js
const result = await optimizeLayout(input);
assert.deepEqual(input, original);
assert.equal(result.report.after.overlapPairs, 0);
assert.deepEqual(result.envelope.events, original.events);
```

## Task 2: CLI, artifacts and layout write contract

Files: `src/commands/layout.mjs`, `src/layout-preview.mjs`, command index, layout-only guard; `test/layout-cli.test.mjs`, `test/layout-push.test.mjs`, bundle test.

Interfaces: CLI loads current workspace, verifies layout-only input, computes and writes a new artifact directory, then stages after.json and marks non-replayable geometry. Push and restore remain the only remote write consumers.

- [ ] Write fake-server tests proving layout does not save, creates inspectable images, and confirmed layout push saves exact coordinates.
- [ ] Write event-ID drift test and preview injection test; observe failures.
- [ ] Implement local command and sanitized, self-contained SVG/HTML including preview-only virtual event arrows.
- [ ] Include event identity/type in remote layout dependency checks.
- [ ] Exercise Node 18 bundle from a temporary directory without adjacent node_modules.

```js
const preview = await runCli(['layout'], {home});
assert.equal(preview.code, 0, preview.stderr);
assert.equal(bot.state.saves, 0);
```

## Task 3: Documentation and final verification

Files: README, skill/SKILL.md and layout reference, AGENTS.md/CLAUDE.md if rules need documenting, package and third party notices.

- [ ] Document pull → layout → preview → check → push --layout-only → confirmed write → remote status/restore.
- [ ] Run focused tests, then full `MD_E2E_NODE=<Node18> npm test`; fix failures before continuing.
- [ ] Build development bundle and run generic CLI offline on the current Taiji snapshot. Review preview and exact coordinate-only diff.
- [ ] Record commands, test counts and actual release/install state. Keep real remote canvas untouched.
