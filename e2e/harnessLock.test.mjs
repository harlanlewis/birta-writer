/**
 * The harness lock's contract: the kind table, staleness, the heartbeat that
 * keeps a live capture from being reaped, the child token, and what a release
 * may remove. `birta-labs:HARNESS_LOCK.md` is the contract; this holds our
 * implementation to it.
 *
 * REAL LOCK FILES, IN A DIRECTORY OF THEIR OWN. Never `$TMPDIR/hl-harness.lock`:
 * that file is the machine's, a peer session may hold it, and a test that
 * wrote it would refuse a live capture in another repository and read whatever
 * that session was doing as its own fixture. Each case gets a fresh directory,
 * so the reader, the writer and the staleness under test are the real ones and
 * only the path underneath them is the test's.
 *
 * The four kind combinations are ENUMERATED from `KINDS`, never listed by hand:
 * the expected verdict is derived from the spec's sentence ("a capture refuses
 * every holder; a sweep refuses a capture") and the loop asserts its own size,
 * so a third kind arriving cannot leave a row untested.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KINDS, LOCK_FILE, tryHarnessLock, refusedBy, kindOf, checkoutOf } from "./harnessLock.mjs";

const THEIRS = "/somewhere/else";
const MINE = "/here/birta-writer";

const made = [];
afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function lockFile() {
    const dir = mkdtempSync(join(tmpdir(), "birta-lock-"));
    made.push(dir);
    return join(dir, "hl-harness.lock");
}

/** Plant another run's record. `kind: undefined` in `over` plants a record with no kind at all. */
function plant(file, over = {}) {
    const holder = { token: "theirs", pid: process.pid, what: "another repository's harness", cwd: THEIRS, at: Date.now(), kind: "capture", ...over };
    if ("kind" in over && over.kind === undefined) delete holder.kind;
    writeFileSync(file, JSON.stringify(holder));
    return holder;
}

/** A pid that is gone: spawnSync waits for it, so it is reaped before the assertion. */
function deadPid() {
    const done = spawnSync("/bin/sh", ["-c", "exit 0"]);
    expect(done.pid, "the fixture needs a process that has exited").toBeTruthy();
    return done.pid;
}

// The vitest run this file is inside holds the real lock and exported its
// token to us. Every case here hands `env` explicitly, so that inheritance
// never reads as a parent's hold over a fixture file.
const noEnv = {};

const take = (what, opts) => tryHarnessLock(what, { cwd: MINE, env: noEnv, ...opts });

describe("harnessLock", () => {
    it("the shared path should be the machine's lock file, named for the resource", () => {
        expect(LOCK_FILE).toBe(join(tmpdir(), "hl-harness.lock"));
    });

    it("the kind table should refuse everything except a sweep beside another checkout's sweep", () => {
        // Derived from the spec's sentence, not from the function under test.
        const expected = (taker, holder) => !(taker === "sweep" && holder === "sweep");
        let rows = 0;
        for (const taker of KINDS) {
            for (const holder of KINDS) {
                rows++;
                const file = lockFile();
                plant(file, { kind: holder, cwd: THEIRS });
                const got = take("mine", { kind: taker, file });
                expect(got.outcome, `taker ${taker} beside holder ${holder}`).toBe(expected(taker, holder) ? "refused" : "taken");
                if (got.outcome === "refused") {
                    expect(got.code).toBe(2);
                    expect(got.message).toContain("another repository's harness");
                    expect(got.message).toContain(`(${holder}, pid ${process.pid}, `);
                    expect(got.message).toContain(THEIRS);
                    expect(got.message).toContain("BIRTA_NO_HARNESS_LOCK=1");
                } else {
                    expect(got.held, "a run beside a holder writes no record of its own").toBe(false);
                    expect(JSON.parse(readFileSync(file, "utf8")).token, "their record survived").toBe("theirs");
                }
            }
        }
        expect(rows).toBe(KINDS.length * KINDS.length);
        expect(rows).toBeGreaterThanOrEqual(4);
    });

    it("a sweep should refuse a sweep of its own checkout, and a worktree should count as its checkout", () => {
        const same = lockFile();
        plant(same, { kind: "sweep", cwd: MINE });
        expect(take("mine", { kind: "sweep", file: same }).outcome).toBe("refused");

        const worktree = lockFile();
        plant(worktree, { kind: "sweep", cwd: join(MINE, ".claude", "worktrees", "agent-abc") });
        expect(take("mine", { kind: "sweep", file: worktree }).outcome, "a lane's worktree is the same repository asking for two suites").toBe("refused");

        expect(checkoutOf(join(MINE, ".claude", "worktrees", "agent-abc"))).toBe(MINE);
        expect(checkoutOf(join(MINE, ".claude", "worktrees", "agent-abc", "e2e"))).toBe(MINE);
        expect(checkoutOf(MINE)).toBe(MINE);
        expect(refusedBy({ kind: "sweep", cwd: MINE }, { kind: "sweep", cwd: THEIRS })).toBe(false);
    });

    it("a record with no kind should be read as a capture", () => {
        const file = lockFile();
        plant(file, { kind: undefined, cwd: THEIRS });
        const got = take("mine", { kind: "sweep", file });
        expect(got.outcome, "a record written before the field existed is refused rather than guessed about").toBe("refused");
        expect(got.message).toContain("(capture, pid");
        expect(kindOf({ token: "t", pid: 1, what: "w", cwd: "c", at: 0 })).toBe("capture");
    });

    it("a kind outside the enumeration should throw rather than hold as something", () => {
        expect(() => take("mine", { kind: undefined, file: lockFile() })).toThrow(/kind must be one of/);
        expect(() => take("mine", { kind: "vitest", file: lockFile() })).toThrow(/kind must be one of/);
    });

    it("a holder whose pid is gone should be stale, and the lock taken over it", () => {
        const file = lockFile();
        plant(file, { pid: deadPid(), kind: "capture" });
        const got = take("mine", { kind: "capture", file });
        expect(got.outcome, "a dead holder refuses nobody").toBe("taken");
        expect(got.held).toBe(true);
        const record = JSON.parse(readFileSync(file, "utf8"));
        expect(record).toMatchObject({ what: "mine", pid: process.pid, cwd: MINE, kind: "capture", token: got.token });
        expect(typeof record.at).toBe("number");
        expect(Object.keys(record).sort()).toEqual(["at", "cwd", "kind", "pid", "token", "what"]);
        got.release();
        expect(existsSync(file), "release takes the record away").toBe(false);
    });

    it("a holder that has not heartbeated for thirty minutes should be stale", () => {
        const file = lockFile();
        plant(file, { at: Date.now() - 31 * 60 * 1000, kind: "capture" });
        const got = take("mine", { kind: "capture", file });
        expect(got.outcome, "a live pid that stopped reporting is still stale").toBe("taken");
        got.release();
    });

    it("a holder should heartbeat `at` while it holds, and stop when released", async () => {
        const file = lockFile();
        const got = take("mine", { kind: "capture", file, heartbeatMs: 10 });
        expect(got.outcome).toBe("taken");
        const first = JSON.parse(readFileSync(file, "utf8")).at;
        await new Promise((r) => setTimeout(r, 60));
        const beat = JSON.parse(readFileSync(file, "utf8"));
        expect(beat.at, "the record's `at` moved while held").toBeGreaterThan(first);
        expect(beat.token, "the heartbeat rewrote our record, not a new one").toBe(got.token);
        got.release();
        expect(existsSync(file)).toBe(false);
        await new Promise((r) => setTimeout(r, 40));
        expect(existsSync(file), "a released holder writes nothing more").toBe(false);
    });

    it("the heartbeat should never write over somebody else's record", async () => {
        const file = lockFile();
        const got = take("mine", { kind: "capture", file, heartbeatMs: 10 });
        expect(got.outcome).toBe("taken");
        const theirs = plant(file, { token: "somebody-else", kind: "capture", at: Date.now() - 1000 });
        await new Promise((r) => setTimeout(r, 60));
        expect(JSON.parse(readFileSync(file, "utf8")), "a reclaimed file is theirs to heartbeat").toEqual(theirs);
        got.release();
        expect(JSON.parse(readFileSync(file, "utf8")), "and theirs to remove").toEqual(theirs);
    });

    it("a child inside its parent's hold should neither claim nor release", () => {
        const file = lockFile();
        plant(file, { token: "the-parent", kind: "capture", cwd: MINE });
        const got = take("perf (spawned by perf:ab)", { kind: "capture", file, env: { WF_HARNESS_LOCK_TOKEN: "the-parent" } });
        expect(got.outcome, "perf-ab's child is the same harness").toBe("taken");
        expect(got.held).toBe(false);
        expect(got.token).toBe("the-parent");
        got.release();
        expect(JSON.parse(readFileSync(file, "utf8")).token, "the parent's record is untouched").toBe("the-parent");
    });

    it("an inherited token that matches no live record should not be a hold", () => {
        const file = lockFile();
        plant(file, { token: "the-parent", kind: "capture", cwd: THEIRS });
        const got = take("mine", { kind: "capture", file, env: { WF_HARNESS_LOCK_TOKEN: "a-token-from-some-earlier-run" } });
        expect(got.outcome, "a stale token in the environment is not a way past a live holder").toBe("refused");
    });

    it("a file caught mid-write should be re-read rather than reaped", () => {
        const file = lockFile();
        // What a reader sees between a holder's exclusive create and its
        // write: the file is there and holds nothing yet. The sleep the taker
        // takes before re-reading is where the holder's write lands.
        writeFileSync(file, "");
        let slept = 0;
        const sleep = () => {
            slept++;
            if (slept === 2) plant(file, { kind: "capture", cwd: THEIRS });
        };
        const got = take("mine", { kind: "capture", file, sleep });
        expect(got.outcome, "the record that arrived is a live holder, and it is refused").toBe("refused");
        expect(got.message).toContain("another repository's harness");
        expect(slept, "it waited for the write rather than reaping on first sight").toBe(2);
        expect(JSON.parse(readFileSync(file, "utf8")).token, "their record survived").toBe("theirs");
    });

    it("a file that stays unreadable should be reaped after the retries", () => {
        const file = lockFile();
        writeFileSync(file, "not a record");
        let slept = 0;
        const got = take("mine", { kind: "capture", file, sleep: () => { slept++; } });
        expect(got.outcome, "a corrupt file cannot hold the lock forever").toBe("taken");
        expect(got.held).toBe(true);
        expect(slept, "and it was re-read before being called corrupt").toBeGreaterThan(1);
        expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(got.token);
        got.release();
    });

    it("a second live racer should be refused rather than reaped", () => {
        const file = lockFile();
        const first = take("first", { kind: "capture", file });
        expect(first.outcome).toBe("taken");
        const second = take("second", { kind: "capture", file, cwd: THEIRS });
        expect(second.outcome).toBe("refused");
        expect(second.message).toContain("held by first (capture, pid");
        expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(first.token);
        first.release();
    });
});
