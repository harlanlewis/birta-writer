/**
 * The harness lock: one heavy harness at a time on this machine, enforced
 * rather than asked for, and shared with every other repository on it.
 *
 * `pnpm test`, `pnpm test:e2e` and the `perf:*` captures all saturate the same
 * cores. Run two and they do not merely take longer, they produce failures
 * that are not real: the corpus suites time out, a click times out, a sweep
 * never finishes inside its budget, and every one of them passes alone.
 * AGENTS.md ("One harness at a time") carried this as prose and a session
 * broke it twice in a day anyway, so it is a mechanism. The prose points here.
 *
 * ── One file for every repository ────────────────────────────────────────
 *
 * The contended resource is the machine's cores, so the lock is the
 * machine's: `$TMPDIR/hl-harness.lock`, named for the resource and not for a
 * repository, and taken by every repository on this machine that runs a
 * browser sweep or a timing capture. A capture here refuses while a sweep in
 * another repository runs, and theirs refuse while ours does. The contract
 * every implementation keeps is `birta-labs:HARNESS_LOCK.md`: the path, the
 * record, the kind table, refusing rather than waiting, staleness, the child
 * token and the exit codes. This file is one implementation of it, since a
 * module reached across repositories breaks the day the other checkout moves.
 *
 * ── The record, and the kinds ────────────────────────────────────────────
 *
 * The holder is one JSON object written in one atomic call (the `wx` flag):
 * `token`, `pid`, `what`, `cwd`, `at` and `kind`. Claim and record are one
 * operation, so the loser of a race can never read a lock with no holder yet,
 * call it stale and reap it. `kind` is `capture` for a run that READS the
 * machine and `sweep` for one that only loads it, and `refusedBy` is the
 * table: a capture refuses every holder; a sweep refuses every capture and a
 * sweep of its own repository, and runs beside another repository's sweep. A
 * record with no kind is read as a capture, the strict reading, so a holder
 * written before the field existed is refused rather than guessed about.
 *
 * What this repository holds as what: every perf runner is a capture, since
 * a timing is all it produces. The Vitest run is a sweep: it reads no timing,
 * and what it buys is that a unit run here no longer refuses every browser
 * sweep on the machine. What it costs is named rather than hidden: a foreign
 * sweep beside it can still push the two heaviest corpus suites past their
 * per-test timeouts, which AGENTS.md already files as a contention red to
 * re-run alone. The e2e sweep is held as a capture although it is run for its
 * pass or fail, because its verdict is load-sensitive (`corpus` and `embeds`
 * go red at their timeouts under another harness and pass alone), and the
 * strict kind is the one that keeps a red meaning something. "Its own
 * repository" folds worktrees into the checkout they belong to
 * (`checkoutOf`): two lanes of one session running `pnpm test` in two
 * worktrees contend exactly as badly as two terminals in one checkout, and
 * the lock existed to refuse that before it was shared.
 *
 * A taker the table lets run beside the holder writes no record of its own,
 * because the file holds one record and it is the holder's. That taker is
 * invisible to the next one; the spec names the cost and no repository has
 * needed a set-valued record yet.
 *
 * ── Staleness, and the heartbeat that makes it safe ──────────────────────
 *
 * A record is stale when its pid is gone, or when `at` is older than
 * STALE_MS. A holder rewrites `at` every HEARTBEAT_MS while it holds, so
 * stale means "stopped reporting" and never "started a while ago": the A/B
 * runners build both sides of a comparison and then measure several fixtures
 * with repetitions, and without the heartbeat the longest capture in this
 * repository would be reaped out from under itself, a second harness would
 * start on top of it, and both sets of numbers would be silently wrong. That
 * is the failure the lock exists to prevent, so the timer is not optional.
 * It is unref'd, so a finished run is never kept alive by it.
 *
 * ── Re-entrant for descendants ───────────────────────────────────────────
 *
 * `perf-ab.mjs` spawns `perf.mjs` as a child and waits for it. Those are one
 * harness, not two, and a lock that could not tell would deadlock the very
 * command it exists to protect. The holder puts its token in the environment
 * (`WF_HARNESS_LOCK_TOKEN`, the spec's name, carried by every repository so
 * a harness one of them spawns can nest in another's hold); a child that
 * inherits a token matching the live lock is already inside it.
 *
 * ── It fails, it does not wait ───────────────────────────────────────────
 *
 * Waiting would be self-healing but silent, and it can stall a five-second
 * vitest run behind a five-minute sweep. Refusing costs one re-run and says
 * exactly what is already running and from which checkout, which is the
 * thing the operator needed to know. Exit 2 is a holder refusing; nothing
 * here exits 3, which the spec reserves for a taker's own precondition.
 * `BIRTA_NO_HARNESS_LOCK=1` overrides it for the case where you know better
 * than this file does, and it is the one escape hatch.
 *
 * ── A free lock is not a quiet machine ───────────────────────────────────
 *
 * The lock knows only about work that TAKES it. `pnpm build` takes none,
 * `mac/scripts/test.sh` takes none, and another repository's unit tests take
 * none, and between them they can hold the load average above the core
 * count while every lock file on the machine is free. A red in a heavy suite
 * with the lock uncontended still means look at `ps` before believing it.
 */
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const LOCK_FILE = join(tmpdir(), "hl-harness.lock");
const TOKEN_VAR = "WF_HARNESS_LOCK_TOKEN";
const OVERRIDE_VAR = "BIRTA_NO_HARNESS_LOCK";
// Thresholds, not measurements: how long a holder may go without reporting
// before it is presumed dead, and how often a live holder reports.
const STALE_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;

/** The two kinds a holder can be, in the spec's words. Enumerated, so a test can walk them. */
export const KINDS = ["sweep", "capture"];

// The checkout root, wherever the runner was started from: the record's
// `cwd` names the checkout the hold is from, and pnpm runs a script at the
// package root while `node e2e/run.mjs` runs from wherever the shell was.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A record with no kind is another repository's older writer, read as a capture. */
export function kindOf(holder) {
    return holder.kind === "sweep" ? "sweep" : "capture";
}

/**
 * The checkout a worktree belongs to. Claude Code and the grind scripts make
 * worktrees under `<checkout>/.claude/worktrees/<name>`, and two of those are
 * one repository asking for two suites, which is what the table refuses for a
 * same-checkout sweep. A worktree made elsewhere by hand is not folded, and
 * reads as another checkout.
 */
export function checkoutOf(cwd) {
    const marker = `${sep}.claude${sep}worktrees${sep}`;
    const i = cwd.indexOf(marker);
    return i === -1 ? cwd : cwd.slice(0, i);
}

/**
 * The shared table, the one thing two implementations can disagree on and
 * both look right. A capture reads the machine, so anything else running
 * spoils it. A sweep only loads the machine, so it runs beside another
 * repository's sweep and refuses beside a capture, and beside a sweep of its
 * own repository.
 */
export function refusedBy(mine, holder) {
    if (mine.kind === "capture") return true;
    if (kindOf(holder) === "capture") return true;
    return checkoutOf(holder.cwd ?? "") === checkoutOf(mine.cwd);
}

/**
 * Is that pid still alive? Signal 0 tests for existence without delivering.
 * EPERM means it exists and belongs to someone else, which is still alive.
 *
 * The residual hole is pid reuse: a record stranded by a kill, whose pid the
 * system later hands to something unrelated, reads as held until its `at`
 * ages past STALE_MS, which the heartbeat no longer refreshes. So the hole
 * costs a reader thirty minutes at most, and the refusal names the override.
 */
function isAlive(pid) {
    if (!Number.isInteger(pid)) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === "EPERM";
    }
}

/**
 * A file that is there and is not a record. Distinct from absent and from
 * stale, because it is what a reader sees in the window between a holder
 * creating the file and writing into it: `wx` makes the create exclusive,
 * but the create and the write are two calls. A reader that reaped on that
 * sight would delete a live holder's record and then claim beside it, which
 * is the failure the lock exists to prevent, wearing the lock's own clothes.
 */
const UNREADABLE = Object.freeze({ unreadable: true });
// How a taker treats an unreadable file: re-read a few times, then call it
// corrupt and reap it. Thresholds, not measurements; the write window is
// microseconds and a file that stays unreadable across all of them is not
// mid-write.
const UNREADABLE_RETRIES = 5;
const UNREADABLE_WAIT_MS = 20;
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** The current holder; null when the lock is absent or stale; UNREADABLE when it is there and not a record. */
function readHolder(file) {
    let raw;
    try {
        raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
        return err?.code === "ENOENT" ? null : UNREADABLE;
    }
    if (!raw || typeof raw !== "object" || typeof raw.pid !== "number") return UNREADABLE;
    if (Date.now() - (raw.at ?? 0) > STALE_MS) return null;
    if (!isAlive(raw.pid)) return null;
    return raw;
}

function describe(holder) {
    const age = Math.round((Date.now() - (holder.at ?? Date.now())) / 1000);
    return `${holder.what ?? "an unnamed run"} (${kindOf(holder)}, pid ${holder.pid}, ${age}s ago, ${holder.cwd ?? "an unknown checkout"})`;
}

/**
 * The whole decision, with no exit and no process state of its own beyond
 * the environment it is handed: `acquireHarnessLock` is this plus the process
 * it runs in. A test hands it a lock file of its own, a checkout of its own
 * and a heartbeat it can wait out, so the reader, the writer, the staleness
 * and the table under test are the real ones.
 *
 * Returns `{ outcome: "taken", token, held, release }`, where `held` is false
 * for a run inside its parent's hold or beside a holder the table allows, or
 * `{ outcome: "refused", code, message }`.
 */
export function tryHarnessLock(what, opts) {
    const { kind, file = LOCK_FILE, cwd = repoRoot, heartbeatMs = HEARTBEAT_MS, env = process.env, sleep = sleepSync } = opts;
    if (!KINDS.includes(kind)) throw new Error(`harness lock: kind must be one of ${KINDS.join(", ")}, got ${String(kind)}`);

    // Our own parent still holds it: we are the same harness, carry on.
    const inherited = env[TOKEN_VAR];
    if (inherited && readHolder(file)?.token === inherited) {
        return { outcome: "taken", token: inherited, held: false, release: () => {} };
    }

    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const holder = { token, pid: process.pid, what, cwd, at: Date.now(), kind };

    let claimed = false;
    for (let attempt = 0; attempt < 2 && !claimed; attempt++) {
        try {
            writeFileSync(file, JSON.stringify(holder), { flag: "wx" });
            claimed = true;
        } catch (err) {
            if (err.code !== "EEXIST") throw err;
            let current = readHolder(file);
            // Mid-write reads as unreadable; so does a corrupt file. The
            // difference is whether it stays that way.
            for (let i = 0; current === UNREADABLE && i < UNREADABLE_RETRIES; i++) {
                sleep(UNREADABLE_WAIT_MS);
                current = readHolder(file);
            }
            if (current === UNREADABLE) current = null;
            if (current) {
                if (refusedBy({ kind, cwd }, current)) {
                    return {
                        outcome: "refused",
                        code: 2,
                        message:
                            `\nharness lock: held by ${describe(current)}.\n` +
                            "  Run together they produce failures that are not real. Wait for it, or stop it;\n" +
                            `  ${OVERRIDE_VAR}=1 proceeds anyway if you know better than this.\n`,
                    };
                }
                // Allowed beside it. The file holds one record and it is
                // theirs, so this run leaves it alone and holds nothing.
                return { outcome: "taken", token: "", held: false, release: () => {} };
            }
            // Absent, unreadable or stale: reap once and retry once. A second
            // failure is a live racer, and the refusal below names that.
            if (existsSync(file)) rmSync(file, { force: true });
        }
    }
    if (!claimed) return { outcome: "refused", code: 2, message: "\nharness lock: another run won the race for it.\n" };

    // The heartbeat. Only ever over our own record: by the time it fires, a
    // file reaped and reclaimed by somebody else is theirs to write. Written
    // beside the file and renamed over it, so no reader ever sees the beat
    // half-written; a write that fails is not worth failing a capture over,
    // and the next claim decides what the lock's state means.
    const beatFile = `${file}.${token}.beat`;
    const beat = setInterval(() => {
        if (readHolder(file)?.token !== token) return;
        try {
            writeFileSync(beatFile, JSON.stringify({ ...holder, at: Date.now() }));
            renameSync(beatFile, file);
        } catch {
            rmSync(beatFile, { force: true });
        }
    }, heartbeatMs);
    beat.unref();

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        clearInterval(beat);
        // Only ours: a reaped-and-retaken lock must not be deleted by the
        // process whose corpse was reaped.
        const current = readHolder(file);
        if (!current || current.token === token) rmSync(file, { force: true });
    };
    return { outcome: "taken", token, held: true, release };
}

/**
 * Take the lock, or exit(2) naming the holder.
 *
 * Returns a release function. Release also runs on process exit and on a
 * signal, so a harness that throws or is interrupted does not strand its
 * record for the next one; the staleness rules cover a kill nothing could
 * catch. The signal handler re-raises the signal when it was the last
 * listener, so the default disposition still ends the process; when Vitest
 * or Playwright hold a listener of their own, theirs runs as before with the
 * record already gone.
 */
export function acquireHarnessLock(what, { kind } = {}) {
    if (process.env[OVERRIDE_VAR]) return () => {};

    const attempt = tryHarnessLock(what, { kind });
    if (attempt.outcome === "refused") {
        process.stderr.write(attempt.message);
        process.exit(attempt.code);
    }

    // Children inherit this, which is what makes perf-ab's spawn re-entrant.
    if (attempt.token) process.env[TOKEN_VAR] = attempt.token;
    process.on("exit", attempt.release);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.once(sig, () => {
            attempt.release();
            if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
        });
    }
    return attempt.release;
}
