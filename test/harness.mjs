/**
 * Local smoke test for pi-super-vim that does not need a model or a pi session.
 *
 * It loads the extension, fakes the pi API and the extension context, opens the
 * vim tab, types into it through the real vim plugin, hits :Pi and checks that
 * the extension hands the text to pi.
 *
 *   node test/harness.mjs
 *
 * Nothing is sent to a model; every pi call is recorded.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const ctrlDir = path.join(os.tmpdir(), "pi-super-vim-test");
const serverName = "PI_SUPER_VIM_TEST";
const sid = "test-0123456789abcdef";

process.env.PI_SUPER_VIM_SERVER = serverName;
process.env.PI_SUPER_VIM_DIR = ctrlDir;
process.env.PI_SUPER_VIM_CLOSE = "1";
process.env.PI_SUPER_VIM_DEBUG = "1";

fs.rmSync(ctrlDir, { recursive: true, force: true });
fs.mkdirSync(ctrlDir, { recursive: true });

const { default: extension } = await import(new URL("../pi-super-vim.ts", import.meta.url).href);

// --- fake pi ---------------------------------------------------------------
const handlers = new Map();
const commands = new Map();
const sent = [];
const logs = [];

const fakePi = {
	on(event, handler) {
		handlers.set(event, handler);
		return () => handlers.delete(event);
	},
	registerCommand(name, options) {
		commands.set(name, options);
	},
	async sendUserMessage(content, options) {
		sent.push({ content, options });
	},
};

// --- fake context ----------------------------------------------------------
let idle = true;
const ctx = {
	mode: "tui",
	hasUI: true,
	cwd: root,
	sessionManager: { getSessionId: () => sid },
	isIdle: () => idle,
	ui: {
		notify(message, type) {
			logs.push(`[${type ?? "info"}] ${message}`);
			console.log(`notify ${type ?? "info"}: ${message}`);
		},
	},
};

extension(fakePi);

const start = handlers.get("session_start");
const settled = handlers.get("agent_settled");
const shutdown = handlers.get("session_shutdown");
if (!start || !settled || !shutdown) throw new Error("extension did not register its handlers");

await start({ type: "session_start", reason: "startup" }, ctx);

// --- helper: talk to the test vim server -----------------------------------
const clientCandidates = [
	process.env.PI_SUPER_VIM_CLIENT,
	path.join("C:/Program Files/Vim/vim92/vim.exe"),
	"/usr/bin/vim",
].filter(Boolean);

function vim(args) {
	const errors = [];
	for (const candidate of clientCandidates) {
		if (!fs.existsSync(candidate)) continue;
		const result = spawnSync(candidate, args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
		if (result.error) {
			errors.push(String(result.error));
			continue;
		}
		if (result.status === 0) return (result.stdout ?? "").trim();
		errors.push(result.stdout || result.stderr || `exit ${result.status}`);
	}
	throw new Error(`vim client failed: ${errors.join(" | ")}`);
}

function vimExpr(expr) {
	return vim(["--servername", serverName, "--remote-expr", expr]);
}

function vimScript(lines) {
	const file = path.join(ctrlDir, "test.cmd.vim");
	fs.writeFileSync(file, lines.join("\n") + "\n");
	return vim(["--servername", serverName, "--remote-expr", `execute(readfile('${file.replace(/'/g, "''")}'))`]);
}

function serverRunning() {
	for (const candidate of clientCandidates) {
		if (!fs.existsSync(candidate)) continue;
		const result = spawnSync(candidate, ["--serverlist"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
		if (result.status !== 0) continue;
		return (result.stdout ?? "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.some((name) => name.toLowerCase() === serverName.toLowerCase());
	}
	return false;
}

function check(name, ok, extra = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` -- ${extra}` : ""}`);
	if (!ok) process.exitCode = 1;
}

// --- open the tab (what agent_settled does) --------------------------------
await settled({ type: "agent_settled", aborted: false }, ctx);
await new Promise((resolve) => setTimeout(resolve, 1500));

check("vim server is running", vimExpr("v:servername") === serverName, vimExpr("v:servername"));
check("one tab exists", vimExpr("tabpagenr('$')") === "1", `tabs=${vimExpr("tabpagenr('$')")}`);
check("buffer is the session file", /test-0123456789abcdef\.md$/.test(vimExpr("expand('%:p')")), vimExpr("expand('%:p')"));
check("buffer is an acwrite scratch buffer", vimExpr("&buftype") === "acwrite", vimExpr("&buftype"));
check("session var is set", vimExpr("b:pi_session") === sid, vimExpr("b:pi_session"));
check("pi commands exist", vimExpr("exists(':Pi')") === "2", vimExpr("exists(':Pi')"));
check("vim is in insert mode", vimExpr("mode()") === "i", vimExpr("mode()"));

// --- type a prompt and submit with :Pi ------------------------------------
vimScript([
	`source ${path.join(root, "vim", "pi-super-vim.vim").replace(/\\/g, "/")}`,
	`call setline(1, ['first line', 'second line with ''quotes'' and a "double"', '', 'last'])`,
	"Pi",
]);
await new Promise((resolve) => setTimeout(resolve, 800));

check("pi received one message", sent.length === 1, `count=${sent.length}`);
const received = sent[0]?.content ?? "";
check("message text matches the buffer", received === 'first line\nsecond line with \'quotes\' and a "double"\n\nlast', JSON.stringify(received));
check("no deliverAs while idle", sent[0]?.options === undefined, JSON.stringify(sent[0]?.options));

// --- pi answers, the tab is cleared ---------------------------------------
await settled({ type: "agent_settled", aborted: false }, ctx);
await new Promise((resolve) => setTimeout(resolve, 800));
check("tab cleared after a settled run", vimExpr("string(getline(1, '$'))") === "['']", vimExpr("string(getline(1, '$'))"));

// --- unsent text survives the next run ------------------------------------
vimScript([`call setline(1, ['draft that was not sent'])`]);
await settled({ type: "agent_settled", aborted: false }, ctx);
await new Promise((resolve) => setTimeout(resolve, 800));
check("unsent draft is kept", vimExpr("getline(1)") === "draft that was not sent", vimExpr("getline(1)"));

// --- :w also submits ------------------------------------------------------
vimScript(["write"]);
await new Promise((resolve) => setTimeout(resolve, 800));
check(":w submits the buffer", sent.length === 2 && sent.at(-1).content === "draft that was not sent", JSON.stringify(sent.at(-1)?.content));

// --- second session gets its own tab --------------------------------------
const otherSid = "test-fedcba9876543210";
const otherCtx = { ...ctx, sessionManager: { getSessionId: () => otherSid } };
await start({ type: "session_start", reason: "new" }, otherCtx);
await settled({ type: "agent_settled", aborted: false }, otherCtx);
await new Promise((resolve) => setTimeout(resolve, 1500));
check("second session has its own tab", vimExpr("tabpagenr('$')") === "2", `tabs=${vimExpr("tabpagenr('$')")}`);
check("both tabs are labelled", vimExpr("string([gettabvar(1, 'pi_tablabel', ''), gettabvar(2, 'pi_tablabel', '')])") === "['pi:test-012', 'pi:test-fed']", vimExpr("string([gettabvar(1, 'pi_tablabel', ''), gettabvar(2, 'pi_tablabel', '')])"));

// --- busy pi queues the prompt --------------------------------------------
idle = false;
vimScript([`call setline(1, ['queued because pi is busy'])`, "Pi"]);
await new Promise((resolve) => setTimeout(resolve, 800));
check(
	"busy pi receives a followUp",
	sent.at(-1)?.options?.deliverAs === "followUp" && sent.at(-1)?.content === "queued because pi is busy",
	JSON.stringify(sent.at(-1)),
);
idle = true;

// --- shutdown closes the tabs ---------------------------------------------
await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
await new Promise((resolve) => setTimeout(resolve, 1200));
const tabsLeft = (() => {
	try {
		return vimExpr("tabpagenr('$')");
	} catch {
		return "server gone";
	}
})();
check("session tab closed on shutdown", tabsLeft === "1" || tabsLeft === "server gone", `tabs=${tabsLeft} labels=${(() => { try { return vimExpr("string(map(range(1, tabpagenr('$')), {_, i -> gettabvar(i, 'pi_tablabel', '')}))"); } catch { return "-"; } })()}`);
for (const file of fs.readdirSync(ctrlDir)) console.log("ctrl:", file);

// --- closing gvim keeps the draft, /pivim restores it ---------------------
vimScript([`call setline(1, ['draft across a gvim restart'])`]);
vimScript([`execute 'qa!'`]).length; // gvim exits, VimLeavePre writes the draft
await new Promise((resolve) => setTimeout(resolve, 1200));
check("gvim exited", !serverRunning(), "server should be gone");
await commands.get("pivim").handler("", otherCtx);
await new Promise((resolve) => setTimeout(resolve, 3000));
check("pivim started a new gvim", serverRunning());
check("reopened tab restored the draft", vimExpr("getline(1)") === "draft across a gvim restart", vimExpr("string(getline(1, '$'))"));

// --- cleanup --------------------------------------------------------------
try {
	vim(["--servername", serverName, "--remote-expr", "execute('qa!')"]);
} catch {
	// already gone
}

console.log("\nnotifications:");
for (const line of logs) console.log(`  ${line}`);
