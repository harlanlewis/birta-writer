/**
 * The panel's output, read by a real YAML parser.
 *
 * Every other suite here asks whether the panel's own parser agrees with the
 * panel's own writer, which is a question they can agree on while both being
 * wrong: `parseTabularFrontmatter` splits a line on its FIRST colon and keeps
 * the rest verbatim, so it read `note: Note: see below` back as the string it
 * meant while js-yaml refused the block outright (MAR-455).
 *
 * js-yaml is a dev-only dependency and exists for exactly this: an oracle the
 * editor did not write. The invariant is the one a reader cares about, not a
 * spelling: whatever the panel commits must PARSE, and must yield the value
 * the user typed. How it spells that value is the writer's business.
 */
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { parseTabularFrontmatter, serializeFrontmatter } from "../components/frontmatter";

/** Values a user can type into a cell that YAML does not read back as itself. */
const HOSTILE = [
    "Note: see below",
    "ratio: 3",
    "trailing:",
    "a: b: c",
    "#hash-first",
    "value # trailing",
    "- leading dash",
    "? leading question",
    ": leading colon",
    "{not a map",
    "[not a seq",
    "*anchor",
    "&anchor",
    "|block",
    ">folded",
    "@reserved",
    "`backtick",
    "%directive",
    '"unbalanced',
    "'unbalanced",
    // Quoted at both ends and broken in between: the shape every "starts and
    // ends with the same quote" check in this file reads as already quoted.
    '"abc"def"',
    "'abc'def'",
    '"trailing\\"',
    "yes",
    "null",
    "2026-01-01",
    "plain value",
    "a, b",
    "jane@example.com",
    "https://example.com/a:b",
    "team:ga4-docs",
    // A hash with no space before it is an ordinary character in YAML, and is
    // the one thing our own flow splitter refuses to scan past.
    "issue#12",
    "a#b",
];

/** The value YAML reads back for `key`, or the parse error. */
function readBack(block: string, key: string): unknown {
    const inner = block.replace(/^---\n/, "").replace(/\n---\n?$/, "\n");
    return (load(inner) as Record<string, unknown>)[key];
}

describe("what the metadata panel commits, read by js-yaml", () => {
    describe("a flat scalar", () => {
        it.each(HOSTILE)("typing %j into a value should parse and read back as itself", (typed) => {
            const raw = "---\nnote: a\nkeep: untouched\n---\n";
            const entries = parseTabularFrontmatter(raw)!;
            entries[0]!.value = typed;

            const out = serializeFrontmatter(entries, raw);

            expect(() => readBack(out, "note")).not.toThrow();
            expect(String(readBack(out, "note"))).toBe(typed);
            expect(readBack(out, "keep")).toBe("untouched");
        });
    });

    describe("a nested leaf", () => {
        it.each(HOSTILE)("typing %j into a block leaf should parse and read back as itself", (typed) => {
            const raw = "---\nsources:\n  - id: a\n    note: b\n---\n";
            const entries = parseTabularFrontmatter(raw)!;
            entries[0]!.nested!.items[0]!.leaves[1]!.value = typed;

            const out = serializeFrontmatter(entries, raw);

            expect(() => readBack(out, "sources")).not.toThrow();
            const sources = readBack(out, "sources") as { id: string; note: unknown }[];
            expect(sources[0]!.id).toBe("a");
            expect(String(sources[0]!.note)).toBe(typed);
        });
    });

    // A flow leaf shares one line with its siblings, where a comma or a
    // bracket ends the value wherever it sits rather than only at the front.
    // The sibling matters as much as the value: a value cut short also invents
    // a key out of its own tail, so `from` is asserted every time.
    describe("a flow leaf", () => {
        it.each(HOSTILE)("typing %j into a flow leaf should parse and read back as itself", (typed) => {
            const raw = "---\nwindow: { from: x, to: y }\n---\n";
            const entries = parseTabularFrontmatter(raw)!;
            entries[0]!.nested!.items[0]!.leaves[1]!.value = typed;

            const out = serializeFrontmatter(entries, raw);

            expect(() => readBack(out, "window")).not.toThrow();
            const window = readBack(out, "window") as Record<string, unknown>;
            expect(window['from']).toBe("x");
            expect(String(window['to'])).toBe(typed);
            expect(Object.keys(window)).toEqual(["from", "to"]);
        });
    });

    // The panel is lossless first: an untouched block must reach js-yaml as
    // the bytes it came in as, so nothing above can be bought with a rewrite.
    it("an untouched block should reach the parser unchanged", () => {
        const raw = "---\ntitle: \"Hello\"\ntags:\n  - one\nsources:\n  - id: a\n"
            + "window: { from: x, to: y }\nexecutor:\n  resource: r\n---\n";

        expect(serializeFrontmatter(parseTabularFrontmatter(raw)!, raw)).toBe(raw);
        expect(() => readBack(raw, "title")).not.toThrow();
    });
});
