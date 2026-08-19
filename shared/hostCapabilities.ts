/**
 * shared/hostCapabilities.ts
 *
 * The registry of which features live in which surface (MAR-373, MAR-370).
 *
 * The contract: Jot ships zero behavior Birta lacks. Every surface runs the
 * same editor from the same bundle, and what differs between them is only the
 * chrome that names something the HOST provides. A capability is therefore
 * always a host-side thing (a text editor to switch to, a settings UI, a
 * proofreading engine with its review sidebar, an owner for read-only mode, a
 * TOC sidebar, an image store), never an editor feature. An editor feature is
 * gated by its own `birta.*` setting, not here.
 *
 * The host declares its capabilities in `window.__i18n.hostCapabilities`
 * (src/webviewHtml.ts bakes the full list for VS Code). ABSENT MEANS THE VS CODE PROFILE, so
 * an existing page that never heard of the field keeps every item it ever
 * had; an explicit `[]` is a host with none. Consumers ask `hostHas(cap)` or
 * `hostHasCommand(id)` and never read the field directly, so the absent-means-
 * all rule has one home.
 *
 * Dependency-free (no vscode, no DOM types) so both the extension and the
 * webview import it; the read of the declaration goes through `globalThis`,
 * which is `window` in every webview.
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
 * names nothing at all; `hostCapabilities.test.ts` checks both directions.
 */
export const APP_ONLY_CAPABILITIES: readonly HostCapability[] = ["appPreferences"];

export const HOST_PROFILES = {
    vscode: ALL_HOST_CAPABILITIES.filter(
        (c) => !APP_ONLY_CAPABILITIES.includes(c),
    ) as readonly HostCapability[],
    // The Jot shell (`Prefs.bootConfig` in jot/Sources/BirtaJot/Preferences.swift)
    // and the e2e Jot page restate this list as a literal, because neither
    // Swift nor an HTML bootstrap can import it. They are not free to drift:
    // shared/__tests__/hostCapabilities.test.ts parses both and fails.
    jot: ["imageUpload", "appPreferences", "agent"] as readonly HostCapability[],
} as const satisfies Record<string, readonly HostCapability[]>;

interface HostDeclaration {
    __i18n?: { hostCapabilities?: readonly HostCapability[] };
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
    const declared = (globalThis as HostDeclaration).__i18n?.hostCapabilities;
    if (declared === undefined) { return !APP_ONLY_CAPABILITIES.includes(cap); }
    return declared.includes(cap);
}

const COMMAND_CAPABILITY: ReadonlyMap<string, HostCapability> = new Map(
    EDITOR_COMMANDS.flatMap((meta) =>
        "hostCapability" in meta && meta.hostCapability
            ? [[meta.id, meta.hostCapability] as const]
            : []),
);

/**
 * Whether the host can honour editor command `id`: true for every command
 * that requires no capability, and for a gated one exactly when the host
 * declares its capability. The one predicate every surface that offers or
 * runs a command (toolbar, gear menu, slash menu, `runEditorCommand`) reads,
 * so a chord, a palette pick and a menu row can never disagree.
 */
export function hostHasCommand(id: string): boolean {
    const cap = COMMAND_CAPABILITY.get(id);
    return cap === undefined || hostHas(cap);
}
