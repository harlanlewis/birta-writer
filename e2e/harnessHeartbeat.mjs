// The harness lock's heartbeat, as a process of its own (harnessLock.mjs,
// "Staleness, and the heartbeat that makes it safe").
//
// A process rather than a timer in the holder, because the holder's event
// loop is not something this can count on: `perf-ab.mjs` takes the lock and
// then sits in synchronous child calls (the builds, then the whole compare)
// until it exits, and a timer in that loop never fires. This one runs its own
// loop, asks whether the holder is still its parent, and stops on its own
// when it is gone or the record is no longer the holder's.
//
// Usage: node harnessHeartbeat.mjs <lockFile> <token> <holderPid> <intervalMs>
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";

const [file, token, pidArg, msArg] = process.argv.slice(2);
const holderPid = Number(pidArg);
const intervalMs = Number(msArg);
if (!file || !token || !Number.isInteger(holderPid) || !(intervalMs > 0)) {
    process.stderr.write("harnessHeartbeat: usage: <lockFile> <token> <holderPid> <intervalMs>\n");
    process.exit(2);
}

/**
 * Whether the holder is still our parent. Asked of `ppid` rather than of
 * `kill(pid, 0)`: a holder that dies has this process reparented at once,
 * and the answer stays no whatever the system later hands the holder's pid
 * to. A liveness test by pid would keep a stranded record beating for as
 * long as the stranger lived, and refuse every harness on the machine in a
 * dead holder's name, which is the failure the contract names.
 */
function holderAlive() {
    return process.ppid === holderPid;
}

/** One beat: rewrite `at` on our own record, renamed over the file so no reader sees it half-written. */
function beat() {
    if (!holderAlive()) process.exit(0);
    let record;
    try {
        record = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        // Mid-write, or reaped: the next tick decides which.
        return;
    }
    // Somebody else's now (reaped and reclaimed): theirs to beat, ours to stop.
    if (record?.token !== token) process.exit(0);
    const beatFile = `${file}.${token}.beat`;
    try {
        writeFileSync(beatFile, JSON.stringify({ ...record, at: Date.now() }));
        renameSync(beatFile, file);
    } catch {
        rmSync(beatFile, { force: true });
    }
}

setInterval(beat, intervalMs);
