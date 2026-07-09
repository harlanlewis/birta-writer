/**
 * webview/perfBoot.ts
 *
 * Must be imported as the FIRST line of webview/index.ts. ES module evaluation
 * order guarantees a module's imports run before its own body, so importing
 * this first stamps `mdw:eval-start` at the earliest point the bundle can
 * observe — before any other webview module has evaluated. The gap from
 * navigation start to this mark is the browser's script-fetch + parse cost;
 * the gap from here to `mdw:ready-posted` is the eager module-eval + UI
 * construction cost.
 */
import { mark } from "./perf";

mark("eval-start");
