import { readInput, loadCore, guard } from './_lib.mjs';

/**
 * Stop — the session just ended.
 *
 * This is the moment the session's knowledge is at its most complete and about to be lost
 * forever. So we do the cheap, mechanical thing now (re-read the transcript we just
 * generated, refresh the index, re-check what went stale) and QUEUE the thinking.
 *
 * We deliberately do not spawn a model here. A hook that silently burns tokens every time
 * you close a session is a hook that gets uninstalled. The work is queued instead, and
 * drained on your terms: at the next session start, by `/cv drain`, or by the headless
 * runner. The user always knows what it will cost before it costs it.
 *
 * `queueWork: true` is the whole point of this hook — it is what notices "you never gave
 * that experiment a verdict" and "three ideas were raised and dropped" while the evidence
 * is still fresh.
 */

await guard(async () => {
  const input = await readInput();
  const repo = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const core = await loadCore();
  if (!core) return;

  const store = new core.Store(repo);
  const jobs = new core.JobQueue(store);

  await core.sync(repo, { queueWork: true });

  // Mine this session for what it learned and what it left dangling. Cheap tier: this is
  // summarisation and extraction, not judgement.
  if (input.session_id) {
    jobs.enqueue('summarize-session', { sessionId: input.session_id });
    jobs.enqueue('extract-threads', { sessionId: input.session_id });
  }

  // Stop hooks may emit a decision to block; we never do. ClaudeView observes — it does
  // not get a vote on whether the user is allowed to stop working.
});
