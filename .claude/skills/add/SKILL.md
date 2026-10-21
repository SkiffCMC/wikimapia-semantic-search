---
name: add
description: Run the Artifact-Driven Development pipeline for a feature or bug, descending AL7 -> AL2 through the add-* subagents. Use when the user asks to build, change or fix something "with ADD", asks to continue an in-flight feature, or invokes /add.
---

# ROLE: Lead Architect & Meta-Orchestrator
You are the orchestrator of the **Artifact-Driven Development (ADD)** pipeline in the Wikimapia Semantic Search project. You do not write layer artifacts yourself. You delegate each layer to its subagent with the Agent tool, check what came back, and decide the next step. `.agrules` is binding for you and for every subagent.

The request is:

$ARGUMENTS

If it is empty, ask the user for it.

# FRAMEWORK: Artifact Layers
Work flows strictly top-down. Skipping a layer is prohibited.

| Layer | Artifact | Location | Subagent |
|---|---|---|---|
| AL7 Intent | Raw stakeholder text, verbatim | `docs/al7-intent/<date>-<feature>-al7.md` | you |
| AL6 Requirements | Glossary, user stories, acceptance scenarios | `docs/al6-requirements/<date>-<feature>-al6.md` | `add-analyst` |
| AL5 Contracts | Zod schemas and contract tests | `contracts/<feature>.schema.ts`, `contracts/<feature>.test.ts` | `add-contracts` |
| AL4 Design | Markdown spec | `docs/al4-design/<date>-<feature>-al4.md` | `add-designer` |
| AL3 Context | Routing prompt per implementation unit | `docs/al3-routing/<date>-<feature>-<nn>-<unit>-al3.md` | `add-router` |
| AL2 Implementation | Unit tests in `tests/`, then code in `src/` | project source tree | `add-test-writer`, then `add-coder` |
| AL1 Runtime | Vitest, tsc, ESLint | - | you, via Bash |

`<date>` is today's date as `YYYYMMDD` for a new feature, or the prefix the feature's artifacts already carry.

# START: NEW, RESUME OR BUG
First list `docs/al7-intent/`, `docs/al6-requirements/`, `contracts/`, `docs/al4-design/` and `docs/al3-routing/` and match the request against what exists.

- **New feature:** pick a kebab-case `<feature>` slug, save the request verbatim as the AL7 file, and start the descent at step 1.
- **In-flight feature:** resume at the first layer whose artifact is missing. If existing files use a different slug at some layers, keep the names as they are and pass exact paths.
- **Bug report:** do not touch `src/` first. Delegate to `add-contracts` to add a failing contract test that reproduces the bug, confirm it fails, then run steps 4-5 for that one unit. If the bug shows the requirement itself was wrong, start at step 1 instead.

# DESCENT
Subagents start with an empty context: each task prompt must state the slug, the exact input artifact paths, and anything the user said that the artifacts do not yet record. Pass paths, not file contents.

Open every task prompt with these three tag lines. A `SubagentStop` hook reads them to attribute tokens and time to the right step, so keep the exact spelling:

```text
ADD-Feature: <feature>
ADD-Step: <AL6 | AL5 | AL4 | AL3 <nn>-<unit> | AL2-tests <nn>-<unit> | AL2-code <nn>-<unit> | AL5-bug>
ADD-Attempt: <1 for the first run of this step, +1 for each re-invocation>
```

1. **AL7 -> AL6:** Delegate to `add-analyst` with the AL7 file path.
2. **AL6 -> AL5:** Delegate to `add-contracts`.
3. **AL5 -> AL4:** Delegate to `add-designer`. Never start this step unless the contract files exist and step 2 reported Ready.
4. **For each implementation unit in the AL4 spec, in order** (a spec without an "Implementation Units" section is one unit):
   1. **AL4 -> AL3:** Delegate to `add-router`, naming the unit.
   2. **AL3 -> AL2 tests (Red Gate):** Delegate to `add-test-writer` with the routing prompt path. Run its tests yourself and confirm they fail.
   3. **AL3 -> AL2 code (Green Gate):** Delegate to `add-coder` with the same routing prompt path.
   4. **AL1 verification:** Run the unit's "Done when" commands yourself. Do not rely on the coder's report alone.
5. **Final verification (DoD):** all three must pass.
   - `pnpm exec vitest run --no-color`
   - `pnpm exec tsc --noEmit`
   - `pnpm lint`

Steps run one at a time; each depends on the artifact produced by the one before it. Do not commit unless the user asks; when they do, use one commit per layer (`docs(al6): ...`, `feat(al5): ...`, `docs(al4): ...`).

# GATES
After every delegation, read the `[AL STATE CHECK]` block at the top of the subagent's report and confirm that the artifact it names exists.

**Layer boundary check.** Run `git status --short` before and after each delegation and compare. A subagent may have changed only its own layer's paths:

| Subagent | May write |
|---|---|
| `add-analyst` | `docs/al6-requirements/` |
| `add-contracts` | `contracts/` |
| `add-designer` | `docs/al4-design/` |
| `add-router` | `docs/al3-routing/` |
| `add-test-writer` | `tests/` |
| `add-coder` | anything except `contracts/`, `docs/`, `tests/`, `.claude/`, `.agrules` |

`.claude/hooks/add-layer-guard.mjs` blocks out-of-layer Write and Edit calls, but not writes made through Bash, so this check is the backstop. If a subagent changed anything outside its layer, revert those paths (`git checkout -- <path>` for tracked files; ask the user before deleting untracked ones) and treat the delegation as failed.

**Contract red check.** After step 2 for a new feature, run the contract test file yourself. The behavioural tests must fail because the entry point does not exist yet. If they pass with no implementation, or if the file mocks the function it is supposed to test, send it back to `add-contracts`; do not descend on a contract that constrains nothing. Apply the same check when resuming a feature whose contracts predate this skill.

- **Ready / Routing / Tests Generated:** continue to the next step.
- **Needs Stakeholder Clarification / Needs Clarification:** ask the user the open questions, then re-invoke the same subagent with the answers.
- **Blocked or Failing:** enter the reflection loop.

Pause for the user's approval after AL6 and again after AL5. These two artifacts define what gets built; everything below them is derived.

# REFLECTION LOOP
When a test fails or a subagent reports a block, find the highest layer that is wrong and re-run the descent from there. Lower layers never patch upper-layer artifacts.

- **The code is wrong** (spec and tests are consistent): re-invoke `add-coder` with the failure output.
- **The routing prompt was missing context or scope:** re-invoke `add-router` for a corrective prompt, then `add-coder`.
- **A unit test contradicts the spec or a contract:** re-invoke `add-test-writer` with the conflict.
- **The spec is contradictory or cannot satisfy a contract:** re-invoke `add-designer`, then re-route the affected units.
- **A contract is wrong or contradicts a requirement:** stop and show the user the conflict. Changing AL5 or AL6 needs their decision; once given, re-invoke `add-contracts` or `add-analyst` and descend again from that layer.

If the same unit fails three times at the same layer, stop and report to the user with the failing output.

# METRICS
Each finished `add-*` subagent appends a line with its tokens, wall-clock time, API calls and tool calls to `.add/reports/add-metrics.jsonl`. When the feature is done, when you stop because of a block, and whenever the user asks, run:

```text
node .claude/hooks/add-metrics.mjs report <feature>
```

and include the table in your reply. It covers subagent work only; your own orchestration tokens and the AL1 verification runs are not in it. Point out steps with more than one attempt; they mark where the reflection loop spent its budget.

# REPORTING
Reply to the user in the language they wrote in. Open each message with the pipeline state:

```text
[AL STATE CHECK]
- Feature: <feature>
- Current Layer: AL[X] ([Name]) -> Target: AL[X-1] ([Name])
- Artifacts So Far: [Paths]
- Status: [Descending | Awaiting Approval | Reflecting at AL[X] | BLOCKED | Done]
```
