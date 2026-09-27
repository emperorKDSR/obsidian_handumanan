# Handumanan

**Handumanan** is a local-first journaling plugin for Obsidian. Capture reflections as Markdown notes, revisit them in a chronological stream, and write with fewer distractions. It is a journal plugin, not a task manager, finance ledger, weekly planner, AI assistant, or all-in-one Personal OS.

Current plugin version: **1.0.0** (see `manifest.json`). The project was forked from `obsidian_diwa`; old DIWA feature and release history does not describe the current plugin.

## Get started

1. Install the plugin files (`main.js`, `manifest.json`, and `styles.css`) in `<vault>/.obsidian/plugins/handumanan/` and enable Handumanan under Community plugins.
2. Open **Handumanan Journal** from the ribbon or run **Open Handumanan Life Journal** from the command palette.
3. Write in the composer and submit your entry. `Ctrl+Enter` / `Cmd+Enter` submits while the composer is focused. To open the journal with a keyboard shortcut, assign one to a Handumanan command in Obsidian's Hotkeys settings; no default capture hotkey is registered.

Entries are stored as Markdown with YAML frontmatter under the configured journal folder (default: `000 Bin/Handumanan/`), partitioned by year and month. Your vault remains the source of truth.

## Journaling features

- **Reflection stream:** Browse entries by day in bounded 25-entry pages with Newer/Older controls; search and filter to Today, On This Day, Keepsakes, or Unburdening.
- **Capture:** Use gentle time-of-day prompts, mood beads, private-entry marking, saved local drafts, and paste or attach media. Mood-only check-ins are supported.
- **Write and revisit:** Edit or delete an entry, mark a keepsake, select entries for a non-destructive weave, or choose **Recall** to revisit an older memory. Recall prefers safe anniversary entries, favors keepsakes, and avoids immediately repeating a selection. Private and unburdening entries are excluded.
- **Sanctuary mode:** Focus the composer and dim surrounding content for deep reflection. Press `Escape` to leave Sanctuary mode.
- **Privacy Shield:** Blur reflection text in the journal view until deliberately revealed with each entry's reveal button. This is a visual screen-sharing/shoulder-surfing aid, **not encryption or access control**; Markdown remains readable in the vault and other Obsidian views.
- **Inline links:** The composer supports `[[` file links, `#` context suggestions, `@` person suggestions, and `//` natural-language dates.

The journal view adapts to desktop, tablet, and mobile. It does not provide separate Gawa, Bulsa, Review, Search, AI, Voice, or Calendar modules.

When editing an existing reflection, a failed save leaves your text in the editor and displays an error. If the note changed elsewhere after editing began, Handumanan refuses to overwrite its newer body: copy your unsaved text, cancel editing, and reopen the reflection to compare changes. Other editors or external sync tools can still change vault files independently.

## Commands and settings

Available command-palette actions:

| Command | Effect |
| --- | --- |
| Open Handumanan Life Journal | Open the journal |
| Open Sanctuary Mode (Deep Reflection) | Open and focus the journal composer |
| Toggle Privacy Shield (Blur Reflections) | Toggle visual blur on open journal entries |
| New Journal Entry | Open the journal for capture |

In plugin settings you can configure the **Journal Folder**, **Attachments Folder**, **People / Constellations Folder**, **Default Privacy Shield**, and **Introspective Prompt Deck**. The default attachments and people folders are `000 Bin/Handumanan Attachments` and `000 Bin/Handumanan People`.

## Development

Run `npm ci`, `npm test`, and `npm run build` to install locked dependencies, check journal service behavior, type-check, and bundle `main.js`. The build does not install into a vault; copy `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/handumanan/` when deploying. Preserve the vault's `data.json`. A synthetic 10,000-entry metadata index check is included in the tests; real Obsidian device and vault performance still needs hands-on measurement.

Architecture: `src/main.ts` registers the journal views and commands; `src/views/DesktopHubView.ts` implements the responsive journal; `src/services/CaptureService.ts` stores entries; `src/services/IndexService.ts` indexes them; `src/application/RefreshCoordinator.ts` coalesces view refreshes. The three registered platform view types use the same journal view class.
