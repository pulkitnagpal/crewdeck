---
description: Crewdeck's look for SilverBullet.
tags: meta/theme
displayName: Crewdeck
scheme: light
fonts:
  ui: Inter
  editor: Inter
  editorSize: 16
counterpart: "[[Library/Crewdeck/Theme Dark]]"
---
The Crewdeck theme. Pick it under Configuration → Appearance → Theme (or run "Theme: Select").

```space-style
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Newsreader:opsz,wght@6..72,500;6..72,600&display=swap");
html {
  --root-background-color: #FBFAF7;
  --root-color: #1C1B19;
  --subtle-color: #8A857B;
  --subtle-background-color: rgba(28, 27, 25, 0.06);
  --ui-surface-border-color: #E7E3DA;
  --ui-accent-color: #3550D6;
  --ui-accent-contrast-color: #FFFFFF;
  --link-color: #3550D6;
  --link-missing-color: #B5651D;
  --top-background-color: #F3F1EC;
  --top-border-color: #E7E3DA;
  --panel-background-color: #F6F5F1;
  --editor-font: Inter, -apple-system, system-ui, sans-serif;
  --ui-font: Inter, -apple-system, system-ui, sans-serif;
}
#sb-main .cm-editor .sb-line-h1, #sb-main .cm-editor .sb-line-h2 { font-family: "Newsreader", Georgia, serif; letter-spacing: -0.01em; }
#sb-top { border-bottom: 1px solid #E7E3DA; }
```
