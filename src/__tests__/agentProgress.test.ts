/**
 * The `/ai` progress reader, over output captured from real harnesses.
 *
 * The cases come from `shared/__fixtures__/agentProgressCases.json`, which
 * `mac/Tests/BirtaWriterCoreTests/AgentProgressTests.swift` reads too, so a
 * line only one of the two readers produces fails in one suite rather than
 * sitting undiscovered in whichever implementation was not updated. The
 * fixture's own header carries the captures' provenance.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentProgressReader, PROGRESS_LINE_MAX, plainLine, type AgentStream } from "../agentBridge/agentProgress";

interface Feed { stream: AgentStream; chunk: string; repeat?: number; feeds?: number; shows: string | null }
interface Case { name: string; why: string; feed: Feed[]; structured: boolean; lastSaid: string | null }

const { cases } = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "__fixtures__", "agentProgressCases.json"),
    "utf8",
)) as { cases: Case[] };

/** What each read of `c` answered, in feed order, and the reader it left. */
function play(c: Case): { shown: (string | null)[]; reader: AgentProgressReader } {
    const reader = new AgentProgressReader();
    const shown = c.feed.map((f) => {
        const text = f.chunk.repeat(f.repeat ?? 1);
        let last: string | undefined;
        for (let i = 0; i < (f.feeds ?? 1); i++) { last = reader.read(text, f.stream); }
        return last ?? null;
    });
    return { shown, reader };
}

const byName = (name: string): Case => {
    const found = cases.find((c) => c.name === name);
    if (!found) { throw new Error(`no case named ${name} in the shared fixture`); }
    return found;
};

describe("AgentProgressReader, over the shared cases", () => {
    it("the shared fixture should hold the cases both readers are held to", () => {
        // An unreadable or emptied fixture would otherwise pass this file in
        // silence, since every case below is generated from it.
        expect(cases.length).toBeGreaterThanOrEqual(14);
    });

    it.each(cases.map((c) => [c.name, c] as const))("%s should show what the fixture says", (_name, c) => {
        const { shown, reader } = play(c);
        expect(shown, c.why).toEqual(c.feed.map((f) => f.shows));
        expect(reader.isStructured, c.why).toBe(c.structured);
        expect(reader.lastSaid ?? null, c.why).toBe(c.lastSaid);
    });

    it("both captured runs should be reduced to more than a handful of steps", () => {
        // The instrument reached the stream: a reducer that recognized none of
        // it would show nothing, and a fixture edited to expect nothing would
        // agree with it.
        for (const name of ["claude-code-2.1.278-stream-json", "codex-0.149.0-json"]) {
            expect(play(byName(name)).shown.filter((s) => s !== null).length, name).toBeGreaterThan(3);
        }
    });

    it("a thinking block's content should never reach the line", () => {
        // The fixture's expectation already says `Thinking`; this says why that
        // is the property rather than a coincidence of the words.
        const { shown } = play(byName("thinking-content-withheld"));
        expect(shown.join(" ")).not.toContain("production");
    });

    it("a long line should be cut to something a corner can hold", () => {
        const line = play(byName("long-line-clamped")).shown.at(-1);
        expect(line).toBeDefined();
        expect(line!.length).toBeLessThanOrEqual(PROGRESS_LINE_MAX);
        expect(line!.endsWith("…")).toBe(true);
    });

    it("a stream that never sends a newline should have dropped its head", () => {
        const { shown } = play(byName("unbounded-line-dropped"));
        expect(shown.some((s) => s?.startsWith("START"))).toBe(false);
    });
});

describe("plainLine", () => {
    it("an empty line should reduce to nothing", () => {
        expect(plainLine("   \u001B[0m  ")).toBe("");
    });
});
