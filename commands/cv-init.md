---
name: cv-init
description: Cold-start ClaudeView on this project — read the whole session history, index the code, and build the project map from scratch.
---

Initialise ClaudeView for this project.

**This is read-only with respect to the user's code. You must not change their implementation.** Your job here is to *explain what exists* and *flag what looks wrong* — never to fix it. If you spot something worth changing, record it as an insight, do not act on it.

Run the phases in order and report progress as you go.

## Phase 1 — Observe (free, no tokens)

Call `cv_sync` with `queueWork: true`. This reads every transcript for this project (including the nested subagent and workflow transcripts, which is where a large fraction of the real work lives), scans git, and indexes the code with tree-sitter.

Report what it found: events, components, commits, and anything already stale.

## Phase 1.5 — Get the fan-out plan, and FOLLOW IT

Run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/packages/cli/dist/cli.js plan --repo <repo>
```

It returns the agent fleet with a **model assigned to each one**. Dispatch them **in parallel**, each with the model it names — pass `model:` on the Agent tool.

This is not advisory. The assignments are calibrated against a real measured cold-start (1,318,993 output tokens on a 30k-LOC repo), and the routing exists because **volume work and judgement work are not the same job**:

- **Annotation is volume** — read a file, write one concrete sentence. It was the 2nd most expensive agent in the measured run and needs no frontier model. Haiku.
- **Red-teaming and flow-authoring are judgement.** They produced every critical finding. A confident, plausible, *wrong* insight is worse than silence — so they do NOT get cheapened, ever.

Cheapen volume. Never cheapen judgement.

## Phase 2 — Explain the structure

The index knows the *shape* of the code but nothing about its *meaning*. Read the most important components (start with the ones the session history touched most — those are where the project's attention actually went) and give them a purpose.

Then author the **Flows** — the conceptual pipelines a human actually wants to look at, e.g. `query → preprocess → embed → BM25 → rerank → LLM`. Use `cv_flow`, and **anchor every step to real code**. An unanchored step is a lie waiting to happen: it will keep asserting something long after the code moves. An anchored one flags itself.

## Phase 3 — Recover what was lost

Mine the history for what would otherwise be gone:

- **Decisions** (`cv_decide`): choices made and *why*, especially where the rationale is nowhere in the code. Mark superseded ones as superseded.
- **Threads** (`cv_thread`): every "we should try X sometime" that was said and never done. These are the ideas that die silently. Be generous here.
- **Experiments** (`cv_experiment`): anything that was tried, especially the things that **failed**. A recorded loss is worth more than a recorded win — it is what stops the same dead end being re-explored.

## Phase 4 — Red-team it (adversarial)

Now look at the code with hostile eyes and record `cv_insight`s. Genuinely useful findings look like:

- "this is not optimal — it could be done like *this*"
- "this is wrong, and it deceives you: it looks like it handles the error but it swallows it"
- dead code, duplicated logic, a test that asserts nothing, a race, a silent failure

Be honest about `confidence`. A feed that cries wolf is a feed nobody reads, and you only get one chance at the user's trust in this screen. Attach evidence (`file`/`symbol`) to everything.

## Finally

Summarise for the user: what this project *is*, the flows you mapped, what you found that concerns you, and what ideas were recovered from the history that they had forgotten about.
