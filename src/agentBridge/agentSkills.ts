/**
 * The agent skills on this machine, as the `/ai` composer offers them (MAR-483).
 *
 * A skill is a folder holding a `SKILL.md` whose frontmatter carries `name`
 * and `description` (the Agent Skills spec's two required fields). That file
 * is the equivalent of the `--help` the flag pickers read: it ships WITH the
 * skill, and its description is written to be read by a machine deciding
 * whether to use it, which is what a menu needs. No harness on the survey
 * publishes its skills in help, and Claude Code has no listing command, so
 * the filesystem is the contract.
 *
 * Pure by the linkResolver precedent: no `vscode` import, the IO lent by the
 * caller. Scan order is precedence: the workspace's folders, then the home
 * directory's, then the one folder the configured harness keeps for itself.
 * A name found twice keeps its first finding, so a project skill shadows a
 * user one of the same name, which is how the harnesses resolve it too.
 *
 * A scan is exhaustive only for the paths scanned. A plugin's skills, an
 * enterprise-managed set and an account-synced one live elsewhere, so the
 * result is offered beside free text and never rendered as "the skills".
 */
import type { AgentSkill } from "../../shared/messages";

/** What the caller lends: a directory's entries, and a file's text. */
export interface SkillScanIo {
    /** The subdirectory names under `dir`, or empty when it cannot be listed. */
    listDirs(dir: string): Promise<readonly string[]>;
    /** A file's text, or null when it cannot be read. */
    readText(path: string): Promise<string | null>;
}

/** Skill folders relative to the workspace root. */
export const PROJECT_SKILL_DIRS: readonly string[] = [".claude/skills", ".agents/skills"];

/** Skill folders relative to the home directory, whatever the harness. */
export const USER_SKILL_DIRS: readonly string[] = [".claude/skills", ".agents/skills"];

/**
 * The one folder a harness keeps for its own skills, relative to the home
 * directory, keyed by the harness binary's name. The only vendor knowledge in
 * this module, and the stable half by the same argument that justifies
 * `EFFORT_FLAGS`: where a harness keeps its skills changes far more slowly
 * than which models it offers, and a name missing here costs one absent
 * group rather than a wrong command. Claude Code's is `~/.claude/skills`,
 * already in USER_SKILL_DIRS, so it has no row.
 */
export const HARNESS_SKILL_HOMES: Readonly<Record<string, string>> = {
    codex: ".codex/skills",
    copilot: ".copilot/skills",
    opencode: ".config/opencode/skills",
    gemini: ".gemini/skills",
    qwen: ".qwen/skills",
    cn: ".continue/skills",
};

/** The file every skill folder holds. */
export const SKILL_FILE = "SKILL.md";

/**
 * A skill's name and description, off its `SKILL.md`. Null when the
 * frontmatter lacks either: the spec requires both, and a folder without
 * them is not a skill the harness would offer either.
 *
 * A deliberately small reader: the two fields are single-line scalars in
 * every skill in the wild, and a YAML parser here would be a dependency in
 * the eager extension bundle for two lines of text.
 */
export function parseSkillFile(text: string): { name: string; description: string } | null {
    const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!m) { return null; }
    const fields = new Map<string, string>();
    for (const line of m[1]!.split(/\r?\n/)) {
        const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
        if (kv && !fields.has(kv[1]!)) { fields.set(kv[1]!, unquote(kv[2]!.trim())); }
    }
    const name = fields.get("name") ?? "";
    const description = fields.get("description") ?? "";
    // A name is what goes on the composed line, so it has to be one token
    // the way a skill's folder is; anything else is not a skill name.
    if (!/^[\w][\w.-]*$/.test(name) || description === "") { return null; }
    return { name, description };
}

function unquote(value: string): string {
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
        return value.slice(1, -1);
    }
    return value;
}

/** Where the scan looks for a `harness` (a binary name) with these roots. */
export function skillRoots(opts: { workspace?: string; home: string; harness: string }): Array<{ dir: string; scope: AgentSkill["scope"] }> {
    const join = (root: string, rel: string) => `${root.replace(/[\\/]+$/, "")}/${rel}`;
    const roots: Array<{ dir: string; scope: AgentSkill["scope"] }> = [];
    if (opts.workspace) {
        for (const rel of PROJECT_SKILL_DIRS) { roots.push({ dir: join(opts.workspace, rel), scope: "project" }); }
    }
    for (const rel of USER_SKILL_DIRS) { roots.push({ dir: join(opts.home, rel), scope: "user" }); }
    const own = HARNESS_SKILL_HOMES[opts.harness];
    if (own) { roots.push({ dir: join(opts.home, own), scope: "user" }); }
    return roots;
}

/**
 * Every skill the roots hold, project ones first, each scope sorted by name,
 * a name kept at its first finding.
 */
export async function scanAgentSkills(
    opts: { workspace?: string; home: string; harness: string },
    io: SkillScanIo,
): Promise<AgentSkill[]> {
    // Gathered in root order, which is precedence: the first folder to hold
    // a name keeps it. Sorted afterwards, by scope and then name, so the menu
    // reads as two alphabetical groups whichever folder each came from.
    const seen = new Set<string>();
    const out: AgentSkill[] = [];
    for (const { dir, scope } of skillRoots(opts)) {
        for (const folder of await io.listDirs(dir)) {
            const text = await io.readText(`${dir}/${folder}/${SKILL_FILE}`);
            const parsed = text === null ? null : parseSkillFile(text);
            if (!parsed || seen.has(parsed.name)) { continue; }
            seen.add(parsed.name);
            out.push({ ...parsed, scope });
        }
    }
    const rank = (s: AgentSkill) => (s.scope === "project" ? 0 : 1);
    return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
