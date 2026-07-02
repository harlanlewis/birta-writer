import { describe, it, expect } from "vitest";
import { isSafeExternalUrl } from "../MarkdownEditorProvider";

describe("isSafeExternalUrl", () => {
    it("http/https/mailto links should be allowed", () => {
        expect(isSafeExternalUrl("http://example.com")).toBe(true);
        expect(isSafeExternalUrl("https://example.com/path?q=1")).toBe(true);
        expect(isSafeExternalUrl("HTTPS://Example.com")).toBe(true);
        expect(isSafeExternalUrl("mailto:someone@example.com")).toBe(true);
    });

    it("dangerous schemes like file/vscode/command/javascript should be rejected", () => {
        expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
        expect(isSafeExternalUrl("vscode://ms-vscode.foo")).toBe(false);
        expect(isSafeExternalUrl("command:workbench.action.terminal.new")).toBe(false);
        expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
        expect(isSafeExternalUrl("javascript://%0aalert(1)")).toBe(false);
        expect(isSafeExternalUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    });

    it("malformed or scheme-less input should be rejected without throwing", () => {
        expect(isSafeExternalUrl("")).toBe(false);
        expect(isSafeExternalUrl("not a url")).toBe(false);
        expect(isSafeExternalUrl("//example.com")).toBe(false);
        expect(isSafeExternalUrl("/relative/path")).toBe(false);
    });
});
