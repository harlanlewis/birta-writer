import { describe, it, expect, afterEach } from "vitest";
import { initialConfig, DEFAULT_CONFIG } from "../plugins/proofread";
import { ALL_HOST_CAPABILITIES, type HostCapability } from "../../shared/hostProfile";
import type { ProofreadConfig } from "../../shared/messages";

/**
 * Which of the four checks a surface can RUN, decided from the host profile.
 *
 * Spelling and grammar are lints the page posts out for a host engine to
 * answer; style check and the repeated-word check are computed in the page from
 * a table the bundle carries. So the first two are withdrawn where no host
 * answers them and the last two are never withdrawn at all.
 *
 * The defect this exists for is not a wrong branch, it is a SECOND declarer.
 * The Mac shell used to send its own `proofreadingEnabled`, computed by testing
 * its capabilities for a name that a rename had taken out of the union. The
 * expression could then only be false, which held the master gate off: no
 * style-check underlines at all on that surface, and a Checks menu that opened
 * with its body missing, for as long as the shell said so.
 */
type Declared = {
    __i18n?: {
        host?: { capabilities?: readonly HostCapability[] };
        proofread?: Partial<ProofreadConfig>;
        proofreadOptions?: Record<string, boolean>;
    };
};
const g = globalThis as Declared;

describe("initialConfig withdraws the checks a host cannot answer", () => {
    afterEach(() => { delete g.__i18n; });

    it("a host with no lint engine should get the page's own checks and neither lint", () => {
        g.__i18n = { host: { capabilities: ["imageUpload", "toc"] } };
        const config = initialConfig();
        expect(config.spellCheck).toBe(false);
        expect(config.grammarCheck).toBe(false);
        // The half that matters, and the half the old shell got wrong: the
        // master gate and the style check are the page's own and stay on, so
        // the underlines draw.
        expect(config.proofreadingEnabled).toBe(true);
        expect(config.styleCheck).toBe(true);
    });

    it("a host that declares the engine should keep both lints", () => {
        g.__i18n = { host: { capabilities: ["spellAndGrammar"] } };
        const config = initialConfig();
        expect(config.spellCheck).toBe(DEFAULT_CONFIG.spellCheck);
        expect(config.grammarCheck).toBe(DEFAULT_CONFIG.grammarCheck);
        // Both defaults are ON, so the case above is a real withdrawal rather
        // than two reads of a field that was false either way.
        expect(DEFAULT_CONFIG.spellCheck).toBe(true);
        expect(DEFAULT_CONFIG.grammarCheck).toBe(true);
    });

    it("no declaration at all should mean the VS Code profile, which keeps both", () => {
        delete g.__i18n;
        const config = initialConfig();
        expect(config.spellCheck).toBe(true);
        expect(config.grammarCheck).toBe(true);
    });

    it("the withdrawal should be the capability's and no other's", () => {
        // Every OTHER capability, declared alone, still withdraws the pair;
        // `spellAndGrammar` alone does not. Without this the gate could be
        // reading "declared anything at all" and every case above would agree.
        for (const cap of ALL_HOST_CAPABILITIES.filter((c) => c !== "spellAndGrammar")) {
            g.__i18n = { host: { capabilities: [cap] } };
            expect(initialConfig().spellCheck, cap).toBe(false);
        }
        expect(ALL_HOST_CAPABILITIES.length).toBeGreaterThan(1);
    });

    it("a host snapshot should still be honoured for everything it does declare", () => {
        // The withdrawal is applied OVER the host's snapshot, not instead of
        // it: a surface that persists these options keeps its own answers.
        g.__i18n = {
            host: { capabilities: ["spellAndGrammar"] },
            proofread: { styleCheck: false, spellCheck: false },
        };
        const config = initialConfig();
        expect(config.styleCheck).toBe(false);
        expect(config.spellCheck).toBe(false);
        expect(config.grammarCheck).toBe(true);
    });

    it("a host's stored option keys should reach the config they name", () => {
        // The shape a host stores when it keeps what the MENU posted rather
        // than a config it computed. Every key but the gate is 1:1.
        g.__i18n = {
            host: { capabilities: ["spellAndGrammar"] },
            proofreadOptions: { styleCheck: false, fillers: false },
        };
        const config = initialConfig();
        expect(config.styleCheck).toBe(false);
        expect(config.fillers).toBe(false);
        expect(config.cliches).toBe(true);
    });

    it("the master gate's option key should reach the field it is named differently from", () => {
        // The one key whose two vocabularies differ, and the reason this
        // translation exists at all. Stored under the menu's name; read under
        // the config's.
        g.__i18n = {
            host: { capabilities: ["spellAndGrammar"] },
            proofreadOptions: { proofreading: false },
        };
        expect(initialConfig().proofreadingEnabled).toBe(false);
        // And the option key must NOT land on the config verbatim, or every
        // reader would have a stray property to tolerate.
        expect((initialConfig() as Record<string, unknown>)["proofreading"]).toBeUndefined();
    });

    it("a stored key the config has no field for should be dropped", () => {
        // An option from an older build, or a typo in a defaults domain
        // somebody edited. Spreading it in would put a property on the config
        // that nothing declares.
        g.__i18n = {
            host: { capabilities: ["spellAndGrammar"] },
            proofreadOptions: { notARealCheck: false, fillers: false },
        };
        const config = initialConfig() as Record<string, unknown>;
        expect(config["notARealCheck"]).toBeUndefined();
        expect(config["fillers"]).toBe(false);
    });

    it("a stored boolean should not be able to land on a field that is not one", () => {
        // `userWords` and `styleExceptions` are config fields too, and are
        // ARRAYS. A boolean stored under one of them would reach
        // `setUserWords`, which iterates it, so "the field exists" is not the
        // test; "the field is a boolean" is.
        g.__i18n = {
            host: { capabilities: ["spellAndGrammar"] },
            proofreadOptions: { userWords: true, fillers: false },
        };
        const config = initialConfig();
        expect(Array.isArray(config.userWords)).toBe(true);
        expect(config.fillers).toBe(false);
        // The fixture has to name a real non-boolean field, or it is the
        // unknown-key case above wearing a different name.
        expect(Array.isArray(DEFAULT_CONFIG.userWords)).toBe(true);
    });

    it("a non-boolean stored value should be ignored rather than trusted", () => {
        g.__i18n = {
            host: { capabilities: ["spellAndGrammar"] },
            proofreadOptions: { fillers: "yes" as unknown as boolean },
        };
        expect(initialConfig().fillers).toBe(true);
    });

    it("a host snapshot should not be able to switch on a lint its host cannot answer", () => {
        // The order the two are applied in, asserted as the property rather
        // than as a line of code: the capability is the last word, or a stale
        // stored setting would put the page back to posting lints nothing
        // answers. Asserted through BOTH shapes, because either could carry it.
        g.__i18n = {
            host: { capabilities: ["toc"] },
            proofread: { spellCheck: true, grammarCheck: true },
        };
        expect(initialConfig().spellCheck).toBe(false);
        expect(initialConfig().grammarCheck).toBe(false);

        g.__i18n = {
            host: { capabilities: ["toc"] },
            proofreadOptions: { spellCheck: true, grammarCheck: true },
        };
        expect(initialConfig().spellCheck).toBe(false);
        expect(initialConfig().grammarCheck).toBe(false);
    });
});
