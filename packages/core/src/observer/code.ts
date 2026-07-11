import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { createRequire } from 'node:module';
import { Parser, Language, type Node } from 'web-tree-sitter';
import { hashSource, type Store } from '../store.js';
import type { Component, Anchor } from '../schema.js';

const require = createRequire(import.meta.url);

/**
 * The code indexer.
 *
 * This produces the STRUCTURAL layer of the map: every function, class and module that
 * actually exists, with a content hash. It is Tier-1 — derived from the AST, zero
 * tokens, and it cannot be wrong about what the code says.
 *
 * The hash is the load-bearing part. A Decision or a Flow step pins the hash of the code
 * it describes; when the code changes, the hash changes, and every claim resting on it is
 * mechanically flagged as no longer trustworthy. That is the whole anti-rot mechanism,
 * and it needs no model to run.
 *
 * Tree-sitter is used rather than a per-language toolchain because the projects this must
 * serve are polyglot, and because a grammar that fails on a file should cost us that file,
 * not the run.
 */

/** Grammar per extension. Adding a language is one line — the extraction below is generic. */
const LANGS: Record<string, string> = {
  '.py': 'python', '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript',
  '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.go': 'go',
  '.rs': 'rust', '.rb': 'ruby', '.java': 'java', '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'c_sharp', '.php': 'php', '.swift': 'swift',
  '.kt': 'kotlin', '.scala': 'scala', '.lua': 'lua', '.sh': 'bash', '.bash': 'bash',
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv',
  '__pycache__', 'target', 'vendor', '.claudeview', 'coverage', '.pnpm-store',
]);

/**
 * Node types that constitute a Component, across every grammar we load.
 *
 * Deliberately generic rather than per-language queries: tree-sitter grammars converge on
 * these names, and a generic list degrades gracefully on a grammar we've never seen
 * (worst case: we find nothing in that file) instead of needing bespoke query code for
 * each of the twenty languages a polyglot user might have.
 */
const DEFN_NODES = new Set([
  'function_definition', 'function_declaration', 'function_item', 'method_definition',
  'method_declaration', 'class_definition', 'class_declaration', 'class_specifier',
  'struct_item', 'impl_item', 'interface_declaration', 'type_alias_declaration',
  'arrow_function', 'lexical_declaration', 'decorated_definition', 'enum_declaration',
]);

const IMPORT_NODES = new Set([
  'import_statement', 'import_from_statement', 'import_declaration', 'use_declaration',
  'require_call', 'preproc_include',
]);

export interface IndexResult {
  components: Component[];
  filesScanned: number;
  /** Unchanged since the last index — skipped entirely. */
  filesReused: number;
  filesFailed: number;
  /** Languages present in the repo whose grammar would not load. */
  grammarsFailed: string[];
  ms: number;
}

let ready: Promise<void> | undefined;
const grammars = new Map<string, Language | null>();

/**
 * Load a grammar, remembering failures so we try each language only once.
 *
 * Fail-soft is right for DATA (a weird transcript record, an unparseable file) but wrong
 * for CONFIGURATION. A grammar that won't load is a broken install, and quietly returning
 * "no components" makes it indistinguishable from "this repo has no code" — which is how
 * a version-mismatched WASM ABI can sit there producing an empty, confident, wrong map.
 * So failures are recorded and surfaced by the caller, never swallowed.
 */
async function loadGrammar(lang: string): Promise<Language | null> {
  const cached = grammars.get(lang);
  if (cached !== undefined) return cached;
  try {
    const wasm = require.resolve(`tree-sitter-wasms/out/tree-sitter-${lang}.wasm`);
    const g = await Language.load(wasm);
    grammars.set(lang, g);
    return g;
  } catch {
    grammars.set(lang, null);
    return null;
  }
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p);
      } else if (LANGS[extname(e.name)]) {
        out.push(p);
      }
    }
  }
  return out;
}

/** The name a definition binds, wherever the grammar hangs it. */
function nameOf(node: Node): string | undefined {
  const direct = node.childForFieldName('name');
  if (direct?.text) return direct.text;
  // Rust `impl Foo`, and similar shapes that name via 'type' rather than 'name'.
  const type = node.childForFieldName('type');
  if (type?.text) return type.text;
  // `const handler = () => {}` — the arrow function is anonymous; the binding names it.
  for (const c of node.namedChildren) {
    if (c?.type === 'variable_declarator') {
      const n = c.childForFieldName('name');
      if (n?.text) return n.text;
    }
  }
  return undefined;
}

/** Module specifiers this file imports. Raw strings — resolved to Components afterwards. */
function importsOf(root: Node): string[] {
  const out: string[] = [];
  const visit = (n: Node) => {
    if (IMPORT_NODES.has(n.type)) {
      const m = /['"`]([^'"`]+)['"`]/.exec(n.text) ?? /\bfrom\s+([\w.]+)/.exec(n.text);
      if (m?.[1]) out.push(m[1]);
    }
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(root);
  return [...new Set(out)];
}

export class CodeIndexer {
  private mtimeFile: string;

  constructor(private repoRoot: string, private store: Store) {
    this.mtimeFile = join(store.dir, 'cache', 'index-mtimes.json');
  }

  private async init(): Promise<void> {
    ready ??= Parser.init();
    await ready;
  }

  private loadMtimes(): Record<string, number> {
    try {
      return JSON.parse(readFileSync(this.mtimeFile, 'utf8'));
    } catch {
      return {};
    }
  }

  /**
   * Index the repo into Components.
   *
   * Idempotent: a file whose content hash is unchanged produces an identical Component,
   * and the store folds it to the same revision. So re-indexing costs nothing and never
   * churns the log.
   */
  async index(): Promise<IndexResult> {
    await this.init();
    const t0 = performance.now();
    const files = walk(this.repoRoot);
    const parser = new Parser();
    // `found` holds EVERYTHING that currently exists, including untouched files we reused —
    // deletion-reconciliation needs the complete picture or it would tombstone half the repo.
    // `changed` holds only what we must actually WRITE, so re-indexing an unmodified repo
    // appends nothing and the append-only log stays clean.
    const found: Component[] = [];
    const changed: Component[] = [];
    const grammarsFailed = new Set<string>();
    let failed = 0;
    let reused = 0;

    // Incremental by file mtime. A full re-parse of a 554-file repo costs ~4s, and this
    // runs on every session start — 4 seconds of dead air before Claude says a word is not
    // a price worth paying to re-derive an answer we already have. Unchanged files keep
    // their existing Components, so the steady-state cost is proportional to what you
    // actually edited, not to how big the project is.
    const prevMtimes = this.loadMtimes();
    const mtimes: Record<string, number> = {};
    const existingByPath = new Map<string, Component[]>();
    for (const c of this.store.all('component')) {
      const list = existingByPath.get(c.path) ?? [];
      list.push(c);
      existingByPath.set(c.path, list);
    }

    for (const file of files) {
      const lang = LANGS[extname(file)]!;
      const rel0 = relative(this.repoRoot, file);

      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        failed++;
        continue;
      }
      mtimes[rel0] = mtime;

      // Untouched since we last looked, and we still hold its components: nothing to do.
      const cached = existingByPath.get(rel0);
      if (prevMtimes[rel0] === mtime && cached?.length) {
        found.push(...cached);
        reused++;
        continue;
      }

      const grammar = await loadGrammar(lang);
      if (!grammar) {
        grammarsFailed.add(lang);
        continue;
      }

      let src: string;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        failed++;
        continue;
      }
      // A generated bundle is not architecture. Indexing it would bury the real components
      // under thousands of minified nodes.
      if (src.length > 1_000_000) continue;

      let tree;
      try {
        parser.setLanguage(grammar);
        tree = parser.parse(src);
      } catch {
        failed++;
        continue;
      }
      if (!tree) { failed++; continue; }

      const rel = relative(this.repoRoot, file);
      const imports = importsOf(tree.rootNode);

      // The file itself is a Component. Even a file with no extractable definitions is a
      // real unit a Flow step or a Decision may legitimately want to anchor to.
      const emit = (c: Component) => {
        found.push(c);
        changed.push(c);
      };

      emit({
        id: rel,
        kind: 'component', rev: 0, ts: '', actor: '', provenance: 'observed',
        name: rel, path: rel, language: lang,
        hash: hashSource(src),
        imports, calls: [],
        loc: src.split('\n').length,
      } as Component);

      const visit = (n: Node) => {
        if (DEFN_NODES.has(n.type)) {
          const name = nameOf(n);
          if (name) {
            emit({
              id: `${rel}#${name}`,
              kind: 'component', rev: 0, ts: '', actor: '', provenance: 'observed',
              name, path: rel, symbol: name, language: lang,
              // Hash the symbol's own source, not the file's. A change elsewhere in the
              // file must NOT invalidate a claim about this function — false staleness
              // alarms are how a trust panel becomes noise everyone ignores.
              hash: hashSource(n.text),
              imports: [], calls: [],
              loc: n.endPosition.row - n.startPosition.row + 1,
            } as Component);
          }
        }
        for (const c of n.namedChildren) if (c) visit(c);
      };
      visit(tree.rootNode);
      tree.delete();
    }

    // Resolve import specifiers to Component ids where they point inside the repo. An
    // unresolvable specifier is an external package and is left as-is, not dropped: "we
    // depend on axios" is architecture too.
    const byPath = new Set(found.map((c) => c.path));
    for (const c of found) {
      if (!c.symbol) c.imports = c.imports.map((spec) => resolveImport(spec, c.path, byPath) ?? spec);
    }

    // Every language in the repo failed to load: this is a broken install, not an empty
    // repo. Returning a confident empty map here would poison everything downstream —
    // every claim would read as 'broken' because no component exists to compare against.
    if (files.length > 0 && found.length === 0 && grammarsFailed.size > 0) {
      throw new Error(
        `code indexer: no grammar could be loaded (tried: ${[...grammarsFailed].join(', ')}). ` +
          `This is almost always a web-tree-sitter / tree-sitter-wasms ABI mismatch — both are pinned exactly for this reason.`,
      );
    }

    // Only newly-parsed components are written. Reused ones are already in the store at
    // the correct revision; re-appending them would double the log on every session start
    // for no information gain.
    const written = this.store.putMany(
      'component',
      changed.map(({ kind, rev, ts, actor, ...rest }) => rest) as any,
    );

    // Reconcile DELETIONS. Indexing only ever added and updated, which left a Component
    // behind after its code was deleted — and a claim anchored to that ghost then matched
    // its stale hash and reported itself FRESH.
    //
    // That is the worst outcome this system can produce. 'stale' says "check this";
    // 'broken' says "this is gone"; but a false 'fresh' says "I verified it" about code
    // that does not exist — it launders a lie as a verification, which is precisely the
    // failure ClaudeView exists to eliminate. So: anything we did not find this pass, in a
    // language we could actually parse, is gone.
    const foundIds = new Set(found.map((c) => c.id));
    const parsed = new Set(found.map((c) => c.language));
    for (const c of this.store.all('component')) {
      // Never tombstone a component whose language we couldn't parse this run — its
      // absence means "we didn't look", not "it isn't there".
      if (!foundIds.has(c.id) && parsed.has(c.language)) this.store.remove('component', c.id);
    }

    // Checkpoint mtimes only after a successful pass. Writing them earlier would mean a
    // crash mid-index leaves files marked "already done" that were never parsed.
    writeFileSync(this.mtimeFile, JSON.stringify(mtimes));

    return {
      components: written,
      filesScanned: files.length,
      filesReused: reused,
      filesFailed: failed,
      grammarsFailed: [...grammarsFailed],
      ms: performance.now() - t0,
    };
  }
}

/** Turn `./retriever` or `../db/index` into the repo-relative file it names, if it is one. */
function resolveImport(spec: string, fromPath: string, known: Set<string>): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const base = join(dir, spec).replace(/\\/g, '/');
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'].flatMap((e) => [
      base.replace(/\.js$/, '') + e,
      `${base}/index${e}`,
      `${base}/__init__${e}`,
    ]),
  ];
  return candidates.find((c) => known.has(c));
}

/** The Component id an Anchor refers to. Anchors and Components must agree on this. */
export function anchorId(anchor: Anchor): string {
  return anchor.symbol ? `${anchor.path}#${anchor.symbol}` : anchor.path;
}
