# Changelog

## 0.3.0

- Three colour schemes, picked with **Farben** in the pane's head: *Ruhig* (default; neutral grey
  frames, only *Wartet auf dich* in Claude orange), *Ampel* (colour only for urgency) and *Flächen*
  (tinted cards instead of coloured frames). The choice is kept in the plugin's store and applies to
  every session; an unknown stored value falls back to *Ruhig*.
- Better contrast: secondary text (folder, time, "Stand", counts, open items, steps) no longer uses the
  faint `subtle` grey; "jetzt" is drawn in the text colour, the accent stays on the dot before it.
- The bucket colours moved from the bucket list into the palettes (`hooks/palettes.ts`).

## 0.2.0

First public version.

- One pane design; the design picker and the classic fallback are gone. If drawing the pane fails, it
  shows an error line instead.
- The classification script ships inside the plugin (`scripts/session-monitor.mjs`) and is found through
  the plugin's own folder; no fixed path.
- Opening a session goes through the script (`--open <id>`), which hands the deep link to the platform's
  URL handler (Windows, macOS, Linux) without a shell.
- Project names are shown relative to any folder named `Projects`, otherwise as the last folder name.

## 0.1.0

- Sessions pane with buckets, clickable cards, pause/finish marks and sub-session origin.
