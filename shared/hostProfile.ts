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
 * spelling and grammar engine, an owner for read-only mode, a TOC sidebar, an
 * image store), never an editor feature. An editor feature is gated by its own
 * `birta.*` setting, not here.
 *
 * The host declares one object, `window.__i18n.host`. ABSENT MEANS THE VS CODE
 * PROFILE rather than the literal union: VS Code is the base surface, the one
 * every other host is described as a DIFFERENCE from, so a page that says
 * nothing gets it and never inherits a capability naming a standalone app's
 * window. Every shipped page declares the field regardless; the default is
 * what keeps the webview's own tests, which mount the editor with no host
 * blob at all, on the surface they are written against. An explicit empty
 * profile is a host with nothing, which is a different claim from silence.
 *
 * TWO declarers restate this by hand, because neither Swift nor an HTML
 * bootstrap can import TypeScript: Jot's Swift, split across `Prefs.bootConfig`
 * and `Bridge.i18nObject`, and the e2e Jot page. They are not free to drift;
 * `hostProfile.test.ts` reads both and fails when they disagree. One key is
 * what makes that guard possible to write once instead of once per field.
 *
 * `src/webviewHtml.ts` is not one of them: it imports `HOST_PROFILES.vscode`,
 * so its capabilities cannot drift at all. Its `arrangements` and `shortcuts`
 * are bare empty literals rather than an import, and that pair is what the
 * guard checks there.
 *
 * Dependency-free (no vscode, no DOM types) so both the extension and the
 * webview import it; the read goes through `globalThis`, which is `window` in
 * every webview.
 */
import { EDITOR_COMMANDS, type EditorCommandId } from "./editorCommands";

export type HostCapability =
    /** A raw text editor to switch to (Edit Raw Markdown). */
    | "textEditor"
    /** A settings UI, a keybindings UI, and a release-notes page to open. */
    | "hostSettings"
    /**
     * A spelling and grammar engine the host runs over the document's text.
     *
     * The narrow half of proofreading, and the split is load-bearing. Spelling
     * and grammar are lints the page ASKS for: it posts the blocks out and
     * draws whatever comes back, so a host with no engine answers nothing and
     * those two rows are choices with no effect. Style check is not that. It is
     * computed in the page, synchronously, from a table the bundle carries
     * (`plugins/proofread.ts`), and so is the note-marker highlight beside it,
     * which is why neither is gated on this and both work on every surface.
     *
     * Conflating them is the mistake this name records: one gate over all four
     * rows withdrew the whole Checks menu from a host with no lint engine, so
     * a surface that could run the style check perfectly well was offered no
     * control over it.
     *
     * The rename that split them left a second copy of the old name behind, in
     * Swift, where nothing compares a string to this union: the shell went on
     * testing its capabilities for `proofreading` and getting false forever
     * after. That held the master gate off, so on that surface the style check
     * drew nothing at all and the Checks menu opened with its body missing.
     * `initialConfig` in webview/plugins/proofread.ts owns the decision now,
     * because `hostHas` is the one reader, and `hostProfile.test.ts` fails on a
     * capability name spelled in Swift that is not in this union.
     */
    | "spellAndGrammar"
    /** An owner for read-only mode (the `birta.readOnly` seed and its toggle). */
    | "readOnlyMode"
    /** The table-of-contents / review sidebar. */
    | "toc"
    /**
     * An image store the Insert Image panel can upload to. Uploading only:
     * somewhere to PUT an image is not somewhere to look for one, and Jot is
     * exactly that host (`AttachmentStore` writes beside the note). Browsing
     * is `projectImages`.
     */
    | "imageUpload"
    /**
     * A project the Insert Image panel can enumerate existing images from,
     * which means a workspace of files rather than a single note.
     *
     * Split from `imageUpload` because they are two host facts, and
     * conflating them made the panel ASK a question its host could not
     * answer: on Jot the Project tab was the default, opened, posted
     * `getProjectImages`, and drew an empty grid ten seconds later when the
     * unanswered promise timed out to null (MAR-401). A host that declines
     * this gets no Project tab, which is the panel's existing branch.
     */
    | "projectImages"
    /** A coding agent to hand a prompt to (Ask Agent). */
    | "agent"
    /**
     * A notification surface of the host's own, which the page can leave a
     * failure to rather than saying it in the corner itself.
     *
     * VS Code raises a real notification for a failed `/ai` run, carrying a
     * Show Output action the page cannot offer; a message in the editor's
     * corner beside it would be the same event reported twice. Jot's shell has
     * no such surface for the page's own failures, so there the corner IS the
     * notification.
     *
     * What this names is the HOST's ability to speak, never whether a given
     * message is worth speaking. A page-level message that no host duplicates
     * (the content guard's veto) is not gated on this.
     */
    | "notifications"
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
    "spellAndGrammar",
    "readOnlyMode",
    "toc",
    "imageUpload",
    "projectImages",
    "agent",
    "notifications",
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
    jot: ["spellAndGrammar", "imageUpload", "toc", "appPreferences", "agent"] as readonly HostCapability[],
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
    | "fixedToolbarLayout"
    /**
     * The bar's dropdowns open on CLICK rather than on hover, and their
     * triggers are drawn without a disclosure chevron.
     *
     * One arrangement rather than two, because the chevron is the hover
     * affordance: it exists to tell you that resting there will open
     * something. Where the menu waits for a click, the click is the
     * affordance and the chevron is a mark that promises nothing extra.
     * Separating them would let a surface declare a hover menu with no hint
     * that it opens, which is the state neither is worth having on its own.
     *
     * A layout fact, not a capability: both surfaces can do either, and the
     * same commands run from the same menus whichever way they are opened.
     */
    | "barMenusOnClick"
    /**
     * The find bar is drawn the way the platform draws one: a capsule field
     * with the magnifier and the count inside it, Done rather than an ✕, the
     * search OPTIONS (match case, whole word, regular expression, find in
     * selection) in a dropdown rather than as a strip of toggles beside the
     * field, and the replace row disclosed by a labelled toggle on the bar's
     * own row rather than by a chevron spanning both rows.
     *
     * A layout fact and not a capability, which is the distinction that
     * decides where this belongs: every option and every action is still
     * there and still runs the same code, and a surface that declared this
     * would be claiming nothing about what it can do. What it claims is that
     * a window whose every other control is a native one should not carry an
     * editor's toolbelt across the top of its search field.
     *
     * What stays put is the count and the two chevrons: they are read or
     * pressed on every search, where an option is a mode you set once and
     * forget and the replace row is a second half you ask for.
     */
    | "nativeFindBar"
    /**
     * `/date` opens the host's own date picker instead of the editor's
     * calendar. For a surface that is an application and has a system one to
     * show (Birta Writer presents an `NSDatePicker`).
     *
     * An arrangement and not a capability, which is worth stating because the
     * opposite reading is the tempting one. A capability means the host
     * provides something without which the chrome is never built: no agent, no
     * command. Here the date picker exists in full on every surface, the same
     * `/date` opens it, and the day it returns is inserted by the same code
     * spelling it the same way. Only the drawing of the grid differs, which is
     * the definition of an arrangement.
     *
     * The guard settles it independently of the argument: every capability
     * must gate at least one command (`hostProfile.test.ts`), and this one
     * gates none, because VS Code must keep `/date`. A capability that
     * withdraws nothing names nothing.
     */
    | "nativeDatePicker";

export const ALL_HOST_ARRANGEMENTS: readonly HostArrangement[] = [
    "typographyInGearMenu",
    "formattingInSecondRow",
    "fixedToolbarLayout",
    "barMenusOnClick",
    "nativeFindBar",
    "nativeDatePicker",
];

/** One key the host binds itself, for the keyboard cheatsheet to print. */
export interface HostShortcut {
    /** ProseMirror keymap notation (`Mod-Shift-d`), which `kbd()` parses. */
    readonly keys: string;
    /** What it does, in the words the host's own menu uses. */
    readonly label: string;
    /**
     * The editor command the key runs, where it runs one.
     *
     * Absent on a key that is the HOST's own gesture and reaches no command
     * (Save, New Note, the Settings window). Present, it is what lets chrome
     * print the key beside the control that runs the same thing:
     * `webview/commandChords.ts` resolves a command to a chord through this
     * field, so a host that binds ⌘K to Insert Link puts ⌘K in the link
     * button's tooltip without the button knowing which host it is on.
     */
    readonly command?: EditorCommandId;
    /**
     * The host menu the key lives in, which the cheatsheet prints as a section
     * heading above it.
     *
     * Optional because a host with a handful of keys has nothing to group; the
     * panel falls back to one generic heading, so a host that declares less is
     * not a host whose keys disappear.
     */
    readonly section?: string;
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
 * An absent declaration gets the VS Code profile rather than the literal
 * union: every capability except the app-only ones. Getting this wrong puts a
 * standalone app's row on a page that has no such window to put it in.
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
