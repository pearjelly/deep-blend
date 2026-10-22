---
name: DeepBlend Studio
description: A precise light table for editable Blender work.
colors:
  accent: '#295bc8'
  accent-soft: '#e8eefc'
  canvas: '#f4f6fa'
  surface: '#fff'
  border: '#d8dee8'
  fill: '#edf1f7'
  text: '#20252e'
  subtle: '#47566a'
  muted: '#58677c'
  input-border: '#8492a5'
  good: '#23704e'
  warn: '#946109'
  bad: '#b0303c'
  primary-text: '#fff'
  dark-accent: '#96b6ff'
  dark-accent-soft: '#263b62'
  dark-canvas: '#10151d'
  dark-surface: '#19212d'
  dark-border: '#334155'
  dark-fill: '#253142'
  dark-text: '#edf2f8'
  dark-subtle: '#c2ccda'
  dark-muted: '#a2afc1'
  dark-input-border: '#657692'
  dark-good: '#77c9a0'
  dark-warn: '#efbc73'
  dark-bad: '#ff979c'
  dark-primary-text: '#14213b'
typography:
  headline:
    fontFamily: var(--dsw-font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)
    fontSize: 28px
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: -0.025em
  result-title:
    fontFamily: var(--dsw-font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)
    fontSize: 20px
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: -0.02em
  context-title:
    fontFamily: var(--dsw-font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)
    fontSize: 17px
    fontWeight: 650
    lineHeight: 1.3
  brand-title:
    fontFamily: var(--dsw-font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)
    fontSize: 15px
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: -0.02em
  body:
    fontFamily: var(--dsw-font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)
    fontSize: 14px
    lineHeight: 1.55
  button:
    fontFamily: var(--dsw-font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)
    fontSize: 13px
    lineHeight: 1.4
  caption:
    fontFamily: var(--dsw-font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)
    fontSize: 12px
    lineHeight: 1.55
  badge:
    fontFamily: var(--dsw-font-sans, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)
    fontSize: 11px
    lineHeight: 18px
  code:
    fontFamily: var(--dsw-font-mono, ui-monospace, monospace)
    fontSize: 11px
    lineHeight: 1.55
rounded:
  image: 3px
  frame: 5px
  control: 6px
  chip: 7px
  surface: 8px
spacing:
  '4': 4px
  '6': 6px
  '8': 8px
  '10': 10px
  '12': 12px
  '14': 14px
  '16': 16px
  '18': 18px
  '20': 20px
  '24': 24px
  '28': 28px
  '32': 32px
components:
  button-primary:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.primary-text}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: 6px 12px
  button-secondary:
    backgroundColor: '{colors.fill}'
    textColor: '{colors.text}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: 6px 12px
  button-danger:
    backgroundColor: '{colors.fill}'
    textColor: '{colors.bad}'
    typography: '{typography.button}'
    rounded: '{rounded.control}'
    padding: 6px 12px
  input:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.text}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: 7px 10px
    width: 100%
  navigation-item:
    textColor: '{colors.subtle}'
    padding: 10px 18px
  status-badge:
    textColor: '{colors.subtle}'
    typography: '{typography.badge}'
    rounded: '{rounded.frame}'
    padding: 2px 7px
  card:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.text}'
    rounded: '{rounded.surface}'
    padding: 16px 18px
  film-frame:
    textColor: '{colors.muted}'
    rounded: '{rounded.frame}'
    padding: 4px
  disclosure:
    textColor: '{colors.subtle}'
    padding: 6px 0
  chip:
    textColor: '{colors.subtle}'
    typography: '{typography.caption}'
    rounded: '{rounded.chip}'
    padding: 6px 8px
---

# Design System: DeepBlend Studio

## Overview

**Creative North Star: "光台 / The Lighttable"**

光台 places real work on a quiet studio surface. Cool neutral planes, graphite text and cobalt selection keep model imagery legible; the existing orange DeepBlend mark remains a small identity asset rather than becoming the interface accent.

This is an operational workbench with compact controls and readable source captions. Borders, tonal mats and restrained rounding provide order. System, light and dark preferences remain authoritative, and the same composition responds to the available app or embedded-panel width.

**Key Characteristics:**
- Real imagery and visible source identity.
- Flat planes with precise cobalt selection.
- Compact system typography and tabular numerals.
- Contextual controls with persistent disclosure.

## Colors

The palette uses cool studio neutrals, cobalt interaction and semantic status colors. Frontmatter records the exact implemented values; the unprefixed tokens describe light mode and `dark-` tokens its corresponding dark mode.

### Primary

- **Studio Cobalt** (`accent`): primary actions, selected task underlines, selected recipe outlines, filmstrip selection and focus rings.
- **Cobalt Wash** (`accent-soft`): secondary-button hover and pressed surfaces; text selection.
- **Primary Action Ink** (`primary-text`, `dark-primary-text`): theme-specific text on filled primary actions.

### Neutral

- **Studio Canvas** (`canvas`): the workbench ground; **Paper Surface** (`surface`): header, cards, menus and fields.
- **Image Mat** (`fill`): result mats, secondary controls and technical blocks.
- **Graphite** (`text`), **Slate** (`subtle`) and **Source Slate** (`muted`): principal text, controls and supporting captions.
- **Plane Edge** (`border`): dividers and container edges; **Field Edge** (`input-border`): the stronger input boundary.
- **Success Green**, **Caution Ochre** and **Error Rose** (`good`, `warn`, `bad`) provide semantic text and outlined status badges, with dark counterparts. They describe state and do not add navigation accents.
- Dark counterparts retain these roles with lighter text, darker planes and a lighter cobalt. Explicit dark and system-dark use the same role values. The source defines its variables on the workbench root; embedded host font aliases remain available.

**The Source-Bound Frame Rule.** Keep the selected image, saved revision caption and valid actions bound to the same result; distinguish the selected revision from the current revision.

## Typography

**Body and Heading Font:** the host's sans alias with the system UI fallback stack recorded in frontmatter. There is no separate display typeface.

**Label/Mono Font:** the host's mono alias with a monospace fallback for technical values and code. The standalone host supplies its fuller UI-monospace stack.

The type is compact and functional. Numeric values use tabular figures. Task titles carry the larger scale; labels and source captions stay subordinate without uppercase decoration.

### Hierarchy

- **Headline:** the new-work heading; the narrow layout reduces it to (25px).
- **Result title:** the current project title above the mat; the narrow layout reduces it to (19px).
- **Context title:** the contextual tool heading.
- **Brand title:** the compact DeepBlend Studio name.
- **Body:** normal interface prose and fields. Creation introduction is constrained to (65ch); context hints to (44ch).
- **Button:** action text. Primary action and selected navigation use weight (650).
- **Caption:** source, contextual hints and supporting controls. Filmstrip captions and status badges use the smaller badge scale; code uses the mono role.

**The Operational Type Rule.** Use the system sans stack for controls and task headings; reserve the mono stack for technical values and code.

## Layout

The workbench is a full-height flex shell with a project bar, task navigation and an internally scrolling body. The current result and its filmstrip form the desktop stage, beside a contextual tool pane. The broad layout has a flexible stage plus a pane of (320–360px), separated by (28px), within a maximum workbench width of (1680px). The stage sticks at the body top; the tool pane scrolls within `calc(100dvh - 165px)`. Contextual sections use dividers instead of nested cards.

Desktop body padding is (24px). At an available viewport or named-container width of (1000px) and below, the tool pane becomes (320px), the column gap (20px), and the filmstrip uses three columns up to (110px) wide. At (760px) and below, the result and tools become one column, body padding becomes (16px), sticky/independent scrolling is removed, and the filmstrip becomes a horizontal rail with (100px) frames. Task navigation may scroll horizontally. Both viewport and `deepblend` container queries support the standalone page and narrower embedded panels.

The result mat contains the full image rather than cropping it. When the artifact supplies valid measured width and height, the image reserves that aspect ratio and a container-bounded display width before decoding; legacy artifacts without those dimensions keep their dimensions unknown. On desktop it uses a height clamp of `clamp(240px, calc(100dvh - 550px), 560px)` with a minimum height of (240px). Narrow mats use a (4:3) aspect ratio and a minimum height of (220px). Filmstrip and recipe imagery also use (4:3); filmstrip images crop to cover, recipe images contain.

Creation has a centered maximum width of (1120px), with recipe columns changing from four to two at (1000px), then one at (440px). Its footer is static. Choosing a recipe or blank start collapses the chooser and brings the title, optional goal and creation action forward; the gallery can reopen without losing per-recipe drafts. Comparison mode uses a full-width column and a compact stage. Legacy scene structures also retain the (700px) breakpoint.

The spacing vocabulary in frontmatter comes from repeated control gaps, card padding, section separation and page gutters. It records the built rhythm rather than imposing a single arithmetic scale. Coarse-pointer rules raise ordinary button, field, navigation and summary targets to a minimum of (44px); some explicit compact summary overrides remain smaller in the source.

## Elevation & Depth

The lighttable is flat: image mats, borders, surface tone and cobalt outlines establish hierarchy. Primary cards and buttons carry no shadow, selected recipes use an outline, and contextual edit actions and creation controls are static with no shadow. The utility menu uses a border and stacking order rather than a drop shadow. A legacy editor action bar still has a subtle upward shadow outside the contextual-pane override; it is a limited implementation remnant rather than a new elevation scale.

**The Flat Lighttable Rule.** Keep the primary stage and contextual tool sections flat; use tonal fills, thin borders and explicit selection outlines to establish hierarchy.

## Shapes

Controls and result mats have gently curved corners using `control`; standalone cards, recipe cards and the utility menu use `surface`. Filmstrip frames and status badges use `frame`; thumbnail images use `image`. Chips retain the slightly softer `chip` corner. Contextual sections and active task underlines are square. Borders are generally (1px), with a (2px) task underline, selected recipe outline and focus outline. Focus is offset by (3px); selected recipe outline by (2px). Progress bars retain their narrow capsule silhouette.

## Components

### Buttons

Compact, direct text controls. Secondary actions use the fill surface, a plane-edge border and principal text with the `button-secondary` padding. Primary actions use cobalt, theme-specific action ink and weight (650), retaining their resting accent background and action ink on hover. Danger actions retain the secondary surface with error text. Minimum height is (36px). Active actions reduce brightness to (.95); disabled actions use opacity (.48) and the unavailable cursor. Secondary hover shifts to cobalt wash and cobalt border. Buttons transition background and border over (180ms) with `ease-out`. All interactive elements use the shared visible-focus outline.

### Chips and Status Badges

Chips are compact borderless text actions, with fill-tone hover and stronger text. Badges are compact outlined status labels; semantic variants use their status color for text and border. Badges communicate saved, pending, warning and result state, and are not a second navigation system.

### Cards / Containers

Standalone cards use the `card` surface, padding and rounded token, a thin plane edge and no shadow. Nested cards become transparent divider sections. Within the contextual pane, cards are transparent, square sections with a bottom divider, bottom padding and separation of (20px). Recipe cards place their real preview above inset text and action controls; selected recipes gain an accent outline while retaining the surface background.

### Inputs / Fields

Fields use a surface background, stronger field edge, inherited text and the `input` padding, with a minimum height of (38px). Hover uses the muted edge and focus uses the shared accent outline. Invalid fields use error borders and adjacent textual feedback. Disabled fields use fill tone, opacity (.55) and the unavailable cursor. Technical textareas use mono type and overflow handling. Keep ordinary inputs and optional intent text distinct from executable actions.

### Navigation

Four primary task destinations share a compact underline navigation. Versions and QA sit in a secondary group with smaller muted text. Active destination uses cobalt text, a cobalt bottom border and weight (650); hover uses the fill tone. Disabled destinations retain their labels at opacity (.42). On narrow surfaces, navigation can scroll while both groups remain available. The first destination reads as Start when creating and Brief when a current work's brief is shown; New Work remains a separate header action.

### Saved-Result Filmstrip

A maximum of six recent results use a compact (4:3) contact sheet. Each frame includes a revision caption, and the current revision has its own marker. Selected frames use an accent border and text with a surface background; hover uses the surface background. Selection transitions only border and background over (180ms) with `ease-out`. The main result keeps its image, source caption and image download bound to the selected saved artifact; historical work exposes appropriate comparison and export routes.

### Disclosure and Utility Menu

Native details/summary controls reveal technical evidence, photography, assets, inspection and advanced tools in place. The shared component stores state under stable store/project/new-work/global scopes, adding result or recipe identity as appropriate. Summary identity preserves focus across refreshes. The utility menu is an anchored (240px) bordered surface with internal padding of (16px). Reduced-motion preference removes transitions and smooth scrolling throughout the workbench; there is no entrance choreography.

### Explicit Destinations and Feedback

Following a creation-guide action opens its target disclosure. Choosing Parts opens the scene outline; Materials and Lighting opens the outline, photography and assets; choosing a new starting point reopens the recipe gallery. Selecting a scene camera or light opens photography. Opening form or detail inspection from a historical result returns to the current revision's inspection context without submitting edits or starting a render. Other scoped disclosure choices remain intact.

Selecting an existing project keeps that project's identity visible while its saved source and preview load. The project selector reflects the pending choice, the body exposes a busy loading state, and editing remains disabled until the complete source is adopted. The waiting state displays neither the previous project's image nor a new-work form.

A creation confirmation on the Brief view belongs only to the selected project, including creation without an automatic preview. Scene save feedback sits outside the object editor and advanced patch disclosure, so one visible message remains available even when no object is selected and every tool section is closed. A collapsed tool must not hide the outcome of an explicit action.

These interaction rules follow [D294](deepblend/docs/architecture-decisions.md); separate browser and release verification is recorded in [the milestone register](deepblend/docs/milestone-status.md).

## Do's and Don'ts

### Do:
- **Do** use the theme-specific accent for selection, focus and primary action.
- **Do** retain source captions, selected/current distinction and explicit empty or unsupported states.
- **Do** keep the current result contained within its mat and use cropped thumbnails only in the filmstrip.
- **Do** preserve keyboard focus, scoped disclosure state, reduced motion and larger coarse-pointer targets.
- **Do** keep creation controls reachable after choosing a recipe or blank start, while preserving per-recipe drafts.

### Don't:
- **Don't** replace user-selected light, dark or system appearance with a fixed palette.
- **Don't** introduce decorative entrance choreography into the lighttable.
- **Don't** present an optional project goal as an executable model-generation endpoint.
- **Don't** detach download or export controls from their actual image, project and saved revision.

Not canonized: compact summary overrides, tiny legal/missing-image captions and legacy editor shadows are recorded as implementation limits, not promoted into the general scale. This document records the current artifact and does not assert full release-test completion or artistic approval.
