/**
 * Checks for the :Img clipboard images, no model and no pi session.
 *
 * Two halves, both local:
 *
 *  1. vim: a real gvim sources the plugin, :Img is driven through
 *     --remote-send (the same path a keystroke takes), and the placeholder,
 *     the whole-block backspace and the buffer-local scope are checked.  A test
 *     double (test/fake-clip.ps1) replaces the clipboard so the run does not
 *     touch whatever the user last copied.
 *  2. pi: the extension with a fake pi api; a request file is dropped in the
 *     control dir and the sent message is inspected: text + image content, the
 *     files are deleted after a send, and a placeholder without a file is
 *     reported instead of being sent as an empty image.
 *
 *   node test/image.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixture = path.join(here, "fixture.png");
const fakeClip = path.join(here, "fake-clip.ps1");
const plugin = path.join(root, "vim", "pi-super-vim.vim");

const ctrlDir = path.join(os.tmpdir(), "pi-super-vim-imgtest");
const serverName = "PI_SUPER_VIM_IMGTEST";
const sid = "imgtest-0123456789";

process.env.PI_SUPER_VIM_DIR = ctrlDir;
process.env.PI_SUPER_VIM_SERVER = serverName;
process.env.PI_SUPER_VIM_TEST_IMAGE = fixture;
process.env.PI_SUPER_VIM_CLOSE = "1";
process.env.PI_SUPER_VIM_DEBUG = "1";

fs.rmSync(ctrlDir, { recursive: true, force: true });
fs.mkdirSync(ctrlDir, { recursive: true });

function check(name, ok, extra = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` -- ${extra}` : ""}`);
	if (!ok) process.exitCode = 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, timeout = 8000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await fn()) return true;
		await sleep(60);
	}
	return false;
}

// --- 1. the extension: [#imgN] -> image content -----------------------------

const { default: extension } = await import(new URL("../pi-super-vim.ts", import.meta.url).href);

const handlers = new Map();
const sent = [];
const logs = [];

extension({
	on(event, handler) {
		handlers.set(event, handler);
		return () => handlers.delete(event);
	},
	registerCommand() {},
	async sendUserMessage(content, options) {
		sent.push({ content, options });
	},
});

const ctx = {
	mode: "tui",
	hasUI: true,
	cwd: root,
	sessionManager: { getSessionId: () => sid, getSessionName: () => undefined },
	isIdle: () => true,
	ui: {
		notify(message, type) {
			logs.push(`[${type ?? "info"}] ${message}`);
			console.log(`notify ${type ?? "info"}: ${message}`);
		},
	},
};

await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

const fixtureBytes = fs.readFileSync(fixture);
const imgFile = (id, ext = "png") => path.join(ctrlDir, `${sid}.img${id}.${ext}`);
const request = (mode, text) =>
	fs.writeFileSync(path.join(ctrlDir, `${sid}.req`), JSON.stringify({ sid, text, mode, ts: 1 }), "utf8");

// images are found by placeholder, in text order
fs.writeFileSync(imgFile(1), fixtureBytes);
fs.writeFileSync(imgFile(2), fixtureBytes);
request("auto", "compare [#img1] with [#img2] and tell me");
check(
	"a request with placeholders is delivered",
	await until(() => sent.length === 1),
	`sent=${sent.length}`,
);
const withImages = sent[0]?.content;
check(
	"the message is text plus one image per placeholder, in text order",
	Array.isArray(withImages) &&
		withImages.length === 3 &&
		withImages[0].type === "text" &&
		withImages[0].text === "compare [#img1] with [#img2] and tell me" &&
		withImages.slice(1).every((part) => part.type === "image" && part.mimeType === "image/png"),
	JSON.stringify(withImages && withImages.map((part) => part.type)),
);
check(
	"the image bytes are the file bytes",
	withImages?.[1]?.data === fixtureBytes.toString("base64"),
	`${withImages?.[1]?.data?.length} base64 chars`,
);
check(
	"sent images are removed from the control dir",
	!(await until(() => fs.existsSync(imgFile(1)) || fs.existsSync(imgFile(2)), 500)),
	`img1=${fs.existsSync(imgFile(1))} img2=${fs.existsSync(imgFile(2))}`,
);
check(
	"the notification mentions the image",
	logs.some((line) => line.includes("(+2 image)")),
	logs.at(-1),
);

// a placeholder whose file is gone must not become an empty image
request("auto", "what is in [#img7]?");
check(
	"a placeholder without a file is still delivered",
	await until(() => sent.length === 2),
	`sent=${sent.length}`,
);
check(
	"a missing image degrades to the text",
	typeof sent[1]?.content === "string" && sent[1].content === "what is in [#img7]?",
	JSON.stringify(sent[1]?.content),
);
check(
	"the missing image is reported",
	logs.some((line) => line.includes("[#img7] has no image file")),
	logs.at(-1),
);

// a file nobody points at must survive: it may belong to another placeholder
fs.writeFileSync(imgFile(2), fixtureBytes);
request("auto", "text without any placeholder");
check(
	"a request without placeholders is delivered",
	await until(() => sent.length === 3),
	`sent=${sent.length}`,
);
check(
	"an unreferenced image is sent as a plain string and kept",
	typeof sent[2]?.content === "string" && fs.existsSync(imgFile(2)),
	`content=${typeof sent[2]?.content} kept=${fs.existsSync(imgFile(2))}`,
);
fs.rmSync(imgFile(2), { force: true });

// --- 2. vim: :Img, the backspace and the buffer-local scope ----------------

const vimExe = [
	process.env.PI_SUPER_VIM_GVIM,
	"C:/Program Files/Vim/vim92/gvim.exe",
	"/usr/bin/gvim",
]
	.filter(Boolean)
	.find((candidate) => fs.existsSync(candidate));
if (!vimExe) {
	check("gvim is installed", false, "set PI_SUPER_VIM_GVIM to gvim.exe");
} else {
	const client = [
		process.env.PI_SUPER_VIM_CLIENT,
		path.join(path.dirname(vimExe), "vim.exe"),
		"/usr/bin/vim",
	]
		.filter(Boolean)
		.find((candidate) => fs.existsSync(candidate));
	const vim = (args) => spawnSync(client, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
	// Only the trailing newline goes: a buffer line may legitimately end in spaces.
	const expr = (expression) =>
		(vim(["--servername", serverName, "--remote-expr", expression]).stdout ?? "").replace(/\r?\n$/, "");
	// --remote-send is documented as "not mapped", so keys that have to go
	// through a mapping are queued with feedkeys('m') instead: that is the path
	// a typed key takes.
	const keyFile = path.join(ctrlDir, "keys.vim");
	const send = (notation) => {
		// <C-o> is literal text in a Vimscript string, \<C-o> is the key
		const body = notation.replace(/</g, "\\<");
		fs.writeFileSync(keyFile, `call feedkeys("${body}", 'm')\n`, "utf8");
		expr(`execute(readfile('${keyFile.replace(/\\/g, "/")}'))`);
	};

	const sessionFile = path.join(ctrlDir, `${sid}.md`);
	const startScript = path.join(ctrlDir, "start.vim");
	fs.writeFileSync(
		startScript,
		[
			"set nocompatible",
			// predictable starting state: no auto-insert, the test sends its own keys
			"let g:pi_super_vim_startinsert = 0",
			`let g:pi_super_vim_clip_script = '${fakeClip.replace(/\\/g, "/")}'`,
			`source ${plugin.replace(/\\/g, "/")}`,
			`call PiSuperVimOpen('${sessionFile.replace(/\\/g, "/")}', '${sid}', 1, 'imgtest')`,
			"call setline(1, ['look at this '])",
			"call cursor(1, 13)",
			"",
		].join("\n"),
		"utf8",
	);

	const child = spawn(vimExe, ["--servername", serverName, "-S", startScript], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();

	const serverUp = await until(() => {
		const result = vim(["--serverlist"]);
		return (result.stdout ?? "")
			.split(/\r?\n/)
			.map((line) => line.trim().toLowerCase())
			.includes(serverName.toLowerCase());
	}, 20_000);
	check("test vim server is running", serverUp, serverName);

	if (serverUp) {
		const line = () => expr("getline(1)");
		// the -S script may still be running when the server answers
		const ready = await until(() => expr("exists(':Img')") === "2", 15_000);
		check(":Img exists in the pi prompt buffer", ready, expr("exists(':Img')"));
		check("insert mode backspace is remapped", expr("maparg('<BS>', 'i')") !== "", expr("maparg('<BS>', 'i')"));

		// A = append at end of line: every key below arrives through the same
		// typeahead a user's keys take, so the cursor position is predictable.
		send("A");
		check("vim entered insert mode", await until(() => expr("mode()") === "i", 8_000), expr("mode()"));

		send("<C-o>:Img<CR>");
		const inserted = await until(() => line() === "look at this [#img1]", 20_000);
		check(":Img inserts [#img1] at the cursor", inserted, JSON.stringify(line()));
		check(
			"the image landed next to the session file",
			fs.existsSync(path.join(ctrlDir, `${sid}.img1.png`)),
			String(fs.existsSync(path.join(ctrlDir, `${sid}.img1.png`))),
		);
		check(
			":Img reports what it attached",
			expr("execute('messages')").includes("pi: attached [#img1]"),
			expr("execute('messages')").split("\n").at(-1),
		);

		send("<BS>");
		check(
			"one backspace removes the whole placeholder",
			await until(() => line() === "look at this ", 8_000),
			JSON.stringify(line()),
		);

		// the number is the highest placeholder in the buffer plus one
		send("<C-o>:Img<CR>");
		const reused = await until(() => line() === "look at this [#img1]", 20_000);
		check("the number is reused once no placeholder is left", reused, JSON.stringify(line()));

		send("<C-o>:Img<CR>");
		const second = await until(() => line() === "look at this [#img1][#img2]", 20_000);
		check("a second image gets the next number", second, JSON.stringify(line()));

		send(" tail");
		const typed = await until(() => line() === "look at this [#img1][#img2] tail", 8_000);
		send("<Left><Left><Left><Left><Left>"); // right after the second placeholder
		send("<BS>");
		check(
			"backspace deletes the placeholder next to the cursor and nothing else",
			typed && (await until(() => line() === "look at this [#img1] tail", 8_000)),
			JSON.stringify(line()),
		);

		// forward delete: <Del> on the first character of a placeholder
		expr("execute('call cursor(1, 14)')");
		send("<Del>");
		check(
			"forward delete removes the whole placeholder too",
			await until(() => line() === "look at this  tail", 8_000),
			JSON.stringify(line()),
		);

		// an unusable clipboard leaves the buffer alone and says why
		const before = line();
		expr("execute('let $PI_SUPER_VIM_TEST_IMAGE = ''C:/no/such/image.png''')");
		send("<C-o>:Img<CR>");
		check(
			"a failing clipboard helper inserts nothing and reports it",
			await until(() => expr("execute('messages')").includes("PI_SUPER_VIM_TEST_IMAGE is not a file"), 20_000) &&
				line() === before,
			JSON.stringify(line()),
		);

		// buffer local: a plain buffer has no :Img and no backspace mapping
		expr("execute('setlocal nomodified | enew')");
		check(
			"a plain buffer has no :Img and keeps the normal backspace",
			await until(() => expr("exists(':Img')") === "0" && expr("maparg('<BS>', 'i')") === "", 8_000),
			`exists=${expr("exists(':Img')")} bs=${expr("maparg('<BS>', 'i')")}`,
		);

		vim(["--servername", serverName, "--remote-expr", "execute('qa!')"]);
	}
}

await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
console.log("\nnotifications:");
for (const line of logs) console.log(`  ${line}`);
