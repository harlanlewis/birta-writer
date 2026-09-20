/**
 * The Asana connector (MAR-186): the request it builds and the card it maps.
 *
 * Asana is the first provider on the `token` rung, which until now was a
 * strategy with no provider behind it. What that rung changes is WHERE the
 * credential comes from and nothing else: the request is still rebuilt from
 * parts the recognizer validated, still pinned to one host, and still
 * unreachable from any string a document contains. These assertions are
 * written to hold that, and to hold the one thing a single-host provider makes
 * easy to lose sight of, which is that the host is fixed rather than derived.
 */
import { describe, it, expect } from "vitest";
import { connectorApiRequest, CONNECTORS, type EmbedCardData } from "../../shared/connectors";
import { recognizeEmbed, type EmbedMatch } from "../../shared/embedProviders";
import { asanaCard } from "../connectors/asana";

/** Recognize a URL the way the resolve path does, refusing to guess. */
function matchFor(url: string): EmbedMatch {
    const match = recognizeEmbed(url);
    if (!match) { throw new Error(`not recognized: ${url}`); }
    return match;
}

const TASK_URL = "https://app.asana.com/0/1201234567890123/1207654321098765";
const TASK_GID = "1207654321098765";

/** The body shape the projection asks for, as Asana wraps it. */
const task = (fields: Record<string, unknown>): unknown => ({ data: { gid: TASK_GID, ...fields } });

describe("the Asana connector's spec", () => {
    it("should pin one exact API host and take its verify URL from that host", () => {
        const spec = CONNECTORS.asana;
        expect(spec.apiHosts).toEqual(["app.asana.com"]);
        expect(new URL(spec.verifyUrl).hostname).toBe("app.asana.com");
        // The cheapest authenticated call Asana has, and one that names the
        // account rather than anything the user opened: verifying is about the
        // credential, never about a document.
        expect(spec.verifyUrl).toBe("https://app.asana.com/api/1.0/users/me");
    });

    it("should declare that it cannot be read anonymously", () => {
        // All three rows, because the flag's whole purpose is that providers
        // differ: asserting Asana alone would pass against a constant.
        expect(CONNECTORS.asana.anonymousReads).toBe(false);
        expect(CONNECTORS.linear.anonymousReads).toBe(false);
        expect(CONNECTORS.github.anonymousReads).toBe(true);
    });

    it("should be the token rung, with no OAuth client to ship a secret in", () => {
        expect(CONNECTORS.asana.auth).toBe("token");
        expect(CONNECTORS.asana.oauth).toBeUndefined();
        expect(CONNECTORS.asana.builtinProviderId).toBeUndefined();
    });
});

describe("connectorApiRequest for Asana", () => {
    it("should GET the task endpoint on the pinned host", () => {
        const request = connectorApiRequest(matchFor(TASK_URL));
        expect(request?.connector).toBe("asana");
        expect(new URL(request!.url).hostname).toBe("app.asana.com");
        expect(new URL(request!.url).pathname).toBe(`/api/1.0/tasks/${TASK_GID}`);
        // GET, not POST: no body, which is what the absent field means.
        expect(request?.body).toBeUndefined();
    });

    it("should ask for a fixed projection the document cannot widen", () => {
        // The field list is a constant this repository owns, the same way
        // Linear's query is. Every shape of URL must produce the same one, or
        // the document is contributing to what comes back.
        const projections = new Set<string | null>();
        for (const url of [
            TASK_URL,
            `${TASK_URL}/f`,
            "https://app.asana.com/1/1100000000000001/project/1201234567890123/task/1207654321098765",
            "https://app.asana.com/1/1100000000000001/task/1207654321098765",
        ]) {
            const request = connectorApiRequest(matchFor(url));
            expect(request).not.toBeNull();
            projections.add(new URL(request!.url).searchParams.get("opt_fields"));
            // Every shape names the same task, so every shape asks the same
            // path: the outer URL is a way in, not part of the request.
            expect(new URL(request!.url).pathname).toBe(`/api/1.0/tasks/${TASK_GID}`);
        }
        expect(projections.size).toBe(1);
        expect([...projections][0]).toBe("name,completed,assignee.name,due_on");
    });

    it("should ask nothing for a hand-built id whose task gid is not a number", () => {
        // The recognizer cannot produce these; the request builder must refuse
        // them anyway, because it is not allowed to depend on having run.
        for (const id of ["0/1/../../secret", "0/1/abc", "1/1/task/", "", "0/1"]) {
            expect(connectorApiRequest({ kind: "asana", id })).toBeNull();
        }
    });

    it("should bound the gid, and keep the host a literal whatever the id says", () => {
        // A single-host provider is the case where a host could be derived
        // from the URL without anyone noticing. It is not: the host is written
        // out here, and a validated gid reaches only the path.
        expect(connectorApiRequest({ kind: "asana", id: `0/1/${"9".repeat(21)}` })).toBeNull();
        const atBound = connectorApiRequest({ kind: "asana", id: `0/1/${"9".repeat(20)}` });
        expect(new URL(atBound!.url).hostname).toBe("app.asana.com");
        // An id that spells a whole other URL reaches nothing: it is not a
        // gid, so no request is built at all.
        expect(connectorApiRequest({ kind: "asana", id: "0/1/https://evil.example/1" })).toBeNull();
    });
});

describe("asanaCard", () => {
    const match = matchFor(TASK_URL);
    const card = (body: unknown): EmbedCardData | null => asanaCard(match, body);

    it("should map a complete task to title, assignee, due date and state", () => {
        expect(card(task({
            name: "Ship the token rung",
            completed: false,
            assignee: { name: "Jane Doe" },
            due_on: "2026-09-30",
        }))).toEqual({
            title: "Ship the token rung",
            subtitle: "Jane Doe · Due 2026-09-30",
            status: "Open",
        });
    });

    it("should read a completed task as Completed rather than as no status", () => {
        expect(card(task({ name: "Done thing", completed: true })))
            .toEqual({ title: "Done thing", status: "Completed" });
    });

    it("should omit the subtitle when nobody is assigned and nothing is due", () => {
        const built = card(task({ name: "Unowned", completed: false }));
        expect(built).toEqual({ title: "Unowned", status: "Open" });
        expect(built).not.toHaveProperty("subtitle");
    });

    it("should carry a due date with no assignee on its own", () => {
        expect(card(task({ name: "Deadline", completed: false, due_on: "2026-01-02" })))
            .toEqual({ title: "Deadline", subtitle: "Due 2026-01-02", status: "Open" });
    });

    it("should omit the status unless completion arrived as a real boolean", () => {
        // Absent means unknown, and unknown draws no chip rather than a
        // guessed one. The non-boolean cases are what make this a type check
        // rather than a presence check: under a truthiness read, a `null`
        // would draw "Open" and a string would draw "Completed", both of them
        // claims about a task the body never made.
        for (const completed of [undefined, null, "yes", 0, {}]) {
            const built = card(task(completed === undefined ? { name: "x" } : { name: "x", completed }));
            expect(built, `completed: ${JSON.stringify(completed)}`).toEqual({ title: "x" });
        }
    });

    it("should sanitize every string before it crosses to the webview", () => {
        const built = card(task({
            name: "Ship\u0000 the\u0007  rung &amp; more",
            completed: false,
            assignee: { name: "Jane\nDoe" },
        }));
        expect(built?.title).toBe("Ship the rung & more");
        expect(built?.subtitle).toBe("Jane Doe");
    });

    it("should refuse a body that is not the shape the endpoint promises", () => {
        // Each one turns into an `error` card at the caller, never a blank one.
        expect(card(null)).toBeNull();
        expect(card({})).toBeNull();
        expect(card({ data: null })).toBeNull();
        expect(card({ errors: [{ message: "Not Authorized" }] })).toBeNull();
        expect(card(task({ completed: false }))).toBeNull();
        expect(card(task({ name: 42 }))).toBeNull();
    });
});
