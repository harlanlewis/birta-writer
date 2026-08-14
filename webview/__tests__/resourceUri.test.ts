import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDocumentResource, resolveResourceUrlsIn } from "../utils/resourceUri";

const DOC_BASE = "https://file+.vscode-resource.vscode-cdn.net/Users/x/notes/";
const ROOT_BASE = "https://file+.vscode-resource.vscode-cdn.net/Users/x/";

function setBases(resourceBaseUri: string, workspaceBaseUri = resourceBaseUri): void {
    window.__i18n = { translations: {}, isMac: false, resourceBaseUri, workspaceBaseUri };
}

/** Parse `html` into a detached container the resolver can walk. */
function fragment(html: string): HTMLElement {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host;
}

describe("resolveDocumentResource", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setBases(DOC_BASE, ROOT_BASE);
    });

    it("a document-relative path should resolve against the document's directory", () => {
        expect(resolveDocumentResource("images/cats.jpeg")).toBe(`${DOC_BASE}images/cats.jpeg`);
    });

    it("a dot-relative path should resolve against the document's directory", () => {
        expect(resolveDocumentResource("./images/cats.jpeg")).toBe(`${DOC_BASE}images/cats.jpeg`);
        expect(resolveDocumentResource("../shared/cats.jpeg")).toBe(`${ROOT_BASE}shared/cats.jpeg`);
    });

    it("the @/ workspace alias should resolve against the workspace root", () => {
        expect(resolveDocumentResource("@/assets/cats.jpeg")).toBe(`${ROOT_BASE}assets/cats.jpeg`);
    });

    it("an absolute URL should be returned unchanged", () => {
        for (const url of [
            "https://example.com/cats.jpeg",
            "http://example.com/cats.jpeg",
            "data:image/png;base64,AAAA",
            "//example.com/cats.jpeg",
            `${DOC_BASE}images/cats.jpeg`,
        ]) {
            expect(resolveDocumentResource(url)).toBe(url);
        }
    });

    it("a fragment or an empty value should be returned unchanged", () => {
        expect(resolveDocumentResource("#anchor")).toBe("#anchor");
        expect(resolveDocumentResource("")).toBe("");
        expect(resolveDocumentResource("   ")).toBe("   ");
    });

    it("no base should leave every url as authored", () => {
        setBases("", "");
        expect(resolveDocumentResource("images/cats.jpeg")).toBe("images/cats.jpeg");
    });

    it("a base carrying a query should keep it on the resolved url", () => {
        setBases("https://host.example/dir/?id=7");
        expect(resolveDocumentResource("cats.jpeg")).toBe("https://host.example/dir/cats.jpeg?id=7");
    });

    it("an authored query should win over the base's", () => {
        setBases("https://host.example/dir/?id=7");
        expect(resolveDocumentResource("cats.jpeg?v=2")).toBe("https://host.example/dir/cats.jpeg?v=2");
    });
});

describe("resolveResourceUrlsIn", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setBases(DOC_BASE, ROOT_BASE);
    });

    it("a relative img src should be rewritten in place", () => {
        const host = fragment(`<figure><img src="images/cats.jpeg" alt="Two cats"><figcaption>A caption</figcaption></figure>`);
        resolveResourceUrlsIn(host);
        expect(host.querySelector("img")!.getAttribute("src")).toBe(`${DOC_BASE}images/cats.jpeg`);
        // Everything else is left exactly as the sanitizer produced it.
        expect(host.querySelector("img")!.getAttribute("alt")).toBe("Two cats");
        expect(host.querySelector("figcaption")!.textContent).toBe("A caption");
    });

    it("a video poster and source src should be rewritten too", () => {
        const host = fragment(`<video poster="stills/first.png"><source src="clips/a.webm" type="video/webm"></video>`);
        resolveResourceUrlsIn(host);
        expect(host.querySelector("video")!.getAttribute("poster")).toBe(`${DOC_BASE}stills/first.png`);
        expect(host.querySelector("source")!.getAttribute("src")).toBe(`${DOC_BASE}clips/a.webm`);
    });

    it("every candidate in a srcset should be rewritten, descriptors kept", () => {
        const host = fragment(`<img srcset="small.png 1x, https://example.com/big.png 2x, @/wide.png 800w" src="small.png">`);
        resolveResourceUrlsIn(host);
        expect(host.querySelector("img")!.getAttribute("srcset")).toBe(
            `${DOC_BASE}small.png 1x, https://example.com/big.png 2x, ${ROOT_BASE}wide.png 800w`,
        );
    });

    it("an absolute src should be left alone", () => {
        const host = fragment(`<img src="https://example.com/cats.jpeg"><img src="data:image/gif;base64,AA">`);
        resolveResourceUrlsIn(host);
        const [remote, inline] = [...host.querySelectorAll("img")];
        expect(remote!.getAttribute("src")).toBe("https://example.com/cats.jpeg");
        expect(inline!.getAttribute("src")).toBe("data:image/gif;base64,AA");
    });

    it("no base should leave the rendered attributes untouched", () => {
        setBases("", "");
        const host = fragment(`<img src="images/cats.jpeg">`);
        resolveResourceUrlsIn(host);
        expect(host.querySelector("img")!.getAttribute("src")).toBe("images/cats.jpeg");
    });
});
