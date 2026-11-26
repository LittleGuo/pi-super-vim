/**
 * Local check for pane mode (PI_SUPER_VIM_TARGET=pane): no pi, no model, no gvim.
 *
 * It loads the extension with a fake pi, fires agent_settled and verifies that a
 * Windows Terminal split pane really started vim on the session buffer (the vim
 * half writes <sid>.pane), that a second run does not open a second pane, and
 * that pi asks the pane to clear itself instead.
 *
 *   node test/pane.mjs
 *
 * It opens a real pane in the current Windows Terminal window and closes it
 * again (the pane exits with its vim). Run it inside Windows Terminal.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ctrlDir = path.join(os.tmpdir(), "pi-super-vim-panetest");
const sid = "panetest-0123456789";
const pidFile = path.join(ctrlDir, `${sid}.pane`);

process.env.PI_SUPER_VIM_TARGET = "pane";
process.env.PI_SUPER_VIM_DIR = ctrlDir;
process.env.PI_SUPER_VIM_DEBUG = "1";
process.env.PI_SUPER_VIM_PANE_SPLIT = "h";
process.env.PI_SUPER_VIM_PANE_LINES = "12";

fs.rmSync(ctrlDir, { recursive: true, force: true });
fs.mkdirSync(ctrlDir, { recursive: true });

const { default: extension } = await import(new URL("../pi-super-vim.ts", import.meta.url).href);

const handlers = new Map();
extension({
	on(event, handler) {
		handlers.set(event, handler);
		return () => handlers.delete(event);
	},
	registerCommand() {},
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

// The vim half quits on :Pi and the launcher exits 0, which is what makes WT
// close the pane instead of asking for Enter.
check("the pane quits after :Pi", fs.readFileSync(path.join(ctrlDir, `${sid}.pane.vim`), "utf8").includes("quit_after_send"));
check("the launcher exits 0", /exit \/b 0/.test(fs.readFileSync(path.join(ctrlDir, `${sid}.pane.cmd`), "utf8")));
// The 12 requested lines become a fraction of pi's height (40 is the fallback
// when there is no tty, as in this test).
const debugLog = fs.readFileSync(path.join(ctrlDir, "debug.log"), "utf8");
check(
	"line count becomes a wt --size fraction",
	/pane size=0\.300 \(12 of 40 lines\)/.test(debugLog),
	(debugLog.match(/pane size=[^\n]*/) ?? ["missing"])[0],
);

// Sending closes the pane.  Simulate that vim going away, then check that the
// next settled run opens a fresh pane with a new pid.
spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true });
await new Promise((r) => setTimeout(r, 500));
await settled({ type: "agent_settled", aborted: false }, ctx);
const reopenDeadline = Date.now() + 20_000;
let newPid = pid;
while (Date.now() < reopenDeadline) {
	newPid = Number.parseInt(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "0", 10);
	if (newPid > 0 && newPid !== pid) break;
	await new Promise((r) => setTimeout(r, 300));
}
check("a settled run reopens the pane with a fresh vim", newPid > 0 && newPid !== pid, `old=${pid} new=${newPid}`);
check("only one pane vim is left", vimPids().length === before + 1, `vims=${vimPids().length}`);

if (newPid > 0) {
	spawnSync("taskkill", ["/PID", String(newPid), "/F"], { windowsHide: true });
	console.log(`closed the test pane (vim ${newPid})`);
}
