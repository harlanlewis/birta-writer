/**
 * Vitest's end of the harness lock (see e2e/harnessLock.mjs for why it exists).
 *
 * globalSetup runs once in the main vitest process, before any worker starts,
 * which is exactly the grain the lock wants: the workers are one harness.
 *
 * WATCH MODE IS EXEMPT, deliberately. A watcher is idle almost all of the time
 * and lives for hours; holding the lock for that whole session would turn the
 * guard into a reason not to use watch mode, and a guard people route around
 * protects nothing. The trade is real and worth naming: a rebuild firing inside
 * a watch session while a sweep runs can still contend.
 */
import { acquireHarnessLock } from "./harnessLock.mjs";

// Vitest watches unless it is given the `run` subcommand, so absence of `run`
// IS watch mode — which is the semantic, and catches a bare `npx vitest` that
// a script-name check would miss. The flags and the script name are kept as
// belt and braces for an invocation shaped differently.
const isWatch =
    !process.argv.includes("run") ||
    process.argv.includes("--watch") ||
    process.argv.includes("-w") ||
    process.env["npm_lifecycle_event"] === "test:watch";

let release = () => {};

export function setup() {
    if (isWatch) return;
    release = acquireHarnessLock("vitest");
}

export function teardown() {
    release();
}
