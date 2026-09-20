/**
 * The OKF provenance reader, over entries the PANEL's own parser produced.
 *
 * Every case below starts from a fenced block and goes through
 * `parseTabularFrontmatter`, never from a hand-written `FmEntry`. A literal
 * built here could not carry the shapes this reader turns on (a `verified`
 * spelled as a sequence, as a flow mapping and as a nested mapping all arrive
 * as different `nested.kind` values), so a reader that handled only one of
 * them would pass a suite that declared its own entries.
 */
import { describe, expect, it } from "vitest";
import { parseTabularFrontmatter } from "../frontmatterTable";
import { okfStaleSince, readOkfProvenance } from "../okf";
import type { OkfProvenance } from "../okf";

/** A block through the panel's parser, which must accept it for a case to mean anything. */
function read(lines: string[]): OkfProvenance | null {
    const raw = ["---", ...lines, "---", ""].join("\n");
    const entries = parseTabularFrontmatter(raw);
    // A block the table refuses reaches the reader as no entries at all, which
    // would make every assertion below pass for the wrong reason.
    expect(entries, `the panel's parser refused: ${raw}`).not.toBeNull();
    return readOkfProvenance(entries!);
}

const MARCH = Date.parse("2026-03-20T00:00:00Z");

describe("readOkfProvenance", () => {
    it("a block with no provenance field should read as no provenance at all", () => {
        expect(read(["title: A note", "tags: [one, two]", "type: reference"])).toBeNull();
    });

    it("no entries at all should read as no provenance", () => {
        // The panel's own state for a document whose block is empty: it never
        // goes through the parser, so this one is asked of the reader direct.
        expect(readOkfProvenance([])).toBeNull();
    });

    it("a recognized status should be read", () => {
        expect(read(["status: draft"])?.status).toBe("draft");
        expect(read(["status: stable"])?.status).toBe("stable");
        expect(read(["status: deprecated"])?.status).toBe("deprecated");
    });

    it("a status outside the spec's three should not be read", () => {
        expect(read(["status: wip", "generated:", "  by: human:me"])?.status).toBeNull();
    });

    it("a status outside the three and nothing else should read as no provenance", () => {
        expect(read(["status: wip"])).toBeNull();
    });

    it("a quoted status should be read through its quotes", () => {
        expect(read(['status: "draft"'])?.status).toBe("draft");
    });

    it("stale_after should be kept exactly as the file spells it", () => {
        expect(read(["stale_after: 2026-03-12T00:00:00Z"])?.staleAfter).toBe("2026-03-12T00:00:00Z");
    });

    it("generated with no verified should read as unverified", () => {
        expect(read(["generated:", "  by: gemini/2.5-pro", "  at: 2026-02-01T09:00:00Z"])?.trust)
            .toBe("unverified");
    });

    it("a block with neither generated nor verified should have no trust tier", () => {
        expect(read(["status: draft"])?.trust).toBeNull();
    });

    it("a verified sequence carrying a human actor should read as human", () => {
        expect(read([
            "generated:",
            "  by: gemini/2.5-pro",
            "verified:",
            "  - { by: process:nightly, at: 2026-02-11T02:00:00Z }",
            "  - { by: human:ahormati, at: 2026-02-10T09:00:00Z }",
        ])?.trust).toBe("human");
    });

    it("a verified sequence of machine actors alone should read as machine", () => {
        expect(read([
            "verified:",
            "  - { by: process:nightly, at: 2026-02-11T02:00:00Z }",
            "  - { by: gemini/2.5-pro, at: 2026-02-11T03:00:00Z }",
        ])?.trust).toBe("machine");
    });

    it("a team actor should be machine rather than human, the prefix being the whole test", () => {
        expect(read(["verified:", "  - { by: team:ga4-docs, at: 2026-02-11T02:00:00Z }"])?.trust)
            .toBe("machine");
    });

    it("a single verified mapping rather than a list should read the same way", () => {
        expect(read(["verified:", "  by: human:ahormati", "  at: 2026-02-10T09:00:00Z"])?.trust)
            .toBe("human");
    });

    it("a one-line flow verified should read the same way", () => {
        expect(read(['verified: { by: "human:ahormati", at: 2026-02-10T09:00:00Z }'])?.trust)
            .toBe("human");
    });

    it("a verified block naming no actor should confirm nothing", () => {
        expect(read(["verified:", "  at: 2026-02-10T09:00:00Z"])?.trust).toBe("unverified");
    });

    it("a field no version of the spec defines should be ignored rather than rejected", () => {
        const provenance = read(["not_in_the_spec: whatever", "status: stable"]);
        expect(provenance?.status).toBe("stable");
    });

    it("provenance without the spec's one required field should still be read", () => {
        // `type` is required of an OKF document and is not this reader's gate:
        // a note that says where it came from has said something either way.
        expect(read(["generated:", "  by: gemini/2.5-pro"])?.trust).toBe("unverified");
    });
});

describe("okfStaleSince", () => {
    const at = (staleAfter: string | null): OkfProvenance =>
        ({ status: null, staleAfter, trust: null });

    it("a deadline in the past should give back its calendar day", () => {
        expect(okfStaleSince(at("2026-03-12T00:00:00Z"), MARCH)).toBe("2026-03-12");
    });

    it("a deadline still ahead should give nothing", () => {
        expect(okfStaleSince(at("2026-09-12T00:00:00Z"), MARCH)).toBeNull();
    });

    it("a deadline at this very moment should be the last moment still fresh", () => {
        expect(okfStaleSince(at("2026-03-20T00:00:00Z"), MARCH)).toBeNull();
    });

    it("a deadline one millisecond back should have passed", () => {
        expect(okfStaleSince(at("2026-03-20T00:00:00Z"), MARCH + 1)).toBe("2026-03-20");
    });

    it("an absent deadline should give nothing", () => {
        expect(okfStaleSince(at(null), MARCH)).toBeNull();
    });

    it("a deadline the platform cannot read should give nothing rather than throw", () => {
        expect(okfStaleSince(at("whenever"), MARCH)).toBeNull();
    });

    it("a past deadline not spelled as a calendar date should come back whole", () => {
        // Truncating to ten characters is right only where a date opens the
        // value; anything else would be quoted back as a fragment of a word.
        expect(okfStaleSince(at("01 Jan 2026 00:00:00 GMT"), MARCH)).toBe("01 Jan 2026 00:00:00 GMT");
    });

    it("a bare calendar day in the past should give back that day", () => {
        expect(okfStaleSince(at("2026-03-12"), MARCH)).toBe("2026-03-12");
    });
});
