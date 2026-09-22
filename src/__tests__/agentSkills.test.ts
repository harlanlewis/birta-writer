/**
 * The skill scan (src/agentBridge/agentSkills.ts) over an in-memory disk:
 * which folders are read for which harness, what a SKILL.md has to carry to
 * be offered, and which finding wins when two share a name.
 */
import { describe, it, expect } from "vitest";
import { parseSkillFile, scanAgentSkills, skillRoots, HARNESS_SKILL_HOMES, type SkillScanIo } from "../agentBridge/agentSkills";

const HOME = "/home/u";
const WS = "/ws";

/** A disk as path → text; a directory is implied by the files under it. */
function disk(files: Record<string, string>): SkillScanIo & { reads: string[] } {
    const reads: string[] = [];
    return {
        reads,
        listDirs: async (dir) => {
            const prefix = dir.replace(/\/+$/, "") + "/";
            const names = new Set<string>();
            for (const p of Object.keys(files)) {
                if (p.startsWith(prefix)) { names.add(p.slice(prefix.length).split("/")[0]!); }
            }
            return [...names];
        },
        readText: async (p) => { reads.push(p); return files[p] ?? null; },
    };
}

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

describe("parseSkillFile", () => {
    it("the two required fields should be read, quoted or bare, with a BOM and CRLF tolerated", () => {
        expect(parseSkillFile('﻿---\r\nname: "house-style"\r\ndescription: \'Our voice.\'\r\n---\r\nbody')).toEqual({
            name: "house-style", description: "Our voice.",
        });
        expect(parseSkillFile(skill("a-b.c", "x y z"))).toEqual({ name: "a-b.c", description: "x y z" });
    });

    it("a file missing either field, or with no frontmatter, or a name that is not one token, should be no skill", () => {
        expect(parseSkillFile("---\nname: x\n---\n")).toBeNull();
        expect(parseSkillFile("---\ndescription: x\n---\n")).toBeNull();
        expect(parseSkillFile("# Just a heading\nname: x\ndescription: y\n")).toBeNull();
        expect(parseSkillFile("---\nname: two words\ndescription: y\n---\n")).toBeNull();
        expect(parseSkillFile("---\nname: ../up\ndescription: y\n---\n")).toBeNull();
    });
});

describe("skillRoots", () => {
    it("a workspace should add the two project folders first, and a known harness its own home folder last", () => {
        expect(skillRoots({ workspace: WS, home: HOME, harness: "codex" })).toEqual([
            { dir: `${WS}/.claude/skills`, scope: "project" },
            { dir: `${WS}/.agents/skills`, scope: "project" },
            { dir: `${HOME}/.claude/skills`, scope: "user" },
            { dir: `${HOME}/.agents/skills`, scope: "user" },
            { dir: `${HOME}/.codex/skills`, scope: "user" },
        ]);
    });

    it("no workspace and a harness with no folder of its own should be the two user folders alone", () => {
        expect(skillRoots({ home: HOME, harness: "claude" }).map((r) => r.dir)).toEqual([
            `${HOME}/.claude/skills`, `${HOME}/.agents/skills`,
        ]);
    });

    it("every harness home should be a relative folder, and Claude Code should have none (its folder is already a user one)", () => {
        expect(Object.keys(HARNESS_SKILL_HOMES).length).toBeGreaterThan(3);
        for (const rel of Object.values(HARNESS_SKILL_HOMES)) { expect(rel.startsWith("/")).toBe(false); }
        expect(HARNESS_SKILL_HOMES.claude).toBeUndefined();
    });
});

describe("scanAgentSkills", () => {
    it("project skills should come first, each scope sorted by name, and a shared name kept at its first finding", async () => {
        const io = disk({
            [`${WS}/.claude/skills/zeta/SKILL.md`]: skill("zeta", "project zeta"),
            [`${WS}/.agents/skills/alpha/SKILL.md`]: skill("alpha", "project alpha"),
            [`${HOME}/.claude/skills/alpha/SKILL.md`]: skill("alpha", "user alpha"),
            [`${HOME}/.claude/skills/house-style/SKILL.md`]: skill("house-style", "Our voice."),
            [`${HOME}/.codex/skills/codex-only/SKILL.md`]: skill("codex-only", "Codex keeps this."),
        });
        const found = await scanAgentSkills({ workspace: WS, home: HOME, harness: "codex" }, io);
        expect(found).toEqual([
            { name: "alpha", description: "project alpha", scope: "project" },
            { name: "zeta", description: "project zeta", scope: "project" },
            { name: "codex-only", description: "Codex keeps this.", scope: "user" },
            { name: "house-style", description: "Our voice.", scope: "user" },
        ]);
    });

    it("the harness's own folder should be read only for that harness", async () => {
        const io = disk({ [`${HOME}/.codex/skills/codex-only/SKILL.md`]: skill("codex-only", "x") });
        expect(await scanAgentSkills({ home: HOME, harness: "claude" }, io)).toEqual([]);
        expect((await scanAgentSkills({ home: HOME, harness: "codex" }, io)).map((s) => s.name)).toEqual(["codex-only"]);
    });

    it("a folder without a readable SKILL.md, or one the parser refuses, should be skipped and nothing else read", async () => {
        const io = disk({
            [`${HOME}/.claude/skills/empty/README.md`]: "not a skill",
            [`${HOME}/.claude/skills/broken/SKILL.md`]: "---\nname: broken\n---\n",
            [`${HOME}/.claude/skills/good/SKILL.md`]: skill("good", "fine"),
        });
        expect((await scanAgentSkills({ home: HOME, harness: "claude" }, io)).map((s) => s.name)).toEqual(["good"]);
        // Only SKILL.md files are ever read: the README is not touched.
        expect(io.reads.every((p) => p.endsWith("/SKILL.md"))).toBe(true);
        expect(io.reads.length).toBe(3);
    });
});
