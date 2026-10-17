---
name: styling-rules
description: Standards for adding CSS classes, namespacing UI widgets, and styling responsive elements in styles.css.
---

# Styling Guidelines

Use this skill when modifying the user interface layout, typography, or color declarations.

## 1. Class Namespacing
To avoid conflicts with Obsidian core sheets or other community themes:
*   Use the existing `pos-` prefix for new journal element classes (e.g. `.pos-journal-leaf`).
*   Avoid naked selectors like `button`, `input`, `textarea`, or generic classes like `.title`, `.active`, `.hidden`. Wrap them within their parent component container (e.g. `.pos-sidebar .active`).

---

## 2. obsidian Theme Variables
Never hardcode light/dark hex colors. Always reference Obsidian's CSS custom properties:
*   **Backgrounds**:
    *   `--background-primary`: Main background.
    *   `--background-secondary`: Sidebars and card accents.
*   **Text colors**:
    *   `--text-normal`: Normal copy.
    *   `--text-muted`: Dimmed text.
*   **Accents**:
    *   `--interactive-accent`: Active highlight colors (inherits user's accent setting).
*   **Borders**:
    *   `--border-color`: Fine lines between sections.

Example pattern:
```css
.pos-journal-leaf {
    background-color: var(--background-secondary);
    border: 1px solid var(--border-color);
    color: var(--text-normal);
}
.pos-journal-leaf:hover {
    border-color: var(--interactive-accent);
}
```

---

## 3. Responsive Breakpoints
Ensure layout adjustments are tested for multiple viewports:
*   **Desktop / tablet**: Keep the journal composer and reading stream usable in both wide and narrow Obsidian panes.
*   **Mobile**: Keep the composer accessible above the virtual keyboard and respect safe areas.

Check `styles.css` for existing `@media` blocks and provide keyboard focus and reduced-motion behavior.
