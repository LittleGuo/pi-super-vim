# pi-super-vim

**English** | [中文](README.zh-CN.md)

Write pi prompts in vim — and **paste clipboard screenshots straight into the prompt** (`:Img`).
pi keeps running in its own terminal, and its output stays there; when a run settles, the
extension gets "the input place for this session" ready (a 20-line split pane inside Windows
Terminal, or a tab in a resident gvim). You write the next prompt in vim and hit `:Pi`; the text
(and any images) is delivered exactly as if you had typed it into pi.

Two flavours: **WT split pane** (the default — a pane inside the Windows Terminal that pi runs
in, kept alive between rounds; each round gets a fresh one-shot vim in it; `:q` closes the pane)
and **gvim window** (one resident gvim, one tab per session). `/pivim keep off` brings back the
old "close the pane after sending, split again after the answer" behaviour.

```
 pi (terminal)                                 vim (gvim tab or WT pane)
      |                                              |
      |  1. run settles (agent_settled) or /pivim    |
      +--------------------------------------------> |  open/focus the tab
                                                     |  :Pi  :PiSteer  :PiQueue
      +----------------------------------------------+  :w sends too
      |  2. vim writes <sid>.req
      v
 pi.sendUserMessage(text, images)   <- the extension watches the control dir
```

Why not just send keystrokes to the terminal? That needs Windows SendKeys / clipboard injection,
and focus, encodings, paste mode and long text all get in the way. Instead the extension calls
pi's own `pi.sendUserMessage()`, which is exactly what pressing Enter in pi does (a user message
appears in the TUI and the next run starts normally) — just far more reliable.

## What you get

All in vim, hands never leave the keyboard:

| Command | What it does |
| --- | --- |
| `:Pi` / `:w` | Send this prompt to pi (queued automatically when pi is busy) |
| `:PiSteer` | Interrupt the current run (steer) |
| `:Img` | **Paste a clipboard screenshot as `[#imgN]`**; `:Pi` sends it as a real image alongside the text |
| `:PiClear` / `:PiClose` | Clear / close the current tab (unsent text is kept as a draft) |

The one you will use most is probably pasting images:

```
Esc
:Img                     " clipboard screenshot -> what is wrong in this picture[#img1]
:Img                     " another one -> ...what about [#img1],[#img2]
:Pi                      " both images + this text go out together
```

`:Img` understands **bitmaps** (Win+Shift+S, "copy image" in a browser), **image files copied in
Explorer**, and **a pasted path to an image**. Image bytes never enter the vim buffer — only a
short placeholder; `<BS>` deletes the whole placeholder; the files are cleaned up after a
successful send. Details in [Pasting images (`:Img`)](#pasting-images-img).

Long prompts, Chinese IME text, screenshot bugs, three things at once — that is why this plugin
exists.

## Layout

| File | What it is |
| --- | --- |
| `pi-super-vim.ts` | The pi extension: manages the gvim server / WT pane, per-session tabs, watches request files, delivers to pi |
| `settings.ts` | The `/pivim setting` screen (model + TUI), English/Chinese |
| `vim/pi-super-vim.vim` | The vim half: prompt buffer, `:Pi` commands, `:Img`, tab labels, draft protection |
| `vim/pi-clip.ps1` | Reads the Windows clipboard (screenshot / copied image file / image path) into `imgN.<ext>` for `:Img` |
| `.pi/extensions/pi-super-vim.ts` | Lets pi load the extension automatically inside this repo (one-line forwarder) |
| `test/harness.mjs` | gvim mode self-test (fake pi API + real gvim round trip) |
| `test/pane.mjs` | WT pane self-test (fake pi API + real pane + real vim) |
| `test/settings.mjs` | `/pivim setting` model test (tabs / rows / values / number input) |
| `test/image.mjs` | `:Img` self-test (real gvim + fake clipboard + fake pi), never touches your clipboard |

## Requirements

* **Windows only.** This extension exists because typing long/Chinese prompts in a Windows
  terminal is painful. Linux/macOS are untested and not planned; write in gvim there instead.
* **Vim for Windows** installed in `C:\Program Files\Vim\vim92\` (ships both `gvim.exe` and `vim.exe`)
  * WT split pane (**default**): only console `vim.exe`, plus the `wt.exe` that Windows Terminal
    ships (comes with Windows 11). No Windows Terminal? Use `/pivim gvim` or `PI_SUPER_VIM_TARGET=gvim`.
  * gvim window: `gvim.exe` is the server, `vim.exe` a windowless client (so we can read
    `--remote-expr` output and exit codes).
* Vim 8.1+ (`bufadd()` / `win_findbuf()` / `tabpagebuflist()` / `job_start()`) — tested on 9.x.
* pi 1.4+.
* Pasting images (`:Img`) additionally needs Windows PowerShell: `powershell.exe` is preferred
  (ships with Windows, starts faster), `pwsh` is the fallback. Nothing to install, no admin rights.

## Install

Install Vim first (`winget install vim.vim`, or the official installer), then the extension.
**git is recommended** (you can pin a tag):

```bash
# pin a version (recommended: behaviour does not change under you)
pi install git:github.com/LittleGuo/pi-super-vim@v0.3.0

# or track main
pi install git:github.com/LittleGuo/pi-super-vim@main
```

Updating: `pi update git:github.com/LittleGuo/pi-super-vim` (only moves when a new tag/main is
pushed, otherwise nothing changes).

The same package is on npm; versions line up with the repo's `v*` tags (pushed by GitHub Actions
through Trusted Publishing):

```bash
pi install npm:pi-super-vim@0.3.0    # pin
pi install npm:pi-super-vim          # follow latest
```

Identical contents; the only difference is where `pi install` fetches from. For npm, update with
`pi update --extensions`.

> Maintainers: bump `package.json` → commit and push main → `git tag vX.Y.Z && git push origin vX.Y.Z`.
> `.github/workflows/publish.yml` runs `npm publish` over OIDC (no npm token; a version can only be
> published once).

`vim/pi-super-vim.vim` is read by the extension from the package directory itself — no manual copy.

This repo also has `.pi/extensions/pi-super-vim.ts` (a one-line forwarder), so starting pi **in this
directory** loads it automatically (project-local extensions need the project to be trusted). Note
that if you already installed the package globally you get two copies here; the extension dedupes
itself (the second load returns immediately) so you never get two gvim servers — **but the globally
installed package is the one that takes effect**. To try a local edit immediately, use
`pi -ne -e ./pi-super-vim.ts` (only that copy) or `pi remove git:github.com/LittleGuo/pi-super-vim@main`
first; for a real release, push main and `pi update`.

You can also load a single file explicitly:

```powershell
pi --extension D:\new-start\PI-EXTENSIONS\pi-super-vim\pi-super-vim.ts
```

Or skip packages entirely and drop the files in by hand (pi loads subdirectories with `index.ts`):

```
%USERPROFILE%\.pi\agent\extensions\pi-super-vim\index.ts        <- renamed/copied from pi-super-vim.ts
%USERPROFILE%\.pi\agent\extensions\pi-super-vim\vim\pi-super-vim.vim
```

If you want `:Pi` in a vim you started yourself (not only in pi's own tab/pane):

```
/pivim install      # copies vim/pi-super-vim.vim and pi-clip.ps1 to ~/.vim/plugin/
```

## Usage

`/pivim pane` and `/pivim gvim` switch between the two flavours; the default is the **WT split
pane** (see [Pane mode](#pane-mode-windows-terminal-pane)):

* **WT split pane** (default): split a pane inside the Windows Terminal pi runs in (below pi, 20 lines)
* **gvim window**: one resident gvim, one tab per session; when a run settles the tab is brought
  forward and cleared

The walk-through below uses the gvim window (pane differences are in [Pane mode](#pane-mode-windows-terminal-pane)):

1. Talk to pi as usual.
2. When pi finishes, gvim starts (slower the first time) or switches to this session's tab, labelled
   `pi:<session name>` (falls back to `pi:<first 8 of the id>`); the cursor is already in insert
   mode and the tab is empty.
3. Write your next prompt.
4. `Esc`, then:

| vim command | What it does |
| --- | --- |
| `:Pi` | Send (starts immediately when pi is idle; queued as a follow-up when pi is busy) |
| `:PiQueue` | Queue explicitly, wait for the current run to finish |
| `:PiSteer` | Interject / interrupt the current run (steer) |
| `:w` | Same as `:Pi` — it means "submit" (nothing is written to disk) |
| `:PiClear` | Clear the buffer (`u` brings it back) |
| `:PiClose` | Close this tab (kept if it holds unsent text) |
| `:Img` | Paste a clipboard image as `[#imgN]`, sent with `:Pi` (see [Pasting images](#pasting-images-img)) |

Clearing rules (so your draft is never eaten):

* when the tab is opened after a run, it is cleared if it holds **what was already sent** or you
  never touched it;
* if you already started the next prompt while pi was answering and have not sent it — **it is
  kept**, never overwritten.

Commands in pi:

| Command | What it does |
| --- | --- |
| `/pivim setting` | Open the settings screen (see [Settings](#settings-pivim-setting)) |
| `/pivim` / `/pivim show` | Bring vim up if it is not there (pane mode: split when there is no pane, pull vim into a waiting pane); does nothing when it is already open |
| `/pivim pane` / `/pivim gvim` | Switch flavour, remembered |
| `/pivim split up` / `down` / `left` / `right` | Where vim sits relative to pi (default `down`; `h`/`v` are the old names for down/right) |
| `/pivim keep on` / `keep off` | Keep the pane after `:Pi` (default on; off = close it and split a new one after the answer) |
| `/pivim lines N` / `cols N` | Pane size: text lines (default 20) / columns (default 60) |
| `/pivim status` | Print target / pane settings / gvim / client / plugin / control dir / session — for troubleshooting |
| `/pivim close` | Close this session's tab (pane mode sends a quit signal: a waiting pane closes right away, a vim still being written in closes when you leave it) |
| `/pivim install` | Copy the vim plugin and clipboard script to `~/.vim/plugin/` |

"Does nothing" is literal: when vim is already open in the pane, or gvim already has this
session's tab, `/pivim` does not switch tabs and does not touch the buffer (your half-typed text
stays); it only creates things that are missing.

## Settings (`/pivim setting`)

Easier than remembering commands (English by default; switch **Language** to `zh` and the whole
screen turns Chinese):

```
Super Vim Settings
[General]  pane   gvim
Tab/Shift+Tab/←/→: tabs · ↑/↓: move · Enter/Space: change · Esc/q: close
  ──Mode──
→ Mode                                   pane
  ──Interface──
  Language                               en
```

| tab | row | values |
| --- | --- | --- |
| General | Mode | `pane` / `gvim` |
| General | Language | `en` / `zh` (default `en`; affects the settings screen itself for now) |
| pane | Split | Up / Down / Left / Right |
| pane | Pane lines | a number (Enter starts typing, Enter confirms, Esc cancels) |
| pane | Keep pane | Yes / No (= `keep`) |
| gvim | — | nothing to configure yet |

Changes apply **immediately** and are written to `prefs` (remembered across restarts); switching to
`gvim` also lets a waiting pane go. There is no UI in `prompt` mode — use the `/pivim ...` commands.

## Details

* **One gvim, many tabs**: gvim is a resident server with a fixed name (`PI_SUPER_VIM` by default);
  each pi session gets a tab (tab variable `t:pi_tablabel`, buffer variable `b:pi_session`), so
  several pi sessions never mix. The tab label is `pi:<session name>` (falls back to the first 8
  characters of the id); renaming updates the label in place without stealing focus.
* **The buffer is a scratch buffer**: `buftype=acwrite`, no swap, no undofile, markdown syntax and
  wrapping. Its name is `<control dir>/<session id>.md`, but the file is never actually written.
* **Control directory**: `%TEMP%\pi-super-vim\` by default (`os.tmpdir()`), containing
  * `<sid>.req` / `.req.tmp`: the request vim writes for pi (JSON: text / mode / sid / ts). The
    extension watches the directory and polls once a second as a fallback; the file is removed
    before delivery so a prompt is never delivered twice;
  * `<sid>.cmd.vim`: the little script the extension asks vim to run;
  * `<sid>.draft`: text you had not sent when you closed vim, restored the next time;
  * `<sid>.pane.*` (pane mode): `.pane` is the vim pid, `.pane.vim` / `.pane.cmd` are the script and
    the launcher loop, `.pane.loop` is the waiting heartbeat (rewritten every second), and
    `.pane.open` / `.pane.sent` / `.pane.quit` are the "bring vim back / this was sent / you can go"
    signals — whoever uses one deletes it;
  * `<sid>.imgN.<ext>` / `<sid>.imgN.res`: images captured by `:Img` and its result line (`.res` is
    deleted after reading); image files are deleted after a successful send;
  * `debug.log`: only written with `PI_SUPER_VIM_DEBUG=1`.
* **Tab title**: the plugin replaces `tabline` with its own (shows `pi:<id>`, with `+` when there is
  unsent text; normal tabs show the file name) — but only when your `tabline` was empty, so an
  existing config is never overwritten. Turn it off with `let g:pi_super_vim_tabline = 0`.
* **Exit**: quitting pi (or `/new`, `/resume` to another session) closes the matching tab; closing
  the last tab lets gvim exit. In pane mode a `<sid>.pane.quit` is written: a pane waiting for pi
  closes immediately, a pane with vim still open closes when you leave vim.
  It only stops you when there is **genuinely unsent text**: once the buffer is emptied, `:q` /
  `:PiClose` just close; otherwise the tab is kept and the text becomes a draft. Same for
  `/pivim close`.

## Pasting images (`:Img`)

Press `Esc` and `:Img`, or `<C-o>:Img<CR>` in insert mode: it drops a short placeholder `[#img1]`
at the cursor (after `Esc` the placeholder lands **after** the cursor character, because Esc moves
the cursor back onto the last character you typed — that way it ends up at the end of the line).

```
what is different between this error [#img1] and the normal case [#img2]
```

On `:Pi` the extension reads the image files in the order their `[#imgN]` appear and hands them to
the model as image content next to the text (`pi.sendUserMessage([{type:"text"},{type:"image"}])`).
The `[#imgN]` placeholders stay in the text so the model can tell which is which.

**What the clipboard can hold** (tried in this order, all in `vim/pi-clip.ps1`):

| Clipboard | Typical action | Result |
| --- | --- | --- |
| Bitmap | Win+Shift+S, "copy image" in a browser | converted to PNG on disk |
| File(s) copied in Explorer | select `a.png`, Ctrl+C | the original bytes are copied |
| Path text | copied a `C:\...\a.png` from somewhere | quoted / `file://` / `~` / relative paths are resolved and validated |
| Nothing | — | a message like `pi: no image on the clipboard`, no placeholder is inserted |

**Behaviour rules**:

* **base64 never appears in vim.** `:Img` writes the bytes to `<control dir>/<sid>.imgN.<ext>`; the
  buffer only holds an 8–10 character placeholder, so a big screenshot cannot slow undo down or
  blow up registers.
* **Format is detected by magic number, not extension**: only PNG / JPEG / GIF / WebP; anything else
  fails right at `:Img`.
* **4 MB per image** (`g:pi_super_vim_img_max`). Rejected up front, not at send time. Deliberately no
  compression/rescaling: add it if a provider actually refuses the image; `System.Drawing` resampling
  costs hundreds of milliseconds for no benefit.
* **Files are deleted only after a successful send.** Deleting a placeholder means "do not send this
  image"; if the file is gone (e.g. draft restored after cleanup) pi says `[#imgN] has no image file`
  and sends the text only — never an empty image.
* **Numbering = highest number in the buffer + 1**, so deleting `[#img5]` and pasting again reuses
  `[#img5]` instead of colliding.
* **Deletion is whole-block**: `<BS>` / `<C-H>` / `<C-?>` (terminals send different keys — all three
  are mapped) delete the entire `[#imgN]` in one go, and `<Del>` forwards does the same. Surrounding
  text is untouched.
* **Only inside pi's prompt buffer**: `:Img` and those mappings are `-buffer` / `<buffer>`. After
  `/pivim install` copied the plugin to `~/.vim/plugin/`, a vim you start yourself (even editing a
  markdown file) has no `:Img` and unchanged backspace. Disable the whole feature with
  `let g:pi_super_vim_img = 0`.
* **Known trade-off**: if you delete a placeholder by hand, that image file stays in `%TEMP%`
  (a few hundred KB; the OS cleans up eventually). Add a cleaner only if it becomes a problem.

## Pane mode (Windows Terminal pane)

This is the **default**: vim splits inside the Windows Terminal pi runs in instead of opening a
separate window. (`/pivim gvim` switches back to a gvim window; the choice is remembered.)

```
/pivim setting     # open the settings screen (recommended)
/pivim show        # bring vim up now (gvim: switch to the tab; pane mode: pull vim into the waiting pane)
/pivim pane        # switch to the WT pane (default)
/pivim gvim        # switch back to a separate gvim window
/pivim keep on     # keep the pane after :Pi (default)
/pivim keep off    # close the pane after :Pi, split a new one when pi answers
/pivim split down  # vim below pi (default); up / left / right work too
/pivim lines 20    # pane height in text lines (vertical splits)
/pivim cols 60     # pane width in text columns (horizontal splits)
/pivim status      # current target / direction / size
```

`Up` / `Left` are implemented as the normal `-H`/`-V` split followed by `wt swap-pane up|left`, which
visually puts vim above/left of pi.

These settings live in `<control dir>/prefs` and survive a restart.

**How it works** (the key difference from gvim mode):

* when a run settles a pane opens, containing a **one-shot vim** (not a server, it cannot be called
  remotely);
* when you `:Pi` / `:w`, vim still `qall!`s; by default the **pane stays** (the launcher is a loop,
  which clears the screen and shows one `waiting for pi...` line). `/pivim keep off` restores the old
  behaviour: the pane closes and the next round splits a new one;
* when pi answers, the extension writes `<sid>.pane.open`; the launcher sees it and starts a fresh
  vim **in the same pane** — the buffer lives in memory and dies with the old vim, so there is
  **nothing to clear**, the new vim starts empty; drafts typed in the meantime are restored from
  `<sid>.draft` as usual;
* `:q` without sending: the launcher exits and the pane with it (with keep on, only a send keeps it);
* "is the pane still there?" is a heartbeat: the launcher rewrites `<sid>.pane.loop` every second;
  a missing file or one older than 3 seconds (pane closed with X) means there is none and a new one
  is split;
* focus: a freshly split pane gets focus from WT itself; an **existing** pane is focused with
  `wt -w 0 move-focus down|right` (disable with `PI_SUPER_VIM_PANE_FOCUS=0`).

**Known limitations**: `move-focus` only acts on the active tab / most recently used WT window, so
(a) if you switched to another tab it moves focus there (a no-op in a single-pane tab);
(b) with more than two panes and focus outside pi's half it may move to the wrong pane;
(c) if pi is killed hard the launcher never sees `.pane.quit` and the pane stays on `waiting` —
close it with X.

The size is `lines / pi's terminal rows` (or `cols / columns`) turned into a `wt --size` fraction;
WT rounds to pixels, so expect ±1–2 lines. Env vars `PI_SUPER_VIM_PANE_SPLIT=h|v`,
`PI_SUPER_VIM_PANE_LINES` and `PI_SUPER_VIM_PANE_COLS` are the initial values (anything set with
`/pivim` wins and is remembered).

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_SUPER_VIM_SERVER` | `PI_SUPER_VIM` | gvim server name |
| `PI_SUPER_VIM_DIR` | `%TEMP%\pi-super-vim` | request / draft / command files |
| `PI_SUPER_VIM_GVIM` | auto-detected | path to `gvim.exe` |
| `PI_SUPER_VIM_CLIENT` | auto-detected | path to console `vim.exe` (used to read output) |
| `PI_SUPER_VIM_PLUGIN` | `vim/pi-super-vim.vim` next to this file | vim plugin path |
| `PI_SUPER_VIM_AUTO` | `1` | `0` = do not open vim automatically after a run, only via `/pivim` |
| `PI_SUPER_VIM_STARTINSERT` | `1` | enter insert mode when the tab opens |
| `PI_SUPER_VIM_CLOSE` | `1` | close the tab when pi exits |
| `PI_SUPER_VIM_TARGET` | `pane` | `gvim` = use a separate gvim window (or `/pivim gvim`) |
| `PI_SUPER_VIM_PANE_SPLIT` | `down` | where vim goes: `up` / `down` / `left` / `right` (`h`/`v` = down/right) |
| `PI_SUPER_VIM_PANE_LINES` | `20` | height for up/down splits (text lines) |
| `PI_SUPER_VIM_PANE_COLS` | `60` | width for left/right splits (text columns) |
| `PI_SUPER_VIM_PANE_KEEP` | `1` | `0` = close the pane after `:Pi` and split a new one when pi answers |
| `PI_SUPER_VIM_PANE_WINDOW` | `0` | target for `wt -w`: `0` = most recently used window; a name (e.g. `pivim`) = always that window, creating it if needed |
| `PI_SUPER_VIM_PANE_FOCUS` | `1` | `0` = do not pull focus when vim comes back (no `move-focus`) |
| `PI_SUPER_VIM_WT` | auto-detected | path to `wt.exe` |
| `PI_SUPER_VIM_DEBUG` | `0` | `1` = append to `<control dir>/debug.log` |

Vim-side variables (in your vimrc, or `:let` once pi has opened the tab; they only affect that server):

| Variable | Default | Meaning |
| --- | --- | --- |
| `g:pi_super_vim_startinsert` | `1` | same as `PI_SUPER_VIM_STARTINSERT` |
| `g:pi_super_vim_draft` | `1` | save unsent text when vim is closed |
| `g:pi_super_vim_tabline` | `1` | take over an (empty) `tabline` to show the tab label |
| `g:pi_super_vim_img` | `1` | enable `:Img` and its whole-placeholder delete mappings |
| `g:pi_super_vim_img_max` | `4194304` | max bytes per image for `:Img` |
| `g:pi_super_vim_clip_exe` | auto (`powershell.exe` → `pwsh`) | PowerShell used to read the clipboard |
| `g:pi_super_vim_clip_script` | `pi-clip.ps1` next to the plugin | clipboard script path |

## Troubleshooting

* `/pivim` reports `Windows Terminal did not open a pane`: the single-instance command channel of
  WT is broken — `wt.exe` still exits 0 but the window ignores it (a manual `wt -w 0 split-pane`
  fails the same way). That is WT's own state; restart Windows Terminal. If you cannot restart right
  now, use `/pivim gvim`.
* `/pivim` says `vim is already open in the pane`: the pane is still there (maybe on another tab, or
  squeezed to nothing) and it is not a new split; close that pane (`Ctrl+Shift+W`) or press Enter on
  its prompt, then `/pivim` again.
* `/pivim status`: first check that the gvim / client / plugin paths were found.
* With `PI_SUPER_VIM_DEBUG=1`, look at `%TEMP%\pi-super-vim\debug.log`: every `--serverlist` and
  `--remote-expr` call with its result is in there.
* `E449 invalid expression` usually means a `|` or similar leaked into a `--remote-expr` expression.
  This extension never builds long expressions; it writes the whole vim script to `<sid>.cmd.vim`
  and calls `execute(readfile(...))`, so it cannot hit that.
* `gvim not found`: install the official Vim for Windows, or set `PI_SUPER_VIM_GVIM`.
* The first open takes 0.2–1 s (start gvim, wait for the server to register); afterwards a tab switch
  is about two vim client calls (~0.15 s), which is not noticeable.

## Self-tests

No model, no pi needed:

```powershell
node test/harness.mjs
```

It loads the extension, fakes the pi API and context, opens a tab, types into it with the real vim
plugin and hits `:Pi` / `:w`, then checks the text pi received, the clearing rules, draft protection,
a second session's tab, queueing while busy and closing on exit. It closes the test gvim itself.

Pane mode (runs in its **own** WT window called `pi-super-vim-test`, never in the one pi runs in,
and closes it afterwards):

```powershell
node test/pane.mjs
```

It checks that the pane really splits, that `:Pi` keeps it waiting (launcher loop), that
`/pivim show` and the next settled run put a new vim back into **the same** pane (no new split),
that `:q` lets the pane go and the next run splits a new one; it also runs a real vim to verify the
`.pane.sent` signal written by `:Pi`.

Settings model (tabs / rows / values / number input; no terminal):

```powershell
node test/settings.mjs
```

Pasting images (real gvim, real mappings, real round trip, but `test/fake-clip.ps1` stands in for
the clipboard — your clipboard is never touched):

```powershell
node test/image.mjs
```

It checks that `:Img` inserts the placeholder and writes the file, number reuse/increment, whole-block
deletion with `<BS>` and `<Del>`, that a failing clipboard inserts nothing and reports it, that other
buffers have no `:Img`; and on the pi side: text + images sent in order, files deleted after sending,
missing files sent as text only with a warning.
