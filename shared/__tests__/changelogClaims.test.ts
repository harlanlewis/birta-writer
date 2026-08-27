/**
 * Guards the CHECKABLE half of a CHANGELOG entry's truthfulness.
 *
 * Most of what makes an entry honest is judgement and cannot be automated:
 * whether a fix's scope is stated, whether "never" is defensible, whether two
 * entries describe the same gesture without saying so. Those stay in
 * `AGENTS.md` and in review. But two classes ARE mechanical, and both were
 * shipped wrong in a single session (2026-08-06) despite the prose rule being
 * read and quoted at the time:
 *
 *   - a `birta.*` setting key that no longer exists, or never did. The
 *     CHANGELOG cites 30+ of them; a rename silently turns every prior
 *     mention into a lie, and nothing pointed from the setting back to the
 *     entries naming it.
 *   - a quoted UI string the product does not actually say. That session's
 *     entry quoted `"Move blocked, the result would not survive saving and
 *     reopening."` — the editor emits an em dash there, and the drag path
 *     emits "Drop blocked" rather than "Move blocked", so one quotation was
 *     offered for two surfaces with different strings.
 *
 * This file is in the repo's guard tradition (`noColorLiterals`,
 * `thirdPartyNotices`, the `prose-guard` hook): when prose guidance is
 * violated repeatedly, the rule becomes code. It is a test rather than a hook
 * on purpose — it runs in CI's `unit-test` job, so it blocks a PR rather than
 * only nudging whoever happens to have the hook installed.
 *
 * Punctuation note: the `prose-guard` hook forbids em dashes in `CHANGELOG.md`,
 * and real UI strings contain them, so a verbatim quotation is impossible by
 * construction. Matching therefore normalizes dashes and quotes on BOTH sides.
 * That is a deliberate hole: it means this check cannot catch a
 * punctuation-only misquote, only a quotation of something the product never
 * says. Do not widen it into a byte-exact check without first retiring the
 * hook, or every honest entry goes red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
// BOTH changelogs. They are split by product (AGENTS.md, "Writing the CHANGELOG
// entry"), and a guard that reads only the extension's would quietly stop
// checking every entry the split moved: 35 of them, citing settings and quoting
// UI copy exactly as before. Scope has to follow the content it was written for.
const CHANGELOG = [
    readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"),
    readFileSync(join(ROOT, "mac/CHANGELOG.md"), "utf8"),
].join("\n");

/**
 * Setting keys a CHANGELOG entry names as REMOVED. An entry recording a
 * removal necessarily cites a key that is no longer live, so the check would
 * otherwise make it impossible to document one. Each needs the entry's own
 * words, so a key cannot be parked here to silence a typo.
 */
const RETIRED_SETTINGS: Record<string, string> = {
    // (empty today: the pre-rename `markdownWysiwyg.*` keys are not `birta.*`
    // and so never reach this check. Add here only with the entry's wording.)
};

/**
 * Every `birta.*` identifier the extension contributes: settings AND commands.
 *
 * Both, because the citation regex below cannot tell them apart and should not
 * have to. What the guard is for is that an identifier a reader might paste into
 * their settings or their keybindings actually exists, and a command id is as
 * paste-able as a setting key. Reading only the settings made a true entry
 * naming a real command fail as a stale citation.
 *
 * A command withdrawn from the palette still counts as contributed: it is
 * bindable in `keybindings.json`, which is the whole reason an entry would name
 * it rather than the menu row it sits behind.
 */
function liveBirtaIds(): Set<string> {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const ids = new Set<string>();
    const config = pkg.contributes?.configuration;
    const blocks = Array.isArray(config) ? config : [config];
    for (const block of blocks) {
        for (const key of Object.keys(block?.properties ?? {})) ids.add(key);
    }
    for (const command of pkg.contributes?.commands ?? []) {
        if (typeof command?.command === "string") { ids.add(command.command); }
    }
    return ids;
}

describe("CHANGELOG setting-key citations", () => {
    it("every birta.* key the CHANGELOG names should still exist, or be recorded as retired", () => {
        const live = liveBirtaIds();
        const cited = [...CHANGELOG.matchAll(/`(birta\.[A-Za-z0-9.]+)`/g)].map((m) => m[1]!);
        expect(cited.length, "no keys cited — this guard would be vacuous").toBeGreaterThan(10);

        const stale = [...new Set(cited)].filter((k) => !live.has(k) && !(k in RETIRED_SETTINGS));
        expect(
            stale,
            "a CHANGELOG entry names a setting or command that does not exist. Either the " +
                "id is wrong, or it was renamed and the entries naming it are now false. If " +
                "it was deliberately removed, add it to RETIRED_SETTINGS with the entry's wording.",
        ).toEqual([]);
    });

    it("the guard should be reading commands as well as settings", () => {
        // Without this, narrowing `liveBirtaIds` back to settings alone would
        // pass on any CHANGELOG that happens to cite no command, and the next
        // entry that cites one would fail for a reason nobody could act on.
        const live = liveBirtaIds();
        const settingsOnly = [...live].filter((id) => !id.startsWith("birta.editor."));
        expect(live.size).toBeGreaterThan(settingsOnly.length);
        expect(live.has("birta.editor.toggleStyleOption")).toBe(true);
    });
});

/** Source files a user-visible string could plausibly live in. */
function sourceText(): string {
    const roots = ["webview", "src", "shared", "mac/Sources"];
    const parts: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
            const full = join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else if (/\.(ts|tsx|json|swift)$/.test(name)) parts.push(readFileSync(full, "utf8"));
        }
    };
    for (const r of roots) walk(join(ROOT, r));
    parts.push(readFileSync(join(ROOT, "package.json"), "utf8"));
    return parts.join("\n");
}

/**
 * Fold the punctuation the prose-guard hook forces apart, so a quotation
 * that had to be written with a comma still matches a source string using an
 * em dash. See the header: this is why the check cannot be byte-exact.
 */
function normalize(text: string): string {
    return text
        .replace(/[—–]/g, ",") // em/en dash to comma
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/\s*,\s*/g, ",")
        .replace(/\s+/g, " ")
        .replace(/[.!?]+$/, "")
        .trim()
        .toLowerCase();
}

/**
 * Quotations of text some OTHER program shows the user. An entry explaining
 * how Birta interacts with its host legitimately quotes the host, and that
 * string will never be in our source. Each needs the emitting program named,
 * so a quotation cannot be parked here to silence a mistake about our own
 * copy. Found by this check's first run, which is the intended use: an
 * exemption is a decision someone made and wrote down, not a hole.
 */
const FOREIGN_QUOTES: Record<string, string> = {
    "Do you want to save...?": "VS Code's own unsaved-changes dialog, attributed as such in the entry",
};

describe("CHANGELOG quoted UI copy", () => {
    it("a sentence the CHANGELOG puts in quotes should be a string the product actually says", () => {
        // Sentence-shaped: starts with a capital, long enough to be copy
        // rather than a term of art, and contains a space. Short quoted
        // fragments ("customizable commands") are prose, not quotation.
        const quoted = [...CHANGELOG.matchAll(/"([A-Z][^"]{14,})"/g)]
            .map((m) => m[1]!)
            .filter((q) => !(q in FOREIGN_QUOTES));
        if (quoted.length === 0) return; // nothing to check is a pass, not a failure

        const haystack = normalize(sourceText());
        const missing = quoted.filter((q) => !haystack.includes(normalize(q)));
        expect(
            missing,
            "the CHANGELOG quotes text the product does not contain. A user reads a " +
                "quotation as what they will see on screen. Check the real string " +
                "(including which surface emits it, since two surfaces often differ), " +
                "or describe the message instead of quoting it.",
        ).toEqual([]);
    });
});
