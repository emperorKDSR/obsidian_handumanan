# Project Brief: Handumanan Journal

## Purpose
Handumanan is a local-first, privacy-conscious Obsidian **journal plugin** for capturing, reading, and revisiting personal reflections. It favors low-friction writing, a calm reading stream, and human-readable Markdown over broad productivity features.

## Current scope
- Capture timestamped entries with optional mood, private status, links, and attachments; retain drafts locally while writing.
- Browse, search, filter, edit, and selectively weave entries while retaining their provenance.
- Offer Sanctuary mode, circadian reflection prompts, keepsakes, and intentional memory resurfacing.
- Adapt the same journal experience to Obsidian desktop, tablet, and mobile.

## Boundaries
- This plugin does **not** ship a task manager (Gawa), finance ledger (Bulsa), weekly/monthly planning, AI chat, voice, calendar, or a general-purpose Personal OS.
- Privacy Shield visually blurs the journal stream; it is not encryption. Notes remain readable in the user's vault.
- Notes are Markdown with YAML frontmatter under the configured journal folder. The current version is `1.0.0` in `manifest.json`.
- Legacy DIWA settings or aliases in source are compatibility details, not supported product modules.
