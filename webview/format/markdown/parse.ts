/**
 * webview/format/markdown/parse.ts — the markdown format's parse half, with
 * nothing that draws (MAR-430).
 *
 * `index.ts` composes the whole format from this plus its NodeViews. The
 * split exists for one consumer: the save pipeline's verify worker
 * (workers/verifyWorker.ts) builds a parser from these presets in a context
 * that has no document, and a module that imports a component reads `window`
 * while it loads. Two guards hold the split:
 *
 * - it stays importable with no DOM, which
 *   `shared/__tests__/headlessParserNoDom.test.ts` asks under Node;
 * - the parser it builds is the page's, which
 *   `webview/__tests__/headlessParser.test.ts` asks against the live editor
 *   over the whole corpus, node for node.
 *
 * The page and the worker build from the SAME objects, so the second guard
 * can only go red if a preset is constructed differently in the two places,
 * and this file is where that would have to happen.
 */
import { configureSerialization, gfmFidelity, pureCommonmark } from "../../serialization";
import type { FormatParse } from "../types";

export const markdownParse: FormatParse = {
    // Order matters: gfmFidelity's overrides must register after
    // pureCommonmark, exactly as `.use(gfm)` always followed the base preset
    // (see the gfmFidelity charter in serialization.ts).
    presets: [pureCommonmark, gfmFidelity],
    configureSerialization,
};
