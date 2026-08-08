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
 *    wrote, not in the source we assembled. PlantUML has no way to state a
 *    dozen skinparams on one physical line, so the preamble genuinely costs
 *    lines; we record how many and `unshiftPlantUmlErrorLines()` subtracts them
 *    back out of the message before the user reads it.
 *
 * Colours are supplied by the caller, read from the live `--vscode-*` theme, so
 * a dark diagram tracks the editor rather than a palette hardcoded here.
 */

/** The colours a dark-mode PlantUML render is re-skinned with. */
export type PlantUmlPalette = {
    /** Ink for labels and arrows. */
    foreground: string;
    /** The diagram's own background. Matches what the pane paints behind it. */
    canvas: string;
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

/**
 * The skinparam lines re-skinning a document for a dark editor surface.
 *
 * The shape of this list is dictated by one fact about PlantUML that is easy to
 * get wrong: **`skinparam backgroundColor` is the diagram's page colour, and it
 * is the SAME parameter as `BackgroundColor`** — skinparam names are
 * case-insensitive, so the two spellings collide and the last one wins. There
 * is no generic "fill every element" parameter. A preamble that sets
 * `backgroundColor transparent` and then `BackgroundColor <fill>` therefore
 * sets neither: it paints the page in the intended element fill and leaves
 * every box, participant and node at PlantUML's stock palette. That is what
 * shipped first, and it showed as lavender participant boxes and #181818
 * lifelines sitting on a dark canvas, all but invisible.
 *
 * Element fills are per-family and have to be named individually. The list
 * below covers the families this editor actually renders; anything unnamed
 * keeps PlantUML's own colour, which is a legible default rather than a
 * regression. Verified against the engine in `e2e/plantUmlRender`.
 *
 * Every parameter here is one this engine honours, checked by reading the fills
 * back out of its SVG. Three that upstream documents are NOT implemented and
 * were removed rather than left in as decoration: `ActivityDiamond*`,
 * `ActivityStart/EndColor`, and `StateStart/EndColor`. A decision diamond
 * therefore stays PlantUML's near-white (dark ink on it, so it reads), and
 * terminator discs stay `#222222`. Re-check before adding any of them back.
 */
function darkPreamble(palette: PlantUmlPalette): string[] {
    const { foreground, canvas, elementBackground, border } = palette;
    // The families whose element fill/border/ink PlantUML exposes under a
    // `<Family>BackgroundColor` / `…BorderColor` / `…FontColor` triple.
    const families = [
        "Participant", "Actor", "Boundary", "Control", "Entity", "Database", "Collections",
        "Queue", "Note", "Legend", "Class", "Object", "State", "Component", "Node",
        "Rectangle", "Usecase", "Activity", "Package", "Partition", "Agent", "Artifact",
        "Cloud", "Frame", "Interface", "Storage", "Card", "File", "Folder",
    ];
    return [
        `skinparam backgroundColor ${canvas}`,
        `skinparam defaultFontColor ${foreground}`,
        `skinparam ArrowColor ${foreground}`,
        `skinparam ArrowFontColor ${foreground}`,
        `skinparam BorderColor ${border}`,
        `skinparam TitleFontColor ${foreground}`,
        // Sequence lifelines are their own parameter and default to near-black,
        // which is the single worst artefact of leaving them alone.
        `skinparam SequenceLifeLineBorderColor ${border}`,
        `skinparam SequenceBoxBackgroundColor ${elementBackground}`,
        `skinparam SequenceGroupBodyBackgroundColor ${canvas}`,
        `skinparam SequenceDividerBackgroundColor ${elementBackground}`,
        `skinparam ClassAttributeFontColor ${foreground}`,
        `skinparam StereotypeFontColor ${foreground}`,
        ...families.flatMap((family) => [
            `skinparam ${family}BackgroundColor ${elementBackground}`,
            `skinparam ${family}BorderColor ${border}`,
            `skinparam ${family}FontColor ${foreground}`,
        ]),
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
