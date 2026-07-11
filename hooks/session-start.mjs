import { readInput, loadCore, emitContext, guard } from './_lib.mjs';

/**
 * SessionStart — the feature that pays for the whole project.
 *
 * Without this, every session begins amnesiac: the architecture gets re-derived, the same
 * files get re-read, a decision that was superseded last week gets repeated as current,
 * and an experiment that already failed gets cheerfully re-run. Nothing carries forward
 * except what the human remembers to say out loud.
 *
 * This hook refreshes the observed tier (free — no model, no tokens) and injects a few
 * hundred tokens of "here is what you already know and what you must not get wrong".
 *
 * It must be FAST, because it runs before the user can type. The Observer is incremental
 * by design for exactly this reason: a warm transcript tail is ~1ms and a warm code index
 * ~36ms, so the whole thing is imperceptible.
 */

await guard(async () => {
  const input = await readInput();
  const repo = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const core = await loadCore();
  if (!core) return; // not built yet — stay silent rather than nag

  // Refresh the facts. queueWork stays OFF here: session start is not the moment to
  // enqueue expensive analysis, and a hook should never surprise anyone with spend.
  const result = await core.sync(repo, { queueWork: false });

  const brief = core.buildBrief(new core.Store(repo));

  // A brand-new project has nothing to say. Injecting a hopeful, empty template would be
  // pure noise — and worse, it would teach Claude to ignore this block.
  if (result.components === 0 && result.events === 0) return;

  emitContext('SessionStart', brief);
});
