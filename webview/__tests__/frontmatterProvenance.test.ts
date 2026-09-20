/**
 * The provenance label: the words it composes, where the panel puts it, and
 * the far more common case of a block that earns none.
 *
 * The composition half takes a clock from the caller, so "stale" is a fact
 * about a fixture rather than about the day the suite runs.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mockVscodeApi } from "./setup";
import { renderFrontmatterPanel, serializeFrontmatter, parseTabularFrontmatter } from "../components/frontmatter";
import { provenanceLabel } from "../components/frontmatter/provenance";
import type { OkfProvenance } from "../../shared/okf";

const MARCH = Date.parse("2026-03-20T00:00:00Z");

/** The full field set, with one field no version of the spec defines. */
const FM_OKF = [
    "---",
    "type: reference",
    "title: GA4 dimension catalogue",
    "tags: [analytics, ga4]",
    "status: stable",
    "stale_after: 2026-03-12T00:00:00Z",
    "generated:",
    "  by: gemini/2.5-pro",
    "  at: 2026-02-01T09:00:00Z",
    "verified:",
    "  - { by: human:ahormati, at: 2026-02-10T09:00:00Z }",
    "sources:",
    "  - id: ga4-schema",
    "    resource: references/ga4.md",
    "not_in_the_spec: kept",
    "---",
    "",
].join("\n");

/** Ordinary frontmatter: the shape most documents carry, and no OKF field in it. */
const FM_PLAIN = "---\ntitle: Hello\ntags:\n- one\n- two\n---\n";

/** A block the table cannot describe, so the raw editor takes it. */
const FM_RAW_OKF = "---\n# where this came from\nstatus: draft\n---\n";

function setupDom(): void {
    document.body.innerHTML = '<div id="container"><div id="editor"></div></div>';
}

function labelText(): string | null {
    return document.querySelector("#frontmatter-panel .fm-provenance")?.textContent ?? null;
}

describe("provenanceLabel", () => {
    const of = (p: Partial<OkfProvenance>): OkfProvenance =>
        ({ status: null, staleAfter: null, trust: null, ...p });

    it("a provenance with nothing to say should give no label", () => {
        expect(provenanceLabel(of({}), MARCH)).toBeNull();
    });

    it("a deadline still ahead should give no label of its own", () => {
        expect(provenanceLabel(of({ staleAfter: "2026-09-12T00:00:00Z" }), MARCH)).toBeNull();
    });

    it("a status should be named in the spec's own word", () => {
        expect(provenanceLabel(of({ status: "deprecated" }), MARCH)).toBe("Deprecated");
    });

    it("each tier should be named for what the signatures are", () => {
        expect(provenanceLabel(of({ trust: "unverified" }), MARCH)).toBe("Unverified");
        expect(provenanceLabel(of({ trust: "machine" }), MARCH)).toBe("Machine-verified");
        expect(provenanceLabel(of({ trust: "human" }), MARCH)).toBe("Human-verified");
    });

    it("a passed deadline should be named with the day the file spells", () => {
        expect(provenanceLabel(of({ staleAfter: "2026-03-12T00:00:00Z" }), MARCH))
            .toBe("Stale since 2026-03-12");
    });

    it("every segment should run from the document's claim to what was derived", () => {
        const text = provenanceLabel(
            of({ status: "stable", trust: "human", staleAfter: "2026-03-12T00:00:00Z" }),
            MARCH,
        );
        expect(text).toBe("Stable · Human-verified · Stale since 2026-03-12");
    });
});

describe("the frontmatter panel's provenance label", () => {
    beforeEach(() => {
        setupDom();
    });

    it("a block carrying provenance should draw a label in the bottom row", () => {
        renderFrontmatterPanel(FM_OKF);
        const label = document.querySelector("#frontmatter-panel .fm-add-row .fm-provenance");
        expect(label).not.toBeNull();
        expect(label!.textContent).toContain("Stable");
        expect(label!.textContent).toContain("Human-verified");
    });

    it("the label should sit after the row's buttons so they never move", () => {
        renderFrontmatterPanel(FM_OKF);
        const row = document.querySelector("#frontmatter-panel .fm-add-row")!;
        const classes = [...row.children].map((el) => el.className);
        expect(classes[classes.length - 1]).toBe("fm-provenance");
        expect(classes[0]).toContain("fm-toggle-btn");
    });

    it("the label should be a label rather than a control", () => {
        renderFrontmatterPanel(FM_OKF);
        const label = document.querySelector("#frontmatter-panel .fm-provenance")!;
        expect(label.tagName).toBe("SPAN");
        expect(label.querySelector("button")).toBeNull();
        expect(label.hasAttribute("tabindex")).toBe(false);
    });

    it("ordinary frontmatter with no OKF field should draw no label", () => {
        renderFrontmatterPanel(FM_PLAIN);
        expect(document.querySelector("#frontmatter-panel")).not.toBeNull();
        expect(labelText()).toBeNull();
    });

    it("a document with no frontmatter at all should draw no label", () => {
        renderFrontmatterPanel(undefined);
        expect(labelText()).toBeNull();
    });

    it("a block the raw editor takes should draw no label", () => {
        renderFrontmatterPanel(FM_RAW_OKF);
        expect(document.querySelector("#frontmatter-panel .fm-raw-editor")).not.toBeNull();
        expect(labelText()).toBeNull();
    });

    it("drawing the label should leave the block byte-identical", () => {
        renderFrontmatterPanel(FM_OKF);
        expect(labelText()).not.toBeNull();
        const entries = parseTabularFrontmatter(FM_OKF);
        expect(entries).not.toBeNull();
        expect(serializeFrontmatter(entries!, FM_OKF)).toBe(FM_OKF);
    });

    it("rendering a block carrying provenance should post no edit", () => {
        mockVscodeApi.postMessage.mockClear();
        renderFrontmatterPanel(FM_OKF);
        expect(labelText()).not.toBeNull();
        expect(mockVscodeApi.postMessage.mock.calls).toHaveLength(0);
    });
});
