/**
 * The `/ai` composer's two pickers (webview/components/agentPanel/index.ts),
 * driven the way a user drives them.
 *
 * The subject is what the panel SENDS, not what it draws. A menu row is easy
 * to assert into existence and proves nothing: the defect this file was
 * written for was a row that rendered perfectly and could not change the
 * request behind it, so every case here ends at `host.submit`.
 *
 * Capabilities are passed in rather than probed, because the panel's whole
 * contract is that the harness decides what it may offer and this file
 * decides none of it. The three shapes that matter are a published scale, a
 * flag with no scale, and no effort flag at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAgentPanel, type AgentPanelHandle, type AgentPanelHost } from "../components/agentPanel";
import type { AgentSkill, HarnessCapabilities } from "../../shared/messages";

/** A harness publishing its rungs, as Claude Code, Cline and Copilot do. */
const WITH_SCALE: HarnessCapabilities = {
    harness: "claude",
    version: "1",
    supportsModel: true,
    supportsEffort: true,
    modelFlag: "--model",
    effortFlag: "--effort",
    efforts: ["low", "medium", "high"],
    modelExamples: ["opus", "sonnet"],
};

/**
 * A harness naming its effort flag and publishing no rungs, which is aider
 * and is the shape the free-text row exists for. Reached through
 * `EFFORT_FLAGS` rather than through the flag's values, so `efforts` is
 * empty by construction and not by omission here.
 */
const NO_SCALE: HarnessCapabilities = {
    ...WITH_SCALE,
    harness: "aider",
    effortFlag: "--reasoning-effort",
    efforts: [],
    modelExamples: [],
};

/** A harness with no reasoning flag at all, which is Codex. */
const NO_EFFORT: HarnessCapabilities = {
    ...WITH_SCALE,
    harness: "codex",
    supportsEffort: false,
    effortFlag: undefined,
    efforts: [],
};

let host: AgentPanelHost & { submit: ReturnType<typeof vi.fn>; dismiss: ReturnType<typeof vi.fn> };
let panel: AgentPanelHandle;

function open(caps: HarnessCapabilities | undefined, skills?: readonly AgentSkill[]): void {
    host = {
        saveAttachment: vi.fn(),
        submit: vi.fn(),
        dismiss: vi.fn(),
    };
    panel = createAgentPanel({
        anchor: { left: 0, top: 0, bottom: 0 },
        capabilities: caps,
        skills,
        host,
    });
    document.body.appendChild(panel.el);
}

/** The spec row's buttons, in the order the panel draws them. */
function specButtons(): HTMLButtonElement[] {
    return [...panel.el.querySelectorAll<HTMLButtonElement>(".agent-panel-spec-btn")];
}

/** Open one picker and return its rows' labels. */
function rowsOf(btn: HTMLButtonElement): string[] {
    btn.click();
    const menu = panel.el.querySelector(".agent-panel-menu");
    return [...(menu?.querySelectorAll(".agent-panel-menu-row") ?? [])].map((r) => r.textContent ?? "");
}

/** Click the row with this label in the open menu. */
function clickRow(label: string): void {
    const menu = panel.el.querySelector(".agent-panel-menu");
    const row = [...(menu?.querySelectorAll<HTMLElement>(".agent-panel-menu-row") ?? [])]
        .find((r) => r.textContent === label);
    if (!row) { throw new Error(`no menu row labelled ${label}; rows: ${menu?.textContent}`); }
    row.click();
}

/** Type into the field the free-text row opened, and press `key`. */
function typeInto(value: string, key: string): void {
    const field = panel.el.querySelector<HTMLInputElement>(".agent-panel-menu-input");
    if (!field) { throw new Error("the free-text row opened no field"); }
    field.value = value;
    field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

/** Put a request in and send it, so the assertion is on what was submitted. */
function sendPrompt(): Record<string, unknown> {
    const textarea = panel.el.querySelector<HTMLTextAreaElement>(".agent-panel-input")!;
    textarea.value = "do the thing";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(host.submit).toHaveBeenCalledTimes(1);
    return host.submit.mock.calls[0]![0] as Record<string, unknown>;
}

describe("the composer's pickers", () => {
    beforeEach(() => {
        document.body.textContent = "";
        vi.clearAllMocks();
    });

    it("a harness with no effort flag should draw no effort picker at all", () => {
        // The floor the whole design lands on, and the control for every
        // case below: one button means the effort half is genuinely absent
        // rather than present and empty.
        open(NO_EFFORT);

        expect(specButtons()).toHaveLength(1);
        expect(specButtons()[0]!.textContent).toBe("Default model");
    });

    it("a published scale should be the whole effort menu, with no free-text row", () => {
        // The judgement this pins. An effort list is an enumeration read off
        // the flag's own documented values, and clap and yargs both reject
        // anything outside it, so a typed rung here would be a command that
        // fails rather than a request that differs.
        open(WITH_SCALE);

        expect(rowsOf(specButtons()[1]!)).toEqual(["Default effort", "Low", "Medium", "High"]);
    });

    it("a model list should keep its free-text row, because a list of models is examples", () => {
        // The asymmetry, asserted beside its opposite so the two cannot be
        // quietly made uniform: the same capabilities object yields a
        // free-text row on one picker and not on the other.
        open(WITH_SCALE);

        expect(rowsOf(specButtons()[0]!)).toEqual(["Default model", "Opus", "Sonnet", "Other model…"]);
    });

    it("an effort flag with no scale should offer free text rather than the default alone", () => {
        // The defect this increment removes. Before the row, this menu held
        // exactly one item, the default the user already had: a button that
        // opened onto nothing.
        open(NO_SCALE);

        expect(rowsOf(specButtons()[1]!)).toEqual(["Default effort", "Other effort…"]);
    });

    it("an effort typed into that row should reach the request", () => {
        // The assertion that matters. A row that renders and cannot change
        // what is sent is the same class of defect as the empty menu, so the
        // subject here is `submit`, not the DOM.
        open(NO_SCALE);
        rowsOf(specButtons()[1]!);
        clickRow("Other effort…");
        typeInto("high", "Enter");

        expect(specButtons()[1]!.textContent).toBe("High");
        expect(sendPrompt().effort).toBe("high");
    });

    it("a typed effort should not be mistaken for a model", () => {
        // The failure the generic descriptor exists to stop. Both pickers
        // share one field, and the first cut read and wrote `model` from
        // inside it whichever row had opened it, which would have sent the
        // effort as the model and left the effort unset.
        open(NO_SCALE);
        rowsOf(specButtons()[1]!);
        clickRow("Other effort…");
        typeInto("xhigh", "Enter");
        const sent = sendPrompt();

        expect(sent.effort).toBe("xhigh");
        expect(sent.model).toBeUndefined();
    });

    it("a typed model should still reach the request, unchanged by the effort row", () => {
        // The other direction of the same swap, because a descriptor wired
        // to the wrong variable twice would satisfy the test above.
        open(NO_SCALE);
        rowsOf(specButtons()[0]!);
        clickRow("Other model…");
        typeInto("my-local-model", "Enter");
        const sent = sendPrompt();

        expect(sent.model).toBe("my-local-model");
        expect(sent.effort).toBeUndefined();
    });

    it("an emptied field should mean the harness decides, not an empty flag", () => {
        // `--reasoning-effort ""` is a value the CLI rejects. Absent is how
        // "let the harness decide" is expressed, which is the same rule
        // `setTemplateFlag` holds on the extension side.
        open(NO_SCALE);
        rowsOf(specButtons()[1]!);
        clickRow("Other effort…");
        typeInto("high", "Enter");
        rowsOf(specButtons()[1]!);
        clickRow("Other effort…");
        typeInto("   ", "Enter");

        expect(specButtons()[1]!.textContent).toBe("Default effort");
        expect(sendPrompt().effort).toBeUndefined();
    });

    it("the field should open on the current choice, so editing is not retyping", () => {
        open(NO_SCALE);
        rowsOf(specButtons()[1]!);
        clickRow("Other effort…");
        typeInto("medium", "Enter");
        rowsOf(specButtons()[1]!);
        clickRow("Other effort…");

        expect(panel.el.querySelector<HTMLInputElement>(".agent-panel-menu-input")!.value)
            .toBe("medium");
    });

    it("Escape in that field should abandon the edit rather than commit it", () => {
        // Escape closes the menu and leaves the panel open, so a half-typed
        // value must not become the effort the request runs with.
        open(NO_SCALE);
        rowsOf(specButtons()[1]!);
        clickRow("Other effort…");
        typeInto("hig", "Escape");

        expect(panel.el.querySelector(".agent-panel-menu")).toBeNull();
        expect(specButtons()[1]!.textContent).toBe("Default effort");
        expect(sendPrompt().effort).toBeUndefined();
    });

    it("capabilities arriving after the panel opened should bring the row with them", () => {
        // The probe is kicked off when the document opens and nothing waits
        // on it, so a panel opened first has no controls and gains them.
        open(undefined);
        expect(specButtons()).toHaveLength(0);

        panel.setCapabilities(NO_SCALE);

        expect(rowsOf(specButtons()[1]!)).toEqual(["Default effort", "Other effort…"]);
    });
});

/**
 * The third picker (MAR-483): the skills the host's scan reached. Drawn
 * exactly when a list arrived, grouped by where each came from, free text
 * always reachable, and the pick sent by name.
 */
describe("the composer's skill picker", () => {
    const SKILLS: readonly AgentSkill[] = [
        { name: "birta-changelog", description: "Write a changelog entry.", scope: "project" },
        { name: "house-style", description: "Our voice.", scope: "user" },
    ];

    /** Click the row whose label (its first text node) is this. */
    function clickSkillRow(label: string): void {
        const menu = panel.el.querySelector(".agent-panel-menu");
        const row = [...(menu?.querySelectorAll<HTMLElement>(".agent-panel-menu-row") ?? [])]
            .find((r) => r.firstChild?.textContent === label);
        if (!row) { throw new Error(`no menu row labelled ${label}; rows: ${menu?.textContent}`); }
        row.click();
    }

    beforeEach(() => {
        document.body.textContent = "";
        vi.clearAllMocks();
    });

    it("a host that sent no list should draw no skill picker, capabilities or not", () => {
        open(WITH_SCALE);
        expect(specButtons().map((b) => b.textContent)).toEqual(["Default model", "Default effort"]);
    });

    it("an empty list should still draw the picker, with the default and free text alone", () => {
        open(undefined, []);
        expect(specButtons().map((b) => b.textContent)).toEqual(["No skill"]);
        expect(rowsOf(specButtons()[0]!)).toEqual(["No skill", "Other skill…"]);
    });

    it("the scan's findings should be grouped by where they came from, each with its description as text", () => {
        open(WITH_SCALE, SKILLS);
        const btn = specButtons()[2]!;
        expect(btn.textContent).toBe("No skill");
        btn.click();
        const menu = panel.el.querySelector(".agent-panel-menu")!;
        expect([...menu.querySelectorAll(".agent-panel-menu-heading")].map((h) => h.textContent)).toEqual(["This project", "Your machine"]);
        const rows = [...menu.querySelectorAll(".agent-panel-menu-row")].map((r) => r.firstChild?.textContent);
        expect(rows).toEqual(["No skill", "/birta-changelog", "/house-style", "Other skill…"]);
        const detail = menu.querySelector(".agent-panel-menu-detail")!;
        expect(detail.textContent).toBe("Write a changelog entry.");
        expect(detail.children.length).toBe(0);
    });

    it("a picked skill should reach the request by name, and show on the button", () => {
        open(WITH_SCALE, SKILLS);
        specButtons()[2]!.click();
        clickSkillRow("/house-style");
        expect(specButtons()[2]!.textContent).toBe("/house-style");
        expect(sendPrompt().skill).toBe("house-style");
    });

    it("a description in the file should never become markup in the menu", () => {
        open(undefined, [{ name: "x", description: "<b>bold</b> <img src=x onerror=alert(1)>", scope: "user" }]);
        specButtons()[0]!.click();
        const detail = panel.el.querySelector(".agent-panel-menu-detail")!;
        expect(detail.querySelector("b, img")).toBeNull();
        expect(detail.textContent).toContain("<b>bold</b>");
    });

    it("a skill typed into the free-text row should reach the request, its leading slash dropped", () => {
        open(undefined, SKILLS);
        specButtons()[0]!.click();
        clickSkillRow("Other skill…");
        typeInto("/synced-one", "Enter");
        expect(sendPrompt().skill).toBe("synced-one");
    });

    it("No skill should send no skill, and a list arriving after the panel opened should bring the picker with it", () => {
        open(undefined);
        expect(specButtons()).toHaveLength(0);
        panel.setSkills(SKILLS);
        expect(specButtons().map((b) => b.textContent)).toEqual(["No skill"]);
        specButtons()[0]!.click();
        clickSkillRow("/house-style");
        specButtons()[0]!.click();
        clickSkillRow("No skill");
        expect(sendPrompt().skill).toBeUndefined();
    });
});
