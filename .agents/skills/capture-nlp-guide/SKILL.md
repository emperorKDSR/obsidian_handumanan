---
name: capture-nlp-guide
description: Runbook for Handumanan journal composer autocomplete and natural-language dates.
---

# Journal capture triggers

Handumanan's `attachInlineTriggers` in `src/utils.ts` handles these composer interactions:

| Input | Result |
| --- | --- |
| `[[` | Open `FileSuggestModal` to insert a note link |
| `#` | Open `ContextSuggestModal` for an optional context tag |
| `@` | Open `PersonSuggestModal` for a person mention |
| `//word ` | Parse a natural-language date with `chrono-node` and insert `[[YYYY-MM-DD]]` |
| `++` or `+ ` at line start | Convert to a Markdown checklist item within the journal entry |

Typing a checklist in a journal entry is **not** a standalone task-management module. Consult `src/utils.ts` before altering trigger precedence or syntax; `@` is reserved for people, not dates. Use `src/modals/` for suggestion behavior and `src/utils.ts#parseNaturalDate` for date parsing.
