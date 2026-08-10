/**
 * Every drop line a drag can draw is a slot the move primitive will accept.
 *
 * The drag's slot set and the primitive's legality are decided by two
 * different modules — `components/blockMenu/drag`'s boundary enumeration and
 * `editing/moveBlocks`' `resolveMove` — and until `moveTargetFilter` landed
 * nothing tied them together. The agreement held anyway, because
 * `blockBoundaryPositions` withholds by hand the slots that would break it
 * (an item's lead slot, an artifact-lead item's interior). That is a
 * coincidence maintained by two comments, which is exactly the drift the fold
 * registry is shared to prevent, so this asserts it instead.
 *
 * The invariant, over every fixture in the round-trip corpus and every
 * (grabbable block, offered slot) pair a gesture can express:
 *
 *     offered as a drop line  ⇒  moveBlocks accepts it structurally
 *
 * Stated the useful way round: a user can never aim at a slot whose release
 * does nothing. The two documented exclusions are the put-it-back gesture (a
 * target inside the dragged run, which drag.ts's `dropTargetFor` drops before
 * any line is drawn) and the save-survival refusal, which is deliberately not
 * consulted per slot and announces itself with a notice on release.
 *
 * Folded variants run too: a collapse changes both sides at once (the slot
 * set shrinks, and clause 4 starts refusing fold-hidden targets), so a
 * disagreement between them is likeliest there.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { Editor } from "@milkdown/core";
import { moveFits } from "../editing/moveBlocks";
import { visibleBoundaryPositions } from "../components/blockMenu";
import {
    allFoldablePositions,
    headingFoldPlugin,
    headingFoldPluginKey,
    type HeadingFoldMeta,
} from "../plugins/headingFold";
import {
    editorView,
    enumerateMoveSources,
    loadCorpusFixtures,
    makeCorpusEditor,
} from "./helpers/moveFuzz";

const fixtures = loadCorpusFixtures();

let editors: Editor[] = [];

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
});

async function makeEditor(markdown: string): Promise<Editor> {
    const editor = await makeCorpusEditor(markdown, [headingFoldPlugin]);
    editors.push(editor);
    return editor;
}

/** Every (source, offered slot) pair whose release the primitive would refuse,
 * as readable strings. Empty is the contract. */
function refusedOfferings(editor: Editor): string[] {
    const v = editorView(editor);
    const slots = visibleBoundaryPositions(v.state);
    const refused: string[] = [];
    for (const source of enumerateMoveSources(v)) {
        const range = { from: source.from, to: source.to };
        for (const slot of slots) {
            if (slot.kind !== source.kind) {
                continue; // a run only ever sees slots of its own kind
            }
            if (slot.pos >= range.from && slot.pos <= range.to) {
                continue; // put-it-back: no line is drawn, by design
            }
            if (!moveFits(v.state, range, slot.pos)) {
                const node = v.state.doc.nodeAt(source.pos);
                refused.push(
                    `${node?.type.name ?? "?"} [${range.from},${range.to}) → ${slot.pos}`,
                );
            }
        }
    }
    return refused;
}

describe("every offered drop slot is one the primitive accepts", () => {
    for (const fixture of fixtures) {
        it(`${fixture.name} should offer no slot a drop would refuse`, async () => {
            const editor = await makeEditor(fixture.content);
            expect(refusedOfferings(editor)).toEqual([]);
        }, 30_000);
    }

    for (const fixture of fixtures) {
        it(`${fixture.name} with every section collapsed should offer no refusable slot`, async () => {
            const editor = await makeEditor(fixture.content);
            const v = editorView(editor);
            const positions = allFoldablePositions(v.state.doc);
            if (positions.length === 0) {
                return; // nothing foldable — the unfolded case above is the whole story
            }
            v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, {
                type: "setMany", positions, folded: true,
            } satisfies HeadingFoldMeta));
            expect(refusedOfferings(editor)).toEqual([]);
        }, 30_000);
    }
});
