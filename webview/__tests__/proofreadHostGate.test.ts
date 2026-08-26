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
type Declared = { __i18n?: { host?: { capabilities?: readonly HostCapability[] }; proofread?: Partial<ProofreadConfig> } };
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

    it("a host snapshot should not be able to switch on a lint its host cannot answer", () => {
        // The order the two are applied in, asserted as the property rather
        // than as a line of code: the capability is the last word, or a stale
        // stored setting would put the page back to posting lints nothing
        // answers.
        g.__i18n = {
            host: { capabilities: ["toc"] },
            proofread: { spellCheck: true, grammarCheck: true },
        };
        const config = initialConfig();
        expect(config.spellCheck).toBe(false);
        expect(config.grammarCheck).toBe(false);
    });
});
