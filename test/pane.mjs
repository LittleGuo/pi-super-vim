/**
 * Local check for pane mode (PI_SUPER_VIM_TARGET=pane): no pi, no model, no gvim.
 *
 * It loads the extension with a fake pi and verifies against a real Windows
 * Terminal pane that: a settled run splits a pane and starts vim, a send (`:Pi`)
 * keeps the pane (the launcher loop waits), /pivim show and the next settled run
 * put a fresh vim back into that same pane, and `:q` lets the pane go away so the
 * run after it splits a new one.
 *
 *   node test/pane.mjs
 *
 * It opens a real pane in the current Windows Terminal window and closes it
 * again. Run it inside Windows Terminal.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ctrlDir = path.join(os.tmpdir(), "pi-super-vim-panetest");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..");
const sid = "panetest-0123456789";
const pidFile = path.join(ctrlDir, `${sid}.pane`);

process.env.PI_SUPER_VIM_TARGET = "pane";
process.env.PI_SUPER_VIM_PANE_WINDOW = "pi-super-vim-test"; // own WT window: never touch the one pi runs in
process.env.PI_SUPER_VIM_PANE_FOCUS = "0"; // do not move the focus of whoever runs the test
process.env.PI_SUPER_VIM_DIR = ctrlDir;
process.env.PI_SUPER_VIM_DEBUG = "1";
process.env.PI_SUPER_VIM_PANE_SPLIT = "h";
process.env.PI_SUPER_VIM_PANE_LINES = "12";

fs.rmSync(ctrlDir, { recursive: true, force: true });
fs.mkdirSync(ctrlDir, { recursive: true });

const { default: extension } = await import(new URL("../pi-super-vim.ts", import.meta.url).href);

const handlers = new Map();
const commands = new Map();
extension({
	on(event, handler) {
		handlers.set(event, handler);
		return () => handlers.delete(event);
	},
	registerCommand(name, options) {
		commands.set(name, options);
	},
	async sendUserMessage() {},
});

const ctx = {
	mode: "tui",
	hasUI: true,
	cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), ".."),
	sessionManager: { getSessionId: () => sid, getSessionName: () => "pane-test" },
	isIdle: () => true,
	ui: { notify(message, type) { console.log(`notify ${type ?? "info"}: ${message}`); } },
};

function check(name, ok, extra = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` -- ${extra}` : ""}`);
	if (!ok) process.exitCode = 1;
}

const settled = handlers.get("agent_settled");
if (!settled) throw new Error("extension did not register agent_settled");

/** Pids of vims started from our control dir. */
function vimPids() {
	const out = spawnSync("powershell", ["-NoProfile", "-Command",
		"Get-CimInstance Win32_Process -Filter \"Name='vim.exe'\" | Select-Object -ExpandProperty ProcessId"], { encoding: "utf8" });
	return (out.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
}

const before = vimPids().length;
await settled({ type: "agent_settled", aborted: false }, ctx);
const deadline = Date.now() + 20_000;
while (Date.now() < deadline && !fs.existsSync(pidFile)) await new Promise((r) => setTimeout(r, 300));

check("vim started in a pane (pid marker written)", fs.existsSync(pidFile), pidFile);
check("one more vim than before", vimPids().length === before + 1, `before=${before} after=${vimPids().length}`);
const pid = Number.parseInt(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "0", 10);
check("marker holds a live pid", pid > 0 && vimPids().includes(String(pid)), `pid=${pid}`);

// The vim half still quits on :Pi; the launcher loop is what keeps the pane.
check("vim still quits on :Pi", fs.readFileSync(path.join(ctrlDir, `${sid}.pane.vim`), "utf8").includes("quit_after_send"));
check("the launcher exits 0", /exit \/b 0/.test(fs.readFileSync(path.join(ctrlDir, `${sid}.pane.cmd`), "utf8")));
// The 12 requested lines become a fraction of pi's height (40 is the fallback
// when there is no tty, as in this test).
const debugLog = fs.readFileSync(path.join(ctrlDir, "debug.log"), "utf8");
check(
	"line count becomes a wt --size fraction",
	/pane size=0\.300 \(12 of 40 lines\)/.test(debugLog),
	(debugLog.match(/pane size=[^\n]*/) ?? ["missing"])[0],
);

const loopFile = path.join(ctrlDir, `${sid}.pane.loop`);
const openFile = path.join(ctrlDir, `${sid}.pane.open`);
const sentFile = path.join(ctrlDir, `${sid}.pane.sent`);
const quitFile = path.join(ctrlDir, `${sid}.pane.quit`);
const launcherFile = path.join(ctrlDir, `${sid}.pane.cmd`);

function panePid() {
	try {
		return Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
	} catch {
		return 0;
	}
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(predicate, ms = 20_000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

const splitCount = () => (fs.readFileSync(path.join(ctrlDir, "debug.log"), "utf8").match(/wt split-pane/g) ?? []).length;

// --- the vim half writes the "sent" marker the launcher loop keys on ------
const sentSid = "panetest-vimsent";
const vimScript = path.join(ctrlDir, "vimsent.vim");
const vimBin = (() => {
	for (const candidate of [process.env.PI_SUPER_VIM_CLIENT, "C:/Program Files/Vim/vim92/vim.exe"]) {
		if (candidate && fs.existsSync(candidate)) return candidate;
	}
	const out = spawnSync("where", ["vim"], { encoding: "utf8" });
	return (out.stdout ?? "").split(/\r?\n/)[0] || "vim";
})();
const q = (value) => value.replace(/'/g, "''");
fs.writeFileSync(
	vimScript,
	[
		"set nocompatible",
		`execute 'source' fnameescape('${q(path.join(root, "vim", "pi-super-vim.vim"))}')`,
		"let g:pi_super_vim_quit_after_send = 1",
		`call PiSuperVimOpen('${q(path.join(ctrlDir, `${sentSid}.md`))}', '${sentSid}', 1, 'x')`,
		"call setline(1, ['sent from a pane vim'])",
		"Pi",
	].join("\n") + "\n",
	"utf8",
);
const vimSent = spawnSync(vimBin, ["-N", "-u", "NONE", "-i", "NONE", "-n", "-S", vimScript], { windowsHide: true, timeout: 30_000 });
check(
	"a pane vim writes the sent marker on :Pi",
	fs.existsSync(path.join(ctrlDir, `${sentSid}.pane.sent`)),
	`exit=${vimSent.status} ${(vimSent.stderr ?? "").toString().trim()}`,
);

// --- :Pi keeps the pane, /pivim show brings vim back into it ---------------
const launcherMtime = fs.statSync(launcherFile).mtimeMs;
fs.writeFileSync(sentFile, "1");
spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true });
check("the pane stays after a send", (
	await waitFor(() => !alive(pid) && fs.existsSync(loopFile))
) && splitCount() === 1, `loop=${fs.existsSync(loopFile)} splits=${splitCount()}`);

await commands.get("pivim").handler("show", ctx);
const showPid = (await waitFor(() => panePid() > 0 && panePid() !== pid && alive(panePid()))) ? panePid() : 0;
check("pivim show starts vim in the waiting pane", showPid > 0, `pid=${showPid}`);
check("show did not split a second pane", splitCount() === 1 && fs.statSync(launcherFile).mtimeMs === launcherMtime, `splits=${splitCount()}`);
check("the open request was consumed", !fs.existsSync(openFile));
check("the sent marker was consumed", !fs.existsSync(sentFile));

// --- a settled run reopens vim in the same pane ----------------------------
fs.writeFileSync(sentFile, "1");
if (showPid > 0) spawnSync("taskkill", ["/PID", String(showPid), "/F"], { windowsHide: true });
await waitFor(() => !alive(showPid));
await settled({ type: "agent_settled", aborted: false }, ctx);
const settlePid = (await waitFor(() => panePid() > 0 && panePid() !== showPid && alive(panePid()))) ? panePid() : 0;
check("a settled run reopens vim in the same pane", settlePid > 0, `pid=${settlePid}`);
check("the settle did not split a second pane", splitCount() === 1, `splits=${splitCount()}`);

// --- :q (no send) closes the pane, the next run splits a new one -----------
if (settlePid > 0) spawnSync("taskkill", ["/PID", String(settlePid), "/F"], { windowsHide: true });
check("the pane closes when vim was quit, not sent", await waitFor(() => !fs.existsSync(loopFile), 10_000), `loop=${fs.existsSync(loopFile)}`);

await settled({ type: "agent_settled", aborted: false }, ctx);
const freshPid = (await waitFor(() => panePid() > 0 && panePid() !== settlePid && alive(panePid()))) ? panePid() : 0;
check("the next run splits a new pane", freshPid > 0 && splitCount() === 2, `pid=${freshPid} splits=${splitCount()}`);
check("the launcher was rewritten for the new pane", fs.statSync(launcherFile).mtimeMs > launcherMtime);

// --- cleanup ---------------------------------------------------------------
fs.writeFileSync(quitFile, "");
if (freshPid > 0) spawnSync("taskkill", ["/PID", String(freshPid), "/F"], { windowsHide: true });
await waitFor(() => !fs.existsSync(loopFile), 10_000);
console.log(`closed the test pane (vim ${freshPid})`);
