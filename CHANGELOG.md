# Changelog

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
