/**
 * messageHandlers.ts 测试：验证表格换行模式配置的应用逻辑。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyTableWrap } from "../messageHandlers";

describe("applyTableWrap", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // 清除 CSS 变量
        const root = document.documentElement;
        root.style.removeProperty("--tbl-ow");
    });

    it("aggressive 模式设置 overflow-wrap: anywhere", () => {
        applyTableWrap("aggressive");
        const val = document.documentElement.style.getPropertyValue("--tbl-ow").trim();
        expect(val).toBe("anywhere");
    });

    it("normal 模式设置 overflow-wrap: break-word", () => {
        applyTableWrap("normal");
        const val = document.documentElement.style.getPropertyValue("--tbl-ow").trim();
        expect(val).toBe("break-word");
    });

    it("none 模式设置 overflow-wrap: normal", () => {
        applyTableWrap("none");
        const val = document.documentElement.style.getPropertyValue("--tbl-ow").trim();
        expect(val).toBe("normal");
    });

    it("切换模式时覆盖之前的设置", () => {
        applyTableWrap("aggressive");
        expect(document.documentElement.style.getPropertyValue("--tbl-ow").trim()).toBe("anywhere");

        applyTableWrap("normal");
        expect(document.documentElement.style.getPropertyValue("--tbl-ow").trim()).toBe("break-word");

        applyTableWrap("none");
        expect(document.documentElement.style.getPropertyValue("--tbl-ow").trim()).toBe("normal");
    });
});
