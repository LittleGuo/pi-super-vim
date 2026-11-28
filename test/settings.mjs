/**
 * Model checks for /pivim setting (no terminal, no pi):
 *
 *   node test/settings.mjs
 *
 * The screen itself is rendered by pi's TUI; what can be wrong silently is the
 * data it shows and the values Enter/Space produce, so that is what is tested.
 */

import { SECTION_LABEL, TAB_LABELS, TABS, change, parseLines, rows } from "../settings.ts";

const base = { mode: "pane", split: "down", lines: 20, keep: true };

function check(name, ok, extra = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` -- ${extra}` : ""}`);
	if (!ok) process.exitCode = 1;
}

check("three tabs, general first", JSON.stringify(TABS) === '["general","pane","gvim"]', JSON.stringify(TABS));
check(
	"tab labels",
	JSON.stringify(Object.values(TAB_LABELS)) === '["常规","pane","gvim"]',
	JSON.stringify(Object.values(TAB_LABELS)),
);

check(
	"general shows the mode",
	JSON.stringify(rows("general", base)) === JSON.stringify([{ id: "mode", label: "模式", value: "pane" }]),
	JSON.stringify(rows("general", base)),
);

const paneRows = rows("pane", base);
check(
	"pane shows split / lines / keep",
	JSON.stringify(paneRows.map((row) => `${row.label}=${row.value}`)) === JSON.stringify(["分屏=下", "分屏行数=20", "分屏常驻=是"]),
	JSON.stringify(paneRows.map((row) => `${row.label}=${row.value}`)),
);
check("keep off shows 否", rows("pane", { ...base, keep: false })[2].value === "否");
check("split shows the direction", rows("pane", { ...base, split: "left" })[0].value === "左");
check("gvim tab is empty for now", rows("gvim", base).length === 0);
check(
	"each tab has a section header (gvim none)",
	JSON.stringify([SECTION_LABEL.general, SECTION_LABEL.pane, SECTION_LABEL.gvim]) === '["模式","分屏",""]',
	JSON.stringify([SECTION_LABEL.general, SECTION_LABEL.pane, SECTION_LABEL.gvim]),
);

check("mode cycles pane -> gvim", change(base, "mode").mode === "gvim");
check("mode cycles back", change({ ...base, mode: "gvim" }, "mode").mode === "pane");
check(
	"split cycles down -> left -> right -> up -> down",
	["down", "left", "right", "up", "down"].every((split, i) => {
		let value = base;
		for (let step = 0; step <= i; step++) if (step > 0) value = change(value, "split");
		return value.split === split;
	}),
	JSON.stringify([0, 1, 2, 3, 4].map((i) => {
		let value = base;
		for (let step = 0; step < i; step++) value = change(value, "split");
		return value.split;
	})),
);
check("keep toggles", change(base, "keep").keep === false && change(change(base, "keep"), "keep").keep === true);
check("an unknown row changes nothing", change(base, "lines") === base);

check("lines accepts 20", parseLines("20") === 20);
check("lines accepts 1", parseLines("1") === 1);
check("lines accepts 500", parseLines("500") === 500);
check("lines rejects 0", parseLines("0") === undefined);
check("lines rejects 501", parseLines("501") === undefined);
check("lines rejects empty", parseLines("") === undefined);
check("lines rejects letters", parseLines("2a") === undefined && parseLines("-3") === undefined);
