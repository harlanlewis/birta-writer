import { afterEach, describe, expect, it } from "vitest";
import {
    hasDocumentBase,
    imageDisplaySrc,
    onDocumentBaseChange,
    resolveAgainstBase,
    setDocumentBase,
} from "../components/imageView/documentBase";

const base = { url: "birta://app/~doc/write/post/", scope: "birta://app/~doc/" };

describe("resolveAgainstBase", () => {
    it("a path beside the note should resolve into the note's folder", () => {
        expect(resolveAgainstBase("shot.webp", base)).toBe("birta://app/~doc/write/post/shot.webp");
    });

    it("a path climbing one folder should keep the climb", () => {
        expect(resolveAgainstBase("../shared/a.png", base)).toBe("birta://app/~doc/write/shared/a.png");
    });

    it("a path climbing out of the scope should resolve to nothing", () => {
        expect(resolveAgainstBase("../../../a.png", base)).toBe("");
        expect(resolveAgainstBase("../../../../../etc/passwd", base)).toBe("");
    });

    it("a path climbing exactly to the scope's top should stay inside it", () => {
        expect(resolveAgainstBase("../../a.png", base)).toBe("birta://app/~doc/a.png");
    });

    it("spaces and non-ASCII names should be percent-encoded, not dropped", () => {
        expect(resolveAgainstBase("my shot ä.png", base)).toBe("birta://app/~doc/write/post/my%20shot%20%C3%A4.png");
    });

    it("absolute, schemed and fragment sources should be left as written", () => {
        for (const src of ["https://x.test/a.png", "data:image/png;base64,AA", "blob:birta://app/1", "/a.png", "#x", "vscode-webview://abc/a.png"]) {
            expect(resolveAgainstBase(src, base)).toBe(src);
        }
    });

    it("an @/ path should resolve from the top of the scope", () => {
        expect(resolveAgainstBase("@/Attachments/a.png", base)).toBe("birta://app/~doc/Attachments/a.png");
        expect(resolveAgainstBase("@/../a.png", base)).toBe("");
    });

    it("with no base every source should be left as written", () => {
        for (const src of ["a.png", "../a.png", "@/a.png", ""]) {
            expect(resolveAgainstBase(src, null)).toBe(src);
        }
    });
});

describe("setDocumentBase", () => {
    afterEach(() => setDocumentBase(null));

    it("an init with no base should leave paths as written, the VS Code case", () => {
        setDocumentBase(undefined);
        expect(hasDocumentBase()).toBe(false);
        expect(imageDisplaySrc("../a.png")).toBe("../a.png");
    });

    it("an init with a base should route relative paths through it", () => {
        setDocumentBase(base);
        expect(hasDocumentBase()).toBe(true);
        expect(imageDisplaySrc("../a.png")).toBe("birta://app/~doc/write/a.png");
    });
});

describe("onDocumentBaseChange", () => {
    afterEach(() => setDocumentBase(null));

    it("a changed base should notify once and a repeated one should not", () => {
        let calls = 0;
        const off = onDocumentBaseChange(() => { calls++; });
        setDocumentBase(base);
        setDocumentBase({ ...base });
        expect(calls).toBe(1);
        setDocumentBase({ url: "birta://app/~doc/archive/", scope: base.scope });
        expect(calls).toBe(2);
        off();
        setDocumentBase(null);
        expect(calls).toBe(2);
    });
});
