/**
 * jotMenuTable.ts — Jot's menu table, read out of its Swift source.
 *
 * Swift cannot be imported from a Vitest run and there is no build step that
 * would emit the table as data, so the alternative to parsing is a second copy
 * maintained by hand, which is the thing every guard in this area exists to
 * prevent. Parsing keeps `jot/Sources/BirtaJot/JotMenu.swift` the single
 * source: two tests read it (the host-profile drift guard and the chord parity
 * guard), and neither restates a row.
 *
 * The parser is deliberately strict about the row's SHAPE rather than lenient:
 * a row written differently is not silently skipped, because `parseJotMenu`
 * asserts that what it found accounts for every `.init(title:` in the file. A
 * lenient parser is the failure mode here, since a guard that quietly reads
 * zero rows passes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const JOT_MENU_PATH = "jot/Sources/BirtaJot/JotMenu.swift";

/** One row of the Swift table. */
export interface JotMenuRow {
    /** The menu-item title, as the menu bar draws it. */
    readonly title: string;
    /** The key equivalent, "" for a row with no chord. */
    readonly key: string;
    /** ProseMirror-notation chord ("Mod-Shift-d"), null where there is no key. */
    readonly chord: string | null;
    /** The editor command id, for a `.command` row. */
    readonly command: string | null;
    /** The menu it belongs to (`app` | `file` | `edit` | `format` | `view` | `help`). */
    readonly menu: string;
    /** The submenu title holding it, or null for a row on the menu itself. */
    readonly submenu: string | null;
    /** Whether the row only opens a submenu. */
    readonly isSubmenu: boolean;
}

/** The cheatsheet section heading each menu declares, mirroring `Menu.sectionTitle`. */
export const MENU_SECTIONS: Readonly<Record<string, string>> = {
    app: "Application",
    file: "File",
    edit: "Edit",
    format: "Format",
    view: "View",
    help: "Help",
};

const ROW_RE = new RegExp(
    String.raw`\.init\(title: "([^"]+)"` +
        String.raw`(?:, key: "([^"]*)", modifiers: \[([^\]]*)\])?,\s*` +
        String.raw`action: \.(app|command|link|submenu)\(?(.*?)\)?, menu: \.(\w+)` +
        String.raw`(?:, submenu: "([^"]*)")?`,
    "gs",
);

/** `[.command, .shift]` to the chord `kbd()` parses, in HostShortcut.chord's order. */
function chordOf(key: string, modifiers: string): string {
    const has = (flag: string): boolean =>
        modifiers.split(",").some((m) => m.trim() === flag);
    const parts: string[] = [];
    if (has(".command")) { parts.push("Mod"); }
    if (has(".control")) { parts.push("Ctrl"); }
    if (has(".option")) { parts.push("Alt"); }
    if (has(".shift")) { parts.push("Shift"); }
    parts.push(key);
    return parts.join("-");
}

/** Every row of the table, in declaration order. */
export function parseJotMenu(repoRoot: string): JotMenuRow[] {
    const source = readFileSync(join(repoRoot, JOT_MENU_PATH), "utf8");
    const rows: JotMenuRow[] = [];
    for (const m of source.matchAll(ROW_RE)) {
        const [, title, key, modifiers, kind, payload, menu, submenu] = m;
        rows.push({
            title: title!,
            key: key ?? "",
            chord: key === undefined || key === "" ? null : chordOf(key, modifiers ?? ""),
            command: kind === "command" ? payload!.trim().replace(/^"|"$/g, "") : null,
            menu: menu!,
            submenu: submenu ?? null,
            isSubmenu: kind === "submenu",
        });
    }
    // The instrument has to say what it reached: a regex that stopped matching
    // after a reformat would otherwise report a short table as a clean one, and
    // every check built on it would pass having examined a fraction of the
    // menus. `.init(title:` is the row's one unmistakable opening, so counting
    // those and comparing is a claim about the FILE rather than about the
    // regex's own output. The Help menu's link rows are built by mapping over
    // `AboutLink.allCases` and carry no `.init(title:`, which is why they are
    // absent from both sides of this count and from the parse.
    const declared = source.match(/\.init\(title: "/g)?.length ?? 0;
    if (rows.length !== declared) {
        throw new Error(
            `parseJotMenu read ${rows.length} of ${declared} rows in ${JOT_MENU_PATH}. ` +
                "A row was written in a shape the parser does not recognise; fix the " +
                "parser (or the row) rather than letting the guards run on a partial table.",
        );
    }
    return rows;
}

/** The rows that bind a key, which is what the page is told about. */
export function keyedRows(rows: readonly JotMenuRow[]): JotMenuRow[] {
    return rows.filter((r) => r.chord !== null);
}
