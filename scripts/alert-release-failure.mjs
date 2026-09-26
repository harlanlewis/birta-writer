/**
 * Raise a blocked release where the maintainer will actually see it.
 *
 * The Release workflow is the only nightly whose failure stops shipping, and
 * until this script existed it was the only one with no failure handler at all.
 * Its two siblings (perf-nightly, nightly-fidelity) write a run summary and rely
 * on GitHub emailing the maintainer when a scheduled workflow fails. That email
 * goes to whoever last touched the cron rather than to the repo owner by
 * definition, and it is an Actions notification, which is the class people
 * filter away. Three nights of blocked releases went unnoticed that way on
 * 2026-09-10 through 2026-09-12.
 *
 * So this writes to the tracker instead, which is where AGENTS.md says tracked
 * work lives and where the maintainer already looks. It is deliberately NOT a
 * GitHub issue: `nightly-fidelity.yml` explicitly refuses to open one, and an
 * alert is not a reason to break that rule.
 *
 * It DEDUPES. A release stays blocked until someone fixes it, so a nightly that
 * files a fresh Urgent issue every night would bury the one that matters under
 * its own repetitions. An open issue carrying the marker gets a comment; only
 * the absence of one creates anything.
 *
 * It never fails the workflow. The workflow has already failed by the time this
 * runs, and a broken alert reporting a second failure tells the reader nothing
 * about the release. Every exit path here is 0, and every one of them writes
 * what happened into the run summary, including "I could not reach Linear",
 * because an alerting path that can fail silently is the thing this file exists
 * to stop being true.
 */

import { appendFileSync } from "fs";

const API = "https://api.linear.app/graphql";
const TEAM_KEY = process.env["LINEAR_TEAM_KEY"] ?? "MAR";
const MARKER = "<!-- nightly-release-blocked -->";

const {
    LINEAR_API_KEY,
    GITHUB_SERVER_URL = "https://github.com",
    GITHUB_REPOSITORY = "",
    GITHUB_RUN_ID = "",
    GITHUB_SHA = "",
    JOB_RESULTS = "{}",
} = process.env;

const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;

/** Everything this script says goes to the run summary as well as to Linear. */
function summary(text) {
    process.stdout.write(`${text}\n`);
    const file = process.env["GITHUB_STEP_SUMMARY"];
    if (file) appendFileSync(file, `${text}\n`);
}

async function graphql(query, variables) {
    const res = await fetch(API, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: LINEAR_API_KEY,
        },
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Linear API returned HTTP ${res.status}`);
    const body = await res.json();
    if (body.errors) {
        throw new Error(
            `Linear API error: ${body.errors.map((e) => e.message).join("; ")}`,
        );
    }
    return body.data;
}

function failedJobs() {
    let results;
    try {
        results = JSON.parse(JOB_RESULTS);
    } catch {
        return [];
    }
    return Object.entries(results)
        .filter(([, r]) => r?.result === "failure")
        .map(([id]) => id);
}

const failed = failedJobs();
const failedList = failed.length ? failed.join(", ") : "(none reported)";

// Whether the release itself failed, or something after it did, because the
// two have different consequences and saying the wrong one costs the alert
// its credibility. A reader told nothing shipped, who then finds the release
// on GitHub and the extension on the Marketplace, has been taught to check
// this issue rather than act on it.
const releaseFailed = failed.includes("release");

const consequence = releaseFailed
    ? `The nightly Release run failed in its first job, so nothing was published: no GitHub Release, no Marketplace or Open VSX publish, and no Mac app asset. An installed copy asking for an update is told it is up to date, truthfully, because the newest release really is the last one that succeeded.`
    : `The nightly Release run cut its release, and then ${failedList} failed. What that job produces is missing from this release and from every release until it is fixed; every other surface shipped. An installed copy asking for something that job makes is told there is nothing newer, truthfully, because the newest release carrying it really is the last one that succeeded.`;

const mechanism = releaseFailed
    ? `The publish jobs are \`needs: release\`, so a failure in the first job skips the rest and every surface stops at once. Read the failing step in the run above rather than inferring the cause from the job name.`
    : `The publish jobs are \`needs: release\` but not on each other, so one of them failing leaves the others alone and the release stands with a hole in it. Read the failing step in the run above rather than inferring the cause from the job name.`;

const body = [
    MARKER,
    "",
    consequence,
    "",
    `* Run: ${runUrl}`,
    `* Commit: \`${GITHUB_SHA}\``,
    `* Failed jobs: ${failedList}`,
    "",
    mechanism,
    "",
    `This comment is written by \`scripts/alert-release-failure.mjs\`. It appends to this issue rather than filing a new one each night, so the age of the issue is how long shipping has been blocked.`,
].join("\n");

async function main() {
    summary("## Release blocked");
    summary("");
    summary(`Failed jobs: ${failedList}`);
    summary(`Run: ${runUrl}`);
    summary("");

    if (!LINEAR_API_KEY) {
        summary(
            "**No `LINEAR_API_KEY` secret is set, so no tracker alert was raised.** " +
                "This run summary is the only record, which is the situation this " +
                "script exists to end. Add the secret in repository settings.",
        );
        // The report itself, since by the line above this summary is the whole
        // record. Printing only the job names would leave the reader to work
        // out which surfaces stopped, which is the question the body answers.
        summary("");
        summary(body);
        return;
    }

    // Deliberately a plain team query with the matching done here, rather than
    // a server-side filter on the marker.
    //
    // The first cut filtered on `description: { contains: $marker }` and on
    // `state: { type: { nin: [...] } }`. Neither was verified against the
    // schema, and an alert is the worst place to discover a filter does not
    // exist: a query that errors means no issue is filed on the one night it
    // was needed, and the failure lands inside the catch that reports "could
    // not raise the alert" rather than anywhere a schema problem is legible.
    //
    // `issues(filter: { team: { key: { eq } } })` is the shape Linear's own
    // documentation uses everywhere, so it is the one assumption left, and the
    // marker and the open-ness are decided from fields every issue carries.
    //
    // `first: 250` is Linear's page maximum. A team with more than 250 issues
    // could hide an existing alert past the page boundary and file a second
    // one, which is a duplicate rather than a silence, and the wrong way round
    // to fail.
    const found = await graphql(
        `query($key: String!) {
            issues(filter: { team: { key: { eq: $key } } }, first: 250) {
                nodes { id identifier url description state { type } }
            }
        }`,
        { key: TEAM_KEY },
    );

    const open = found.issues.nodes.find(
        (n) =>
            typeof n.description === "string" &&
            n.description.includes(MARKER) &&
            n.state?.type !== "completed" &&
            n.state?.type !== "canceled",
    );
    if (open) {
        await graphql(
            `mutation($issueId: String!, $body: String!) {
                commentCreate(input: { issueId: $issueId, body: $body }) {
                    success
                }
            }`,
            { issueId: open.id, body },
        );
        summary(
            `Commented on the open alert issue [${open.identifier}](${open.url}). ` +
                `Shipping has been blocked since it was filed.`,
        );
        return;
    }

    const team = await graphql(
        `query($key: String!) {
            teams(filter: { key: { eq: $key } }) { nodes { id } }
            issueLabels(filter: { name: { eq: "#Bug" } }) { nodes { id } }
        }`,
        { key: TEAM_KEY },
    );
    const teamId = team.teams.nodes[0]?.id;
    if (!teamId) {
        summary(`**No Linear team with key \`${TEAM_KEY}\`, so no issue was filed.**`);
        return;
    }
    const labelIds = team.issueLabels.nodes.map((n) => n.id);

    const created = await graphql(
        `mutation($input: IssueCreateInput!) {
            issueCreate(input: $input) { issue { identifier url } }
        }`,
        {
            input: {
                teamId,
                labelIds,
                priority: 1,
                title: releaseFailed
                    ? "Nightly Release is blocked, so nothing is shipping"
                    : `Nightly Release is shipping without ${failedList}`,
                description: body,
            },
        },
    );

    const issue = created.issueCreate.issue;
    summary(`Filed [${issue.identifier}](${issue.url}) as Urgent.`);
}

main().catch((err) => {
    // Deliberately not a rethrow. The workflow has already failed; a second
    // failure here would replace the release's own diagnosis with this script's.
    summary(`**The tracker alert could not be raised: ${err.message}**`);
    summary("The run summary above is the only record of this failure.");
});
