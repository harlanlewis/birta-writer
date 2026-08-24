/**
 * What the browser actually receives when the editor opens a link.
 *
 * Found while wiring `/help` (MAR-395): the webview's `openUrl` handler parsed
 * the URL into a `Uri` before handing it over, which is the one thing that
 * cannot carry a percent-escape. The feedback command had already met this and
 * routed around it with a string, and its own tests model the hop; nothing
 * pinned the general link path, so every document link with an escape in it
 * had been opening at a corrupted address.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { openExternalUrl } from "../utils/openExternalUrl";

const openExternal = vscode.env.openExternal as unknown as ReturnType<typeof vi.fn>;

/**
 * VS Code's `_doOpenExternal`, verified against the shipped 1.130 bundle:
 *
 *     if (typeof i === "string" && t.toString() === o.toString()) n = i;
 *     else n = encodeURI(o.toString(!0));
 *
 * A string is opened verbatim; a `Uri` is re-rendered through `encodeURI`,
 * which escapes `%`. Asserting on what we HANDED the opener would pass either
 * way, which is exactly how the defect survived: this function is what makes
 * the assertion about what the browser sees.
 */
function asOpenerSends(target: unknown): string {
    return typeof target === "string"
        ? target
        : encodeURI((target as { toString(skip: boolean): string }).toString(true));
}

describe("opening an external URL", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    /**
     * The invariant, which holds regardless of what anyone expects the
     * encoding to look like: what was asked for is what arrives.
     */
    it.each([
        ["a percent-escaped path", "https://en.wikipedia.org/wiki/C%2B%2B"],
        ["an escaped space", "https://example.com/a%20b"],
        ["a prefilled query", "https://github.com/o/r/issues/new?title=Bug%3A%20hi&body=%23%20x"],
        ["a mailto draft", "mailto:a@b.c?subject=Bug%3A%20hi&body=line%0Aline"],
        ["a plain URL with nothing to escape", "https://example.com/plain"],
    ])("%s should reach the browser exactly as composed", async (_name, url) => {
        await openExternalUrl(url);

        expect(asOpenerSends(openExternal.mock.calls[0][0])).toBe(url);
    });

    /**
     * The control arm, and the reason the suite above is not decoration: the
     * `Uri` route this replaced does not round-trip, so the tests
     * discriminate between the two implementations rather than passing under
     * either. Without this, every case above would pass on the broken code as
     * happily as on the fixed one.
     *
     * The claim is deliberately "does not survive" rather than "is doubly
     * escaped". Real VS Code corrupts it by `encodeURI` escaping the `%`, and
     * `__mocks__/vscode.ts`'s stand-in `Uri` corrupts it by decoding the
     * escape instead. The MECHANISMS differ, so asserting the real one here
     * would be asserting something this instrument cannot see; the failure is
     * the same on both, and the failure is what the product cares about.
     */
    it("the Uri route it replaced should not survive the trip, which is why it was replaced", () => {
        const url = "https://en.wikipedia.org/wiki/C%2B%2B";

        expect(asOpenerSends(vscode.Uri.parse(url))).not.toBe(url);
    });
});
