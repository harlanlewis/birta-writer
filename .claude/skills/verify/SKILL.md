---
name: verify
description: Drive the real built webview bundle (dist/webview.js) in headless Chromium to verify editor changes end-to-end — use when a change to webview/ needs runtime observation beyond jsdom tests, before committing.
---

# Verifying webview changes at runtime

The user-facing surface is a VS Code custom-editor webview. Launching an
Extension Development Host takes over the user's screen, so verify against
the **real built bundle** in headless Chromium instead: everything except
VS Code's chrome and message host is production code.

## Recipe

1. `pnpm build` — the harness loads `dist/webview.js` + `dist/webview.css`.
2. Create a harness dir (scratchpad), symlink the bundle: `ln -sfn <repo>/dist dist`.
3. Harness `index.html` mirrors the provider template (`src/MarkdownEditorProvider.ts` ~line 885):
   - `<div class="editor-topbar"></div><div id="editor"></div>`
   - Stub **before** the module script:
     ```html
     <script>
       window.__i18n = { translations: {}, isMac: true, toolbar: { placements: {}, order: [] } };
       window.__posted = [];
       window.acquireVsCodeApi = () => ({
         postMessage: (msg) => {
           window.__posted.push(msg);
           if (msg.type === "ready")
             window.postMessage({ type: "init", content: "# Sample\n\ntext\n", syncVersion: 1 }, "*");
         },
         getState: () => undefined, setState: () => {},
       });
     </script>
     <script type="module" src="dist/webview.js"></script>
     ```
   - All `__i18n` reads are optional-chained; the minimal stub boots cleanly.
   - Define a block of `--vscode-*` CSS variables in the harness (dark-theme
     hexes) — outside VS Code they don't exist and menus render transparent.
4. Serve over HTTP (ESM chunks won't load from `file://`):
   `python3 -m http.server 8321` from the harness dir.
5. Playwright: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright` in the
   harness dir — browsers are already cached in `~/Library/Caches/ms-playwright`.
6. Drive with a node script: `page.goto`, `waitForSelector(".milkdown .ProseMirror")`,
   click/`keyboard.type`, screenshot, assert. Outbound messages (autosave
   markdown!) are in `window.__posted` — asserting the serialized `update`
   content is the strongest end-to-end check.

## Gotchas

- Heading NodeViews add chrome text ("#H2" fold labels) — never assert block
  `textContent` equality; assert via `window.__posted` markdown or `includes()`.
- `Meta+ArrowDown` caret navigation is unreliable in headless Chromium; don't
  assume absolute block order after it. Prefer doc-level `includes()` asserts.
- Toolbar/TOC buttons stopPropagation on mousedown — clicks there only reach
  document-level listeners registered in the **capture** phase.
- `page.on("pageerror")` + console-error collection catches boot regressions
  the assertions miss; always include it.

A worked example (slash menu, 25 checks) lived at
`<scratchpad>/harness/drive.js` in the MAR-18 session — grouped-menu render,
aria combobox state, filter/apply/Escape/suppression, outside-click,
viewport-bottom flip.
