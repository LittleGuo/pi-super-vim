/**
 * /pivim setting -- the settings screen.
 *
 * The model (rows / values / cycling) is plain data so the tests can check it
 * without a terminal; the TUI half is loaded lazily so nothing pulls
 * @earendil-works/pi-tui into a plain node process.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SettingsMode = "pane" | "gvim";
export type SettingsSplit = "up" | "down" | "left" | "right";

export interface SettingsValues {
	mode: SettingsMode;
	split: SettingsSplit;
	lines: number;
	keep: boolean;
}

export type SettingsTab = "general" | "pane" | "gvim";

export const TABS: SettingsTab[] = ["general", "pane", "gvim"];

export const TAB_LABELS: Record<SettingsTab, string> = { general: "常规", pane: "pane", gvim: "gvim" };

/** Grouping header shown above the rows of each tab (gvim has none yet). */
export const SECTION_LABEL: Record<SettingsTab, string> = { general: "模式", pane: "分屏", gvim: "" };

const SPLIT_ORDER: SettingsSplit[] = ["up", "down", "left", "right"];
const SPLIT_LABELS: Record<SettingsSplit, string> = { up: "上", down: "下", left: "左", right: "右" };
const MODE_ORDER: SettingsMode[] = ["pane", "gvim"];

const LINES_MIN = 1;
const LINES_MAX = 500;

export interface SettingsRow {
	id: string;
	label: string;
	value: string;
}

/** Rows of one tab, in display order. */
export function rows(tab: SettingsTab, values: SettingsValues): SettingsRow[] {
	if (tab === "general") {
		return [{ id: "mode", label: "模式", value: values.mode }];
	}
	if (tab === "pane") {
		return [
			{ id: "split", label: "分屏", value: SPLIT_LABELS[values.split] },
			// Numbers are typed in place, not cycled: see parseLines().
			{ id: "lines", label: "分屏行数", value: String(values.lines) },
			{ id: "keep", label: "分屏常驻", value: values.keep ? "是" : "否" },
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
		default:
			return values;
	}
}

function next<T>(list: T[], value: T): T {
	return list[(list.indexOf(value) + 1) % list.length]!;
}

/** What the user typed for 分屏行数; undefined when it is not a usable number. */
export function parseLines(text: string): number | undefined {
	if (!/^\d+$/.test(text)) return undefined;
	const value = Number.parseInt(text, 10);
	return value >= LINES_MIN && value <= LINES_MAX ? value : undefined;
}

const HINT = "Tab/Shift+Tab/←/→：切页 · ↑/↓：移动 · Enter/Space：更改 · Esc/q：关闭";
const EDIT_HINT = "输入数字 · Enter：确认 · Esc：取消";

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
		// Digits being typed for 分屏行数; null when not editing.
		let editing: string | null = null;

		const currentRows = () => rows(tab, current);
		const selectedRow = () => {
			const list = currentRows();
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
			const count = currentRows().length;
			if (count === 0) return;
			indexByTab[tab] = (indexByTab[tab] + offset + count) % count;
		};

		/** Rows under the header; width is the box's content width. */
		const bodyLines = (width: number): string[] => {
			const list = currentRows();
			const section = SECTION_LABEL[tab];
			const lines: string[] = [];
			if (section) {
				const head = truncateToWidth(`  ──${section}`, width, "");
				lines.push(theme.fg("dim", `${head}${"─".repeat(Math.max(0, width - visibleWidth(head)))}`));
			}
			if (list.length === 0) {
				lines.push(theme.fg("dim", truncateToWidth("  （暂无设置）", width, "")));
				return lines;
			}
			for (const [index, row] of list.entries()) {
				const selected = index === indexByTab[tab];
				const label = selected ? theme.fg("accent", row.label) : row.label;
				const raw = editing !== null && row.id === "lines" ? `[${editing || String(current.lines)}]` : row.value;
				const value = theme.fg("accent", raw);
				const pad = Math.max(1, width - 2 - visibleWidth(row.label) - visibleWidth(raw));
				lines.push(truncateToWidth(`${selected ? "→ " : "  "}${label}${" ".repeat(pad)}${value}`, width, ""));
			}
			return lines;
		};

		return {
			capturesViewportInput: true,
			render(width: number): string[] {
				const tabBar = TABS.map((entry) =>
					entry === tab ? theme.fg("accent", `[${TAB_LABELS[entry]}]`) : theme.fg("dim", ` ${TAB_LABELS[entry]} `),
				).join(" ");

				const box = new Box(1, 1, (line: string) => theme.bg("customMessageBg", line));
				box.addChild(new Text(theme.bold(theme.fg("accent", "Super Vim 设置")), 1, 0));
				box.addChild(new Text(tabBar, 1, 0));
				box.addChild(new Text(theme.fg("dim", editing === null ? HINT : EDIT_HINT), 1, 0));
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
