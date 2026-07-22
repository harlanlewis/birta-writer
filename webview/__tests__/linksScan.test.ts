import { describe, it, expect } from "vitest";
import { Schema } from "../pm";
import { scanLinks } from "../links/scan";

/**
 * The Links scanner: classify by destination, merge contiguous link runs,
 * resolve reference links, and read wikilink nodes. Node/mark names match the
 * real schema (wiki_link, link, link_ref, link_definition).
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
        expect(scanLinks(doc).map((l) => l.kind)).toEqual(["web", "email", "local", "anchor"]);
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

    it("reads a wikilink node's alias and target", () => {
        const doc = schema.node("doc", null, [p(schema.node("wiki_link", { raw: "README|the readme" }))]);
        const [link] = scanLinks(doc);
        expect(link!.kind).toBe("wikilink");
        expect(link!.text).toBe("the readme");
        expect(link!.href).toBe("README");
    });

    it("returns links in document order", () => {
        const doc = schema.node("doc", null, [p(linked("a", "/a")), p(linked("b", "https://b.com"))]);
        const froms = scanLinks(doc).map((l) => l.from);
        expect([...froms]).toEqual([...froms].sort((x, y) => x - y));
    });
});
