/**
 * shared/hostProfile.ts
 *
 * What the SURFACE is, as one declaration. The single place a host says
 * anything about itself, and the single place the editor asks (MAR-373,
 * MAR-370).
 *
 * The problem this exists to prevent: the boot blob carries about forty
 * fields, and almost all of them are the USER'S settings (`birta.*`). A fact
 * about the host is a different kind of thing, and when host facts are added
 * as bare fields alongside settings there is no type saying which is which and
 * no one place to guard. Three had already accumulated in three shapes. They
 * are one shape now, and a fourth goes here rather than becoming a fourth.
 *
 * A profile holds three kinds of fact, and the distinction is the whole
 * design:
 *
 *   capabilities  something the host PROVIDES that chrome can name. Always
 *                 host-side (a text editor to switch to, a settings window, an
 *                 agent, an image store), never an editor feature; an editor
 *                 feature is gated by its own `birta.*` setting, not here.
 *   arrangements  a LAYOUT choice where two surfaces want the same controls in
 *                 different places. Not a capability: both arrangements offer
 *                 the same thing and run the same commands, so gating one on a
 *                 capability would claim a host cannot do something it can.
 *                 Where the controls sit, and whether the user may move them,
 *                 are both layout facts and both live here.
 *   shortcuts     keys the host itself binds, for the cheatsheet to print.
 *
 * Consumers ask `hostHas`, `hostArranges`, `hostHasCommand` or `hostShortcuts`
 * and never read the declaration, so the absent-means-VS-Code rule below has
 * exactly one home and no call site re-derives it.
 *
 * The contract: Jot ships zero behavior Birta lacks. Every surface runs the
 * same editor from the same bundle, and what differs between them is only the
 * chrome that names something the HOST provides. A capability is therefore
 * always a host-side thing (a text editor to switch to, a settings UI, a
 * proofreading engine with its review sidebar, an owner for read-only mode, a
 * TOC sidebar, an image store), never an editor feature. An editor feature is
 * gated by its own `birta.*` setting, not here.
 *
 * The host declares one object, `window.__i18n.host`. ABSENT MEANS THE VS CODE
 * PROFILE rather than the literal union: a page with no declaration is one
 * that predates the field, which makes it a VS Code page, and it should not
 * inherit a capability that names a standalone app's window. An explicit empty
 * profile is a host with nothing.
 *
 * Three declarers restate this by hand, because neither Swift nor an HTML
 * bootstrap can import TypeScript: `src/webviewHtml.ts` for VS Code,
 * `Prefs.bootConfig` in jot/Sources/BirtaJot/Preferences.swift for Jot, and
 * the e2e Jot page. They are not free to drift; `hostProfile.test.ts` reads
 * all three and fails when they disagree. One key is what makes that guard
 * possible to write once instead of once per field.
 *
 * Dependency-free (no vscode, no DOM types) so both the extension and the
 * webview import it; the read goes through `globalThis`, which is `window` in
 * every webview.
 */
import { EDITOR_COMMANDS } from "./editorCommands";

export type HostCapability =
    /** A raw text editor to switch to (Edit Raw Markdown). */
    | "textEditor"
    /** A settings UI, a keybindings UI, and a release-notes page to open. */
    | "hostSettings"
    /** A proofreading engine and the review sidebar that shows its findings. */
    | "proofreading"
    /** An owner for read-only mode (the `birta.readOnly` seed and its toggle). */
    | "readOnlyMode"
    /** The table-of-contents / review sidebar. */
    | "toc"
    /** An image store the Insert Image panel can upload to and browse. */
    | "imageUpload"
    /** A coding agent to hand a prompt to (Ask Agent). */
    | "agent"
    /**
     * An editor font of the host's own for the content to inherit, which is
     * what the "Editor font" preset names. A host with no editor behind the
     * page (Jot is a window with a document in it) has no such font, so the
     * preset would resolve to nothing and the row would be a dead choice.
     */
    | "editorFont"
    /**
     * An editor area wide enough that constraining text to a reading measure
     * is a choice worth offering. VS Code gives the editor whatever the window
     * has, which on a wide display is far past comfortable. A small floating
     * panel is already its own measure, so the full/fixed control there offers
     * a choice between one width and the same width.
     */
    | "contentMeasure"
    /**
     * The host is an application with a preferences window of its own, which
     * the gear menu can offer to open. Distinct from `hostSettings`, which is
     * VS Code's bundle of settings, keybindings and release notes: an app that
     * has a Settings window has no keybindings editor behind it, and offering
     * one row of three is not the same capability.
     */
    | "appPreferences";

export const ALL_HOST_CAPABILITIES: readonly HostCapability[] = [
    "textEditor",
    "hostSettings",
    "proofreading",
    "readOnlyMode",
    "toc",
    "imageUpload",
    "agent",
    "editorFont",
    "contentMeasure",
    "appPreferences",
];

/**
 * The named profiles, one per surface. VS Code declares everything; Jot
 * declares what its own shell provides, and grows an entry here the day it
 * provides another.
 */
/**
 * Capabilities NO VS Code host has, because they name something only a
 * standalone application provides.
 *
 * Almost every capability runs the other way: VS Code has the thing and a
 * lesser host does not, so `vscode` declares it and the gap is the other
 * surface's. This list is the exception the rule needed once Jot grew a
 * window of its own, and keeping it explicit is what stops "vscode declares
 * everything" from quietly meaning "every new capability is a VS Code
 * feature". A member here MUST be declared by some other profile, or it
 * names nothing at all; `hostProfile.test.ts` checks both directions.
 */
export const APP_ONLY_CAPABILITIES: readonly HostCapability[] = ["appPreferences"];

export const HOST_PROFILES = {
    vscode: ALL_HOST_CAPABILITIES.filter(
        (c) => !APP_ONLY_CAPABILITIES.includes(c),
    ) as readonly HostCapability[],
    // The Jot shell (`Prefs.bootConfig` in jot/Sources/BirtaJot/Preferences.swift)
    // and the e2e Jot page restate this list as a literal, because neither
    // Swift nor an HTML bootstrap can import it. They are not free to drift:
    // shared/__tests__/hostProfile.test.ts parses both and fails.
    jot: ["imageUpload", "appPreferences", "agent"] as readonly HostCapability[],
} as const satisfies Record<string, readonly HostCapability[]>;

/**
 * A layout choice a surface makes, where both answers offer the same controls
 * and run the same commands.
 *
 * NOT a capability, and the difference is worth holding onto: a capability
 * says the host cannot do a thing, so the chrome for it is never built. An
 * arrangement says the host would rather have the thing somewhere else. Gating
 * a layout on a capability would claim VS Code cannot show a font menu.
 */
export type HostArrangement =
    /**
     * The typography rows (width, size, font) live inside the gear menu rather
     * than in a toolbar item of their own. For a surface whose toolbar is
     * short, which is Jot's.
     */
    | "typographyInGearMenu"
    /**
     * Every control that edits the document lives on a second row of the top
     * bar, not in the bar's left zone. The bar's own row keeps the controls
     * that read rather than write, and the button that opens the second row
     * sits among them, beside Find.
     *
     * The left zone staying empty is the point on a surface with traffic
     * lights: it leaves the window's own titlebar row to the window.
     *
     * The partition is DERIVED, never listed: an item takes the second row
     * exactly when `ITEM_MUTATES` says it changes the document, so a new
     * toolbar item lands on the right surface by answering a question it
     * already had to answer. `toolbarRegistry.test.ts` holds both halves.
     */
    | "formattingInSecondRow"
    /**
     * The bar's contents and its visibility belong to the surface, not to the
     * user: no per-item placement, no Customize Toolbar, no Hide Toolbar.
     *
     * A layout fact rather than a capability, because it names nothing the
     * host provides. It is a separate fact from `formattingInSecondRow` and
     * has to be, even though one surface currently declares both: that one
     * decides WHERE a control sits, and this decides WHOSE the arrangement is.
     * Deriving the second from the first at a call site is what this file
     * exists to stop.
     */
    | "fixedToolbarLayout";

export const ALL_HOST_ARRANGEMENTS: readonly HostArrangement[] = [
    "typographyInGearMenu",
    "formattingInSecondRow",
    "fixedToolbarLayout",
];

/** One key the host binds itself, for the keyboard cheatsheet to print. */
export interface HostShortcut {
    /** ProseMirror keymap notation (`Mod-Shift-d`), which `kbd()` parses. */
    readonly keys: string;
    /** What it does, in the words the host's own menu uses. */
    readonly label: string;
}

/** Everything a host says about itself, in one object. */
export interface HostProfile {
    readonly capabilities: readonly HostCapability[];
    readonly arrangements: readonly HostArrangement[];
    readonly shortcuts: readonly HostShortcut[];
}

interface HostDeclaration {
    __i18n?: { host?: Partial<HostProfile> };
}

/**
 * The declared profile, or the VS Code one when nothing is declared.
 *
 * Read on every call rather than cached: the declaration is injected before
 * the bundle evaluates, but a test can replace it between cases, and a cached
 * first read would make the second case answer for the first.
 */
export function hostProfile(): HostProfile {
    const declared = (globalThis as HostDeclaration).__i18n?.host;
    if (declared === undefined) {
        return { capabilities: HOST_PROFILES.vscode, arrangements: [], shortcuts: [] };
    }
    return {
        capabilities: declared.capabilities ?? [],
        arrangements: declared.arrangements ?? [],
        shortcuts: declared.shortcuts ?? [],
    };
}

/** Whether the host wants layout `arrangement`. */
export function hostArranges(arrangement: HostArrangement): boolean {
    return hostProfile().arrangements.includes(arrangement);
}

/** The host's own fixed keys, for the cheatsheet. Empty where it binds none. */
export function hostShortcuts(): readonly HostShortcut[] {
    return hostProfile().shortcuts;
}

/**
 * Whether the host declares `cap`.
 *
 * An absent declaration means a page that predates the field, which is a VS
 * Code page, so it gets the VS Code profile rather than the literal union:
 * every capability except the app-only ones. Before `APP_ONLY_CAPABILITIES`
 * existed those were the same set, which is why the rule reads as unchanged
 * from every existing page's point of view. Getting this wrong puts a
 * standalone app's row on a page that never heard of standalone apps.
 */
export function hostHas(cap: HostCapability): boolean {
    return hostProfile().capabilities.includes(cap);
}

const COMMAND_CAPABILITY: ReadonlyMap<string, HostCapability> = new Map(
    EDITOR_COMMANDS.flatMap((meta) =>
        "hostCapability" in meta && meta.hostCapability
            ? [[meta.id, meta.hostCapability] as const]
            : []),
);

/**
 * Commands an ARRANGEMENT withdraws, as opposed to a missing capability.
 *
 * The two reasons a command can be absent are different in kind and the same
 * in effect. A capability is missing because the host provides no such thing;
 * an arrangement withdraws a command because the surface has settled the
 * question the command exists to reopen (Customize Toolbar under
 * `fixedToolbarLayout`). They meet here rather than at each call site so
 * `hostHasCommand` stays the ONE predicate, and every surface that already
 * filters on it gains the second reason without a line changing.
 */
const COMMAND_WITHDRAWN_BY: ReadonlyMap<string, HostArrangement> = new Map(
    EDITOR_COMMANDS.flatMap((meta) =>
        "absentUnder" in meta && meta.absentUnder
            ? [[meta.id, meta.absentUnder as HostArrangement] as const]
            : []),
);

/**
 * Whether the host can honour editor command `id`: true for every command
 * that requires no capability and that no declared arrangement withdraws.
 * The one predicate every surface that offers or runs a command (toolbar,
 * gear menu, slash menu, `runEditorCommand`) reads, so a chord, a palette
 * pick and a menu row can never disagree.
 */
export function hostHasCommand(id: string): boolean {
    const cap = COMMAND_CAPABILITY.get(id);
    if (cap !== undefined && !hostHas(cap)) { return false; }
    const withdrawn = COMMAND_WITHDRAWN_BY.get(id);
    return withdrawn === undefined || !hostArranges(withdrawn);
}
