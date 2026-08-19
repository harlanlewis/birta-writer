/**
 * shared/diffMessages.ts - the protocol for the rendered-diff panel (MAR-55).
 *
 * Deliberately NOT part of `shared/messages.ts`. That union is the editor's
 * protocol, spoken by the custom editor's webview; the diff panel is a
 * different page (dist/diffView.js) with a different view type and four
 * messages. Folding four members into a ~60-member union would make every
 * editor-side exhaustive switch carry cases it can never receive, and the
 * webview mirror (webview/messaging.ts) would gain handlers for a page it does
 * not run in. Two protocols, two files.
 *
 * The extension side sends these through `postToDiffView`
 * (src/webviewMessaging.ts), which is what keeps the payloads compile-checked
 * - see the guard in src/__tests__/typedWebviewSends.test.ts.
 */

/**
 * Where the left-hand side of the comparison came from.
 *
 * `untracked` is not an error: a file git has never seen has an empty base, so
 * the whole document reads as inserted. The panel says which one it is,
 * because "everything is new" and "nothing changed" look alike to a reader
 * who does not know whether the file is tracked.
 */
export type DiffBaseOrigin = "head" | "untracked";

/** Extension → diff panel. */
export type ToDiffViewMessage =
    /**
     * The pair to render, and the only message that carries content. Sent once
     * in answer to `diffReady` and again on every refresh, so the panel's
     * render path is the same on first paint and on update.
     */
    | {
          type: "diffContent";
          /** The file's content at HEAD; "" when `baseOrigin` is "untracked". */
          base: string;
          /** The file's live content: the open buffer when there is one, disk otherwise. */
          working: string;
          /** Workspace-relative path, for the panel's header. */
          label: string;
          baseOrigin: DiffBaseOrigin;
      }
    /** The comparison could not be made (no repository, git unavailable). */
    | { type: "diffUnavailable"; reason: string };

/** Diff panel → extension. */
export type FromDiffViewMessage =
    /** The page's script has loaded and is ready for `diffContent`. */
    | { type: "diffReady" }
    /** Rendering threw; the extension surfaces it rather than leaving a blank panel. */
    | { type: "diffFailed"; message: string };
