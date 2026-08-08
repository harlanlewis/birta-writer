/**
 * The harness lock: one heavy harness at a time, enforced rather than asked for.
 *
 * `pnpm test`, `pnpm test:e2e` and the `perf:*` captures all saturate the same
 * cores. Run two and they do not merely take longer — they produce failures
 * that are not real. Measured in this repository on 2026-08-08, one machine,
 * back to back:
 *
 *              contended                              alone
 *   corpus     FAIL, document open exceeded 60000ms   44/44 in 9.0s
 *   embeds     FAIL, click timeout after 30000ms      61/61 in 6.9s
 *   full sweep never finished inside 600s             55 suites, 261.5s, 0 fail
 *
 * Both of those reds cost a re-run each, and the sweep's apparent slowness was
 * the same cause wearing a different hat: a clean sweep is under five minutes.
 *
 * AGENTS.md carried this as prose ("Run one harness at a time") and a session
 * broke it twice in a day anyway, so it is a mechanism now. The prose points
 * here instead of asking.
 *
 * ── Machine-wide, not repo-wide ──────────────────────────────────────────
 *
 * The contended resource is the machine's cores, so the lock is too. Two
 * worktrees of this repository compete exactly as badly as two terminals in
 * one, and a repo-scoped lock would let them.
 *
 * ── Re-entrant for descendants ───────────────────────────────────────────
 *
 * `perf-ab.mjs` spawns `perf.mjs` as a child and waits for it. Those are one
 * harness, not two, and a lock that could not tell would deadlock the very
 * command it exists to protect. The holder puts its token in the environment;
 * a child that inherits a token matching the live lock is already inside it.
 *
 * ── It fails, it does not wait ───────────────────────────────────────────
 *
 * Waiting would be self-healing but silent, and it can stall a five-second
 * vitest run behind a five-minute sweep. Refusing costs one re-run and says
 * exactly what is already running, which is the thing the operator needed to
 * know. `BIRTA_NO_HARNESS_LOCK=1` overrides it for the case where you know
 * better than this file does.
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ONE atomic operation that both claims the lock and records who holds it.
// An earlier version made a directory and then wrote the holder into it, which
// has a window: the loser of the race reads a lock with no holder yet, decides
// it is stale, reaps it, and both processes proceed. `wx` cannot do that —
// either the file did not exist and this call created it with its contents, or
// it did and this call threw.
const LOCK_FILE = join(tmpdir(), "birta-writer-harness.lock");
const TOKEN_VAR = "BIRTA_HARNESS_LOCK_TOKEN";

/** Read the current holder, or null if the lock is absent or unreadable. */
function readHolder() {
    try {
        return JSON.parse(readFileSync(LOCK_FILE, "utf8"));
    } catch {
        return null;
    }
}

/**
 * Is that pid still alive? Signal 0 tests for existence without delivering.
 *
 * The residual hole is pid reuse: a lock stranded by a kill, whose pid the
 * system later hands to something unrelated, reads as held and never clears.
 * That takes a wrap of the pid space to happen, and the refusal message names
 * the override, so it costs a reader one confused minute rather than a wedged
 * checkout. Closing it properly means comparing process start times, which has
 * no portable answer.
 */
function isAlive(pid) {
    if (!Number.isInteger(pid)) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means it exists and belongs to someone else — still alive.
        return err.code === "EPERM";
    }
}

function describe(holder) {
    if (!holder) return "another harness";
    const heldSec = holder.startedAt ? Math.round((Date.now() - holder.startedAt) / 1000) : null;
    const age = heldSec === null ? "" : `, held ${heldSec}s`;
    return `${holder.name} (pid ${holder.pid}${age})`;
}

/**
 * Take the lock, or exit(2) naming the holder.
 *
 * Returns a release function. Release also runs on process exit, so a harness
 * that throws does not strand the lock for the next one.
 */
export function acquireHarnessLock(name) {
    if (process.env["BIRTA_NO_HARNESS_LOCK"]) return () => {};

    const inherited = process.env[TOKEN_VAR];
    if (inherited) {
        const holder = readHolder();
        // Our own parent still holds it: we are the same harness, carry on.
        if (holder && holder.token === inherited && isAlive(holder.pid)) return () => {};
    }

    const token = `${process.pid}-${Date.now()}`;
    const holderJson = JSON.stringify({ name, pid: process.pid, token, startedAt: Date.now() });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            writeFileSync(LOCK_FILE, holderJson, { flag: "wx" });
        } catch (err) {
            if (err.code !== "EEXIST") throw err;
            const holder = readHolder();
            // Unreadable but present counts as HELD, not stale. Only a holder
            // we can read and prove dead is reaped.
            if (!holder || isAlive(holder.pid)) {
                process.stderr.write(
                    `\nharness-lock: ${describe(holder)} is already running.\n` +
                    "The suites and the perf captures compete for the same cores, and run\n" +
                    "together they produce failures that are not real. Wait for it, or stop it.\n" +
                    "Override with BIRTA_NO_HARNESS_LOCK=1 if you know better than this.\n\n",
                );
                process.exit(2);
            }
            // The holder is gone (Ctrl-C, a crash, a reboot). Nothing runs on
            // process death for a signal-terminated process, so this reaper —
            // not a signal handler — is what makes an interrupted run harmless
            // to the next one. Reap and retry.
            rmSync(LOCK_FILE, { force: true });
            continue;
        }

        // Children inherit this, which is what makes perf-ab's spawn re-entrant.
        process.env[TOKEN_VAR] = token;

        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            // Only ours: a reaped-and-retaken lock must not be deleted by the
            // process whose corpse was reaped.
            if (readHolder()?.token === token) rmSync(LOCK_FILE, { force: true });
        };
        process.on("exit", release);
        return release;
    }

    process.stderr.write("\nharness-lock: could not take the lock after reaping a dead holder.\n");
    process.exit(2);
}
