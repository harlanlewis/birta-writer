/**
 * components/pathBar/styles.ts
 *
 * The path bar's CSS, injected the first time a bar is drawn rather than
 * shipped in the eager stylesheet, for the reason the file explorer's is
 * (`components/fileExplorer/styles.ts`): esbuild hoists every `.css` reachable
 * from the entry into the render-blocking `webview.css`, lazy chunks included,
 * and only a host that hands the page a path ever draws one.
 *
 * `[hidden]` is honoured once, globally, by `ui/chrome.css`.
 */

const STYLE_ID = "path-bar-styles";

export const PATH_BAR_CSS = `
/* Fixed to the window's foot, under the document column. The content already
   keeps half a viewport of room below its last line and the caret keeps an
   inset larger than this bar off the bottom edge, so nothing it covers is
   anything a reader is looking at. Below every floating surface (menus,
   popups, overlay drawers): it is the window's furniture, not a card. */
.path-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    /* The formatting row's own leading inset (toolbar/dock.css). With the
       segment's padding below matching a bar button's (toolbar.css, .tb-btn),
       the first icon here starts where the row's first control starts its
       content, so the two stand on one vertical line. */
    padding: var(--ui-space-1) var(--ui-space-1) var(--ui-space-2);
    background-color: var(--vscode-editor-background);
    font-size: var(--ui-fs-s);
    color: var(--vscode-descriptionForeground);
    /* Quiet at rest, as the formatting row is; full ink while it is being
       reached for, by pointer or by keyboard. */
    opacity: 0.75;
    transition: opacity 0.12s;

    &:hover,
    &:focus-within {
        opacity: 1;
    }
}

/* Beside a docked side panel, never over it: the same classes and variables
   the formatting row reads, so the two cannot disagree about where a panel
   ends. */
body.files-open .path-bar {
    left: var(--files-reserve, 0px);
}

body.toc-open:not(.toc-right) .path-bar {
    left: calc(var(--files-reserve, 0px) + var(--toc-width, 260px));
}

body.toc-open.toc-right .path-bar {
    right: var(--toc-width, 260px);
}

.path-bar__list {
    display: flex;
    align-items: center;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
}

/* One line, always. A long path gives up the middle folders' names first and
   the file's last, which is the one a reader came to read. */
.path-bar__item {
    display: flex;
    align-items: center;
    min-width: 0;
    flex: 0 1 auto;

    &:last-child {
        flex-shrink: 0.2;
    }
}

.path-bar__segment {
    gap: var(--ui-space-2);
    min-width: 0;
    padding: var(--ui-space-1) var(--ui-space-2);
    font-size: inherit;
    color: inherit;

    &:hover {
        color: var(--vscode-foreground);
    }
}

.path-bar__icon {
    display: inline-flex;
    flex: none;

    & svg {
        width: 14px;
        height: 14px;
    }
}

.path-bar__label {
    /* The primitive sets line-height 1, which with the clip below cuts the
       descenders off a name like "recording". */
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.path-bar__chevron {
    display: inline-flex;
    flex: none;
    margin: 0 var(--ui-space-1);
    opacity: 0.7;

    & svg {
        width: 10px;
        height: 10px;
    }
}
`;

export function ensurePathBarStyles(): void {
    if (document.getElementById(STYLE_ID)) { return; }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = PATH_BAR_CSS;
    document.head.appendChild(style);
}
