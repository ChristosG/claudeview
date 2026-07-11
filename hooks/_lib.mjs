import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared hook plumbing.
 *
 * The governing rule for every hook in this plugin: **a hook must never break the user's
 * session.** ClaudeView is an observer. If it fails — a corrupt store, a missing build, a
 * transcript format that changed under us — the correct behaviour is to say nothing and
 * get out of the way, not to spew a stack trace over someone's prompt or block them from
 * working. An observability tool that takes down the thing it observes has negative value.
 *
 * So: everything is wrapped, every failure is swallowed, and we always exit 0.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');

/** Read the hook payload Claude Code sends on stdin. */
export async function readInput() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

/** Load the built core. Returns null if the plugin hasn't been built — never throws. */
export async function loadCore() {
  try {
    const require = createRequire(import.meta.url);
    void require;
    return await import(join(PLUGIN_ROOT, 'packages/core/dist/index.js'));
  } catch {
    return null;
  }
}

/** Inject text into Claude's context window. The one thing a transcript cannot do itself. */
export function emitContext(hookEventName, additionalContext) {
  if (!additionalContext) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }),
  );
}

/**
 * Run a hook body under the never-break-the-session guarantee.
 * Errors go to stderr (visible if the user looks) and the hook exits clean regardless.
 */
export async function guard(fn) {
  try {
    await fn();
  } catch (e) {
    process.stderr.write(`claudeview: ${e?.message ?? e}\n`);
  }
  process.exit(0);
}
