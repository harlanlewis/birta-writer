/**
 * shared/syntaxSets.ts
 *
 * WHICH Markdown the editor OFFERS to write, as one declaration.
 *
 * A document renders whatever it contains, always. Nothing here reaches the
 * parser, the schema or the serializer, and that separation is the whole
 * design: a file holding a GFM table opens as a table on every surface and
 * under every setting, because a reader who cannot see what a file says has
 * been failed by the editor rather than served by it. What a syntax set
 * governs is the other direction, the tools the editor hands you: a writer
 * targeting CommonMark should not be offered an Insert Table button whose
 * output their renderer will print as pipes.
 *
 * CommonMark is the floor and is not a member of this union. It is the syntax
 * every target in the list already contains, so a set for it would be a set
 * that can never be turned off, and a row in the settings UI that does nothing
 * is worse than no row. Every set below is an independent opt-in on top of it:
 * they overlap freely (three of the four provide footnotes), and a feature is
 * offered when ANY enabled set provides it. Turning them all off leaves the
 * CommonMark floor, which is the strict target spelled as the absence of
 * every extension rather than as a fifth mutually exclusive choice.
 *
 * A FEATURE is a syntax a target either has or does not, never a button. The
 * distinction decides what belongs here: `table` is a feature because GitHub
 * renders one and CommonMark does not; "the table item is on the left of the
 * bar" is a layout choice and lives in the user's toolbar config. This is the
 * same line `shared/hostProfile.ts` draws between a capability and an
 * arrangement, for the same reason: a vocabulary that admits both stops being
 * a vocabulary and becomes a list of flags.
 *
 * Dependency-free (no vscode, no DOM types) so the extension, the webview and
 * the Mac shell's port all read one table. The enabled sets are read through
 * `globalThis.__i18n`, the way `hostProfile()` reads its own declaration, so
 * there is no cached copy to go stale when the setting changes mid-session.
 */

/**
 * A publishing target whose syntax the editor can offer to write.
 *
 * Named for the tool a writer is aiming at rather than for the specification
 * behind it: someone choosing a target knows they are writing for GitHub, and
 * would have to look up which of GFM, `remark-gfm` and the alert extension
 * that implies.
 */
export type SyntaxSet =
    /**
     * GitHub Flavored Markdown, plus the two extensions GitHub renders on top
     * of it in issues and READMEs: `> [!NOTE]` alerts, and Mermaid in a fenced
     * block. Both are GitHub features rather than GFM ones, and a writer
     * targeting GitHub wants them; splitting them out would give the roster a
     * set nobody would think to enable on its own.
     */
    | "gfm"
    /**
     * Obsidian: `[[wikilinks]]`, `==highlights==`, callouts and math, over the
     * GFM base Obsidian itself builds on.
     */
    | "obsidian"
    /**
     * Pandoc: footnotes, math, and `:::` fenced divs. Pandoc reads far more
     * than this; what the list holds is what this editor can WRITE, so a
     * Pandoc extension the editor has no tool for is absent rather than
     * declared and unreachable.
     */
    | "pandoc"
    /**
     * The syntaxes only this editor renders: living-calculation fences, SVG
     * fences, and Notion's `<aside>` callouts as they arrive from an export.
     *
     * A real target rather than a courtesy entry. Their output degrades
     * legibly elsewhere (a calc or svg fence is a code block, an `<aside>` is
     * inline HTML), so writing them is a deliberate choice to keep a document
     * that only reads fully here, and that is exactly the choice a target is
     * for.
     */
    | "birta";

export const ALL_SYNTAX_SETS: readonly SyntaxSet[] = ["gfm", "obsidian", "pandoc", "birta"];

/**
 * A syntax a target either supports or does not.
 *
 * Every member is beyond CommonMark, because a CommonMark construct needs no
 * feature: it is the floor, and a tool for it is never withdrawn. So there is
 * no `heading`, no `bulletList`, no `codeBlock` and no `link` here, and adding
 * one would be adding a feature no set could ever fail to provide.
 */
export type SyntaxFeature =
    /** GFM pipe tables. */
    | "table"
    /** `~~struck~~`. */
    | "strikethrough"
    /** `- [ ]` / `- [x]` task list items. */
    | "taskList"
    /** `[^1]` references and their definitions. */
    | "footnote"
    /** `$inline$` and `$$block$$` math. */
    | "math"
    /** `==marked==`. */
    | "highlight"
    /** `[[wikilinks]]`, as the link popup's Local link format offers them. */
    | "wikiLink"
    /** `> [!NOTE]` callouts, in both the GitHub alert and Obsidian spellings. */
    | "calloutAlert"
    /** `:::name` fenced divs (generic container directives). */
    | "fencedDiv"
    /** Notion's `<aside>` callouts, as an export writes them. */
    | "notionCallout"
    /** A `mermaid` fenced block, rendered as a diagram. */
    | "mermaid"
    /** An `svg` fenced block, rendered as the picture its source draws. */
    | "svg"
    /** A `calc` fenced block, evaluated as a living worksheet. */
    | "calc";

export const ALL_SYNTAX_FEATURES: readonly SyntaxFeature[] = [
    "table",
    "strikethrough",
    "taskList",
    "footnote",
    "math",
    "highlight",
    "wikiLink",
    "calloutAlert",
    "fencedDiv",
    "notionCallout",
    "mermaid",
    "svg",
    "calc",
];

/**
 * What each target supports, as one table.
 *
 * Overlap is the normal case and is deliberately spelled out per set rather
 * than expressed as one set extending another. Obsidian does build on GFM, but
 * writing that as inheritance would make a future divergence (Obsidian
 * dropping something, or the GFM row gaining something Obsidian never had) a
 * change to the relationship rather than to one row, and the rows are what a
 * reader checks a claim against.
 */
export const SYNTAX_SET_FEATURES: Record<SyntaxSet, readonly SyntaxFeature[]> = {
    gfm: ["table", "strikethrough", "taskList", "footnote", "math", "calloutAlert", "mermaid"],
    obsidian: [
        "table",
        "strikethrough",
        "taskList",
        "footnote",
        "math",
        "highlight",
        "wikiLink",
        "calloutAlert",
        "mermaid",
    ],
    pandoc: ["table", "strikethrough", "footnote", "math", "fencedDiv"],
    birta: ["calc", "svg", "notionCallout"],
};

/**
 * Every set ships ON, so an installation that never opens this setting is the
 * editor as it was before targets existed: every tool offered, nothing
 * withdrawn. Narrowing is the deliberate act, which is the right way round for
 * a feature whose whole effect is taking controls away.
 */
export const DEFAULT_SYNTAX_SETS: readonly SyntaxSet[] = ALL_SYNTAX_SETS;

/**
 * A settings.json value is free text, and the enum only constrains the UI, so
 * a typo would otherwise reach the gate as a set nothing provides. Unknown
 * entries are dropped and duplicates collapse; an EMPTY result is kept as
 * empty, because that is the CommonMark-only target rather than a mistake.
 * A non-array (a bare string, null, a stale object) is the shape that cannot
 * mean anything, and falls back to the default.
 */
export function normalizeSyntaxSets(value: unknown): readonly SyntaxSet[] {
    if (!Array.isArray(value)) {
        return DEFAULT_SYNTAX_SETS;
    }
    const seen = new Set<SyntaxSet>();
    for (const entry of value) {
        if (typeof entry === "string" && (ALL_SYNTAX_SETS as readonly string[]).includes(entry)) {
            seen.add(entry as SyntaxSet);
        }
    }
    return ALL_SYNTAX_SETS.filter((set) => seen.has(set));
}

interface SyntaxDeclaration {
    __i18n?: { syntaxSets?: unknown };
}

/**
 * The sets in force, read fresh on every call.
 *
 * Not cached, for the reason `hostProfile()` gives and one more: a host
 * profile is baked at page load and these are not. The user can change the
 * target while the editor is open, and the live update writes the new list
 * back to the same blob, so a cached first read would leave every surface
 * answering for the target the document was opened under.
 *
 * An absent declaration means the default (every set), not the empty list: a
 * page that says nothing about targets is not a page asking for strict
 * CommonMark, and every existing test page and harness page says nothing.
 */
export function enabledSyntaxSets(): readonly SyntaxSet[] {
    return normalizeSyntaxSets((globalThis as SyntaxDeclaration).__i18n?.syntaxSets);
}

/**
 * Whether any enabled set provides `feature`.
 *
 * `undefined` is the CommonMark answer and is always true, which is what lets
 * a caller pass an optional `syntax` field straight through: a tool that
 * declares no feature is a tool for the floor, and the floor is never
 * withdrawn.
 */
export function syntaxAllows(feature: SyntaxFeature | undefined): boolean {
    return setsAllow(enabledSyntaxSets(), feature);
}

/**
 * The same question asked of an EXPLICIT list, for a caller that holds the sets
 * rather than living on the page that declares them.
 *
 * The extension host is the one such caller: it publishes the gate as VS Code
 * context keys and has no `__i18n` blob to read, so without this it would
 * either re-derive the union or write a declaration into its own globals to
 * read straight back. The Swift port has had this shape from the start
 * (`SyntaxScope.allows(_:in:)`), and the page's own predicate is now the same
 * function with the declaration filled in.
 */
export function setsAllow(
    sets: readonly SyntaxSet[],
    feature: SyntaxFeature | undefined,
): boolean {
    if (feature === undefined) {
        return true;
    }
    return sets.some((set) => SYNTAX_SET_FEATURES[set].includes(feature));
}

/**
 * The VS Code context key that carries `feature`'s answer into `when` clauses.
 *
 * The one thing a syntax target cannot withdraw from inside the page: VS Code's
 * own command palette and its contributed keybindings are declared in
 * `package.json` and resolved by the workbench, so the page never sees the
 * question. `runEditorCommand` still refuses a withdrawn command, which is what
 * keeps a stale palette row from doing anything, but a row that runs and does
 * nothing is the toolbar and the palette disagreeing about whether a tool
 * exists, which is what this whole predicate is for.
 *
 * Derived rather than written into `package.json` twice:
 * `shared/__tests__/syntaxContributions.test.ts` builds the expected `when`
 * clause from `EDITOR_COMMANDS` and fails on a contribution that does not carry
 * it, so a new gated command cannot ship with a palette row that outlives it.
 *
 * Set from the resource-less read of the setting, the same one the live
 * `syntaxSetsChanged` broadcast uses. A context key is per window and the
 * setting can in principle differ per workspace folder; the broadcast already
 * has that shape, so the palette agrees with the toolbar rather than with a
 * third answer nobody else holds.
 */
export function syntaxContextKey(feature: SyntaxFeature): string {
    return `birta.syntax.${feature}`;
}

/** The sets that provide `feature`, for a UI that has to explain an absence. */
export function setsProviding(feature: SyntaxFeature): readonly SyntaxSet[] {
    return ALL_SYNTAX_SETS.filter((set) => SYNTAX_SET_FEATURES[set].includes(feature));
}
