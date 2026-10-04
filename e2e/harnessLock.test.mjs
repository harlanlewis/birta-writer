/**
 * The harness lock's contract: the kind table, staleness, the heartbeat that
 * keeps a live capture from being reaped, the child token, and what a release
 * may remove. The contract is shared by every repository that takes the lock
 * and kept outside this one; this holds our implementation to it.
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
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
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

    /** The record's `at` once it has moved past `after`, or null if it never does within the wait. */
    async function beatAfter(file, after, waitMs = 3000) {
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
            try {
                const record = JSON.parse(readFileSync(file, "utf8"));
                if (record.at > after) return record;
            } catch {
                // Between the create and the write, or between a beat and its rename.
            }
            await new Promise((r) => setTimeout(r, 10));
        }
        return null;
    }

    it("a holder should heartbeat `at` while it holds, and stop when released", async () => {
        // The beat is a process of its own, so its first tick waits on a
        // Node start; polled rather than slept for, or a loaded machine
        // reads a beat that had not happened yet as a beat that never would.
        const file = lockFile();
        const got = take("mine", { kind: "capture", file, heartbeatMs: 10 });
        expect(got.outcome).toBe("taken");
        const first = JSON.parse(readFileSync(file, "utf8")).at;
        const beat = await beatAfter(file, first);
        expect(beat, "the record's `at` moved while held").not.toBeNull();
        expect(beat.token, "the heartbeat rewrote our record, not a new one").toBe(got.token);
        got.release();
        expect(existsSync(file)).toBe(false);
        await new Promise((r) => setTimeout(r, 60));
        expect(existsSync(file), "a released holder writes nothing more").toBe(false);
    });

    it("a holder whose event loop is blocked should still heartbeat, because the beat is its own process", async () => {
        // perf-ab's shape: claim, then sit in a synchronous call until done.
        // A timer in that loop never fires; the beat has to come from outside.
        const file = lockFile();
        const module = pathToFileURL(fileURLToPath(new URL("./harnessLock.mjs", import.meta.url))).href;
        const child = spawn(process.execPath, ["--input-type=module", "-e", [
            `import { tryHarnessLock } from ${JSON.stringify(module)};`,
            `const got = tryHarnessLock("blocked", { kind: "capture", file: ${JSON.stringify(file)}, heartbeatMs: 20 });`,
            `if (got.outcome !== "taken") process.exit(3);`,
            `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);`,
            `got.release();`,
        ].join("\n")], { stdio: "ignore", env: noEnv });
        const exited = new Promise((r) => child.on("close", r));
        // The claim, read once it is whole: the create and the write are two
        // calls, and a read between them is not a record.
        const claimed = await beatAfter(file, 0);
        expect(claimed, "the blocked holder claimed the lock").not.toBeNull();
        const moved = await beatAfter(file, claimed.at);
        expect(moved, "the record's `at` moved while the holder's loop was blocked").not.toBeNull();
        expect(moved.token).toBe(claimed.token);
        expect(await exited, "the holder ran to its own release").toBe(0);
        expect(existsSync(file), "release took the record with it").toBe(false);
    });

    it("a holder killed outright should leave a record that stops beating, so it can go stale", async () => {
        // The one way a heartbeat could be harmful: a holder that dies with
        // no release, whose beat goes on refreshing a stranded record. It
        // stops because the holder is no longer its parent, whatever the
        // holder's pid is later handed to.
        const file = lockFile();
        const module = pathToFileURL(fileURLToPath(new URL("./harnessLock.mjs", import.meta.url))).href;
        const child = spawn(process.execPath, ["--input-type=module", "-e", [
            `import { tryHarnessLock } from ${JSON.stringify(module)};`,
            `const got = tryHarnessLock("doomed", { kind: "capture", file: ${JSON.stringify(file)}, heartbeatMs: 10 });`,
            `if (got.outcome !== "taken") process.exit(3);`,
            `setInterval(() => {}, 1000);`,
        ].join("\n")], { stdio: "ignore", env: noEnv });
        const exited = new Promise((r) => child.on("close", r));
        const claimed = await beatAfter(file, 0);
        expect(claimed, "the holder claimed the lock").not.toBeNull();
        expect(await beatAfter(file, claimed.at), "the heartbeat was running before the kill").not.toBeNull();
        child.kill("SIGKILL");
        await exited;
        // Past the beat's own interval several times over: a beat that
        // outlived its holder would have moved `at` by now.
        await new Promise((r) => setTimeout(r, 150));
        const settled = JSON.parse(readFileSync(file, "utf8")).at;
        await new Promise((r) => setTimeout(r, 150));
        expect(JSON.parse(readFileSync(file, "utf8")).at, "the record kept beating after its holder was killed").toBe(settled);
        rmSync(file, { force: true });
    });

    it("a heartbeat whose holder is not its parent should exit without touching the record", async () => {
        // What tells this liveness check from one by pid: pid 1 is alive,
        // and a beat asking `kill(1, 0)` would go on beating a record for a
        // holder that is long gone; asking whether 1 is its parent, it stops
        // at its first tick and the record never moves.
        const file = lockFile();
        const planted = plant(file, { token: "orphaned", kind: "capture", pid: 1, at: Date.now() - 1000 });
        const script = fileURLToPath(new URL("./harnessHeartbeat.mjs", import.meta.url));
        const beat = spawn(process.execPath, [script, file, "orphaned", "1", "10"], { stdio: "ignore", env: noEnv });
        const exit = await Promise.race([
            new Promise((r) => beat.on("close", (code) => r({ exited: true, code }))),
            new Promise((r) => setTimeout(() => r({ exited: false }), 1500)),
        ]);
        if (!exit.exited) beat.kill();
        expect(exit.exited, "the beat kept running for a holder that is not its parent").toBe(true);
        expect(JSON.parse(readFileSync(file, "utf8")), "the beat rewrote a record that is not its holder's").toEqual(planted);
    });

    it("the heartbeat should never write over somebody else's record", async () => {
        const file = lockFile();
        const got = take("mine", { kind: "capture", file, heartbeatMs: 10 });
        expect(got.outcome).toBe("taken");
        // One beat observed first, so the heartbeat is known to be running
        // before the file becomes somebody else's; otherwise a beat that
        // never started passes this for the wrong reason.
        const first = JSON.parse(readFileSync(file, "utf8")).at;
        expect(await beatAfter(file, first), "the heartbeat reached its subject").not.toBeNull();
        // The beat is held still while the file changes hands, as it is in
        // production: a reclaim happens over a stale or dead record, whose
        // beat has already exited. Planting under a live beat would race its
        // read-and-rename, and lose to it once in a while for no reason
        // this test is about.
        process.kill(got.heartbeatPid, "SIGSTOP");
        const theirs = plant(file, { token: "somebody-else", kind: "capture", at: Date.now() - 1000 });
        process.kill(got.heartbeatPid, "SIGCONT");
        await new Promise((r) => setTimeout(r, 80));
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
