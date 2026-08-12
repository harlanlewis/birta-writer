/**
 * Drift guard for RELEASES_URL (MAR-356).
 *
 * The gear menu's What's New row opens a hardcoded URL, because the webview
 * cannot read package.json at runtime. Nothing else ties that string to the
 * repository we actually publish from, so a repository move that updates the
 * manifest would leave the row pointing at the old one, silently and forever:
 * the URL would still resolve, and GitHub would still render a releases page.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { RELEASES_URL } from "../product";

const pkg = JSON.parse(
    fs.readFileSync(path.join(path.resolve(__dirname, "../.."), "package.json"), "utf8"),
);

describe("RELEASES_URL", () => {
    it("should be the releases page of package.json's repository", () => {
        const repo: string = pkg.repository.url.replace(/\.git$/, "");
        expect(RELEASES_URL).toBe(`${repo}/releases`);
    });

    it("should be an https URL, so the host's scheme allowlist admits it", () => {
        // isSafeExternalUrl (src/MarkdownEditorProvider.ts) is what the openUrl
        // handler consults; anything but http/https/mailto is dropped silently,
        // which would make the row a no-op with no error anywhere.
        expect(new URL(RELEASES_URL).protocol).toBe("https:");
    });

    it("should carry no query string, so openExternal's percent-escaping cannot corrupt it", () => {
        // env.openExternal round-trips through encodeURI, which escapes `%`
        // (see src/feedback/sendFeedback.ts). A URL with no `?` and no percent
        // escape survives that hop unchanged.
        const url = new URL(RELEASES_URL);
        expect(url.search).toBe("");
        expect(RELEASES_URL).not.toContain("%");
    });
});
