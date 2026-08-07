/**
 * The PlantUML theming preamble and its bookkeeping.
 *
 * The interesting cases here are not "does it prepend text" but the two
 * constraints that were found empirically against the real engine and that a
 * refactor could silently break:
 *
 *  - a `@startjson` / `@startyaml` body is DATA, so injecting a skinparam line
 *    turns a valid diagram into a parse error;
 *  - the preamble shifts every line number the engine reports, so an error
 *    message must be shifted back before a user reads it.
 */
import { describe, it, expect } from "vitest";
import {
    applyPlantUmlTheme,
    plantUmlBodyIsData,
    plantUmlDirective,
    unshiftPlantUmlErrorLines,
    type PlantUmlPalette,
} from "../components/codeBlock/plantUmlTheme";

const PALETTE: PlantUmlPalette = {
    foreground: "#d4d4d4",
    elementBackground: "#2d2d30",
    border: "#6e7681",
};

describe("plantUmlDirective", () => {
    it("a source opening with @startuml should report uml", () => {
        expect(plantUmlDirective("@startuml\nA -> B\n@enduml")).toBe("uml");
    });

    it("a non-uml opening directive should report its own word, lowercased", () => {
        expect(plantUmlDirective("@startMindmap\n* a\n@endmindmap")).toBe("mindmap");
    });

    it("leading whitespace before the directive should still be recognised", () => {
        expect(plantUmlDirective("\n  @startgantt\n[A] lasts 1 day\n@endgantt")).toBe("gantt");
    });

    it("a source with no opening directive should report null", () => {
        expect(plantUmlDirective("Alice -> Bob : hi")).toBeNull();
    });
});

describe("plantUmlBodyIsData", () => {
    it("a @startjson block should be reported as a data body", () => {
        expect(plantUmlBodyIsData('@startjson\n{"a": 1}\n@endjson')).toBe(true);
    });

    it("a @startyaml block should be reported as a data body", () => {
        expect(plantUmlBodyIsData("@startyaml\na: 1\n@endyaml")).toBe(true);
    });

    it("an ordinary @startuml block should not be reported as a data body", () => {
        expect(plantUmlBodyIsData("@startuml\nA -> B\n@enduml")).toBe(false);
    });
});

describe("applyPlantUmlTheme", () => {
    it("a null palette (light mode) should return the source byte-identical", () => {
        const src = "@startuml\nAlice -> Bob : hi\n@enduml";
        const out = applyPlantUmlTheme(src, null);
        expect(out.source).toBe(src);
        expect(out.addedLines).toBe(0);
    });

    it("a dark palette should insert the preamble AFTER the opening directive", () => {
        const src = "@startuml\nAlice -> Bob : hi\n@enduml";
        const out = applyPlantUmlTheme(src, PALETTE);
        const lines = out.source.split("\n");
        expect(lines[0]).toBe("@startuml");
        expect(lines[1]).toBe("skinparam backgroundColor transparent");
        // The user's own content survives, and the directive stays line 1.
        expect(out.source).toContain("Alice -> Bob : hi");
        expect(out.addedLines).toBeGreaterThan(0);
    });

    it("the reported addedLines should match the lines actually inserted", () => {
        const src = "@startuml\nA -> B\n@enduml";
        const out = applyPlantUmlTheme(src, PALETTE);
        const before = src.split("\n").length;
        const after = out.source.split("\n").length;
        expect(after - before).toBe(out.addedLines);
    });

    it("the palette colours should reach the emitted skinparams", () => {
        const out = applyPlantUmlTheme("@startuml\nA -> B\n@enduml", PALETTE);
        expect(out.source).toContain(`skinparam defaultFontColor ${PALETTE.foreground}`);
        expect(out.source).toContain(`skinparam BackgroundColor ${PALETTE.elementBackground}`);
        expect(out.source).toContain(`skinparam BorderColor ${PALETTE.border}`);
    });

    it("a data-body diagram should be left untouched even in dark mode", () => {
        // Regression: a skinparam line inside @startjson is parsed as JSON and
        // fails the whole render. Verified against the engine.
        const src = '@startjson\n{"a": 1}\n@endjson';
        const out = applyPlantUmlTheme(src, PALETTE);
        expect(out.source).toBe(src);
        expect(out.addedLines).toBe(0);
        expect(out.source).not.toContain("skinparam");
    });

    it("a source with no opening directive should be wrapped so the preamble applies", () => {
        const out = applyPlantUmlTheme("Alice -> Bob : hi", PALETTE);
        expect(out.source.startsWith("@startuml\n")).toBe(true);
        expect(out.source.trimEnd().endsWith("@enduml")).toBe(true);
        expect(out.source).toContain("Alice -> Bob : hi");
        // The synthesized @startuml counts too, or error lines drift by one.
        const added = out.source.split("\n").length - "Alice -> Bob : hi".split("\n").length;
        expect(out.addedLines).toBe(added - 1); // trailing @enduml is not a shift
    });

    it("a CRLF source should still place the preamble after the directive line", () => {
        const out = applyPlantUmlTheme("@startuml\r\nA -> B\r\n@enduml", PALETTE);
        expect(out.source.split(/\r?\n/)[0]).toBe("@startuml");
        expect(out.source.split(/\r?\n/)[1]).toBe("skinparam backgroundColor transparent");
    });
});

describe("unshiftPlantUmlErrorLines", () => {
    it("no injected lines should leave the message untouched", () => {
        expect(unshiftPlantUmlErrorLines("Parse error at line 4:2", 0)).toBe("Parse error at line 4:2");
    });

    it("an injected preamble should shift a reported line back onto the user's numbering", () => {
        expect(unshiftPlantUmlErrorLines("Parse error at line 15:2", 13)).toBe("Parse error at line 2:2");
    });

    it("a line reference inside the preamble should be left alone rather than going negative", () => {
        // Nothing useful to point at: the offending line is one we injected.
        expect(unshiftPlantUmlErrorLines("error at line 3", 13)).toBe("error at line 3");
    });

    it("every line reference in a multi-reference message should be shifted", () => {
        expect(unshiftPlantUmlErrorLines("line 20 conflicts with line 30", 10))
            .toBe("line 10 conflicts with line 20");
    });

    it("a message with no line reference should pass through unchanged", () => {
        const msg = "IO error: remote fetch disabled (feature = \"remote\")";
        expect(unshiftPlantUmlErrorLines(msg, 13)).toBe(msg);
    });
});
