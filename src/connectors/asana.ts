/**
 * src/connectors/asana.ts
 *
 * The Asana connector's response mapper (MAR-186): one app.asana.com REST body
 * to the provider-agnostic card the webview renders.
 *
 * Asana is the connector that proves the THIRD rung of the auth ladder. GitHub
 * rides a credential VS Code already holds; Linear rides OAuth-PKCE with a
 * registered public client; Asana can do neither, because its OAuth issues a
 * client secret and a secret inside a distributed extension is not one. What
 * Asana does offer is a personal access token, which is the rung the seam was
 * shaped for and the rung nothing had ever run.
 *
 * Hand-rolled against the REST shape with no client SDK, per MAR-198's rule: a
 * dependency here would be an unauditable surface and eager weight for one card.
 *
 * Every string that leaves this module is sanitized (`sanitizeTitle`: entities
 * decoded, control characters stripped, whitespace collapsed, length capped)
 * before it crosses to the webview, which renders it as third-party content.
 */
import * as vscode from "vscode";
import { sanitizeTitle } from "../utils/openGraph";
import type { EmbedMatch } from "../../shared/embedProviders";
import type { EmbedCardData } from "../../shared/connectors";

/** One level of an untrusted JSON body, or null. */
function obj(value: unknown, key: string): Record<string, unknown> | null {
    const nested = (value as Record<string, unknown> | null)?.[key];
    return typeof nested === "object" && nested !== null
        ? (nested as Record<string, unknown>)
        : null;
}

/** Read one string field off an untrusted body, sanitized or undefined. */
function str(value: unknown, key: string): string | undefined {
    const found = (value as Record<string, unknown> | null)?.[key];
    return typeof found === "string" ? (sanitizeTitle(found) ?? undefined) : undefined;
}

/**
 * Build the card for a recognized Asana embed from its API response, or null
 * when the body is not the shape the endpoint promises.
 *
 * Null rather than a partial card in two cases the caller turns into an
 * `error` card: no `data` object at all (which is how Asana answers a refusal
 * it did not give a status to), and a task with no name (a shape the
 * projection cannot produce, so it means the body is not what it claims).
 */
export function asanaCard(_match: EmbedMatch, body: unknown): EmbedCardData | null {
    const data = obj(body, "data");
    if (!data) {
        return null;
    }
    const title = str(data, "name");
    if (title === undefined) {
        return null;
    }

    // Assignee and due date, in that order, joined into the one supporting
    // line `EmbedCardData` allows. `due_on` is Asana's own calendar date and
    // is passed through as the provider spells it rather than reformatted:
    // this module has no locale, and a date rewritten into the wrong one reads
    // as a different day.
    const bits: string[] = [];
    const assignee = str(obj(data, "assignee"), "name");
    if (assignee !== undefined) {
        bits.push(assignee);
    }
    const dueOn = str(data, "due_on");
    if (dueOn !== undefined) {
        bits.push(vscode.l10n.t("Due {0}", dueOn));
    }

    return {
        title,
        ...(bits.length > 0 ? { subtitle: bits.join(" · ") } : {}),
        // Completion is the one fact the card exists for, and it is a boolean
        // rather than a workflow state: Asana has sections and custom fields,
        // but `completed` is the only status every task in every workspace
        // has. A body that omits it gets no chip rather than a guessed one.
        ...(typeof data.completed === "boolean"
            ? { status: data.completed ? vscode.l10n.t("Completed") : vscode.l10n.t("Open") }
            : {}),
    };
}
