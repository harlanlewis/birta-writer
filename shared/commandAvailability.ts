/**
 * shared/commandAvailability.ts
 *
 * THE predicate every surface asks before offering or running an editor
 * command. One question, four reasons a command can be absent, and no call
 * site that knows how many there are.
 *
 * The reasons are different in kind and identical in effect:
 *
 *   the host cannot answer      no text editor to switch to, no image store,
 *                               no agent (`hostCapability`)
 *   the surface has settled it  Customize Toolbar where the layout is not the
 *                               user's (`absentUnder`)
 *   the target does not spell   an Insert Table button under a CommonMark-only
 *   it                          target (`syntax`, shared/syntaxSets.ts)
 *   there is nothing to act on  Toggle Table of Contents on a document whose
 *                               outline has nothing to show (`setCommandsIdle`)
 *
 * The last is the only one the DOCUMENT decides, and it moves while the page
 * is open, as a syntax target does: a surface that offered a command asks
 * again when told (the toolbar's `refreshOfferedItems`, the host palette's
 * repost), exactly as it does for a target change.
 *
 * The first two meet in `hostHasCommand`, which is the host's own question and
 * stays that. This module adds the third, and exists rather than being folded
 * into that function because a syntax target is the USER'S choice about a
 * document, not a fact about the surface: putting it behind a name that says
 * "host" would make the name lie, and the next reader would go looking for the
 * declaration in a host profile that never had it.
 *
 * The two are read host first, then target, so "why is this absent" is
 * answered by whichever fires first, exactly as capability and arrangement
 * already are inside `hostHasCommand`.
 *
 * `commandAvailable` is what surfaces call, and calling `hostHasCommand`
 * directly from a surface is the mistake to avoid: it answers only two thirds
 * of the question, so a toolbar row and the chord bound to the same command
 * would disagree about whether the tool exists. That is the divergence
 * `hostHasCommand` was itself built to stop, and
 * `shared/__tests__/commandAvailability.test.ts` fails on a surface that
 * reaches past this module.
 */
import { EDITOR_COMMANDS } from "./editorCommands";
import { hostHasCommand } from "./hostProfile";
import { syntaxAllows, type SyntaxFeature } from "./syntaxSets";

/**
 * The syntax each command writes, where it writes one beyond CommonMark.
 *
 * Built from the command metadata rather than kept as a second list here, so a
 * command declares its own target scope beside its title and there is nothing
 * to keep in step.
 */
const COMMAND_SYNTAX: ReadonlyMap<string, SyntaxFeature> = new Map(
    EDITOR_COMMANDS.flatMap((meta) =>
        "syntax" in meta && meta.syntax
            ? [[meta.id, meta.syntax as SyntaxFeature] as const]
            : []),
);

/** The syntax `id` writes, or undefined for a CommonMark command. */
export function commandSyntax(id: string): SyntaxFeature | undefined {
    return COMMAND_SYNTAX.get(id);
}

/**
 * Whether command `id` may be offered here and now: the host can honour it,
 * no arrangement withdraws it, and some enabled syntax set spells what it
 * writes.
 *
 * An unknown id is available, which is the same answer `hostHasCommand` gives
 * and for the same reason: the tables are sparse, so absence from them means
 * "no gate", never "no such command".
 */
export function commandAvailable(id: string): boolean {
    return hostHasCommand(id) && syntaxAllows(COMMAND_SYNTAX.get(id)) && !idleCommands.has(id);
}

/** Commands the document currently gives nothing to act on. */
const idleCommands = new Set<string>();

/**
 * The commands idle right now, for a host whose own menus run editor
 * commands and has to dim them for the same reason every surface here
 * withdraws them (the `idle` half of `paletteCommands`).
 */
export function idleCommandIds(): string[] {
    return [...idleCommands];
}

/**
 * Mark `ids` as having nothing to act on, or something again. Set by the
 * component that owns what the commands act on (the outline, for its own
 * commands), never by a surface. Returns whether anything changed, so the
 * caller re-offers only when it must.
 */
export function setCommandsIdle(ids: readonly string[], idle: boolean): boolean {
    let changed = false;
    for (const id of ids) {
        if (idleCommands.has(id) === idle) { continue; }
        if (idle) { idleCommands.add(id); } else { idleCommands.delete(id); }
        changed = true;
    }
    return changed;
}
