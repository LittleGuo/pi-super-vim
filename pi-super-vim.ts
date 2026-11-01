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
};

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
// opening and closing the tab
// ---------------------------------------------------------------------------

async function openTab(ctx: ExtensionContext, clear: boolean): Promise<void> {
	const sid = ctx.sessionManager.getSessionId();
	if (!sid) throw new Error("pi session is not ready yet");
	const plugin = resolvePluginPath(ctx.cwd);
	if (!plugin) throw new Error("vim/pi-super-vim.vim not found (set PI_SUPER_VIM_PLUGIN)");
	fs.mkdirSync(config.ctrlDir, { recursive: true });
	await serialize(async () => {
		await ensureServer(sessionFilePath(sid));
		await runVimScript(sid, [
			`execute 'source' fnameescape(${vimStr(plugin)})`,
			...(config.startInsert ? [] : ["let g:pi_super_vim_startinsert = 0"]),
			`call PiSuperVimOpen(${vimStr(sessionFilePath(sid))}, ${vimStr(sid)}, ${clear ? 1 : 0})`,
		]);
	});
}

async function closeTab(ctx: ExtensionContext): Promise<void> {
	const sid = ctx.sessionManager.getSessionId();
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
// receiving prompts from vim
// ---------------------------------------------------------------------------

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

	try {
		await pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
	} catch (error) {
		// A run may have started between the idle check and the send.
		try {
			await pi.sendUserMessage(text, { deliverAs: "followUp" });
		} catch (retryError) {
			notify(`vim -> pi failed: ${String(retryError ?? error)}`, "error");
			return;
		}
	}
	const preview = text.replace(/\s+/g, " ").slice(0, 70);
	notify(`vim -> pi (${deliverAs ?? "now"}): ${preview}`, "info");
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

export default function piSuperVim(pi: ExtensionAPI) {
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
		// A reload brings the same session back: keep its tab.
		if (!config.closeOnExit || event.reason === "reload") return;
		try {
			await Promise.race([closeTab(ctx), sleep(2_000)]);
		} catch (error) {
			log(`close tab failed: ${String(error)}`);
		}
	});

	pi.registerCommand("pivim", {
		description: "Open the vim prompt tab (pivim install | close | status)",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const action = (args ?? "").trim().toLowerCase();
			try {
				if (action === "install") {
					const plugin = resolvePluginPath(ctx.cwd);
					if (!plugin) throw new Error("vim/pi-super-vim.vim not found");
					const target = path.join(os.homedir(), ".vim", "plugin", "pi-super-vim.vim");
					fs.mkdirSync(path.dirname(target), { recursive: true });
					fs.copyFileSync(plugin, target);
					notify(`installed ${target}`, "info");
					return;
				}
				if (action === "close") {
					await closeTab(ctx);
					notify("pivim: tab closed", "info");
					return;
				}
				if (action === "status") {
					const alive = await serverAlive();
					const plugin = resolvePluginPath(ctx.cwd);
					notify(
						[
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
				await openTab(ctx, true);
				notify("pivim: vim tab is ready", "info");
			} catch (error) {
				notify(`pivim: ${String(error instanceof Error ? error.message : error)}`, "error");
			}
		},
	});
}
