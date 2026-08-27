/**
 * appMenuTable.ts — the Mac app's menu table, read out of its Swift source.
 *
 * Swift cannot be imported from a Vitest run and there is no build step that
 * would emit the table as data, so the alternative to parsing is a second copy
 * maintained by hand, which is the thing every guard in this area exists to
 * prevent. Parsing keeps `mac/Sources/BirtaWriter/AppMenu.swift` the single
 * source: two tests read it (the host-profile drift guard and the chord parity
 * guard), and neither restates a row.
 *
 * The parser is deliberately strict about the row's SHAPE rather than lenient:
 * a row written differently is not silently skipped, because `parseAppMenu`
 * asserts that what it found accounts for every row the file declares, counted
 * by a pattern strictly more permissive than the one that reads a row. A
 * lenient parser is the failure mode here, since a guard that quietly reads
 * zero rows passes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const APP_MENU_PATH = "mac/Sources/BirtaWriter/AppMenu.swift";

/** One row of the Swift table. */
export interface AppMenuRow {
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
    const source = readFileSync(join(repoRoot, APP_MENU_PATH), "utf8");
    const cases = source.match(/case\s+app(?:,\s*\w+)+\n/)?.[0];
    if (cases === undefined) {
        throw new Error(`no \`case app, …\` declaration found in ${APP_MENU_PATH}`);
    }
    const menus = cases.trim().replace(/^case\s+/, "").split(",").map((m) => m.trim());
    // Scoped to the property's own body: a repo-wide sweep for `case .x: return
    // "y"` would pick up any other switch that returns a string and report a
    // map nobody declared.
    const body = /var sectionTitle: String \{([\s\S]*?)\n {8}\}/.exec(source)?.[1];
    if (body === undefined) {
        throw new Error(`no \`var sectionTitle: String\` body found in ${APP_MENU_PATH}`);
    }
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/case \.(\w+): return "([^"]+)"/g)) {
        out[m[1]!] = m[2]!;
    }
    const missing = menus.filter((m) => !(m in out));
    if (missing.length > 0 || Object.keys(out).length !== menus.length) {
        throw new Error(
            `menuSections read ${Object.keys(out).length} headings for ${menus.length} menus ` +
                `in ${APP_MENU_PATH}${missing.length > 0 ? ` (missing ${missing.join(", ")})` : ""}. ` +
                "Fix the parser rather than letting a guard compare against a partial map.",
        );
    }
    return out;
}

const ROW_RE = new RegExp(
    String.raw`\.init\(title: "([^"]+)"` +
        String.raw`(?:, key: "([^"]*)", modifiers: \[([^\]]*)\])?,\s*` +
        String.raw`action: \.(app|command|link|submenu|recents)\(?(.*?)\)?, menu: \.(\w+)` +
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
export function parseAppMenu(repoRoot: string): AppMenuRow[] {
    const source = readFileSync(join(repoRoot, APP_MENU_PATH), "utf8");
    const rows: AppMenuRow[] = [];
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
    // The property the denominator has to have is not that it is spelled
    // differently from `ROW_RE`, it is that it is strictly MORE PERMISSIVE than
    // anything `ROW_RE` requires. A denominator that shares one of the
    // numerator's requirements falls with it, and two numbers that fall
    // together are the tautology whatever they are made of: counting
    // `.init(title: "` was one, and counting the literal `, menu: .` was the
    // same one respelled, since `ROW_RE` carries those exact bytes and a row
    // that merely wraps before `menu:` or writes it ahead of `action:` leaves
    // both sides. So the count tolerates the whitespace and the ordering
    // `ROW_RE` insists on, and `appMenuTable.test.ts` reformats a real row
    // three ways and requires each to throw.
    //
    // The whitespace is optional on BOTH sides of the colon for the same
    // reason: every space `ROW_RE` insists on is a way the two counts could
    // fall together again. `\bmenu` and not `menu` keeps `submenu:` from being
    // counted twice, and the `\.` keeps the type's own `let menu: Menu` and the
    // two `menu: menu` arguments in `add`/`fill` out of it.
    //
    // A row whose title is not a literal cannot be parsed and is subtracted
    // once, by counting the constructions that have one rather than by a number
    // written here: the Help menu's links are built by mapping over
    // `AboutLink.allCases`, and a second such map joins this on its own.
    const declared = source.match(/\bmenu\s*:\s*\./g)?.length ?? 0;
    const unnamed = source.match(/Row\(title: (?!")/g)?.length ?? 0;
    if (rows.length !== declared - unnamed) {
        throw new Error(
            `parseAppMenu read ${rows.length} rows against ${declared} declared ` +
                `(${unnamed} with a computed title) in ${APP_MENU_PATH}. ` +
                "A row was written in a shape the parser does not recognise; fix the " +
                "parser (or the row) rather than letting the guards run on a partial table.",
        );
    }
    return rows;
}

/** The rows that bind a key, which is what the page is told about. */
export function keyedRows(rows: readonly AppMenuRow[]): AppMenuRow[] {
    return rows.filter((r) => r.chord !== null);
}
