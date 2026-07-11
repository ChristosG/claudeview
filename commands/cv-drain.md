---
name: cv-drain
description: Process the analysis jobs queued by the dashboard or the Observer (reconcile foreign commits, verify stale claims, annotate, red-team).
---

Call `cv_jobs` to list queued work, then actually do it. Each job type has a specific contract:

- **`reconcile`** — commits appeared that our session history cannot explain (a teammate pushed, you rebased, you edited outside Claude). The structural map has already healed itself for free, but *intent* cannot be recovered from an AST. Read the diff and the commit messages, infer what they were doing, and record it. **Everything you write here is `inferred`, not `authored`** — you are reconstructing, not remembering, and the record must say so.

- **`verify`** — a claim's anchored code changed. Read the new code and decide: is the claim merely *out of date*, or is it now actually *wrong*? If it is wrong, say so explicitly — a contradicted claim is far more dangerous than a stale one, because it still reads as authoritative.

- **`annotate`** — components have no purpose recorded. Read them and give them one. Be concrete ("parses the retrieval config and validates chunk sizes"), not vague ("handles configuration").

- **`red-team`** — adversarial review. Record `cv_insight`s with honest confidence and real evidence.

- **`extract-threads`** / **`summarize-session`** — mine the session transcript for ideas raised and never pursued, and write the journal entry.

- **`ask`** — a question from the dashboard's search box. Search the store first (`cv_ask`), read the code if needed, answer.

Work through them, record results with the `cv_*` write tools, and report what you did.
