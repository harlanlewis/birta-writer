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
 * asserts that what it found accounts for every row the file declares, counted
 * in a vocabulary the parser itself does not use. A lenient parser is the
 * failure mode here, since a guard that quietly reads zero rows passes.
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

/**
 * The cheatsheet section heading each menu declares, READ OUT of
 * `Menu.sectionTitle` rather than mirrored here.
 *
 * A mirror is what this replaces, and the mirror was invisible: nothing
 * compared it to the switch it copied, and the Swift check that touches the
 * field (`XCTAssertEqual(shortcut.section, row.menu.sectionTitle)`) compares
 * Swift to Swift. So renaming a heading in the shell left the app printing the
 * new word, the e2e page declaring the old one, and every guard green.
 *
 * The enum's own cases are the denominator: a `Menu` case with no arm here is
 * a parse that stopped seeing the switch, and it throws rather than returning a
 * short map that every check written over it would pass on.
 */
export function menuSections(repoRoot: string): Readonly<Record<string, string>> {
    const source = readFileSync(join(repoRoot, JOT_MENU_PATH), "utf8");
    const cases = source.match(/case\s+app(?:,\s*\w+)+\n/)?.[0];
    if (cases === undefined) {
        throw new Error(`no \`case app, …\` declaration found in ${JOT_MENU_PATH}`);
    }
    const menus = cases.trim().replace(/^case\s+/, "").split(",").map((m) => m.trim());
    // Scoped to the property's own body: a repo-wide sweep for `case .x: return
    // "y"` would pick up any other switch that returns a string and report a
    // map nobody declared.
    const body = /var sectionTitle: String \{([\s\S]*?)\n {8}\}/.exec(source)?.[1];
    if (body === undefined) {
        throw new Error(`no \`var sectionTitle: String\` body found in ${JOT_MENU_PATH}`);
    }
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/case \.(\w+): return "([^"]+)"/g)) {
        out[m[1]!] = m[2]!;
    }
    const missing = menus.filter((m) => !(m in out));
    if (missing.length > 0 || Object.keys(out).length !== menus.length) {
        throw new Error(
            `menuSections read ${Object.keys(out).length} headings for ${menus.length} menus ` +
                `in ${JOT_MENU_PATH}${missing.length > 0 ? ` (missing ${missing.join(", ")})` : ""}. ` +
                "Fix the parser rather than letting a guard compare against a partial map.",
        );
    }
    return out;
}

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
    // menus.
    //
    // The denominator is deliberately in a DIFFERENT vocabulary from the
    // parser's own opening. Counting `.init(title: "` was the tautology this
    // replaces: `ROW_RE` starts with that same text, so a row written in Swift's
    // other legal form (`Row(title: …)`, which the file already uses) is
    // subtracted from both sides and the check compares two numbers that fell
    // by one together. `, menu: .` is what every row must carry whatever
    // spelling constructed it, so counting those is a claim about the FILE.
    //
    // A row whose title is not a literal cannot be parsed and is subtracted
    // once, by counting the constructions that have one rather than by a number
    // written here: the Help menu's links are built by mapping over
    // `AboutLink.allCases`, and a second such map joins this on its own.
    const declared = source.match(/, menu: \./g)?.length ?? 0;
    const unnamed = source.match(/Row\(title: (?!")/g)?.length ?? 0;
    if (rows.length !== declared - unnamed) {
        throw new Error(
            `parseJotMenu read ${rows.length} rows against ${declared} declared ` +
                `(${unnamed} with a computed title) in ${JOT_MENU_PATH}. ` +
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
