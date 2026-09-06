# Lessons

## A short answer never overrides the user's own worked example

**What happened.** Asked whether a Channel maps to one output size or several. The user's own answer to the previous question already described the plural case — "we say quote card and then download the linkedin, insta and twitter images", sizes "from the current best practices for facebook, linkedin, insta, twitter". A later one-word reply said "one". I noticed the tension, wrote a one-line hedge about it, and then committed the wrong model into `CONTEXT.md` and an ADR arguing for it.

**Rule.** When a short answer contradicts a concrete example the user gave earlier, the example wins as evidence of intent. Stop and re-ask in one sentence, quoting their example back. Never resolve the contradiction silently, and never write it into a durable artifact — glossary, ADR, schema, migration — on a hedge.

**Why it matters.** A hedge in chat scrolls away in minutes. A wrong ADR reads as a considered decision for years, and the next reader has no idea it rested on an unresolved contradiction.

## `git restore` after a mutation discards whatever else is uncommitted there

**What happened.** Proving a test can fail means mutating the code, running the suite, and reverting. The revert was `git restore packages/models/lib/adapters/edgeface/`. Two refactors sat uncommitted in that folder, and the restore took them with the mutation. They were only noticed a rebase later, when a mutation no longer matched the text it was written against.

**Rule.** Commit the green state before the first mutation, every time. `git restore <path>` is not "undo my last edit", it is "make this path match HEAD" — so it is only safe when HEAD is where you want to land. Nothing else may be uncommitted under that path.

**Why it matters.** The loss is silent. The suite stays green because the refactors were behaviour-preserving, so nothing points at the gap; what is left is a commit whose message describes work that is not in it.
