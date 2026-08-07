/**
 * Turning a PlantUML document into a themed one, as pure string work.
 *
 * PlantUML has no built-in dark palette we can switch on. Its `!theme <name>`
 * directive downloads a theme over HTTP, and this engine is compiled without
 * remote fetch (see `plantUmlLoader.ts`), so themes arrive the only other way
 * PlantUML offers: `skinparam` lines prepended to the document.
 *
 * Two constraints shape everything here.
 *
 * 1. **Some diagram bodies are data, not PlantUML.** `@startjson` and
 *    `@startyaml` parse their contents as literal JSON/YAML, so a `skinparam`
 *    line inside them is not a directive — it is malformed data, and the render
 *    fails outright with a parse error. Verified against the engine; both are
 *    excluded, and `plantUmlBodyIsData()` is the list. Anything added to
 *    PlantUML later with a data body belongs there too. The cost of the
 *    exclusion is small: those two render their own fixed palette either way.
 *
 * 2. **The preamble must not move the user's line numbers.** The engine reports
 *    parse errors as "line N", and the user counts lines in the source they
 *    wrote, not in the source we assembled. Every injected line is therefore
 *    joined into ONE physical line using PlantUML's `\n`-free multi-directive
 *    form is not available — so instead we record how many lines we added and
 *    `unshiftPlantUmlErrorLines()` subtracts them back out of the message.
 *
 * Colours are supplied by the caller, read from the live `--vscode-*` theme, so
 * a dark diagram tracks the editor rather than a palette hardcoded here.
 */

/** The colours a dark-mode PlantUML render is re-skinned with. */
export type PlantUmlPalette = {
    /** Ink for labels and arrows. */
    foreground: string;
    /** Fill for boxes, participants, nodes. */
    elementBackground: string;
    /** Borders and separator lines. */
    border: string;
};

/**
 * The `@startX` word opening a document, lowercased (`uml`, `json`, `mindmap`,
 * …), or null when the source has no opening directive at all — which is legal,
 * and which the engine treats as an implicit `@startuml`.
 */
export function plantUmlDirective(source: string): string | null {
    return source.match(/^\s*@start(\w+)/)?.[1]?.toLowerCase() ?? null;
}

/**
 * True when the diagram's body is parsed as data rather than as PlantUML, so no
 * preamble may be injected into it. See the header for why this list exists.
 */
export function plantUmlBodyIsData(source: string): boolean {
    const directive = plantUmlDirective(source);
    return directive === "json" || directive === "yaml";
}

/** The skinparam lines re-skinning a document for a dark editor surface. */
function darkPreamble(palette: PlantUmlPalette): string[] {
    const { foreground, elementBackground, border } = palette;
    return [
        // The pane already paints the themed surface behind the diagram; a
        // transparent canvas lets it through instead of stamping a second,
        // slightly-different rectangle on top of it.
        "skinparam backgroundColor transparent",
        `skinparam defaultFontColor ${foreground}`,
        `skinparam ArrowColor ${foreground}`,
        `skinparam ArrowFontColor ${foreground}`,
        `skinparam BorderColor ${border}`,
        `skinparam BackgroundColor ${elementBackground}`,
        `skinparam NoteBackgroundColor ${elementBackground}`,
        `skinparam NoteBorderColor ${border}`,
        `skinparam NoteFontColor ${foreground}`,
        `skinparam TitleFontColor ${foreground}`,
        `skinparam LegendFontColor ${foreground}`,
        `skinparam LegendBackgroundColor ${elementBackground}`,
        `skinparam LegendBorderColor ${border}`,
    ];
}

/** A themed document plus how many lines the preamble added. */
export type ThemedPlantUml = { source: string; addedLines: number };

/**
 * Apply the dark preamble to a document, or return it untouched.
 *
 * `palette` is null in light mode (the engine's own palette is already a light
 * one, so there is nothing to do) and the source is returned verbatim — no
 * injection, no line shift, no risk to a document we did not need to touch.
 */
export function applyPlantUmlTheme(source: string, palette: PlantUmlPalette | null): ThemedPlantUml {
    if (!palette || plantUmlBodyIsData(source)) {
        return { source, addedLines: 0 };
    }

    const preamble = darkPreamble(palette);
    const opening = source.match(/^\s*@start\w+[^\n]*\r?\n/);

    // With an opening directive, the preamble goes immediately after it; the
    // directive must stay the first line of the document.
    if (opening) {
        const head = source.slice(0, opening[0].length);
        return {
            source: head + preamble.join("\n") + "\n" + source.slice(opening[0].length),
            addedLines: preamble.length,
        };
    }

    // No directive: the engine implies @startuml. We must state it explicitly,
    // because the preamble has to sit inside the diagram to take effect.
    return {
        source: `@startuml\n${preamble.join("\n")}\n${source}\n@enduml`,
        addedLines: preamble.length + 1,
    };
}

/**
 * Rewrite "line N" references in an engine error so they point at the line the
 * user actually wrote. A no-op when nothing was injected.
 */
export function unshiftPlantUmlErrorLines(message: string, addedLines: number): string {
    if (addedLines <= 0) return message;
    return message.replace(/\bline (\d+)/gi, (whole, n: string) => {
        const shifted = Number(n) - addedLines;
        return shifted > 0 ? `line ${shifted}` : whole;
    });
}
