/**
 * MAR-390: the check relating the page's outbound vocabulary to what Birta
 * Writer Jot actually parses.
 *
 * `WebviewMessage.parse` files everything it does not know under
 * `.other(type)`, and `Coordinator.handle` answers that with a trace line that
 * goes nowhere in a build a person runs. Most of that gap is correct, because
 * Jot declines most capabilities and the commands that post those messages are
 * never offered. The defect this guards is that nothing distinguished those
 * from a message that IS reachable in Jot and is being dropped, and the two
 * look identical from inside `.other`.
 *
 * The hazard is not hypothetical, and it has now fired three times:
 * `copyAgentReference` (a live palette button that did nothing, found by eye
 * from a screenshot), `agentCancel` (see below), and `agentAttachment`.
 *
 * THE ENUMERATION IS DERIVED FROM THE COMPILER, never from a regex or a line
 * range. This is worth stating because two earlier attempts to count these by
 * text both got it wrong, in opposite directions, on the same declaration: a
 * line-range count swept in `AgentRunMessage`, which is declared between the
 * two unions and belongs to the host-to-page one by name, and a body-scoped
 * regex for `{ type: "..." }` literals missed that same type entirely because
 * it is referenced by name rather than inlined. `tsc` knows the union members
 * and can miss neither.
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_HOST_CAPABILITIES, HOST_PROFILES, type HostCapability } from "../hostProfile";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const messagesPath = join(repoRoot, "shared", "messages.ts");
const bridgePath = join(repoRoot, "jot", "Sources", "BirtaJotCore", "Bridge.swift");

/** The `type` string literals of a message union, straight off the checker. */
function unionMessageTypes(aliasName: string): string[] {
    const program = ts.createProgram([messagesPath], {
        target: ts.ScriptTarget.ES2020,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
    });
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(messagesPath);
    if (!source) throw new Error(`could not load ${messagesPath}`);

    let alias: ts.TypeAliasDeclaration | undefined;
    ts.forEachChild(source, (node) => {
        if (ts.isTypeAliasDeclaration(node) && node.name.text === aliasName) alias = node;
    });
    if (!alias) throw new Error(`no type alias ${aliasName} in shared/messages.ts`);

    const type = checker.getTypeAtLocation(alias.name);
    const members = type.isUnion() ? type.types : [type];
    const names = new Set<string>();
    for (const member of members) {
        const prop = member.getProperty("type");
        if (!prop) throw new Error(`a ${aliasName} member has no \`type\` property`);
        const propType = checker.getTypeOfSymbolAtLocation(prop, alias);
        const literals = propType.isUnion() ? propType.types : [propType];
        for (const lit of literals) {
            if (!lit.isStringLiteral()) throw new Error(`a ${aliasName} \`type\` is not a string literal`);
            names.add(lit.value);
        }
    }
    return [...names].sort();
}

/** The wire names `Bridge.parse`'s switch actually has a case for. */
function bridgeParsedTypes(): string[] {
    const swift = readFileSync(bridgePath, "utf8");
    const start = swift.indexOf("switch type {");
    if (start < 0) throw new Error("Bridge.swift no longer has a `switch type {`; this guard needs rewriting");
    const end = swift.indexOf("\n        }", start);
    if (end < 0) throw new Error("could not find the end of Bridge.swift's parse switch");
    const body = swift.slice(start, end);
    const names = new Set<string>();
    for (const label of body.matchAll(/case ((?:"[^"]+"\s*,?\s*)+):/g)) {
        for (const quoted of label[1].matchAll(/"([^"]+)"/g)) names.add(quoted[1]);
    }
    return [...names].sort();
}

/**
 * Page-to-host types Jot deliberately does not parse, each with the reason.
 *
 * This list is what makes the guard honest. Without it the check is either
 * permanently red or written loosely enough to pass on anything. Adding a
 * message type to `ToExtensionMessage` fails this file until somebody decides
 * which of the three buckets it is in, which is the whole point: a
 * hand-written list is a list a new case never joins, so the LIST is hand
 * written and the ENUMERATION it is checked against is derived.
 */
const DELIBERATELY_UNPARSED: Record<string, string> = {
    // Capabilities Jot does not declare, so the commands that post these are
    // never offered. `HOST_PROFILES.jot` is the declaration.
    connectService: "posted only by a locked embed card's Connect affordance, and no card ever resolves in Jot, so the affordance is never drawn",
    openFile: "no `textEditor` capability: there is no editor to open a file into",
    openKeybindings: "no `hostSettings` capability, which is what gates `openKeyboardShortcuts`: the hotkey is Jot's own setting",
    openSettings: "the extension's own settings window; Jot answers `openHostPreferences` instead",
    switchToTextEditor: "no `textEditor` capability: the panel is the only surface",
    resolveSyncConflict: "Jot never sends `setSyncConflict`, so the badge that posts this cannot appear",
    pickLinkTarget: "no workspace to pick a target from",
    getLinkTargetSuggestions: "no workspace to suggest targets from",
    getPathSuggestions: "no workspace to suggest paths from, so the field offers nothing and stays typable rather than hanging",
    resolveLinkTarget: "no workspace: a link to a project file cannot resolve",
    resolveImagePath: "images are stored relatively beside the note; nothing to resolve against a workspace",
    getProjectImages: "no `projectImages` capability, so the insert panel is handed no loader and hides its Project tab: the question is never asked",
    requestFmSuggestions: "frontmatter suggestions come from a workspace's other documents",
    exportHtml: "no export destination: Jot has no Save As for a rendered file",
    whatsNewSeen: "the extension's release notes; Jot's update offer is its own",

    // ASKED IN JOT, and deliberately not answered, because the page's own
    // documented behaviour without an answer is the behaviour Jot wants. This
    // is the third category rather than a variety of the first: the question
    // IS put, so a reason here has to argue that the silence is right, not
    // that nothing asks.
    requestAgentCapabilities: "the panel renders no model or effort control when capabilities are absent, which is what `shared/messages.ts` says absent means, and is correct for a host that runs no harness probe: `openAgentPanel` does not wait on the reply, so nothing is blocked by it never coming",

    // Editor state the extension persists into workspace/global storage. Jot
    // persists what it wants through its own `viewState` and `setToolbar*`
    // messages, and drops the rest rather than growing a store per setting.
    setBlockHandles: "editor state Jot does not persist; the default stands each launch",
    setCalcAutoInsert: "editor state Jot does not persist",
    setChecklistSink: "editor state Jot does not persist",
    setNoteHighlight: "editor state Jot does not persist",
    setPasteUnfurlAutoApply: "editor state Jot does not persist",
    setProofreadOption: "editor state Jot does not persist",
    setNetworkEnabled: "Jot owns the network switch in its own Settings, not from the page",
    reviewGroupByType: "editor state Jot does not persist",
    spellAddWord: "no user dictionary: Jot has no store for one",
    styleAddException: "no style-exception store",
    lintBlocks: "the extension's linter runs in its host; Jot has none",
    frontmatterUpdate: "the extension mirrors frontmatter into its own state; Jot has no mirror",
    wordCount: "the extension's status bar; Jot has no status bar to put it in",
    fatalParse: "the extension's error sink; Jot reports a crash through its own path",
};

/**
 * Reachable in Jot AND dropped: real defects, each with its ticket.
 *
 * This is `it.fails`'s discipline in list form. It must SHRINK. A type here is
 * a button a person can press in Jot that does nothing, so moving one out is
 * the fix rather than a tidy-up.
 */
const KNOWN_GAPS: Record<string, string> = {
    resolveEmbedCard:
        "MAR-390: `queueEmbedCardResolution` states in its own header that it is deliberately NOT gated on the connection, because the extension reads a public resource anonymously. So the page asks for a card on every connector-capable embed it finds, on every host, and Jot answers none: each request settles null at `CARD_REPLY_TIMEOUT_MS` and no card is drawn where the extension would draw one. Quieter than `getProjectImages`, which sat on Loading, but the same class",
};

describe("Jot's parse table against the page's outbound vocabulary", () => {
    const toHost = unionMessageTypes("ToExtensionMessage");
    const parsed = bridgeParsedTypes();

    /**
     * THE INSTRUMENT REACHED SOMETHING.
     *
     * A derivation that silently returned nothing would make every assertion
     * below vacuous and this file would pass having enumerated none, which is
     * the exact failure AGENTS.md names. These floors are deliberately far
     * below the real counts, so they catch a broken reader without becoming a
     * number that has to be maintained.
     */
    it("the derivation should reach a plausible number of types on both sides", () => {
        expect(toHost.length).toBeGreaterThan(40);
        expect(parsed.length).toBeGreaterThan(15);
    });

    /**
     * THE ONE THAT FOUND A LIVE BUG.
     *
     * A case whose wire name nothing posts is dead, and it reads exactly like
     * a handled message. `stopAgentRun` sat in the parse table for as long as
     * Jot had `/ai`, while the page posted `agentCancel`, so clicking the
     * gutter marker to cancel a run did nothing and `AgentRunner.stop` was
     * unreachable from the page.
     */
    it("every case in Jot's parse table should be a type the page can actually post", () => {
        const stale = parsed.filter((t) => !toHost.includes(t));

        expect(stale, "a parse case nothing posts is dead code that reads as a handled message").toEqual([]);
    });

    /**
     * Every page-to-host type is parsed, deliberately declined with a reason,
     * or a named known gap. A new type belongs to whoever adds it.
     */
    it("every type the page can post should be parsed, declined with a reason, or a named gap", () => {
        const unclassified = toHost.filter(
            (t) => !parsed.includes(t)
                && !(t in DELIBERATELY_UNPARSED)
                && !(t in KNOWN_GAPS));

        expect(
            unclassified,
            "add a case to Bridge.swift, or a reason to DELIBERATELY_UNPARSED, or a ticket to KNOWN_GAPS",
        ).toEqual([]);
    });

    /**
     * A reason may cite a capability, and citing one is a checkable claim.
     *
     * Two kinds of rot this catches, both of which were live in this list: a
     * capability that does not exist at all (`connectors`, `keybindings`),
     * which no reader can verify and no rename would have updated; and one Jot
     * declares, which would make the reason argue the opposite of the truth.
     */
    it("a reason citing a capability should name a real one Jot declines", () => {
        const cited = Object.entries(DELIBERATELY_UNPARSED).flatMap(([type, reason]) =>
            [...reason.matchAll(/`([a-zA-Z]+)` capability/g)].map((m) => [type, m[1]!] as const));

        // The sweep reached something: no citations at all would make the loop
        // below vacuous and this test would pass having checked nothing.
        expect(cited.length).toBeGreaterThan(0);
        for (const [type, cap] of cited) {
            expect(ALL_HOST_CAPABILITIES, `${type} cites a capability that does not exist`)
                .toContain(cap as HostCapability);
            expect(HOST_PROFILES.jot, `${type} cites a capability Jot declares`)
                .not.toContain(cap as HostCapability);
        }
    });

    /** A reason that is not a reason is the loose wording this list exists to prevent. */
    it("every declined type should carry a reason with something in it", () => {
        for (const [type, reason] of Object.entries(DELIBERATELY_UNPARSED)) {
            expect(reason.length, `${type}'s reason is too short to be one`).toBeGreaterThan(20);
        }
    });

    /** The lists must not rot into claims about types that no longer exist. */
    it("the declined list and the gap list should not name a type the page cannot post", () => {
        const declinedGhosts = Object.keys(DELIBERATELY_UNPARSED).filter((t) => !toHost.includes(t));
        const gapGhosts = Object.keys(KNOWN_GAPS).filter((t) => !toHost.includes(t));

        expect([...declinedGhosts, ...gapGhosts]).toEqual([]);
    });

    /** A type cannot be both parsed and declined; that is an unread reason. */
    it("no type should be both parsed and listed as declined", () => {
        const both = parsed.filter((t) => t in DELIBERATELY_UNPARSED || t in KNOWN_GAPS);

        expect(both, "Jot parses these, so their entry is stale and should be deleted").toEqual([]);
    });
});
