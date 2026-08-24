# Lessons

## A short answer never overrides the user's own worked example

**What happened.** Asked whether a Channel maps to one output size or several. The user's own answer to the previous question already described the plural case — "we say quote card and then download the linkedin, insta and twitter images", sizes "from the current best practices for facebook, linkedin, insta, twitter". A later one-word reply said "one". I noticed the tension, wrote a one-line hedge about it, and then committed the wrong model into `CONTEXT.md` and an ADR arguing for it.

**Rule.** When a short answer contradicts a concrete example the user gave earlier, the example wins as evidence of intent. Stop and re-ask in one sentence, quoting their example back. Never resolve the contradiction silently, and never write it into a durable artifact — glossary, ADR, schema, migration — on a hedge.

**Why it matters.** A hedge in chat scrolls away in minutes. A wrong ADR reads as a considered decision for years, and the next reader has no idea it rested on an unresolved contradiction.
