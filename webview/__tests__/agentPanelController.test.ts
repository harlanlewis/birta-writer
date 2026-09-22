/**
 * The controller's half of the skill picker (MAR-483): a skill list is kept
 * only from a host that declares `agentSkills`. The capability is read here
 * and nowhere else, so this is the file that holds the gate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { agentSkills, resetAgentSkillsForTests, setAgentSkills } from "../agentPanelController";

const SKILLS = [{ name: "house-style", description: "Our voice.", scope: "user" as const }];

describe("setAgentSkills", () => {
    beforeEach(() => { resetAgentSkillsForTests(); });
    afterEach(() => {
        delete (window as { __i18n?: unknown }).__i18n;
    });

    it("a host declaring the capability (VS Code, absent host) should have its list kept", () => {
        setAgentSkills(SKILLS);
        expect(agentSkills()).toEqual(SKILLS);
    });

    it("a host that does not declare it should have the list dropped, so no picker can be drawn there", () => {
        (window as { __i18n?: unknown }).__i18n = {
            host: { capabilities: ["agent"], arrangements: [], shortcuts: [] },
        };
        setAgentSkills(SKILLS);
        expect(agentSkills()).toBeUndefined();
    });
});
