/**
 * Every plugin `serialization.ts` filters out of a Milkdown preset must still
 * BE in that preset.
 *
 * `pureCommonmark` and `gfmFidelity` are built by removing stock plugins and
 * registering replacements. A filter that silently stops matching does not
 * error — it leaves the stock plugin registered alongside ours, and what
 * happens next depends on the plugin: a schema override still wins (it
 * registers later), but a REMARK transform runs anyway, and an INPUT RULE
 * fires alongside its replacement. The worst case is `remarkInlineLinkPlugin`,
 * which rewrites `[text][ref]` inline and DELETES the `[ref]: url`
 * definitions before the transformer ever sees them.
 *
 * This is the guard `keepTableAlign.test.ts` already had for its own filter
 * (`expect(gfm).toContain(upstreamKeepTableAlign)`), generalized to the seven
 * that had none. It is written for the Milkdown-upgrade PR: a rename, a
 * removal, or a re-export that changes plugin identity fails HERE, naming the
 * plugin, rather than surfacing days later as a fidelity bug.
 *
 * `remarkInlineLinkPlugin` is the one filtered by `meta.displayName` rather
 * than by identity, because it is absent from the preset's `.d.ts` — so it is
 * also the one most likely to drift. It gets its own case.
 */
import { describe, it, expect } from "vitest";
import { commonmark, remarkPreserveEmptyLinePlugin } from "@milkdown/preset-commonmark";
import { gfm, keepTableAlignPlugin } from "@milkdown/preset-gfm";
import { emphasisInputReplacedPlugins } from "../plugins/emphasisInput";
import { headingInputReplacedPlugins } from "../plugins/headingInput";
import { imageStringAttrReplacedPlugins } from "../plugins/image";
import { listSpreadReplacedPlugins } from "../plugins/list";
import { strikethroughHtmlReplacedPlugins } from "../plugins/pasteHtml";
import { sourceStyleReplacedPlugins } from "../plugins/sourceStyle";
import { tableBreakReplacedPlugins } from "../plugins/tableBreaks";
import { gfmFidelity, pureCommonmark } from "../serialization";

/** The `withMeta` display name a plugin carries, if any. */
function displayName(plugin: unknown): string | undefined {
    return (plugin as { meta?: { displayName?: string } }).meta?.displayName;
}

const COMMONMARK_SETS: [string, Set<unknown>][] = [
    ["sourceStyleReplacedPlugins", sourceStyleReplacedPlugins],
    ["tableBreakReplacedPlugins", tableBreakReplacedPlugins],
    ["listSpreadReplacedPlugins", listSpreadReplacedPlugins],
    ["imageStringAttrReplacedPlugins", imageStringAttrReplacedPlugins],
    ["headingInputReplacedPlugins", headingInputReplacedPlugins],
    ["emphasisInputReplacedPlugins", emphasisInputReplacedPlugins],
];

describe("preset filter identity", () => {
    for (const [name, set] of COMMONMARK_SETS) {
        it(`every plugin in ${name} should still be a member of the commonmark preset`, () => {
            expect(set.size).toBeGreaterThan(0);
            for (const plugin of set) {
                expect(commonmark, `${name}: a member is no longer in commonmark`).toContain(plugin);
            }
        });
    }

    it("every plugin in strikethroughHtmlReplacedPlugins should still be a member of the gfm preset", () => {
        expect(strikethroughHtmlReplacedPlugins.size).toBeGreaterThan(0);
        for (const plugin of strikethroughHtmlReplacedPlugins) {
            expect(gfm).toContain(plugin);
        }
    });

    it("remarkPreserveEmptyLinePlugin's two halves should still be members of the commonmark preset", () => {
        // Filtered by identity on `.plugin` and `.options` separately; a
        // composed plugin that stopped exposing both would leave one behind.
        expect(commonmark).toContain(remarkPreserveEmptyLinePlugin.plugin);
        expect(commonmark).toContain(remarkPreserveEmptyLinePlugin.options);
    });

    it("both halves of remarkInlineLinkPlugin should still carry its display name", () => {
        // The string filter's premise: the plugin is unnamed in the preset's
        // .d.ts, so `serialization.ts` matches `meta.displayName`. If upstream
        // renames it the filter goes quiet and reference-style links start
        // losing their `[ref]: url` definitions on every save.
        //
        // A `$remark` plugin contributes a PAIR — `Remark<name>` and
        // `RemarkConfig<name>` — exactly like `remarkPreserveEmptyLinePlugin`'s
        // `.plugin` / `.options`. Both must match, so assert on the shape
        // rather than the count: a rename of either half alone would otherwise
        // still total two and slip through.
        const names = commonmark
            .map(displayName)
            .filter((name): name is string => !!name?.includes("remarkInlineLinkPlugin"));
        expect(new Set(names)).toEqual(
            new Set(["Remark<remarkInlineLinkPlugin>", "RemarkConfig<remarkInlineLinkPlugin>"]),
        );
        expect(names).toHaveLength(2);
    });

    it("keepTableAlignPlugin should still be a member of the gfm preset", () => {
        // Not filtered any more — 7.22.0's version is ours — but gfmFidelity
        // still depends on the plugin BEING there, because that is what pays
        // for `tableAlignDefaultPlugin`'s null default to stay consistent
        // across a column. If upstream ever drops it, the alignment behavior
        // in keepTableAlign.test.ts goes with it.
        expect(gfm).toContain(keepTableAlignPlugin);
    });

    it("the built presets should be smaller than the stock ones by exactly what was filtered", () => {
        // A count check catches the inverse failure the membership checks
        // cannot: a filter predicate that matches MORE than intended (an
        // upstream refactor making two plugins share an identity, say).
        const commonmarkRemoved =
            sourceStyleReplacedPlugins.size +
            tableBreakReplacedPlugins.size +
            listSpreadReplacedPlugins.size +
            imageStringAttrReplacedPlugins.size +
            headingInputReplacedPlugins.size +
            emphasisInputReplacedPlugins.size +
            2 + // remarkPreserveEmptyLinePlugin.plugin + .options
            2; // remarkInlineLinkPlugin's Remark + RemarkConfig halves
        const kept = pureCommonmark.filter((plugin) => commonmark.includes(plugin));
        expect(kept).toHaveLength(commonmark.length - commonmarkRemoved);

        const gfmRemoved = strikethroughHtmlReplacedPlugins.size;
        const gfmKept = gfmFidelity.filter((plugin) => gfm.includes(plugin));
        expect(gfmKept).toHaveLength(gfm.length - gfmRemoved);
    });
});
