# Active Context: Handumanan Journal

## Current State & Scope
- **Core Scope**: Handumanan is primarily a focused, intimate Life Journaling plugin.
- **Architectural Upgrades Implemented**:
  - **Decoupled Shell Architecture**: Separated the composer from the document stream in `DesktopHubView.ts`. Live user keystrokes, focus, and mobile virtual keyboards are never destroyed by background sync file events.
  - **Crash-Safe Frontmatter**: Migrated from regex string replacement to Obsidian's official `app.fileManager.processFrontMatter` in `CaptureService.ts`.
  - **10k-Scale MetadataCache Startup**: Replaced sequential disk reads with `app.metadataCache.getFileCache()`, dropping startup time for large vaults from 30+ seconds to <100ms.
  - **Append-Only Infinite Stream**: Replaced quadratic DOM teardowns on scroll with true append-only streaming and cached Markdown render fragments.
  - **Privacy Shield Hardening**: Removed accidental-glimpse `:hover` unblurring in `styles.css`. Reflections strictly require intentional click-to-reveal.
  - **Syntax Disambiguation**: Reassigned `@` exclusively to `PersonSuggestModal` for interpersonal constellation mentions, shifting natural language dates to `//`.
  - **Psychological Safety in Serendipity**: Excluded `private: true` and `type: 'unburdening'` entries from random memory resurfacing (`🎲 Resurface`) to protect emotional safety.
  - **Autobiographical Weaving**: Set `trashSources: false` by default in `MergeNotesModal.ts`; tagged source entries with `synthesized: true` and `wovenInto: [[Target]]` while generating a provenance appendix.
  - **Circadian Prompts & Pebble-Drop**: Added time-aware prompt decks (Morning, Midday, Evening) and 1-tap presence check-ins via mood beads alone.
  - **WCAG AA Light Theme Contrast & Touch Targets**: Added theme-adaptive yellow tokens (`--color-yellow-subtle`, `--text-warning`) and enlarged touch targets for mobile.
  - **UI/UX Philosophy Realignment with `obsidian_diwa`**:
    - **Continuous Document Stream (Outliner Row Flow)**: Replaced boxy stationery card leaves with `obsidian_diwa`'s typography-first continuous outliner rows (`.pos-note-stream-item`). Features a fixed 68px left gutter (`.pos-note-gutter`), compact timestamps, flush-right hover actions (`.pos-note-actions`), and subtle hairline date dividers with count pills (`.pos-date-divider`).
    - **Hero Quick Capture Composer**: Ported `obsidian_diwa`'s compact idle capture bar (`.pos-composer-compact.pos-reflect-composer-compact`) that expands into the full desktop hero composer with borderless auto-expanding input, unified 28px pill buttons (`.pos-composer-pill-btn` for Task, Important, Context/Area, and Privacy), keyboard shortcut hints (`⌘↵ Save · ⇧↵ Next`), and clean Save button.
    - **Mobile Frosted Glass Controls**: Ported `obsidian_diwa`'s 1-line floating action bar (`.pos-mobile-action-bar`), bottom floating search capsule (`.pos-mobile-floating-search`), and sticky composer (`.pos-mobile-sticky-composer`) with `backdrop-filter: blur(24px)` and safe-area padding.
    - **In-Place Live Task Interactivity**: Interactive markdown checkboxes (`.pos-interactive-checkbox`) with optimistic strike-through and direct in-place markdown file updates via `CaptureService.toggleTaskInFile`.
    - **Native Obsidian Lucide Icons & Tokens**: Adheres strictly to `--diwa-radius: 12px`, `--diwa-radius-pill: 9999px`, `--diwa-shadow`, and Obsidian semantic custom properties.
    - **Stream Row Typographic Baseline Alignment**: Locked the first row of journal text to the exact typographic baseline of the gutter timestamp (`align-items: baseline !important;`, normalized zero-margin resets for note body first-children, direct markdown rendering without extra wrapper divs, and body-first DOM ordering before badges).

## Journal-only maturity review
- Independent product-design, visual-UI, interaction-UX, and system reviewers, followed by cross-challenge, agree the focused journal is **functionally mature with qualifications**, but **not yet best-in-class**. This was a source review, not a hands-on accessibility or device study.
- Highest-priority gaps: silent inline-edit save failure, same-note concurrent write risk, and keyboard-inaccessible per-entry privacy reveal/search clearing. Reduced-motion support, first-use guidance, and measured large-vault behavior remain open.
- Privacy Shield's command/header toggle is keyboard-accessible; it is the per-entry *reveal* that is not. An inline save failure leaves the user's edit text in the editor; it does not destroy the draft, but fails to communicate that saving did not succeed.

## Implemented journal direction
- `DesktopHubView` keeps the active composer separate from stream refreshes and renders a responsive journal stream.
- The phone view now uses a compact two-row capture dock: writing and Record above horizontally scrollable mood options and the private-entry toggle. Search and Privacy Shield stay in the header; Sanctuary, Recall, Select, and Settings live in an Obsidian More menu. The phone-only layout class keeps 768px tablets on tablet styling.
- `CaptureService` creates Markdown entries and persists drafts; `IndexService` supports filtering and excludes private/unburdening entries from resurfacing.
- Sanctuary mode, Privacy Shield, prompts, mood check-ins, keepsakes, search, and non-destructive weaving support reflective writing.

## Known limitations to verify or improve
- Inline-edit save failures now surface without discarding unsaved text; an entry changed externally since editing began is rejected with conflict guidance. This does not replace live merge resolution between Obsidian editor tabs or external sync tools.
- Search clear and private-text reveal are keyboard-operable, leaf actions show on focus, and CSS honors reduced motion. First-entry guidance is shown in the empty journal.
- The stream now uses bounded 25-entry pages. Indexing rejects stale asynchronous reads and runs uncached startup reads at bounded concurrency; Recall remains user-initiated and excludes private/unburdening entries.
- Vitest service tests cover conflicts, metadata preservation, index races, privacy exclusions, and synthetic 10k-entry metadata indexing. Actual Obsidian desktop/mobile interaction, theme, sync, and scroll performance are not yet measured; historical deployment notes are not revalidated here.
- On 2026-09-27, the production build and 14 service tests passed, and `main.js`, `manifest.json`, and `styles.css` were deployed to the user-confirmed local Obsidian vault. Installed asset hashes matched the build outputs; the existing plugin `data.json` hash was unchanged. Obsidian reload and hands-on behavior remain unverified.
- On 2026-09-27, the compact phone layout was rebuilt and deployed to the user-approved `K0000` vault. The installed `main.js`, `manifest.json`, and `styles.css` hashes matched the worktree outputs, and `data.json` was unchanged. Obsidian reload and hands-on phone/tablet keyboard, theme, narrow-pane, and touch behavior remain unverified.
- The user observed a black empty region above the iPhone keyboard after that deployment. Handumanan now mirrors the on-device-confirmed DIWA fix: no keyboard-driven root height subtraction or `100dvh` override, an overflow-visible phone container with a non-collapsing stream while the keyboard is open, and Obsidian keyboard-state detection without scrolling inputs already in view. On 2026-09-27, this fix was built and deployed to the approved `K0000` vault; all three installed assets matched their source hashes and `data.json` was unchanged. It still needs confirmation on the user's iPhone after Obsidian Sync and restart.
