import { describe, it, expect } from "vitest";
import {
    composeFeedback,
    describeChangedSettings,
    formatDiagnostics,
    isReportableValue,
    type Diagnostics,
} from "../feedback/compose";

const diagnostics: Diagnostics = {
    extensionVersion: "0.0.0",
    hostVersion: "VS Code 1.99.0",
    platform: "darwin arm64",
    changedSettings: [],
};

describe("isReportableValue", () => {
    it("a boolean or finite number should be reportable", () => {
        expect(isReportableValue(true)).toBe(true);
        expect(isReportableValue(0)).toBe(true);
        expect(isReportableValue(72)).toBe(true);
    });

    it("a non-finite number should not be reportable", () => {
        expect(isReportableValue(Number.NaN)).toBe(false);
        expect(isReportableValue(Number.POSITIVE_INFINITY)).toBe(false);
    });

    it("an enum-shaped string should be reportable", () => {
        expect(isReportableValue("richText")).toBe(true);
        expect(isReportableValue("always")).toBe(true);
        expect(isReportableValue("wrap-none")).toBe(true);
    });

    it("a string that could carry a path or prose should not be reportable", () => {
        expect(isReportableValue("/Users/someone/notes/theme.css")).toBe(false);
        expect(isReportableValue("C:\\work\\client-secret.css")).toBe(false);
        expect(isReportableValue("Helvetica Neue, sans-serif")).toBe(false);
        expect(isReportableValue("a".repeat(25))).toBe(false);
        expect(isReportableValue("")).toBe(false);
        // Leading non-letter: a value that starts with a digit or symbol is
        // more likely data than an enum member.
        expect(isReportableValue("2024-report")).toBe(false);
    });

    it("an object or null should not be reportable", () => {
        expect(isReportableValue({ a: 1 })).toBe(false);
        expect(isReportableValue(null)).toBe(false);
        expect(isReportableValue(undefined)).toBe(false);
    });
});

describe("describeChangedSettings", () => {
    it("a setting at its default should be omitted", () => {
        const lines = describeChangedSettings(
            { "birta.copyFormat": "markdown" },
            { "birta.copyFormat": "markdown" },
        );
        expect(lines).toEqual([]);
    });

    it("a changed enum setting should report its value", () => {
        const lines = describeChangedSettings(
            { "birta.copyFormat": "richText" },
            { "birta.copyFormat": "markdown" },
        );
        expect(lines).toEqual(["birta.copyFormat: richText"]);
    });

    it("a changed path-bearing setting should report only that it is customized", () => {
        const lines = describeChangedSettings(
            { "birta.fontFamilySans": "/Users/someone/fonts/Private.otf" },
            { "birta.fontFamilySans": "" },
        );
        expect(lines).toEqual(["birta.fontFamilySans: customized"]);
        expect(lines.join("\n")).not.toContain("someone");
    });

    it("a changed array setting should report only its length", () => {
        const lines = describeChangedSettings(
            { "birta.customCss": ["/home/me/secret/a.css", "/home/me/secret/b.css"] },
            { "birta.customCss": [] },
        );
        expect(lines).toEqual(["birta.customCss: 2 entries"]);
        expect(lines.join("\n")).not.toContain("secret");
    });

    it("a single-entry array should be reported in the singular", () => {
        const lines = describeChangedSettings(
            { "birta.customJs": ["/x/y.js"] },
            { "birta.customJs": [] },
        );
        expect(lines).toEqual(["birta.customJs: 1 entry"]);
    });

    it("multiple changed settings should be ordered by key", () => {
        const lines = describeChangedSettings(
            { "birta.zeta": true, "birta.alpha": false },
            { "birta.zeta": false, "birta.alpha": true },
        );
        expect(lines).toEqual(["birta.alpha: false", "birta.zeta: true"]);
    });

    it("a key absent from the snapshot should count as changed, not crash", () => {
        const lines = describeChangedSettings({}, { "birta.toolbarVisible": true });
        expect(lines).toEqual(["birta.toolbarVisible: customized"]);
    });
});

describe("formatDiagnostics", () => {
    it("no changed settings should say so explicitly", () => {
        expect(formatDiagnostics(diagnostics)).toContain("all birta.* settings at their defaults");
    });

    it("the block should be collapsed so it never dominates the report", () => {
        const block = formatDiagnostics(diagnostics);
        expect(block.startsWith("<details>")).toBe(true);
        expect(block.trimEnd().endsWith("</details>")).toBe(true);
    });
});

describe("composeFeedback", () => {
    it("a report with details should title on the summary and carry the details first", () => {
        const { title, body } = composeFeedback({
            summary: "Moving a list item loses its table",
            details: "Drag the second bullet upward.",
            diagnostics,
        });
        expect(title).toBe("Moving a list item loses its table");
        expect(body.indexOf("Drag the second bullet upward.")).toBeLessThan(
            body.indexOf("<details>"),
        );
    });

    it("a skipped disappointment question should leave no trace in the body", () => {
        const { body } = composeFeedback({
            summary: "Add a thing",
            details: "",
            diagnostics,
        });
        expect(body).not.toContain("no longer use");
    });

    it("an answered disappointment question should record the answer verbatim", () => {
        const { body } = composeFeedback({
            summary: "Hello",
            details: "",
            disappointment: "very",
            diagnostics,
        });
        expect(body).toContain("How would you feel if you could no longer use Birta Writer?");
        expect(body).toContain("Very disappointed");
    });

    it("empty details should produce a placeholder rather than a blank section", () => {
        const { body } = composeFeedback({
            summary: "Hello",
            details: "   ",
            diagnostics,
        });
        expect(body).toContain("_(no further detail given)_");
    });

    it("a summary with surrounding whitespace should be trimmed in the title", () => {
        const { title } = composeFeedback({
            summary: "  spaced  ",
            details: "",
            diagnostics,
        });
        expect(title).toBe("spaced");
    });
});
