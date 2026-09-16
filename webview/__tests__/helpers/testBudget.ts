/**
 * How long a test that is slow BY NATURE may take, sized to the instrument
 * running it rather than written as one number.
 *
 * A corpus walk, a whole-tree stylesheet scan, a sweep over every fixture:
 * each costs what the tree costs, and a fixed budget over it is a claim
 * about one machine on one day. Coverage instrumentation multiplies every
 * parse and every call, and a shared CI runner shares its cores, so the same
 * test reads several times slower there than on a laptop with the machine
 * to itself, and a fixed budget goes red with nothing wrong in the tree. A
 * red nobody can act on teaches the next reader to re-run rather than read,
 * which is how a real intermittent gets buried the day it arrives.
 *
 * So a budget is a BASE, measured with the machine to itself, times the
 * factor the instrument adds. `vitest.config.ts` says which instrument is
 * running: it raises the default timeout by the same factor for the whole
 * suite under coverage and hands every worker `BIRTA_TEST_COVERAGE`, which
 * is the one variable this reads. `shared/__tests__/testBudgets.test.ts`
 * holds that every per-test timeout in the tree goes through here, so a
 * fixed number cannot creep back in.
 *
 * A wait budget (`vi.waitFor`) takes the same factor for the same reason:
 * what it waits on is work, and the instrument slows the work.
 */
const COVERAGE_FACTOR = 4;

/** Whether the suite is running under coverage instrumentation. */
export const underCoverage = process.env["BIRTA_TEST_COVERAGE"] === "1";

/** `baseMs` on a bare run; scaled by the instrument's factor under coverage. */
export function budget(baseMs: number): number {
    return underCoverage ? baseMs * COVERAGE_FACTOR : baseMs;
}
