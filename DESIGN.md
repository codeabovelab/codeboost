---
# gstack: design-md-format=spec
name: codeboost
description: Evidence Desk. A near-black inspection surface with fine lines, where every changed line shows which plan item it belongs to.
colors:
  canvas: "#101216"
  surface: "#171B21"
  surface-raised: "#20262E"
  surface-selected: "#213448"
  line: "#343D49"
  control-outline: "#758295"
  text: "#E8ECF1"
  text-muted: "#A5AFBD"
  primary: "#8ABFFF"
  on-primary: "#101216"
  primary-hover: "#A6CEFF"
  focus-ring: "#8ABFFF"
  success: "#8FDDA8"
  warning: "#E9BE6E"
  error: "#F2847E"
  neutral-status: "#9AA3B0"
  diff-added-bg: "#1B2C24"
  diff-removed-bg: "#33201F"
  unplanned-hatch: "#F2847E"
typography:
  display:
    fontFamily: IBM Plex Sans
    fontWeight: 600
    fontSize: 1.25rem
    lineHeight: 1.4
    letterSpacing: 0em
  heading:
    fontFamily: IBM Plex Sans
    fontWeight: 600
    fontSize: 1rem
    lineHeight: 1.5
  body:
    fontFamily: IBM Plex Sans
    fontWeight: 400
    fontSize: 0.8125rem
    lineHeight: 1.385
  reading:
    fontFamily: IBM Plex Sans
    fontWeight: 400
    fontSize: 0.875rem
    lineHeight: 1.5
  label:
    fontFamily: IBM Plex Sans
    fontWeight: 500
    fontSize: 0.75rem
    letterSpacing: 0em
  mono:
    fontFamily: IBM Plex Mono
    fontWeight: 400
    fontSize: 0.75rem
    lineHeight: 1.5
    fontFeature: tnum
rounded:
  none: 0px
  sm: 4px
  md: 6px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  row: 32px
  app-bar: 44px
  review-strip: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.sm}"
    height: 28px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    borderColor: "{colors.line}"
    rounded: "{rounded.sm}"
    height: 28px
  input:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.control-outline}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
  list-row:
    height: "{spacing.row}"
    backgroundColor: "{colors.surface}"
    selectedBackgroundColor: "{colors.surface-selected}"
  pane:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.line}"
    rounded: "{rounded.none}"
  nav-link:
    textColor: "{colors.text-muted}"
    activeTextColor: "{colors.text}"
  logo:
    size: 20px
    color: "{colors.text}"
  provenance-gutter:
    width: 56px
    textColor: "{colors.text-muted}"
    unplannedColor: "{colors.unplanned-hatch}"
---

# codeboost

**Who this is for.** Anyone building or changing a codeboost screen. **What it is for.** It is the single source of truth for fonts, colors, spacing, and screen character. Exact values live in the header above. This text explains how and why to use them. It is written in plain language (ISO 24495-1:2023).

## Overview

**Creative North Star:** "Evidence Desk". A calm, near-black inspection surface where the code is the main thing and every change shows its reason. It serves the one thing users should remember: *"I can see exactly what the agent did."*

**Product context:** codeboost is a single-user, local, open-source developer tool. It turns GitHub issues into plans, runs AI agents on each plan item, and lets you review the pull request one plan item at a time. Its peers are Linear, GitHub's review screen, and code editors. See `docs/designs/codeboost-plan-indexed-review.md`.

**Mode per surface:** every screen is **Operate**. You come to finish a task, not to be persuaded.

**Reference sites:** [Linear's UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) for restraint in how much color is used. [Dark-mode accessibility guidance](https://atmos.style/blog/dark-mode-ui-best-practices) for status colors.

**Key characteristics (first five seconds):**
- The code pane is the largest, brightest thing on the screen.
- Lines, not boxes. Panes are divided by 1px lines, never by cards or shadows.
- Blue means "you can click this". Nothing else is blue.
- Status is always an icon plus a word plus a color.
- Unplanned code carries a red hatched strip that is visible before you read a single line.

## Colors

**Strategy:** Restrained. Neutral grey-blue surfaces, one accent, and four status colors. Color is rare, so it always means something.

**Light or dark:** Dark. You review code at your desk, often at night after an overnight run, for long stretches beside a dark code editor. A dark surface reduces glare and keeps diff colors readable.

**How to use the colors:**
- **Surfaces step up in brightness:** canvas → surface → surface-raised → surface-selected. Hierarchy comes from these steps and from the `line` color, not from shadows.
- **`primary` (light blue) marks only things you can act on:** buttons, links, the current tab, and focus rings. Never use it for status or decoration. Text on a primary button uses `on-primary` (dark), which gives 9.8:1 contrast.
- **Status colors carry meaning:**

| Token | Meaning | Icon and word |
|---|---|---|
| `success` | OK: passed, in scope, approved | ✓ plus a word such as "OK" or "Passed" |
| `warning` | Attribution warning, stale | ! plus a word such as "Stale" or "Ambiguous" |
| `error` | Scope or test failure, blocker, unplanned | ✕ plus a word such as "Fail" or "Unplanned" |
| `neutral-status` | Not applicable | – plus "N/A" |

- `success` is much lighter than `error`. This lets red-green color-blind users still tell them apart by brightness. Never rely on hue alone.
- **Contrast (checked 2026-09-22):** every text and status color is at least 5.0:1 on every surface. Body text is 14.6:1 on `surface`.
- **Diff backgrounds:** `diff-added-bg` and `diff-removed-bg` are quiet tints. The `+` and `−` signs carry the meaning, not the tint.

## Typography

**Faces:** IBM Plex Sans for the interface, and IBM Plex Mono for code, file paths, commit IDs, plan-item IDs, and numbers. Plex was drawn for engineering documentation, which suits a tool about inspecting evidence. The two faces share proportions, so code and interface sit together calmly.

**Why Plex is allowed here:** IBM Plex Sans is on the "too common for headlines" list. It is used here only as interface text on an Operate surface, which the rule permits. There are no marketing headlines in codeboost.

**Loading:** self-host both families (weights 400, 500, and 600 for Sans; 400 and 500 for Mono) with `font-display: swap`, so codeboost works offline. Fallbacks: `"IBM Plex Sans", "Segoe UI", sans-serif` and `"IBM Plex Mono", Menlo, Consolas, monospace`.

**Scale:** 12px labels and code, 13px interface text, 14px reading text (conversation and lesson details), 16px section headings, 20px page titles. Levels differ by size and weight, not by weight alone. Use tabular numbers (`tnum`) wherever numbers line up in columns.

**Small text on purpose:** 13px interface text is below the common 16px body guideline. The user chose a compact, dense tool. High contrast (at least 5:1) and a 32px row height keep it readable. Longer reading text uses 14px.

## Layout

**Desktop only, from 1280px** (design review D25).

| Width | Layout |
|---|---|
| 1440px and wider | Three panes. Plan list 232px, code fills the rest, conversation 344px |
| 1280–1439px | The conversation pane collapses to a tab. The plan list narrows to 208px |
| Below 1280px | A notice asks for a wider window |

**Frame:** a 44px app bar (the shared menu, design review D13), then a 48px review strip (issue, PR, revision, progress, blockers), then full-height panes. Panes can be resized and collapsed.

**Rhythm:** a 4px base grid. Rows are 32px. Pane padding is 12px. Space between sections is 16px or 24px. Keep density tight inside lists and give the code pane the most room.

## Elevation & Depth

There are no shadows and no glows. Depth comes from the surface brightness steps and 1px `line` borders. A popover or menu uses `surface-raised` with a 1px `line` border. If a real shadow is ever needed for a floating menu, it must be offset (for example 0 4px 12px at 40% of canvas), never a zero-offset colored halo.

## Shapes

- Panes, lists, and the code area have square corners (`rounded.none`). They are layout, not cards.
- Buttons, inputs, tags, and chips use `rounded.sm` (4px).
- Menus and popovers use `rounded.md` (6px). An element inside one uses 6px minus its inset.
- `rounded.full` is only for small status dots.

## Components

**Every interactive component has these states:**
- **Hover:** background one surface step brighter, or `primary-hover` for primary buttons.
- **Focus-visible:** a 2px `focus-ring` outline with a 2px gap. It must look different from the selected-row fill.
- **Active:** the same as hover, with the outline kept while focused.
- **Disabled:** text in `text-muted` and no hover change. A disabled button still explains itself; for example, the merge button reads "3 blockers".

**Logo.** A terminal prompt (`>_`) inside a rounded square, followed by the word "codeboost".
- It sits at the left of the app bar on every screen, 20px square, with 8px between the mark and the word.
- The mark and the word use `text`. They are never blue, because blue means "you can click this".
- The mark is drawn with 1.4px to 1.5px strokes and round caps, so it matches Plex's weight at 13px.
- Screen readers skip the mark (`aria-hidden`) and read the word.

```svg
<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
  <rect x="1.5" y="2.5" width="17" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.4"/>
  <path d="M5.5 7.5l3 2.5-3 2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M10.5 13h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>
```

**List row:** 32px high. Shows ID, title, count, and status icons. The selected row uses `surface-selected`.

**Status mark:** icon + word + color, with a screen-reader label such as "In scope: fail, 1 file outside declared files".

**Provenance gutter (the signature component).** A 56px column to the left of the line numbers in every diff.
- Each changed block shows the ID of the plan item that made it, such as `P2`, in Plex Mono with `text-muted`.
- A block that belongs to no plan item gets a red diagonal-hatched strip in `unplanned-hatch` and the word "Unplanned" beside it.
- An ambiguous block shows "Ambiguous" with the ! icon in `warning`.
- The gutter is read aloud with its block, for example "Lines 118 to 129, plan item P2".

**File-change card:** sits inside the code pane in change order. It has a `line` border, `rounded.sm`, an icon for the kind of change, old → new values in Plex Mono, and a "Details" expander.

**Tables (Lessons, Learning):** 32px rows, sortable headers with a visible sort arrow, and a filter bar above the table. Rows expand in place, with no side panel.

## Do's and Don'ts

- **Do** use `primary` only for things you can act on.
- **Do** pair every status color with its icon and a word.
- **Do** give the code pane the most width and the brightest text.
- **Do** show the provenance gutter on every diff, including file-change cards.
- **Do** check any new color pair for at least 4.5:1 contrast before using it.
- **Don't** wrap panes, messages, or files in cards, and never put a card inside a card.
- **Don't** use shadows, glows, gradients, or colored halos.
- **Don't** use blue, purple, or accent colors to decorate.
- **Don't** add a colored left border to a card to show state. Use the status mark instead. The provenance gutter is a column in the diff, not a card border.
- **Don't** use a serif or italic display face. All text is Plex.

## Motion

- **Approach:** minimal and functional. Motion only explains a change of state.
- **Easing:** enter ease-out, exit ease-in, move ease-in-out.
- **Duration:** micro 80ms (hover and focus), short 150ms (expand a row, switch a tab), medium 250ms (open or collapse a pane). Nothing longer.
- **The one designed moment:** when you approve a plan item, its status mark fills from an outline to a solid ✓ in 150ms, and the progress count updates.
- **Reduced motion:** if the user asks for reduced motion, all transitions are instant.

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-22 | Initial design system, "Evidence Desk", created | Created by /design-consultation from the design review (D22), the approved mockups, 2026 dev-tool research, and two outside proposals (Codex "Evidence Desk", Claude subagent "Flight Recorder") |
| 2026-09-22 | IBM Plex Sans and IBM Plex Mono, verified on Google Fonts; self-hosted | One engineering-document family. Readable at 13px, with tabular numbers |
| 2026-09-22 | Light-blue accent #8ABFFF with dark text | Keeps the accent readable (9.8:1) and separate from the status colors |
| 2026-09-22 | Provenance gutter adopted (preview variant B) | Makes "I can see exactly what the agent did" visible. Idea from the Claude subagent |
| 2026-09-22 | The serif "second voice" for the user's own words was not adopted | The user chose variant B. Two faces are enough |
| 2026-09-22 | Logo: terminal-prompt mark (`>_`) in a rounded square, in `text` color | Taken from the approved review-screen mockup. It was left out of the first HTML screen and restored at the user's request |
| 2026-09-22 | Contrast-checked values kept instead of values extracted from the mockup image | The extracted values (for example error #DA1E28) failed contrast on dark surfaces |
