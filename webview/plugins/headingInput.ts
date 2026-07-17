/**
 * Absolute `#` heading retype.
 *
 * Milkdown's stock `wrapInHeadingInputRule` ADDS the typed hashes to an
 * existing heading's level (`# ` at the start of an H3 makes an H4, capped
 * at 6). That reads as a bug: everywhere else the hashes you type are the
 * level you get — on a paragraph, in raw markdown, in the gutter menu. This
 * rule replaces it with paragraph semantics for every block: `#`×n + space
 * sets level n outright, whatever the block was before. Seven or more
 * hashes match nothing and stay literal text, exactly as CommonMark treats
 * them.
 *
 * `pureCommonmark` filters the stock rule out via
 * `headingInputReplacedPlugins` (the same replaced-plugins pattern as
 * sourceStyle/tableBreaks); `editor.ts` registers this one instead.
 */
import { textblockTypeInputRule } from "../pm";
import { headingSchema, wrapInHeadingInputRule } from "@milkdown/preset-commonmark";
import { $inputRule } from "@milkdown/utils";

export const headingAbsoluteInputRule = $inputRule((ctx) =>
    textblockTypeInputRule(/^(?<hashes>#{1,6})\s$/, headingSchema.type(ctx), (match) => ({
        level: match.groups?.["hashes"]?.length ?? 1,
    })),
);

/** The stock preset plugin this module replaces. */
export const headingInputReplacedPlugins = new Set<unknown>([wrapInHeadingInputRule]);
