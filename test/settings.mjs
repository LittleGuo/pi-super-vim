/**
 * Model checks for /pivim setting (no terminal, no pi):
 *
 *   node test/settings.mjs
 *
 * The screen itself is rendered by pi's TUI; what can be wrong silently is the
 * data it shows, the language it shows it in, and the values Enter/Space
 * produce, so that is what is tested.
 */

import { COPY, TABS, change, groups, parseLines } from "../settings.ts";

const en = { mode: "pane", split: "down", lines: 20, keep: true, lang: "en" };
const zh = { ...en, lang: "zh" };

function check(name, ok, extra = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` -- ${extra}` : ""}`);
	if (!ok) process.exitCode = 1;
}

const rowsOf = (tab, values) => groups(tab, values).flatMap((group) => group.rows);
const pairs = (tab, values) => rowsOf(tab, values).map((row) => `${row.label}=${row.value}`);

check("three tabs, general first", JSON.stringify(TABS) === '["general","pane","gvim"]', JSON.stringify(TABS));

check(
	"general has mode and language in English",
	JSON.stringify(groups("general", en).map((group) => `${group.label}:${group.rows.map((r) => `${r.label}=${r.value}`).join(",")}`)) ===
		JSON.stringify(["Mode:Mode=pane", "Interface:Language=en"]),
	JSON.stringify(groups("general", en).map((group) => `${group.label}:${group.rows.map((r) => `${r.label}=${r.value}`).join(",")}`)),
);
check(
	"general switches to Chinese",
	JSON.stringify(groups("general", zh).map((group) => `${group.label}:${group.rows.map((r) => `${r.label}=${r.value}`).join(",")}`)) ===
		JSON.stringify(["模式:模式=pane", "界面:语言=zh"]),
	JSON.stringify(groups("general", zh).map((group) => `${group.label}:${group.rows.map((r) => `${r.label}=${r.value}`).join(",")}`)),
);
check("pane rows in English", JSON.stringify(pairs("pane", en)) === JSON.stringify(["Split=Down", "Pane lines=20", "Keep pane=Yes"]), JSON.stringify(pairs("pane", en)));
check("pane rows in Chinese", JSON.stringify(pairs("pane", zh)) === JSON.stringify(["分屏=下", "分屏行数=20", "分屏常驻=是"]), JSON.stringify(pairs("pane", zh)));
check("keep off shows No / 否", rowsOf("pane", { ...en, keep: false })[2].value === "No" && rowsOf("pane", { ...zh, keep: false })[2].value === "否");
check("split shows the direction in both languages", rowsOf("pane", { ...en, split: "left" })[0].value === "Left" && rowsOf("pane", { ...zh, split: "left" })[0].value === "左");
check("gvim tab is empty for now", groups("gvim", en).length === 0);

check("mode cycles pane -> gvim", change(en, "mode").mode === "gvim");
check("mode cycles back", change({ ...en, mode: "gvim" }, "mode").mode === "pane");
check(
	"split cycles down -> left -> right -> up -> down",
	["down", "left", "right", "up", "down"].every((split, i) => {
		let value = en;
		for (let step = 0; step < i; step++) value = change(value, "split");
		return value.split === split;
	}),
);
check("keep toggles", change(en, "keep").keep === false && change(change(en, "keep"), "keep").keep === true);
check("language toggles en -> zh -> en", change(en, "language").lang === "zh" && change(change(en, "language"), "language").lang === "en");
check("an unknown row changes nothing", change(en, "lines") === en);

check(
	"both languages have every tab and split label",
	Object.keys(COPY.en.tabs).length === TABS.length &&
		Object.keys(COPY.zh.tabs).length === TABS.length &&
		Object.keys(COPY.en.splits).join() === "up,down,left,right" &&
		Object.keys(COPY.zh.splits).join() === "up,down,left,right",
);
check("the two languages are actually different", COPY.en.title !== COPY.zh.title && COPY.en.hint !== COPY.zh.hint);

check("lines accepts 20", parseLines("20") === 20);
check("lines accepts 1", parseLines("1") === 1);
check("lines accepts 500", parseLines("500") === 500);
check("lines rejects 0", parseLines("0") === undefined);
check("lines rejects 501", parseLines("501") === undefined);
check("lines rejects empty", parseLines("") === undefined);
check("lines rejects letters", parseLines("2a") === undefined && parseLines("-3") === undefined);
