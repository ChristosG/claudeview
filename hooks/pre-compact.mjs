import { readInput, loadCore, emitContext, guard } from './_lib.mjs';

/**
 * PreCompact — fired moments before the context window is thrown away.
 *
 * This is the highest-leverage instant in a long session and almost nothing uses it.
 * Everything Claude currently understands about the work is about to be compressed into a
 * summary, and whatever the summariser judges unimportant is gone for good. In practice
 * that is precisely where hard-won facts die: the experiment that failed, the decision
 * that got reversed, the constraint discovered the painful way.
 *
 * ClaudeView already holds those durably on disk, so we simply re-assert them on the far
 * side of the compaction. The context boundary stops being a memory cliff.
 *
 * Note the asymmetry with SessionStart: there, the brief tells Claude what it does not yet
 * know. Here, it re-tells Claude what it is about to forget.
 */

await guard(async () => {
  const input = await readInput();
  const repo = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const core = await loadCore();
  if (!core) return;

  // Capture what this session established BEFORE the evidence is compacted away.
  await core.sync(repo, { queueWork: false });

  const store = new core.Store(repo);
  const brief = core.buildBrief(store, { maxChars: 2000 });
  if (!brief) return;

  emitContext(
    'PreCompact',
    `Context is being compacted. ClaudeView's durable record of this project follows — treat it as authoritative over anything that gets lost in the summary:\n\n${brief}`,
  );
});
