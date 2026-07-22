import { describe, it, expect } from "vitest";
import { Schema } from "../pm";
import { scanLinks, incrementalScanLinks } from "../links/scan";
import { EditorState } from "../pm";
import { vi } from "vitest";

/**
 * The Links scanner: classify by DESTINATION (never syntax), merge contiguous
 * link runs, resolve reference links, and read wikilink nodes. Node/mark names
 * match the real schema (wiki_link, link, link_ref, link_definition).
 */
const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        wiki_link: { group: "inline", inline: true, atom: true, attrs: { raw: { default: "" } } },
        link_definition: { group: "block", atom: true, attrs: { identifier: { default: "" }, url: { default: "" } } },
        text: { group: "inline" },
    },
    marks: {
        link: { attrs: { href: { default: "" } } },
        link_ref: { attrs: { identifier: { default: "" } } },
    },
});

const p = (...content: import("../pm").Node[]) => schema.node("paragraph", null, content);
const linked = (text: string, href: string) => schema.text(text, [schema.mark("link", { href })]);

describe("scanLinks", () => {
    it("classifies inline links by destination", () => {
        const doc = schema.node("doc", null, [
            p(schema.text("see "), linked("home", "https://example.com")),
            p(linked("mail", "mailto:a@b.com")),
            p(linked("readme", "/README")),
            p(linked("top", "#intro")),
        ]);
        expect(scanLinks(doc).map((l) => l.kind)).toEqual(["web", "email", "local", "doc"]);
    });

    it("any URL scheme is an external (web) destination", () => {
        const doc = schema.node("doc", null, [
            p(linked("call", "tel:+15551234")),
            p(linked("vault", "obsidian://open?vault=x")),
        ]);
        expect(scanLinks(doc).map((l) => l.kind)).toEqual(["web", "web"]);
    });

    it("merges a contiguous same-href run into one link", () => {
        const doc = schema.node("doc", null, [
            p(linked("bold", "https://x.com"), linked(" tail", "https://x.com")),
        ]);
        const links = scanLinks(doc);
        expect(links).toHaveLength(1);
        expect(links[0]!.text).toBe("bold tail");
    });

    it("does NOT merge adjacent links with different hrefs", () => {
        const doc = schema.node("doc", null, [
            p(linked("a", "https://a.com"), linked("b", "https://b.com")),
        ]);
        expect(scanLinks(doc)).toHaveLength(2);
    });

    it("resolves a reference link to its definition url", () => {
        const doc = schema.node("doc", null, [
            p(schema.text("spec", [schema.mark("link_ref", { identifier: "spec" })])),
            schema.node("link_definition", { identifier: "spec", url: "https://spec.example" }),
        ]);
        const [link] = scanLinks(doc);
        expect(link!.kind).toBe("web");
        expect(link!.href).toBe("https://spec.example");
    });

    it("a wikilink to a file is a LOCAL destination (syntax never makes a group)", () => {
        const doc = schema.node("doc", null, [p(schema.node("wiki_link", { raw: "README|the readme" }))]);
        const [link] = scanLinks(doc);
        expect(link!.kind).toBe("local");
        expect(link!.text).toBe("the readme");
        expect(link!.href).toBe("README");
        expect(link!.wiki).toBe(true); // syntax kept for open-routing only
    });

    it("a bare [[#heading]] wikilink is an in-document destination", () => {
        const doc = schema.node("doc", null, [p(schema.node("wiki_link", { raw: "#wikilinks" }))]);
        const [link] = scanLinks(doc);
        expect(link!.kind).toBe("doc");
    });

    it("returns links in document order", () => {
        const doc = schema.node("doc", null, [p(linked("a", "/a")), p(linked("b", "https://b.com"))]);
        const froms = scanLinks(doc).map((l) => l.from);
        expect([...froms]).toEqual([...froms].sort((x, y) => x - y));
    });
});

// ── incrementalScanLinks: the per-keystroke fast path ──────────────────────
// Ground truth is the full scan: whatever the fast path returns (when it
// doesn't bail) must equal scanLinks(next).

describe("incrementalScanLinks — oracle equality with a full scan", () => {
    function defsOf(doc: import("../pm").Node): Map<string, string> {
        const defs = new Map<string, string>();
        doc.descendants((n) => {
            if (n.type.name === "link_definition") { defs.set(n.attrs["identifier"] ?? "", n.attrs["url"] ?? ""); }
            return true;
        });
        return defs;
    }
    function edit(doc: import("../pm").Node, build: (s: EditorState) => import("../pm").Transaction) {
        const state = EditorState.create({ doc, schema });
        return { prev: doc, next: state.apply(build(state)).doc };
    }
    function check(prev: import("../pm").Node, next: import("../pm").Node) {
        const inc = incrementalScanLinks(prev, scanLinks(prev), next, defsOf(prev));
        if (inc !== null) { expect(inc).toEqual(scanLinks(next)); }
        return inc;
    }

    it("typing before a link fast-paths and shifts its anchor", () => {
        const doc = schema.node("doc", null, [p(schema.text("plain lead")), p(linked("home", "https://x.com"))]);
        const { prev, next } = edit(doc, (s) => s.tr.insertText("XX", 1));
        const inc = check(prev, next);
        expect(inc).not.toBeNull();
        expect(next.textBetween(inc![0]!.from, inc![0]!.to)).toBe("home");
    });

    it("editing a link's own text fast-paths and agrees with the full scan", () => {
        const doc = schema.node("doc", null, [p(linked("home", "https://x.com"), schema.text(" tail"))]);
        const { prev, next } = edit(doc, (s) => s.tr.insertText("y", 3));
        const inc = check(prev, next);
        expect(inc).not.toBeNull();
        expect(inc![0]!.text).toBe("hoyme");
    });

    it("a reference link in ANOTHER block still resolves via the cached defs", () => {
        const doc = schema.node("doc", null, [
            p(schema.text("lead")),
            p(schema.text("spec", [schema.mark("link_ref", { identifier: "spec" })])),
            schema.node("link_definition", { identifier: "spec", url: "https://spec.example" }),
        ]);
        const { prev, next } = edit(doc, (s) => s.tr.insertText("x", 2)); // edit the lead block
        const inc = check(prev, next);
        expect(inc).not.toBeNull();
        expect(inc!.find((l) => l.text === "spec")!.href).toBe("https://spec.example");
    });

    it("editing INSIDE the block holding a reference link keeps its resolution", () => {
        const doc = schema.node("doc", null, [
            p(schema.text("see "), schema.text("spec", [schema.mark("link_ref", { identifier: "spec" })])),
            schema.node("link_definition", { identifier: "spec", url: "https://spec.example" }),
        ]);
        const { prev, next } = edit(doc, (s) => s.tr.insertText("!", 1));
        const inc = check(prev, next);
        expect(inc).not.toBeNull();
        expect(inc!.find((l) => l.text === "spec")!.kind).toBe("web");
    });

    it("splitting a paragraph BAILS to a full scan", () => {
        const doc = schema.node("doc", null, [p(schema.text("one "), linked("two", "/two"))]);
        const { prev, next } = edit(doc, (s) => s.tr.split(3));
        expect(incrementalScanLinks(prev, scanLinks(prev), next, defsOf(prev))).toBeNull();
    });

    it("the fast path never walks the whole document", () => {
        const doc = schema.node("doc", null, [
            p(schema.text("lead")),
            p(linked("a", "https://a.com")),
            p(schema.node("wiki_link", { raw: "README" })),
        ]);
        const { prev, next } = edit(doc, (s) => s.tr.insertText("z", 1));
        const walk = vi.spyOn(next, "descendants");
        const inc = incrementalScanLinks(prev, scanLinks(prev), next, defsOf(prev));
        expect(inc).not.toBeNull();
        expect(walk).not.toHaveBeenCalled();
    });
});
