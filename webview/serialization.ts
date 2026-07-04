/**
 * Markdown serialization configuration, shared by the editor and by the
 * round-trip tests so both exercise the exact same serializer behavior.
 */
import { remarkStringifyOptionsCtx, type Editor } from "@milkdown/core";
import { commonmark, remarkPreserveEmptyLinePlugin } from "@milkdown/preset-commonmark";
import { fidelitySerializerPlugin } from "./plugins/fidelitySerializer";
import { referenceLinksPlugin } from "./plugins/referenceLinks";
import { mathPlugin } from "./plugins/math";

type EditorCtx = Parameters<Parameters<Editor["config"]>[0]>[0];

/**
 * The commonmark preset minus two of Milkdown's remark transforms, plus our
 * reference-link schemas.
 *
 * `remark-preserve-empty-line` round-trips empty paragraphs (and empty table
 * cells) as literal `<br />` HTML, which pollutes a file that should stay
 * pure Markdown. With it removed, empty paragraphs degrade to blank lines —
 * the closest Markdown has to an empty paragraph — and empty table cells
 * serialize as genuinely empty cells. Standalone `<br />` lines already
 * present in a file are no longer swallowed on parse either; they stay as
 * inert HTML nodes and round-trip unchanged.
 *
 * `remark-inline-links` rewrites `[text][ref]` into inline links and DELETES
 * the `[ref]: url` definitions before the ProseMirror transformer runs, so
 * reference-style documents were silently restructured. With it removed, the
 * `definition` / `linkReference` / `imageReference` mdast nodes reach the
 * transformer and are modeled by `referenceLinksPlugin`
 * (plugins/referenceLinks.ts), keeping the reference form intact. The plugin
 * is absent from the preset's .d.ts, so it is filtered by its withMeta
 * displayName rather than by identity.
 *
 * `fidelitySerializerPlugin` (plugins/fidelitySerializer.ts) swaps the stock
 * `SerializerState` for a vendored, patched copy that keeps a link
 * containing bold/italic/code children serialized as ONE link instead of
 * several adjacent same-URL links, and defers emphasis edge-space trimming
 * until after adjacent mark segments have merged.
 *
 * `mathPlugin` (plugins/math.ts) adds KaTeX inline/block math: `remark-math`
 * for parsing/serializing `$...$` and `$$...$$`, a visitor that routes block
 * math through the fenced-code-block machinery, and a `code_block` schema
 * extension that serializes LaTeX-language blocks back to `$$`. It is placed
 * after the base preset so the `code_block` extendSchema overrides the stock
 * commonmark definition.
 */
export const pureCommonmark = [
    ...commonmark.filter((plugin) => {
        if (
            plugin === remarkPreserveEmptyLinePlugin.plugin ||
            plugin === remarkPreserveEmptyLinePlugin.options
        ) {
            return false;
        }
        const displayName = (plugin as { meta?: { displayName?: string } }).meta?.displayName;
        return !(displayName?.includes("remarkInlineLinkPlugin"));
    }),
    ...referenceLinksPlugin,
    ...mathPlugin,
    fidelitySerializerPlugin,
];

// Custom table serializer: every column keeps its natural width, with no
// column-width alignment. Overrides the remark-gfm default table handler,
// which pads all columns to equal width and therefore reformats the whole
// table when a single cell is edited.
// state.enter/exit maintain the mdast-util-to-markdown context stack, which
// drives the escaping rules for special characters.
function serializeTableNoAlign(node: any, _parent: any, state: any): string {
    const tableExit = state.enter("table");
    const lines: string[] = [];

    for (let rowIdx = 0; rowIdx < node.children.length; rowIdx++) {
        const row = node.children[rowIdx];
        const rowExit = state.enter("tableRow");

        const cellValues: string[] = row.children.map((cell: any) => {
            const cellExit = state.enter("tableCell");
            const phrasingExit = state.enter("phrasing");
            const value = state.containerPhrasing(cell, { before: "|", after: "|" });
            phrasingExit();
            cellExit();
            return value;
        });

        rowExit();
        lines.push("| " + cellValues.join(" | ") + " |");

        // After the header row, insert the separator row, keeping the original
        // alignment markers (:---:, ---:, :---, ---)
        if (rowIdx === 0) {
            const aligns: (string | null)[] = node.align ?? [];
            const seps = row.children.map((_: any, j: number) => {
                const a = aligns[j] ?? null;
                if (a === "center") return ":---:";
                if (a === "right") return "---:";
                if (a === "left") return ":---";
                return "---";
            });
            lines.push("|" + seps.join("|") + "|");
        }
    }

    tableExit();
    return lines.join("\n");
}

/**
 * Apply the stringify options that keep serializer output close to the
 * original file formatting: `-` bullets, `---` rules (instead of `***`), and
 * the natural-width table handler.
 */
export function configureSerialization(ctx: EditorCtx): void {
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({
        ...prev,
        bullet: "-" as const,
        rule: "-" as const,
        handlers: {
            ...(prev.handlers ?? {}),
            table: serializeTableNoAlign,
        },
    }));
}
