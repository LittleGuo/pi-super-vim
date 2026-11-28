/**
 * pi-super-vim
 *
 * pi keeps running in its terminal; typing happens in a real vim.
 *
 *   pi  --(gvim --remote-expr)-->  a vim tab named after the session
 *   vim --(request file)-------->  pi (delivered as a normal user message)
 *
 * When a run has settled, this extension asks an already running gvim (a vim
 * server) to focus the tab for the current session id, creating it if needed.
 * The tab is cleared when it holds nothing unsent, so it is ready for the next
 * prompt.  In vim, `:Pi` writes the buffer to `<ctrl>/<session>.req`; this
 * extension watches that file and hands the text to pi with
 * `pi.sendUserMessage()`, which is exactly what typing it in the pi prompt
 * would do - without fragile keystroke injection into the terminal.
 *
 * The vim side lives in `vim/pi-super-vim.vim` next to this file.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingsValues } from "./settings.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

const config = {
	/** Name of the vim server (gvim --servername). Shared by all pi sessions. */
	serverName: process.env.PI_SUPER_VIM_SERVER?.trim() || "PI_SUPER_VIM",
	/** Where request/draft/command files live. */
	ctrlDir: path.resolve(process.env.PI_SUPER_VIM_DIR?.trim() || path.join(os.tmpdir(), "pi-super-vim")),
	/** Explicit path to the vim half, overrides the one next to this file. */
	pluginOverride: process.env.PI_SUPER_VIM_PLUGIN?.trim() || undefined,
	/** Open the vim tab after every run. PI_SUPER_VIM_AUTO=0 disables it. */
	autoOpen: process.env.PI_SUPER_VIM_AUTO !== "0",
	/** Let gvim enter insert mode when the tab is opened. */
	startInsert: process.env.PI_SUPER_VIM_STARTINSERT !== "0",
	/** Close the session tab when pi exits (only if it holds no unsent text). */
	closeOnExit: process.env.PI_SUPER_VIM_CLOSE !== "0",
	/** Append diagnostics to <ctrl>/debug.log. */
	debug: process.env.PI_SUPER_VIM_DEBUG === "1",
	/** WT split pane by default; PI_SUPER_VIM_TARGET=gvim for a gvim window (also the default off Windows). */
	target: process.env.PI_SUPER_VIM_TARGET?.trim().toLowerCase() === "gvim" || process.platform !== "win32" ? "gvim" : "pane",
	/** Share of the pane the vim side gets (wt split-pane --size). */
	paneSize: process.env.PI_SUPER_VIM_PANE_SIZE?.trim() || "",
	/** Where vim goes relative to pi. h/v are the old names for down/right. */
	paneSplit: parseSplit(process.env.PI_SUPER_VIM_PANE_SPLIT) ?? "down",
	/** Pull focus into the pane when vim comes back. PI_SUPER_VIM_PANE_FOCUS=0 disables it. */
	paneFocus: process.env.PI_SUPER_VIM_PANE_FOCUS !== "0",
	/** Keep the pane after a send and start vim in it again. 0 = one pane per prompt. */
	paneKeep: process.env.PI_SUPER_VIM_PANE_KEEP !== "0",
	/** wt -w: "0" = most recently used window, a name keeps the pane in its own window. */
	paneWindow: process.env.PI_SUPER_VIM_PANE_WINDOW?.trim() || "0",
	/** Pane height in text lines when vim is above/below pi. */
	paneLines: Number.parseInt(process.env.PI_SUPER_VIM_PANE_LINES ?? "", 10) || 20,
	/** Pane width in text columns when vim is left/right of pi. */
	paneCols: Number.parseInt(process.env.PI_SUPER_VIM_PANE_COLS ?? "", 10) || 60,
};

type Target = "gvim" | "pane";

type PaneSplit = "up" | "down" | "left" | "right";

/** h/v are the names used before the settings screen had four directions. */
function parseSplit(value: string | undefined): PaneSplit | undefined {
	const split = value?.trim().toLowerCase();
	if (split === "h") return "down";
	if (split === "v") return "right";
	return split === "up" || split === "down" || split === "left" || split === "right" ? split : undefined;
}

/** A vertical (above/below) split sizes by lines, a horizontal one by columns. */
function splitVertical(split: PaneSplit): boolean {
	return split === "up" || split === "down";
}

type RequestMode = "auto" | "steer" | "followUp";

interface VimRequest {
	sid?: string;
	text?: string;
	mode?: RequestMode;
	ts?: number;
}

interface SessionState {
	id: string;
	reqFile: string;
	watcher?: fs.FSWatcher;
	poll?: NodeJS.Timeout;
	warned: boolean;
}

/** What pi.sendUserMessage() takes: the prompt plus the images :Img attached. */
type OutgoingContent = Array<
	{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
>;

let session: SessionState | undefined;
let latestCtx: ExtensionContext | undefined;
let piApi: ExtensionAPI | undefined;
let delivering = false;
let spawnServer: Promise<void> | null = null;
let spawnedGvim: ChildProcess | null = null;
let vimQueue: Promise<unknown> = Promise.resolve();

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function log(message: string): void {
	if (!config.debug) return;
	try {
		fs.mkdirSync(config.ctrlDir, { recursive: true });
		fs.appendFileSync(path.join(config.ctrlDir, "debug.log"), `${new Date().toISOString()} ${message}\n`);
	} catch {
		// logging must never break the flow
	}
}

function notify(message: string, type: "info" | "warning" | "error" = "info"): void {
	log(`${type}: ${message}`);
	const ctx = latestCtx;
	if (!ctx?.hasUI) return;
	try {
		ctx.ui.notify(message, type);
	} catch {
		// UI may already be gone
	}
}

/** Vim single quoted string. */
function vimStr(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function sessionFilePath(sid: string): string {
	return path.join(config.ctrlDir, `${sid}.md`);
}

/** Target picked with /pivim pane|gvim, remembered across restarts. */
function rememberedTarget(): Target | undefined {
	try {
		const value = fs.readFileSync(path.join(config.ctrlDir, "target"), "utf8").trim();
		return value === "pane" || value === "gvim" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** key=value file with the /pivim settings, so they survive a restart. */
function readPrefs(): Record<string, string> {
	const prefs: Record<string, string> = {};
	try {
		for (const line of fs.readFileSync(path.join(config.ctrlDir, "prefs"), "utf8").split(/\r?\n/)) {
			const at = line.indexOf("=");
			if (at > 0) prefs[line.slice(0, at).trim()] = line.slice(at + 1).trim();
		}
	} catch {
		// no prefs yet
	}
	return prefs;
}

function writePref(key: string, value: string): void {
	fs.mkdirSync(config.ctrlDir, { recursive: true });
	const prefs = readPrefs();
	prefs[key] = value;
	fs.writeFileSync(
		path.join(config.ctrlDir, "prefs"),
		`${Object.entries(prefs).map(([k, v]) => `${k}=${v}`).join("\n")}\n`,
		"utf8",
	);
}

/**
 * Values from the settings screen: apply them to the running config and remember
 * them. Leaving pane mode drops a waiting pane, same as /pivim gvim.
 */
function applySettings(ctx: ExtensionContext, values: SettingsValues): void {
	if (values.mode === "gvim" && config.target === "pane") {
		const sid = ctx.sessionManager.getSessionId();
		if (sid) fs.writeFileSync(path.join(config.ctrlDir, `${sid}.pane.quit`), "", "utf8");
	}
	config.target = values.mode;
	config.paneSplit = values.split;
	config.paneLines = values.lines;
	config.paneKeep = values.keep;
	writePref("target", values.mode);
	writePref("split", values.split);
	writePref("lines", String(values.lines));
	writePref("keep", values.keep ? "on" : "off");
}

/**
 * wt wants a fraction of the pane, we want text lines/columns.  pi's own
 * terminal size is the area being split, so plain division is the right answer.
 */
function paneSizeFraction(): string {
	const rows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 40;
	const cols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 120;
	const vertical = splitVertical(config.paneSplit);
	const fraction = vertical ? config.paneLines / rows : config.paneCols / cols;
	const size = Math.min(0.9, Math.max(0.1, fraction)).toFixed(3);
	const want = vertical ? `${config.paneLines} of ${rows} lines` : `${config.paneCols} of ${cols} cols`;
	log(`pane size=${size} (${want})`);
	return size;
}

/** Session name for the vim tab label; empty when the session has none. */
function sessionLabel(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionName?.()?.trim() ?? "";
}

function resolvePluginPath(cwd: string): string | undefined {
	const candidates = [
		config.pluginOverride,
		path.join(here, "vim", "pi-super-vim.vim"),
		path.join(cwd, "vim", "pi-super-vim.vim"),
		path.join(cwd, ".pi", "extensions", "vim", "pi-super-vim.vim"),
	].filter((value): value is string => Boolean(value));
	return candidates.find(isFile);
}

function serialize<T>(fn: () => Promise<T>): Promise<T> {
	const next = vimQueue.then(fn, fn);
	vimQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

// ---------------------------------------------------------------------------
// finding vim
// ---------------------------------------------------------------------------

function findOnPath(names: string[]): string | undefined {
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const suffixes = process.platform === "win32" ? ["", ".exe", ".EXE"] : [""];
	for (const name of names) {
		for (const dir of dirs) {
			for (const suffix of suffixes) {
				const candidate = path.join(dir, name + suffix);
				if (isFile(candidate)) return candidate;
			}
		}
	}
	return undefined;
}

function findInVimInstallDirs(binary: "gvim.exe" | "vim.exe"): string | undefined {
	const roots = [
		process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Vim"),
		process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Vim"),
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Vim"),
		process.env.ProgramData && path.join(process.env.ProgramData, "Vim"),
		"C:\\Vim",
	].filter((value): value is string => Boolean(value));

	const found: string[] = [];
	for (const root of roots) {
		const direct = path.join(root, binary);
		if (isFile(direct)) found.push(direct);
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const candidate = path.join(root, entry.name, binary);
			if (isFile(candidate)) found.push(candidate);
		}
	}
	// "vim92" vs "vim91": highest version wins
	found.sort();
	return found.at(-1);
}

let cachedGvim: string | null | undefined;
function gvimPath(): string | undefined {
	if (cachedGvim !== undefined) return cachedGvim ?? undefined;
	const explicit = process.env.PI_SUPER_VIM_GVIM?.trim();
	cachedGvim =
		(explicit && isFile(explicit) ? explicit : undefined) ??
		(process.platform === "win32" ? findInVimInstallDirs("gvim.exe") : undefined) ??
		findOnPath(["gvim", "gvim.exe"]) ??
		null;
	log(`gvim: ${cachedGvim ?? "not found"}`);
	return cachedGvim ?? undefined;
}

let cachedClient: string | null | undefined;
/** Console vim: it can talk to the server and we can read its stdout. */
function clientPath(): string | undefined {
	if (cachedClient !== undefined) return cachedClient ?? undefined;
	const explicit = process.env.PI_SUPER_VIM_CLIENT?.trim();
	if (explicit && isFile(explicit)) {
		cachedClient = explicit;
		return explicit;
	}
	const gvim = gvimPath();
	const sibling = gvim ? path.join(path.dirname(gvim), "vim.exe") : undefined;
	if (sibling && isFile(sibling)) {
		cachedClient = sibling;
		return sibling;
	}
	cachedClient = findOnPath(["vim", "vim.exe"]) ?? gvim ?? null;
	log(`vim client: ${cachedClient ?? "not found"}`);
	return cachedClient ?? undefined;
}

// ---------------------------------------------------------------------------
// talking to the vim server
// ---------------------------------------------------------------------------

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runVimBinary(binary: string, args: string[], timeout = 15_000): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(
			binary,
			args,
			{ timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? -1 : 0;
				resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
			},
		);
	});
}

let canListServers = true;

async function serverAlive(): Promise<boolean> {
	const client = clientPath();
	if (client && canListServers) {
		const result = await runVimBinary(client, ["--serverlist"], 8_000);
		if (result.code !== 0) {
			canListServers = false;
			log(`--serverlist unsupported: ${(result.stderr || result.stdout).trim()}`);
		} else {
			const names = result.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			log(`serverlist: [${names.join(", ")}]`);
			return names.some((name) => name.toLowerCase() === config.serverName.toLowerCase());
		}
	}
	return spawnedGvim !== null && spawnedGvim.exitCode === null;
}

async function remoteExpr(expression: string): Promise<RunResult> {
	const binary = clientPath() ?? gvimPath();
	if (!binary) throw new Error("vim executable not found");
	const result = await runVimBinary(binary, ["--servername", config.serverName, "--remote-expr", expression]);
	log(`remote-expr ${expression.slice(0, 120)} -> code=${result.code} out=${result.stdout.trim().slice(0, 200)}`);
	if (result.code !== 0 && canListServers) {
		throw new Error(`vim client failed: ${(result.stderr || result.stdout).trim()}`);
	}
	return result;
}

/** Tab number of the session's gvim tab; 0 when it has none (or the plugin is not loaded yet). */
async function vimTabNumber(sid: string): Promise<number> {
	const answer = await remoteExpr(`exists('*PiSuperVimTab') ? PiSuperVimTab(${vimStr(sid)}) : -1`);
	const tab = Number.parseInt(answer.stdout.trim(), 10);
	return Number.isFinite(tab) && tab > 0 ? tab : 0;
}

async function startServer(openFile: string | undefined): Promise<void> {
	const gvim = gvimPath();
	if (!gvim) {
		throw new Error("gvim not found. Install Vim for Windows (gvim.exe) or set PI_SUPER_VIM_GVIM to its path.");
	}
	const args = ["--servername", config.serverName];
	if (openFile) args.push(openFile);
	log(`starting ${gvim} ${args.join(" ")}`);
	const child = spawn(gvim, args, {
		detached: true,
		stdio: "ignore",
		windowsHide: false,
		// keep the vim config, so the user's colors and plugins apply
		env: process.env,
	});
	child.on("error", (error) => log(`gvim spawn error: ${String(error)}`));
	child.unref();
	spawnedGvim = child;

	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) {
		await sleep(150);
		if (await serverAlive()) {
			log("vim server is ready");
			return;
		}
		if (child.exitCode !== null) {
			throw new Error(`gvim exited right away (code ${child.exitCode}). Is gvim.exe runnable?`);
		}
	}
	throw new Error("timed out waiting for the vim server to start");
}

async function ensureServer(openFile: string): Promise<void> {
	if (await serverAlive()) return;
	if (!spawnServer) {
		spawnServer = startServer(openFile).finally(() => {
			spawnServer = null;
		});
	}
	await spawnServer;
}

/** Run vim commands in the server; throws with the vim error message. */
async function runVimScript(sid: string, lines: string[]): Promise<void> {
	const scriptFile = path.join(config.ctrlDir, `${sid}.cmd.vim`);
	const statusFile = path.join(config.ctrlDir, `${sid}.status`);
	const script = [
		"let g:pi_super_vim_error = ''",
		"try",
		...lines.map((line) => `  ${line}`),
		"catch",
		"  let g:pi_super_vim_error = v:exception",
		"endtry",
		`call writefile([g:pi_super_vim_error], ${vimStr(statusFile)})`,
	].join("\n");
	fs.writeFileSync(scriptFile, `${script}\n`, "utf8");
	fs.rmSync(statusFile, { force: true });

	// One round trip only: a second remote request could disturb insert mode.
	const result = await remoteExpr(`execute(readfile(${vimStr(scriptFile)}))`);
	if (fs.existsSync(statusFile)) {
		const message = fs.readFileSync(statusFile, "utf8").replace(/\r/g, "").trim();
		if (message) throw new Error(`vim: ${message}`);
		return;
	}
	const output = result.stdout.replace(/\r/g, "").trim();
	throw new Error(`vim: ${output || result.stderr.trim() || "no answer from vim (is the server still running?)"}`);
}

// ---------------------------------------------------------------------------
// pane mode: vim in a Windows Terminal split pane
// ---------------------------------------------------------------------------

/** Pid the vim half wrote into <sid>.pane; 0 when there is none. */
function panePid(pidFile: string): number {
	try {
		const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
		return Number.isFinite(pid) && pid > 0 ? pid : 0;
	} catch {
		return 0;
	}
}

/** True while that vim is still running; it removes the file on exit. */
function paneAlive(pidFile: string): boolean {
	const pid = panePid(pidFile);
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * The pane's launcher loop rewrites <sid>.pane.loop every second while it waits
 * for pi.  A missing or stale file means the pane is gone (closed, or `:q`).
 */
function paneWaiting(loopFile: string): boolean {
	try {
		return Date.now() - fs.statSync(loopFile).mtimeMs < 3_000;
	} catch {
		return false;
	}
}

/**
 * A pane that comes back does not take the focus: the new pane of a split does,
 * but an existing one needs wt's move-focus, which only works on the active
 * tab/window and gives up quietly otherwise.
 */
function focusPane(sid: string): void {
	if (!config.paneFocus) return;
	const wt = wtPath();
	if (!wt) return;
	const dir = paneDirs.get(sid) ?? config.paneSplit;
	log(`pane: move-focus ${dir}`);
	const child = spawn(wt, ["-w", config.paneWindow, "move-focus", dir], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.on("error", (error) => log(`move-focus failed: ${String(error)}`));
	child.unref();
}

/** Split direction each session's pane was created with (/pivim split may change). */
const paneDirs = new Map<string, PaneSplit>();

/** wt.exe: App Execution Aliases cannot be stat()ed, so probe with access(). */
function wtPath(): string | undefined {
	const explicit = process.env.PI_SUPER_VIM_WT?.trim();
	if (explicit) return explicit;
	const alias = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "wt.exe");
	if (alias) {
		try {
			fs.accessSync(alias, fs.constants.X_OK);
			return alias;
		} catch {
			// not the alias, fall through to PATH
		}
	}
	return findOnPath(["wt", "wt.exe"]);
}

async function openPane(ctx: ExtensionContext, clear: boolean): Promise<"opened" | "already"> {
	const sid = ctx.sessionManager.getSessionId();
	if (!sid) throw new Error("pi session is not ready yet");
	const plugin = resolvePluginPath(ctx.cwd);
	if (!plugin) throw new Error("vim/pi-super-vim.vim not found (set PI_SUPER_VIM_PLUGIN)");
	const vim = clientPath();
	if (!vim) throw new Error("vim.exe not found (set PI_SUPER_VIM_CLIENT)");
	const wt = wtPath();
	if (!wt) throw new Error("wt.exe not found: pane mode needs Windows Terminal (set PI_SUPER_VIM_WT)");
	fs.mkdirSync(config.ctrlDir, { recursive: true });

	// The launcher loop keeps the pane alive after a send and starts a fresh vim
	// on demand, so there are three states: vim up (you are writing), loop waiting
	// for pi, or no pane at all.
	const pidFile = path.join(config.ctrlDir, `${sid}.pane`);
	const loopFile = path.join(config.ctrlDir, `${sid}.pane.loop`);
	const openFile = path.join(config.ctrlDir, `${sid}.pane.open`);
	const sentFile = path.join(config.ctrlDir, `${sid}.pane.sent`);
	const quitFile = path.join(config.ctrlDir, `${sid}.pane.quit`);

	if (paneAlive(pidFile)) {
		log("pane: vim is up, leaving it alone");
		return "already";
	}
	if (config.paneKeep && paneWaiting(loopFile)) {
		log("pane: waiting, asked the loop for vim");
		fs.writeFileSync(openFile, String(Date.now()), "utf8");
		focusPane(sid);
		return "opened";
	}
	log("pane: no pane, splitting one");

	const file = sessionFilePath(sid);
	const scriptFile = path.join(config.ctrlDir, `${sid}.pane.vim`);
	const launcher = path.join(config.ctrlDir, `${sid}.pane.cmd`);
	const label = sessionLabel(ctx);
	fs.writeFileSync(
		scriptFile,
		[
			`execute 'source' fnameescape(${vimStr(plugin)})`,
			"let g:pi_super_vim_quit_after_send = 1",
			...(config.startInsert ? [] : ["let g:pi_super_vim_startinsert = 0"]),
			`call PiSuperVimOpen(${vimStr(file)}, ${vimStr(sid)}, ${clear ? 1 : 0}, ${vimStr(label)})`,
		].join("\n") + "\n",
		"utf8",
	);
	// The launcher is a loop so the pane outlives one vim: after `:Pi` it waits
	// for <sid>.pane.open, after `:q` it exits and WT closes the pane.  With
	// /pivim keep off it is the old one-shot line instead.  A .cmd file, because
	// wt's own parser eats arguments that start with "-".  Exit 0 matters: with
	// a non-zero code WT keeps the dead pane and asks for Enter.
	const q = (value: string) => `"${value}"`;
	const lines = config.paneKeep
		? [
			"@echo off",
			":loop",
			`if exist ${q(quitFile)} goto quit`,
			`del ${q(openFile)} >nul 2>&1`,
			`del ${q(sentFile)} >nul 2>&1`,
			`${q(vim)} -S ${q(scriptFile)} ${q(file)}`,
			`if exist ${q(sentFile)} goto wait`,
			"goto quit",
			":wait",
			"title pi pane - waiting for pi",
			"echo waiting for pi... (this pane stays; close it to hide)",
			":waitloop",
			`if exist ${q(quitFile)} goto quit`,
			`if exist ${q(openFile)} goto loop`,
			// The heartbeat is written only while waiting, so a fresh file means
			// "waiting for pi", not "vim is starting up".
			`echo waiting>${q(loopFile)}`,
			"ping -n 2 127.0.0.1 >nul",
			"goto waitloop",
			":quit",
			`del ${q(loopFile)} >nul 2>&1`,
			`del ${q(openFile)} >nul 2>&1`,
			`del ${q(sentFile)} >nul 2>&1`,
			"exit /b 0",
		]
		: ["@echo off", `${q(vim)} -S ${q(scriptFile)} ${q(file)}`, "exit /b 0"];
	fs.writeFileSync(launcher, lines.join("\r\n") + "\r\n", "utf8");

	// Clean leftovers so a fresh pane does not quit or open vim right away, and
	// seed the heartbeat so a second settle does not split another pane.
	for (const marker of [quitFile, openFile, sentFile, loopFile]) fs.rmSync(marker, { force: true });
	if (config.paneKeep) fs.writeFileSync(loopFile, "spawn", "utf8");
	paneDirs.set(sid, config.paneSplit);

	log(`wt split-pane ${launcher}`);
	const before = panePid(pidFile);
	// wt -H always puts the new pane below / -V to the right; up and left are
	// that split followed by a swap of the two panes.
	const child = spawn(
		wt,
		[
			"-w", config.paneWindow, "split-pane", splitVertical(config.paneSplit) ? "-H" : "-V",
			"--size", paneSizeFraction(),
			"-d", ctx.cwd,
			"--title", `pi:${label || sid.slice(0, 8)}`,
			"--", "cmd", "/c", launcher,
		],
		{ detached: true, stdio: "ignore", windowsHide: true, env: process.env },
	);
	child.on("error", (error) => log(`wt spawn error: ${String(error)}`));
	child.unref();

	// wt exits 0 even when a wedged Windows Terminal ignores the command, so wait
	// for the vim half instead of reporting success blindly.
	for (let i = 0; i < 50; i++) {
		await sleep(100);
		if (panePid(pidFile) === before || !paneAlive(pidFile)) continue;
		// The split is real now, so the new pane is the active one: swapping it
		// with the pane above/left of pi is what makes "up" and "left" work.
		if (config.paneSplit === "up" || config.paneSplit === "left") {
			const swap = spawn(wt, ["-w", config.paneWindow, "swap-pane", config.paneSplit], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			swap.on("error", (error) => log(`swap-pane failed: ${String(error)}`));
			swap.unref();
		}
		return "opened";
	}
	// Drop the seeded heartbeat, or the next attempt believes a pane is waiting.
	fs.rmSync(loopFile, { force: true });
	throw new Error("Windows Terminal did not open a pane (it ignored the wt command) - restart Windows Terminal");
}

// ---------------------------------------------------------------------------
// opening and closing the tab
// ---------------------------------------------------------------------------

/**
 * Open the session's vim.  leaveExisting is for /pivim: a tab that is already
 * there must not be cleared or switched to; the settled run always refreshes it.
 */
async function openTab(ctx: ExtensionContext, clear: boolean, leaveExisting = false): Promise<"opened" | "already"> {
	if (config.target === "pane") {
		return openPane(ctx, clear);
	}
	const sid = ctx.sessionManager.getSessionId();
	if (!sid) throw new Error("pi session is not ready yet");
	const plugin = resolvePluginPath(ctx.cwd);
	if (!plugin) throw new Error("vim/pi-super-vim.vim not found (set PI_SUPER_VIM_PLUGIN)");
	fs.mkdirSync(config.ctrlDir, { recursive: true });
	// A live server that already has this session's tab: nothing to do.
	if (leaveExisting && (await serverAlive()) && (await vimTabNumber(sid)) > 0) return "already";
	await serialize(async () => {
		await ensureServer(sessionFilePath(sid));
		await runVimScript(sid, [
			`execute 'source' fnameescape(${vimStr(plugin)})`,
			...(config.startInsert ? [] : ["let g:pi_super_vim_startinsert = 0"]),
			`call PiSuperVimOpen(${vimStr(sessionFilePath(sid))}, ${vimStr(sid)}, ${clear ? 1 : 0}, ${vimStr(sessionLabel(ctx))})`,
		]);
	});
	return "opened";
}

async function closeTab(ctx: ExtensionContext): Promise<void> {
	const sid = ctx.sessionManager.getSessionId();
	if (config.target === "pane") {
		// The launcher loop exits on this; a vim still open keeps the pane until
		// it is closed (its unsent text must survive, so no kill).
		if (sid) fs.writeFileSync(path.join(config.ctrlDir, `${sid}.pane.quit`), "", "utf8");
		return;
	}
	const plugin = resolvePluginPath(ctx.cwd);
	if (!sid || !plugin) return;
	if (!(await serverAlive())) return;
	await serialize(async () => {
		await runVimScript(sid, [
			`execute 'source' fnameescape(${vimStr(plugin)})`,
			`call PiSuperVimClose(${vimStr(sid)})`,
		]);
	});
}

// ---------------------------------------------------------------------------
// receiving prompts from vim, with the images :Img attached
// ---------------------------------------------------------------------------

/** Written into the buffer by :Img; the file is <ctrl>/<sid>.img<N>.<ext>. */
const IMAGE_PLACEHOLDER = /\[#img(\d+)\]/g;

/** What pi-clip.ps1 can produce, keyed by the extension it writes. */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/**
 * Images the text refers to, in the order the text mentions them.  A placeholder
 * whose file is gone (deleted placeholder, restored draft, aborted run) is
 * reported as missing instead of being sent as an empty image.
 */
function imagesForText(text: string, sid: string) {
	const images: OutgoingContent = [];
	const files: string[] = [];
	const missing: number[] = [];

	let names: string[] = [];
	try {
		names = fs.readdirSync(config.ctrlDir);
	} catch {
		// No control dir yet: every placeholder below is reported as missing,
		// so nothing is swallowed silently.
	}

	const ids = [...new Set([...text.matchAll(IMAGE_PLACEHOLDER)].map((match) => Number(match[1])))];
	for (const id of ids) {
		const prefix = `${sid}.img${id}.`;
		const name = names.find((candidate) => {
			if (!candidate.startsWith(prefix)) return false;
			return IMAGE_MIME_BY_EXTENSION[candidate.slice(prefix.length).toLowerCase()] !== undefined;
		});
		if (!name) {
			missing.push(id);
			continue;
		}
		const file = path.join(config.ctrlDir, name);
		const mimeType = IMAGE_MIME_BY_EXTENSION[path.extname(name).slice(1).toLowerCase()];
		if (!mimeType) {
			missing.push(id);
			continue;
		}
		try {
			const bytes = fs.readFileSync(file);
			images.push({ type: "image", data: bytes.toString("base64"), mimeType });
			files.push(file);
		} catch {
			missing.push(id);
		}
	}

	return { images, files, missing };
}

async function deliver(request: VimRequest): Promise<void> {
	const ctx = latestCtx;
	const pi = piApi;
	if (!ctx || !pi) return;

	const text = typeof request.text === "string" ? request.text.replace(/\r\n/g, "\n").trimEnd() : "";
	if (!text.trim()) {
		notify("vim: empty prompt, nothing sent", "warning");
		return;
	}

	const mode: RequestMode = request.mode === "steer" || request.mode === "followUp" ? request.mode : "auto";
	const busy = !ctx.isIdle();
	const deliverAs = mode === "auto" ? (busy ? "followUp" : undefined) : mode;

	const { images, files, missing } = imagesForText(text, ctx.sessionManager.getSessionId() ?? "");
	for (const id of missing) {
		notify(`vim: [#img${id}] has no image file, sent as text only`, "warning");
	}
	const content: string | OutgoingContent = images.length > 0 ? [{ type: "text", text }, ...images] : text;

	try {
		await pi.sendUserMessage(content, deliverAs ? { deliverAs } : undefined);
	} catch (error) {
		// A run may have started between the idle check and the send.
		try {
			await pi.sendUserMessage(content, { deliverAs: "followUp" });
		} catch (retryError) {
			notify(`vim -> pi failed: ${String(retryError ?? error)}`, "error");
			return;
		}
	}
	// Only after a successful send: a failed delivery can be retried with :Pi.
	for (const file of files) {
		try {
			fs.rmSync(file, { force: true });
		} catch (error) {
			log(`cannot delete ${file}: ${String(error)}`);
		}
	}
	const preview = text.replace(/\s+/g, " ").slice(0, 70);
	const attached = images.length > 0 ? ` (+${images.length} image)` : "";
	notify(`vim -> pi (${deliverAs ?? "now"}): ${preview}${attached}`, "info");
}

async function drainRequests(): Promise<void> {
	const current = session;
	if (!current || delivering) return;
	delivering = true;
	try {
		// A burst of sends is handled in order until the file is gone.
		for (;;) {
			if (session !== current) return;
			let raw: string;
			try {
				raw = fs.readFileSync(current.reqFile, "utf8");
			} catch {
				return;
			}
			// Remove it first: a crash must not deliver the same prompt twice.
			try {
				fs.unlinkSync(current.reqFile);
			} catch {
				// someone else already took it
			}
			let request: VimRequest;
			try {
				request = JSON.parse(raw) as VimRequest;
			} catch (error) {
				notify(`vim: bad request file (${String(error)})`, "error");
				continue;
			}
			await deliver(request);
		}
	} finally {
		delivering = false;
	}
}

function scheduleDrain(): void {
	void drainRequests().catch((error) => log(`drain failed: ${String(error)}`));
}

function startWatching(id: string): void {
	const reqFile = path.join(config.ctrlDir, `${id}.req`);
	const state: SessionState = { id, reqFile, warned: false };
	session = state;
	// Drop a request left over from an earlier run of the same session id.
	fs.rmSync(reqFile, { force: true });
	fs.rmSync(`${reqFile}.tmp`, { force: true });

	try {
		state.watcher = fs.watch(config.ctrlDir, (_event, filename) => {
			if (!filename) {
				scheduleDrain();
				return;
			}
			if (String(filename).startsWith(`${id}.req`)) scheduleDrain();
		});
		state.watcher.on("error", (error) => log(`watch error: ${String(error)}`));
	} catch (error) {
		log(`fs.watch failed: ${String(error)}`);
	}
	// fs.watch can miss events on network drives / after sleep; a cheap poll
	// makes the round trip dependable.
	state.poll = setInterval(scheduleDrain, 1_000);
	state.poll.unref?.();
}

function stopWatching(): void {
	if (!session) return;
	session.watcher?.close();
	if (session.poll) clearInterval(session.poll);
	session = undefined;
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

const loadedKey = Symbol.for("pi-super-vim.loaded");

export default function piSuperVim(pi: ExtensionAPI) {
	const globals = globalThis as { [loadedKey]?: boolean };
	// Installed as a package *and* loaded through the repo's .pi/extensions
	// forwarder, pi runs this twice: two gvim servers under one name, two tabs
	// per session, and concurrent remote-expr requests (vim: E956).
	if (globals[loadedKey]) {
		log("already loaded in this process, skipping");
		return;
	}
	globals[loadedKey] = true;

	config.target = rememberedTarget() ?? config.target;
	{
		const prefs = readPrefs();
		if (prefs.target === "pane" || prefs.target === "gvim") config.target = prefs.target;
		const split = parseSplit(prefs.split);
		if (split) config.paneSplit = split;
		if (prefs.keep === "on") config.paneKeep = true;
		if (prefs.keep === "off") config.paneKeep = false;
		const lines = Number.parseInt(prefs.lines ?? "", 10);
		if (lines > 0) config.paneLines = lines;
		const cols = Number.parseInt(prefs.cols ?? "", 10);
		if (cols > 0) config.paneCols = cols;
	}
	piApi = pi;

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		const id = ctx.sessionManager.getSessionId();
		if (!id) return;
		stopWatching();
		fs.mkdirSync(config.ctrlDir, { recursive: true });
		startWatching(id);
		log(`session ${id}, ctrl dir ${config.ctrlDir}`);
	});

	pi.on("session_info_changed", async (event, ctx) => {
		latestCtx = ctx;
		const sid = ctx.sessionManager.getSessionId();
		const plugin = resolvePluginPath(ctx.cwd);
		if (!sid || !plugin || !(await serverAlive())) return;
		const label = event.name?.trim() ?? "";
		// Renaming must not steal focus, so this only relabels the tab.
		await serialize(() =>
			runVimScript(sid, [
				`execute 'source' fnameescape(${vimStr(plugin)})`,
				`call PiSuperVimRelabel(${vimStr(sid)}, ${vimStr(label)})`,
			]),
		).catch((error) => log(`relabel failed: ${String(error)}`));
	});

	pi.on("agent_settled", async (_event, ctx) => {
		latestCtx = ctx;
		if (!config.autoOpen || ctx.mode !== "tui") return;
		openTab(ctx, true).catch((error) => {
			if (session?.warned) return;
			if (session) session.warned = true;
			notify(`pi-super-vim: ${String(error instanceof Error ? error.message : error)}`, "error");
		});
	});

	pi.on("session_shutdown", async (event, ctx) => {
		stopWatching();
		// release the claim so the reloaded runtime can load this again
		globals[loadedKey] = false;
		// A reload brings the same session back: keep its tab.
		if (!config.closeOnExit || event.reason === "reload") return;
		try {
			await Promise.race([closeTab(ctx), sleep(2_000)]);
		} catch (error) {
			log(`close tab failed: ${String(error)}`);
		}
	});

	pi.registerCommand("pivim", {
		description: "Open the vim prompt now (pivim [show|open] | setting | pane | gvim | split up|down|left|right | lines N | cols N | keep on|off | install | close | status)",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const words = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
			const action = words[0] ?? "";
			const value = words[1] ?? "";
			try {
				if (action === "pane" || action === "gvim") {
					applySettings(ctx, { mode: action, split: config.paneSplit, lines: config.paneLines, keep: config.paneKeep });
					notify(`pivim: target ${action}, remembered for the next pi start`, "info");
					return;
				}
				if (action === "split") {
					const split = parseSplit(value);
					if (!split) throw new Error("give a direction: /pivim split up|down|left|right");
					config.paneSplit = split;
					writePref("split", split);
					notify(`pivim: split ${split} (next pane)`, "info");
					return;
				}
				if (action === "keep") {
					const on = value !== "off" && value !== "0";
					config.paneKeep = on;
					writePref("keep", on ? "on" : "off");
					// The running launcher keeps its mode; a waiting pane can be let go now.
					if (!on) {
						const sid = ctx.sessionManager.getSessionId();
						if (sid) fs.writeFileSync(path.join(config.ctrlDir, `${sid}.pane.quit`), "", "utf8");
					}
					notify(`pivim: keep ${on ? "on (pane stays after :Pi)" : "off (pane closes after :Pi)"}`, "info");
					return;
				}
				if (action === "lines" || action === "cols") {
					const size = Number.parseInt(value, 10);
					if (!(size > 0)) throw new Error(`give a number: /pivim ${action} 20`);
					if (action === "lines") config.paneLines = size;
					else config.paneCols = size;
					writePref(action, String(size));
					notify(`pivim: ${action} ${size} (next pane)`, "info");
					return;
				}
				if (action === "setting" || action === "settings") {
					const { openSettings } = await import("./settings.ts");
					await openSettings(
						ctx,
						{ mode: config.target, split: config.paneSplit, lines: config.paneLines, keep: config.paneKeep },
						(values) => applySettings(ctx, values),
					);
					return;
				}
				if (action === "install") {
					const plugin = resolvePluginPath(ctx.cwd);
					if (!plugin) throw new Error("vim/pi-super-vim.vim not found");
					const target = path.join(os.homedir(), ".vim", "plugin");
					fs.mkdirSync(target, { recursive: true });
					fs.copyFileSync(plugin, path.join(target, path.basename(plugin)));
					// :Img runs pi-clip.ps1 from next to the plugin file.
					const helper = path.join(path.dirname(plugin), "pi-clip.ps1");
					if (isFile(helper)) fs.copyFileSync(helper, path.join(target, "pi-clip.ps1"));
					notify(`installed ${path.join(target, path.basename(plugin))}`, "info");
					return;
				}
				if (action === "close") {
					await closeTab(ctx);
					notify("pivim: closed", "info");
					return;
				}
				if (action === "status") {
					const alive = await serverAlive();
					const plugin = resolvePluginPath(ctx.cwd);
					notify(
						[
							`target: ${config.target}`,
							`pane: split ${config.paneSplit}, ${splitVertical(config.paneSplit) ? `${config.paneLines} lines` : `${config.paneCols} cols`} (size ${paneSizeFraction()}), keep ${config.paneKeep ? "on" : "off"}, focus ${config.paneFocus ? "on" : "off"}, window ${config.paneWindow}`,
							`vim server: ${config.serverName} (${alive ? "running" : "not running"})`,
							`gvim: ${gvimPath() ?? "not found"}`,
							`client: ${clientPath() ?? "not found"}`,
							`plugin: ${plugin ?? "not found"}`,
							`ctrl dir: ${config.ctrlDir}`,
							`session: ${ctx.sessionManager.getSessionId() ?? "-"}`,
						].join("\n"),
						"info",
					);
					return;
				}
				// Bare /pivim, /pivim show and /pivim open: pi runs extension commands
				// even while a run is streaming, and in pane mode this also brings vim
				// back into a pane that is already waiting.
				const opened = await openTab(ctx, true, true);
				const where = config.target === "pane" ? "in the pane" : "as a tab";
				notify(opened === "already" ? `pivim: vim is already open ${where}` : "pivim: vim is ready", "info");
			} catch (error) {
				notify(`pivim: ${String(error instanceof Error ? error.message : error)}`, "error");
			}
		},
	});
}
