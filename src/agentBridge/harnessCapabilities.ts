/**
 * What the configured harness accepts, asked of the harness itself.
 *
 * The `/ai` panel offers a model and an effort. Both are flags on somebody
 * else's CLI, and there are only three places that knowledge could come
 * from: a list Birta ships (rots on every model release, and is wrong for
 * any harness nobody thought of), a list the user maintains by hand (config
 * for a thing they already told their harness), or the harness. This module
 * is the third. Nothing here names a vendor, a model, or a flag value.
 *
 * `--help` is the contract because it ships WITH the harness, so it is
 * current by construction: a CLI that gains an effort level documents it in
 * the same release that accepts it. It costs two process spawns, which is
 * cheap once per harness version and far too expensive in front of a panel;
 * `time claude --help` is the measurement, not a number written here.
 *
 * What it can and cannot learn, measured rather than assumed:
 *   - whether a flag exists, and its exact spelling: reliable.
 *   - the values of an ENUMERATED flag (`--effort <level>` documents
 *     `(low, medium, high, xhigh, max)`): reliable when the help lists them.
 *   - the set of models: whatever the help gives, which for the one harness
 *     this was checked against (Claude Code) is prose examples rather than a
 *     list. That is an observation about that CLI, not a law about CLIs, so
 *     the model paragraph is read by the SAME two passes as any other: an
 *     enumeration if it has one, quoted examples otherwise. A harness that
 *     does publish its models therefore gets a real list for free, and one
 *     that does not is not misrepresented as having given one.
 *
 * That last distinction is the one thing here that must not be flattened.
 * `modelExamples` is named for the weaker case because the weaker case is
 * what has actually been seen, and a model absent from it may work perfectly
 * well. Free text stays reachable in the UI for exactly that reason.
 *
 * A parse that finds nothing is not a failure to paper over: the control it
 * would have driven is simply not offered, and the user's template runs
 * exactly as it does today. Never a wrong flag; at worst an absent picker.
 */

import type { HarnessCapabilities } from "../../shared/messages";

export type { HarnessCapabilities };

/**
 * The help paragraph belonging to `flag`, or null when the flag is absent.
 *
 * A flag's paragraph runs from its own line until the next flag line, the
 * next unindented line (help sections start at column 0 while a flag's
 * continuation lines are indented), or the end of the text. That is the
 * shape every commander/clap/cobra CLI prints.
 *
 * Anchored at line start with leading whitespace so `--model` does not match
 * inside `--fallback-model`: the two are different flags, and reading one as
 * the other would set the wrong thing.
 *
 * The end-of-text alternative is `(?![\s\S])` rather than `$` because `m` is
 * needed for the leading anchor, and under `m` a `$` matches the end of
 * every LINE, which ends each paragraph at its first line and quietly loses
 * the values and examples that are the point of reading it.
 */
export function helpParagraph(help: string, flag: string): string | null {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
        // The short-alias prefix, which clap prints as `-m, --model <MODEL>`
        // and argparse as `-m MESSAGE, --message MESSAGE`, so the alias may
        // carry a metavar of its own. Without this the long flag is not at
        // the start of its own line and the paragraph is missed entirely,
        // which is how Codex reported no model support while documenting one.
        `^[ \\t]+(?:-[^\\s,]+(?:[ =][^\\s,]+)?,[ \\t]*)*${escaped}` +
        // The metavar, in the three shapes help formatters print. Angled is
        // commander and clap (`<model>`); BARE UPPERCASE is argparse and
        // click (`MODEL`, `TEXT`), which is most of the Python ecosystem and
        // matched nothing at all until it was added; bracketed is optional
        // arguments (`[search]`). Uppercase must be the WHOLE token, or a
        // description beginning with an ordinary capitalised word ("Use
        // open-source provider") would be eaten as the flag's metavar.
        `[ =](?:<[^>]+>|\\[[^\\]]+\\]|[A-Z][A-Z0-9_]*(?![a-z]))` +
        `[.]*(.*?)(?=\\n\\s*-{1,2}[\\w-]|\\n\\S|(?![\\s\\S]))`,
        "ms",
    );
    const m = re.exec(help);
    // The description may sit on the flag's own line (commander, pi) or on the
    // following indented lines (clap). Both land in the same capture, because
    // the group runs to the next flag or the next unindented line either way.
    return m ? (m[1] ?? "").split(/\s+/).join(" ").trim() : null;
}

/**
 * The first spelling of a concept this help documents, with its paragraph.
 *
 * The SPELLINGS are the only vendor knowledge in this module, and they are
 * the stable half: what a CLI calls its reasoning knob changes far more
 * slowly than which models it offers, and a name missing here costs one
 * absent control rather than a wrong flag. The VALUES are still read from
 * the help, never from a list here.
 */
export function findFlag(
    help: string,
    spellings: readonly string[],
): { flag: string; paragraph: string } | null {
    for (const flag of spellings) {
        const paragraph = helpParagraph(help, flag);
        if (paragraph !== null) { return { flag, paragraph }; }
    }
    return null;
}

/**
 * The harness a template runs: the first word of the command (`claude`,
 * `codex`, `pi`), which is the one thing about it the editor can know.
 *
 * Lives in this module rather than beside the dispatcher because both the
 * dispatcher and the probe need it, and the probe importing the dispatcher
 * for it made a cycle. Which MODEL answered is still the harness's own
 * business; this is only its name.
 */
export function harnessName(template: string): string {
    const first = template.trim().split(/\s+/)[0] ?? "";
    return first.replace(/^.*[\\/]/, "") || "agent";
}

/** What a CLI may call the model flag. */
export const MODEL_FLAGS = ["--model"] as const;
/**
 * What a CLI may call the reasoning-effort flag, for the case where it names
 * itself but enumerates nothing. Both entries are VERIFIED against installed
 * binaries: Claude Code says `--effort`, pi says `--thinking`. Nothing
 * speculative belongs here; an unverified guess is the same n-of-1 error as
 * a parser written against one CLI, and `effortFlagFromValues` below is the
 * path that does not need the name at all.
 */
export const EFFORT_FLAGS = ["--effort", "--thinking"] as const;

/**
 * Every long flag the help documents, with its paragraph.
 *
 * The enumeration is what lets a control be found by the SHAPE of what it
 * accepts rather than by its name, which is the difference between a list
 * that has to be maintained per vendor and one that does not.
 */
export function allFlags(help: string): Array<{ flag: string; paragraph: string }> {
    const out: Array<{ flag: string; paragraph: string }> = [];
    // Same alias prefix and same three metavar shapes as helpParagraph; the
    // two must agree, or a flag found here has no paragraph and one found
    // there is absent from the sweep that hunts for the effort scale.
    const flagLine =
        /^[ \t]+(?:-[^\s,]+(?:[ =][^\s,]+)?,[ \t]*)*(--[\w-]+)[ =](?:<[^>]+>|\[[^\]]+\]|[A-Z][A-Z0-9_]*(?![a-z]))/gm;
    for (const m of help.matchAll(flagLine)) {
        const flag = m[1]!;
        if (out.some((f) => f.flag === flag)) { continue; }
        const paragraph = helpParagraph(help, flag);
        if (paragraph !== null) { out.push({ flag, paragraph }); }
    }
    return out;
}

/** A scale is an effort scale when it offers at least these three rungs. */
const EFFORT_RUNGS = ["low", "medium", "high"];

/**
 * The flag whose documented values look like a reasoning scale, whatever it
 * is called.
 *
 * This is the mechanism; the name list is the fallback. Claude Code's
 * `--effort` and pi's `--thinking` are the same control under different
 * words, and both enumerate low/medium/high among their rungs, so the values
 * identify it where the name cannot. A harness inventing a third name for it
 * is then found on the day it ships rather than on the day someone adds a
 * string here.
 *
 * The three rungs are required TOGETHER because one alone is not evidence: a
 * `--compression` or `--quality` flag might offer `high`, but a low/medium/
 * high triple on a coding agent's flag is the reasoning knob. A false
 * positive costs a wrong control rather than a wrong command, since the
 * value still comes from the flag's own documented set.
 */
export function effortFlagFromValues(
    help: string,
): { flag: string; paragraph: string } | null {
    for (const candidate of allFlags(help)) {
        if (MODEL_FLAGS.includes(candidate.flag as (typeof MODEL_FLAGS)[number])) { continue; }
        const values = enumeratedValues(candidate.paragraph);
        if (EFFORT_RUNGS.every((rung) => values.includes(rung))) { return candidate; }
    }
    return null;
}

/**
 * Values a paragraph enumerates as `(a, b, c)`. Three or more, lowercase
 * words: a pair in parentheses is far more often prose than a value list,
 * and a wrong scale in front of the user is worse than no scale.
 */
export function enumeratedValues(paragraph: string): string[] {
    // Two shapes, both seen in the wild: parenthesised, as Claude Code prints
    // `(low, medium, high, xhigh, max)`, and trailing after a colon, as pi
    // prints `Set thinking level: off, minimal, low, ...`. The colon form has
    // to run to the end of the paragraph, or it would stop at the first comma
    // and report a list of two.
    const parens = /\(([a-z0-9][a-z0-9-]*(?:,\s*[a-z0-9][a-z0-9-]*){2,})\)/.exec(paragraph);
    const colon = /:\s*([a-z0-9][a-z0-9-]*(?:,\s*[a-z0-9][a-z0-9-]*){2,})\s*$/.exec(paragraph);
    const m = parens ?? colon;
    return m ? m[1]!.split(",").map((v) => v.trim()).filter(Boolean) : [];
}

/**
 * Names a paragraph quotes, as examples to suggest. Single-quoted tokens
 * are the convention help text uses for a literal value the user may type.
 */
export function quotedExamples(paragraph: string): string[] {
    return [...new Set([...paragraph.matchAll(/'([a-z0-9][a-z0-9.\-]*)'/g)].map((m) => m[1]!))];
}

/**
 * Read one harness's help into capabilities. Pure, so the whole contract is
 * testable against captured help text with nothing spawned.
 */
export function parseHarnessHelp(
    harness: string,
    version: string,
    help: string,
): HarnessCapabilities {
    const model = findFlag(help, MODEL_FLAGS);
    // Shape first, name second. A flag documenting a low/medium/high scale is
    // the reasoning control whatever it is called, and only a flag that names
    // itself without enumerating anything needs the list.
    const effort = effortFlagFromValues(help) ?? findFlag(help, EFFORT_FLAGS);
    // An enumeration first, examples second. Claude Code's model paragraph
    // has only examples, but that is one data point rather than a rule, and
    // reading a harness that DOES list its models as if it had not would
    // throw away the better answer for no reason.
    const enumeratedModels = model ? enumeratedValues(model.paragraph) : [];
    return {
        harness,
        version: version.trim(),
        supportsModel: model !== null,
        supportsEffort: effort !== null,
        // The spelling this harness actually uses, so what the panel writes is
        // a flag the CLI takes: `--effort` for Claude Code and `--thinking`
        // for pi are the same control under different names, and writing the
        // wrong one is a command that fails rather than a model that differs.
        modelFlag: model?.flag,
        effortFlag: effort?.flag,
        efforts: effort ? enumeratedValues(effort.paragraph) : [],
        modelExamples: enumeratedModels.length > 0
            ? enumeratedModels
            : (model ? quotedExamples(model.paragraph) : []),
    };
}
