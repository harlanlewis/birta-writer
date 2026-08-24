/**
 * src/utils/openExternalUrl.ts
 *
 * Hand a URL to the host's browser with its encoding intact.
 *
 * `env.openExternal` is typed for `Uri`, and a `Uri` is lossy here. The opener
 * renders one as `encodeURI(uri.toString(true))`, and `encodeURI` escapes `%`,
 * so every percent-escape arrives doubled: a link to `…/C%2B%2B` opens
 * `…/C%252B%252B`, and a prefilled form shows the literal text `Bug%3A%20hi`
 * where its title belongs. There is no encoding of the query that survives it,
 * because `%` itself is what gets escaped.
 *
 * A **string** is passed through verbatim, verified across all three hops of
 * VS Code 1.130: `ExtHostWindow.openUri` keeps it as `uriAsString`,
 * `MainThreadWindow.$openUri` prefers it when it round-trips, and
 * `_doOpenExternal` opens it as-is (`typeof i === "string" && … → n = i`).
 * The cast is the price of a public signature narrower than the runtime it
 * fronts. `sendFeedback.test.ts` models that last hop directly, which is the
 * only way to assert what the browser receives rather than what we stored.
 *
 * This is NOT a safety check. Callers gate the URL themselves
 * (`isSafeExternalUrl` for anything arriving from a webview), and VS Code
 * shows its own trusted-domains confirmation on top.
 *
 * **It takes an ALREADY-ENCODED URL, and that is the whole of when to reach
 * for it.** Handed something raw, a filesystem path with a space in it say, it
 * passes the space through and the result is not a URL. For that case the
 * `Uri` route is the correct one and not a bug: `encodeURI` over an unencoded
 * path is exactly right, and it is only over an already-encoded one that it
 * escapes the `%` and doubles everything. `src/htmlExport.ts` opens the file
 * it just wrote and keeps `openExternal(target)` for that reason.
 */
import * as vscode from "vscode";

export function openExternalUrl(url: string): Thenable<boolean> {
    return vscode.env.openExternal(url as unknown as vscode.Uri);
}
