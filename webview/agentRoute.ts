/**
 * What `/ai` would run, as one line the slash menu can show at the caret.
 *
 * The extension owns the answer (`birta.agent.command` is application-scoped
 * and the raw shell template never crosses into the webview); this module
 * holds the summary it pushes and turns it into a sentence. Nothing here
 * decides anything: an unknown route is a shorter sentence, never a guess.
 *
 * The sentence is a PLACEHOLDER for the argument, so it says what to type
 * first and where it goes second. It must stay short enough not to wrap, and
 * it disappears the moment the user types (plugins/slashArgumentHint.ts).
 */
import { t } from "./i18n";
import type { AgentRouteSummary } from "../shared/messages";

let current: AgentRouteSummary | undefined;

/** Store the extension's push. Undefined until the first `agentRoute` message. */
export function setAgentRoute(route: AgentRouteSummary | undefined): void {
    current = route;
}

/** The last summary, or undefined when the host has not said. */
export function agentRoute(): AgentRouteSummary | undefined {
    return current;
}

/**
 * The effort flag's own documented values (`claude --help`), spelled the way
 * a person writes them. A value outside the set is shown exactly as the user
 * typed it: this is a display table, not a filter, and a template naming an
 * effort Birta has not heard of still names one.
 */
const EFFORT_LABELS: Readonly<Record<string, string>> = {
    low: "Low", medium: "Medium", high: "High", xhigh: "xHigh", max: "Max",
};

/** `xhigh` as `xHigh`; anything unrecognized exactly as configured. */
export function displayEffort(raw: string): string {
    return EFFORT_LABELS[raw.toLowerCase()] ?? raw;
}

/**
 * `opus` as `Opus`. Only a bare alias is title-cased; anything carrying a
 * dash or a digit is a full model id (`claude-fable-5`) and is left exactly
 * as typed, because prettifying an identifier makes it stop being the thing
 * the user could paste back into their own command.
 */
export function displayModel(raw: string): string {
    if (/[-_.\d]/.test(raw)) { return raw; }
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * `claude`, or `claude (Opus xHigh)` when the template names them. Every part
 * is an identifier the user typed into a setting, so this is not a translated
 * string: there is nothing here for a translator to decide, and a `{0} ({1})`
 * key would be a message with no message in it.
 */
function target(route: AgentRouteSummary): string {
    const harness = route.harness ?? "";
    const spec = [
        route.model ? displayModel(route.model) : undefined,
        route.effort ? displayEffort(route.effort) : undefined,
    ].filter(Boolean).join(" ");
    return spec ? `${harness} (${spec})` : harness;
}

/** Fill a single `{0}` slot, the emptyLineHint convention. */
function fill(template: string, value: string): string {
    const [before, after = ""] = template.split("{0}");
    return `${before ?? ""}${value}${after}`;
}

/**
 * The line to show after the `/ai ` pill. Falls back to the bare "your
 * request" whenever the route is unknown or nameless, which is what a host
 * other than VS Code gets: a placeholder that is true everywhere beats one
 * that names a tool nobody configured.
 */
export function agentRouteHint(route: AgentRouteSummary | undefined = current): string {
    const bare = t("your request");
    if (!route) { return bare; }
    if (!route.configured) { return t("your request; Enter to choose where it goes"); }
    if (route.kind === "chat") { return t("your request, for the Chat view"); }
    if (route.kind === "clipboard") { return t("your request, to copy for your agent"); }
    const where = target(route);
    if (!where) { return bare; }
    // Only the terminal is named. A background run is the default and shows
    // its own gutter marker a moment later, so saying so here spends width
    // on something the user is about to see anyway.
    return fill(
        route.mode === "terminal"
            ? t("edit with {0} in a terminal")
            : t("edit with {0}"),
        where,
    );
}

/**
 * The hint in parts, so the model and effort can be emphasised while the rest
 * stays quiet. `strong` is the bit naming what will run, and is empty
 * whenever nothing is named: a route with no model reads "edit with claude",
 * where emphasising the binary would draw the eye to the least surprising
 * word on the line.
 *
 * `trailing` names what Enter does with nothing typed, which is open the
 * composer. It is stated only when there IS a composer to open, so the hint
 * never promises a panel the host cannot show.
 */
export function agentRouteHintParts(
    route: AgentRouteSummary | undefined = current,
    canCompose = true,
): { text: string; strong?: string; trailing?: string } {
    const trailing = canCompose ? t("press Enter for more options") : undefined;
    if (!route?.configured || route.kind !== "shell") {
        return { text: agentRouteHint(route), trailing };
    }
    const spec = [
        route.model ? displayModel(route.model) : undefined,
        route.effort ? displayEffort(route.effort) : undefined,
    ].filter(Boolean).join(" ");
    return { text: agentRouteHint(route), strong: spec || undefined, trailing };
}
