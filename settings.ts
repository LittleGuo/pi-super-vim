/**
 * /pivim setting -- the settings screen.
 *
 * The model (groups / values / cycling) is plain data so the tests can check it
 * without a terminal; the TUI half is loaded lazily so nothing pulls
 * @earendil-works/pi-tui into a plain node process.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SettingsMode = "pane" | "gvim";
export type SettingsSplit = "up" | "down" | "left" | "right";
export type SettingsLanguage = "en" | "zh";
export type SettingsTab = "general" | "pane" | "gvim";

export interface SettingsValues {
	mode: SettingsMode;
	split: SettingsSplit;
	lines: number;
	keep: boolean;
	lang: SettingsLanguage;
}

export const TABS: SettingsTab[] = ["general", "pane", "gvim"];

interface Copy {
	title: string;
	tabs: Record<SettingsTab, string>;
	sections: { mode: string; ui: string; split: string };
	hint: string;
	editHint: string;
	empty: string;
	labels: { mode: string; language: string; split: string; lines: string; keep: string };
	yes: string;
	no: string;
	splits: Record<SettingsSplit, string>;
}

export const COPY: Record<SettingsLanguage, Copy> = {
	en: {
		title: "Super Vim Settings",
		tabs: { general: "General", pane: "pane", gvim: "gvim" },
		sections: { mode: "Mode", ui: "Interface", split: "Split" },
		hint: "Tab/Shift+Tab/←/→: tabs · ↑/↓: move · Enter/Space: change · Esc/q: close",
		editHint: "Type a number · Enter: confirm · Esc: cancel",
		empty: "(nothing to configure yet)",
		labels: { mode: "Mode", language: "Language", split: "Split", lines: "Pane lines", keep: "Keep pane" },
		yes: "Yes",
		no: "No",
		splits: { up: "Up", down: "Down", left: "Left", right: "Right" },
	},
	zh: {
		title: "Super Vim 设置",
		tabs: { general: "常规", pane: "pane", gvim: "gvim" },
		sections: { mode: "模式", ui: "界面", split: "分屏" },
		hint: "Tab/Shift+Tab/←/→：切页 · ↑/↓：移动 · Enter/Space：更改 · Esc/q：关闭",
		editHint: "输入数字 · Enter：确认 · Esc：取消",
		empty: "（暂无设置）",
		labels: { mode: "模式", language: "语言", split: "分屏", lines: "分屏行数", keep: "分屏常驻" },
		yes: "是",
		no: "否",
		splits: { up: "上", down: "下", left: "左", right: "右" },
	},
};

const SPLIT_ORDER: SettingsSplit[] = ["up", "down", "left", "right"];
const MODE_ORDER: SettingsMode[] = ["pane", "gvim"];

const LINES_MIN = 1;
const LINES_MAX = 500;

export interface SettingsRow {
	id: string;
	label: string;
	value: string;
}

export interface SettingsGroup {
	label: string;
	rows: SettingsRow[];
}

/** Groups of one tab, in display order; an empty label means "no header". */
export function groups(tab: SettingsTab, values: SettingsValues): SettingsGroup[] {
	const copy = COPY[values.lang];
	if (tab === "general") {
		return [
			{ label: copy.sections.mode, rows: [{ id: "mode", label: copy.labels.mode, value: values.mode }] },
			{ label: copy.sections.ui, rows: [{ id: "language", label: copy.labels.language, value: values.lang }] },
		];
	}
	if (tab === "pane") {
		return [
			{
				label: copy.sections.split,
				rows: [
					{ id: "split", label: copy.labels.split, value: copy.splits[values.split] },
					// Numbers are typed in place, not cycled: see parseLines().
					{ id: "lines", label: copy.labels.lines, value: String(values.lines) },
					{ id: "keep", label: copy.labels.keep, value: values.keep ? copy.yes : copy.no },
				],
			},
		];
	}
	return []; // the gvim tab has nothing to configure yet
}

/** Enter/Space on a row: the next value. "lines" is edited as text instead. */
export function change(values: SettingsValues, id: string): SettingsValues {
	switch (id) {
		case "mode":
			return { ...values, mode: next(MODE_ORDER, values.mode) };
		case "split":
			return { ...values, split: next(SPLIT_ORDER, values.split) };
		case "keep":
			return { ...values, keep: !values.keep };
		case "language":
			return { ...values, lang: values.lang === "en" ? "zh" : "en" };
		default:
			return values;
	}
}

function next<T>(list: T[], value: T): T {
	return list[(list.indexOf(value) + 1) % list.length]!;
}

/** What the user typed for the pane height; undefined when it is not usable. */
export function parseLines(text: string): number | undefined {
	if (!/^\d+$/.test(text)) return undefined;
	const value = Number.parseInt(text, 10);
	return value >= LINES_MIN && value <= LINES_MAX ? value : undefined;
}

/** Open the settings screen; onChange runs on every change (it persists them). */
export async function openSettings(
	ctx: ExtensionContext,
	values: SettingsValues,
	onChange: (values: SettingsValues) => void,
): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("settings need the interactive TUI");
	const { Box, Key, Text, matchesKey, truncateToWidth, visibleWidth } = await import("@earendil-works/pi-tui");

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let tab: SettingsTab = "general";
		let current: SettingsValues = { ...values };
		const indexByTab: Record<SettingsTab, number> = { general: 0, pane: 0, gvim: 0 };
		// Digits being typed for the pane height; null when not editing.
		let editing: string | null = null;

		const copy = () => COPY[current.lang];
		const settingRows = () => groups(tab, current).flatMap((group) => group.rows);
		const selectedRow = () => {
			const list = settingRows();
			return list[Math.min(indexByTab[tab], Math.max(0, list.length - 1))];
		};

		const apply = (id: string) => {
			if (id === "lines") {
				// Typing replaces the number; an empty field changes nothing.
				editing = "";
				return;
			}
			current = change(current, id);
			onChange(current);
		};

		const commitLines = () => {
			const lines = parseLines(editing ?? "");
			editing = null;
			if (lines === undefined) return;
			current = { ...current, lines };
			onChange(current);
		};

		const switchTab = (offset: number) => {
			editing = null;
			tab = TABS[(TABS.indexOf(tab) + offset + TABS.length) % TABS.length]!;
		};

		const move = (offset: number) => {
			const count = settingRows().length;
			if (count === 0) return;
			indexByTab[tab] = (indexByTab[tab] + offset + count) % count;
		};

		/** Groups and rows; width is the box's content width. */
		const bodyLines = (width: number): string[] => {
			const lines: string[] = [];
			let index = 0;
			const empty = copy().empty;
			for (const group of groups(tab, current)) {
				if (group.label) {
					const head = truncateToWidth(`  ──${group.label}`, width, "");
					lines.push(theme.fg("dim", `${head}${"─".repeat(Math.max(0, width - visibleWidth(head)))}`));
				}
				for (const row of group.rows) {
					const selected = index === indexByTab[tab];
					index++;
					const label = selected ? theme.fg("accent", row.label) : row.label;
					const raw = editing !== null && row.id === "lines" ? `[${editing || String(current.lines)}]` : row.value;
					const value = theme.fg("accent", raw);
					const pad = Math.max(1, width - 2 - visibleWidth(row.label) - visibleWidth(raw));
					lines.push(truncateToWidth(`${selected ? "→ " : "  "}${label}${" ".repeat(pad)}${value}`, width, ""));
				}
			}
			if (lines.length === 0) lines.push(theme.fg("dim", truncateToWidth(`  ${empty}`, width, "")));
			return lines;
		};

		return {
			capturesViewportInput: true,
			render(width: number): string[] {
				const text = copy();
				const tabBar = TABS.map((entry) =>
					entry === tab ? theme.fg("accent", `[${text.tabs[entry]}]`) : theme.fg("dim", ` ${text.tabs[entry]} `),
				).join(" ");

				const box = new Box(1, 1, (line: string) => theme.bg("customMessageBg", line));
				box.addChild(new Text(theme.bold(theme.fg("accent", text.title)), 1, 0));
				box.addChild(new Text(tabBar, 1, 0));
				box.addChild(new Text(theme.fg("dim", editing === null ? text.hint : text.editHint), 1, 0));
				// The box hands its children the width inside the padding, so the rows
				// must be laid out from that width, not from the box width.
				box.addChild({
					render: (childWidth: number) => bodyLines(childWidth),
					invalidate: () => {},
				});
				return box.render(width);
			},
			invalidate(): void {},
			handleInput(data: string): void {
				if (editing !== null) {
					if (matchesKey(data, Key.enter)) commitLines();
					else if (matchesKey(data, Key.escape)) editing = null;
					else if (matchesKey(data, Key.backspace)) editing = editing.slice(0, -1);
					else if (/^\d$/.test(data)) editing += data;
					else return;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) switchTab(1);
				else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) switchTab(-1);
				else if (matchesKey(data, Key.up)) move(-1);
				else if (matchesKey(data, Key.down)) move(1);
				else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === " ") {
					const row = selectedRow();
					if (row) apply(row.id);
				} else if (matchesKey(data, Key.escape) || data === "q") {
					done(undefined);
					return;
				} else return;
				tui.requestRender();
			},
		};
	}, { overlay: true });
}
