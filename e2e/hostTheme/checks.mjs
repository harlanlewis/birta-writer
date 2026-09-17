/**
 * A host colour theme over the page, in a real browser.
 *
 * The Mac app applies a VS Code theme by redeclaring the palette's
 * `--vscode-*` variables in a `host-theme` style element after the palette's
 * link, and colours code-block tokens through `--host-token-*` variables that
 * `codeBlock.css` reads with the terminal palette as the fallback. Both are
 * claims about the cascade: that the override outranks the palette's dark
 * block (which has the higher specificity of the two palette blocks) under
 * either body class, that emptying the element hands the palette back (which
 * is what a live switch to the appearance does), and that a token with no
 * override keeps its fallback while one with an override takes it, face
 * included. jsdom computes none of this.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    // The grammar is a lazy chunk: wait for the block to be highlighted, not
    // merely present, or every token assertion is about a missing element.
    await page.waitForSelector(".milkdown .editor .token.keyword", { timeout: 10000 });
    await page.waitForSelector(".milkdown .editor .token.comment", { timeout: 10000 });
    await page.waitForTimeout(200);

    const root = () => page.evaluate((name) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim(), "--vscode-editor-background");
    const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    // ── The workbench colour, under both palettes ─────────────────────
    check("under vscode-dark the theme's paper outranks the palette's dark block",
        (await root()) === "#182529", await root());
    check("and the body is painted in it", (await bodyBg()) === "rgb(24, 37, 41)", await bodyBg());

    await page.evaluate(() => {
        document.body.classList.remove("vscode-dark");
        document.body.classList.add("vscode-light");
    });
    await page.waitForTimeout(50);
    check("under vscode-light the same declaration outranks the palette's light block",
        (await root()) === "#182529", await root());

    // ── Handing the palette back ──────────────────────────────────────
    // What `WebHost.setTheme(class:css:)` does for the appearance: the class
    // is the page's, and the element is emptied rather than removed.
    await page.evaluate(() => { document.getElementById("host-theme").textContent = ""; });
    await page.waitForTimeout(50);
    const lightPaper = await root();
    check("an emptied theme element hands the light palette back",
        lightPaper !== "#182529" && lightPaper.length > 0, lightPaper);
    await page.evaluate(() => {
        document.body.classList.remove("vscode-light");
        document.body.classList.add("vscode-dark");
    });
    await page.waitForTimeout(50);
    const darkPaper = await root();
    check("and the dark palette under the other class, so both defaults still stand",
        darkPaper !== "#182529" && darkPaper !== lightPaper, `${lightPaper} / ${darkPaper}`);

    // ── The tokens ────────────────────────────────────────────────────
    // Put the theme back for the token half.
    await page.evaluate(() => {
        document.getElementById("host-theme").textContent = `:root:has(body.vscode-light), :root:has(body.vscode-dark) {
  --host-token-comment: #123456;
  --host-token-comment-style: normal;
  --host-token-comment-weight: bold;
  --host-token-keyword: #abcdef;
  --host-token-keyword-style: italic;
  --host-token-keyword-weight: normal;
  --host-token-string: #fedcba;
  --vscode-editor-background: #182529;
}`;
    });
    await page.waitForTimeout(50);
    const tokens = await page.evaluate(() => {
        const read = (sel) => {
            const el = document.querySelector(`.milkdown .editor ${sel}`);
            if (!el) { return null; }
            const cs = getComputedStyle(el);
            return { color: cs.color, style: cs.fontStyle, weight: cs.fontWeight };
        };
        // What the palette says a number is coloured, resolved by the browser
        // rather than restated here, so the fallback arm compares against the
        // real fallback.
        const probe = document.createElement("span");
        probe.style.color = "var(--vscode-terminal-ansiBlue)";
        document.body.appendChild(probe);
        const blue = getComputedStyle(probe).color;
        probe.remove();
        return { comment: read(".token.comment"), keyword: read(".token.keyword"),
                 string: read(".token.string"), number: read(".token.number"),
                 present: { number: !!document.querySelector(".milkdown .editor .token.number") },
                 blue };
    });
    check("a token with a colour and a face takes both (comment: colour, upright, bold)",
        tokens.comment?.color === "rgb(18, 52, 86)" && tokens.comment?.style === "normal"
            && ["700", "bold"].includes(tokens.comment?.weight ?? ""),
        JSON.stringify(tokens.comment));
    check("a token whose face the theme sets takes it (keyword: italic, normal weight)",
        tokens.keyword?.color === "rgb(171, 205, 239)" && tokens.keyword?.style === "italic"
            && ["400", "normal"].includes(tokens.keyword?.weight ?? ""),
        JSON.stringify(tokens.keyword));
    check("a token given a colour alone keeps the face it inherits (string: upright, normal weight)",
        tokens.string?.color === "rgb(254, 220, 186)" && tokens.string?.style === "normal"
            && ["400", "normal"].includes(tokens.string?.weight ?? ""),
        JSON.stringify(tokens.string));
    check("a token the theme says nothing about keeps the palette's fallback (number: terminal blue)",
        tokens.present.number && tokens.number?.color === tokens.blue, `${tokens.number?.color} vs ${tokens.blue}`);

    // The fallback arm, on a token that IS present: drop the string override
    // and the string returns to the palette's yellow.
    const fallback = await page.evaluate(() => {
        const style = document.getElementById("host-theme");
        style.textContent = style.textContent.replace("  --host-token-string: #fedcba;\n", "");
        const probe = document.createElement("span");
        probe.style.color = "var(--vscode-terminal-ansiYellow)";
        document.body.appendChild(probe);
        const yellow = getComputedStyle(probe).color;
        probe.remove();
        const string = document.querySelector(".milkdown .editor .token.string");
        return { string: string ? getComputedStyle(string).color : null, yellow };
    });
    check("a token the theme says nothing about keeps the palette's fallback (string: terminal yellow)",
        fallback.string === fallback.yellow, JSON.stringify(fallback));
}
