# pi-super-vim

[English](README.md) | **中文**

用 vim 来写 pi 的 prompt，**顺手把剪贴板里的截图贴进去**（`:Img`）。pi 还在原来的终端里跑，
输出也在原来的地方；pi 答完一轮之后，它把「当前 session 的输入处」准备好（WT 里 split 一个 pane，
或者常驻 gvim 的一个 tab），你在 vim 里写完 `:Pi`，这段文字（和贴进去的图）就被当成你刚刚在
pi 里敲下的输入。

两种形态：**WT 分屏**（默认，在 pi 所在的 Windows Terminal 里 split 一个 20 行的 pane，留着不关，
每次回复后在里面换一个一次性 vim；`:q` 才关 pane）和 gvim 窗口（一个常驻 gvim + 每个 session 一个 tab）。
`/pivim keep off` 恢复成「发完即关、回复后重开」。

```
 ┌───────────────┐   ① 一轮结束(agent_settled)      ┌──────────────────────────┐
 │  pi  (终端)   │ ──── gvim --remote-expr ───────► │  gvim  (常驻, 一个 server)│
 │               │      session id 找到/新建 tab    │   tab: pi:01a19799       │
 │               │      tab 内容清空                │   (buffer: <sid>.md)     │
 │               │                                  │                          │
 │               │   ② 你在 vim 里写 prompt,        │   :Pi  :PiSteer  :PiQueue│
 │               │      :Pi  /  :w  ────────────►  │   :w 也等于发送          │
 │               │      (写请求文件)                 └──────────────────────────┘
 │  pi 把文字当作 │ ◄── ③ 扩展监听请求文件, pi.sendUserMessage()
 └───────────────┘
```

为什么不真的往终端里「敲键」：那需要 Windows 的 SendKeys / 剪贴板注入，焦点、编码、粘贴模式、
长文本都会出问题。这里扩展直接调用 pi 自己的 `pi.sendUserMessage()`，效果和你在 pi 里输入回车
完全一样（TUI 里会出现一条 user 消息，然后正常开始下一轮），但可靠得多。

## 能干什么

全在 vim 里，手不用离开键盘：

| 命令 | 作用 |
| --- | --- |
| `:Pi` / `:w` | 把这段 prompt 发给 pi（pi 正忙就自动排队） |
| `:PiSteer` | 插话，打断当前这一轮 |
| `:Img` | **把剪贴板里的截图贴成一个 `[#imgN]`**，`:Pi` 时作为真正的图片和文本一起发给模型 |
| `:PiClear` / `:PiClose` | 清空 / 关掉当前 tab（没发的字会留成草稿） |

最常用的一条大概是贴图：

```
Esc
:Img                     " 剪贴板里的截图 -> 这张图说了什么[#img1]
:Img                     " 再贴一张 -> ...什么[#img1],[#img2]
:Pi                      " 两张图 + 这段文字一起发出去
```

只要剪贴板里是**位图**（Win+Shift+S 截图、浏览器「复制图片」）、**资源管理器复制的图片文件**，
或者**一段图片路径文本**，`:Img` 都认。图片字节不进 vim 缓冲区，只落一个短占位符；
`<BS>` 一次删掉整个占位符；发出去之后文件自动清理。详见下面[「贴图（`:Img`）」](#贴图img)。

写长 prompt、粘中文、贴截图报错、一次说清几件事 —— 这就是这个插件存在的理由。

## 组成

| 文件 | 作用 |
| --- | --- |
| `pi-super-vim.ts` | pi 扩展：管理 gvim server / WT pane、按 session 开关 tab、监听请求文件、投递给 pi |
| `settings.ts` | `/pivim setting` 设置界面（数据 + 界面，中英双语） |
| `vim/pi-super-vim.vim` | vim 这一半：维护 prompt buffer、`:Pi` 等命令、`:Img` 贴图、tab 标题、草稿保护 |
| `vim/pi-clip.ps1` | 读 Windows 剪贴板（截图 / 复制的图片文件 / 图片路径），落盘成 `imgN.<ext>`，供 `:Img` 调用 |
| `.pi/extensions/pi-super-vim.ts` | 让 pi 在本项目里自动加载上面的扩展（转发一行） |
| `test/harness.mjs` | gvim 模式自测（假的 pi API + 真 gvim 往返） |
| `test/pane.mjs` | WT 分屏自测（假的 pi API + 真 pane + 真 vim） |
| `test/settings.mjs` | `/pivim setting` 的数据层自测（tab/行/值/输入校验） |
| `test/image.mjs` | `:Img` 自测（真 gvim + 假剪贴板 + 假 pi），不碰你真实剪贴板 |

## 环境要求

* **仅 Windows**。这个扩展是给「Windows 终端里打中文/长 prompt 难受」写的，Linux/macOS 没实测，也不打算支持。
  非 Windows 上请在 gvim 里自己写，别提 issue。
* **Vim for Windows**：装 `C:\Program Files\Vim\vim92\`（里面同时有 `gvim.exe` 和 `vim.exe`）
  * WT 分屏（**默认**）：只要 console 的 `vim.exe`，另外需要 Windows Terminal 自带的 `wt.exe`
    （Win11 自带，不用额外装）。没有 WT 就 `/pivim gvim` 或设 `PI_SUPER_VIM_TARGET=gvim`
  * gvim 窗口：`gvim.exe` 当 server，`vim.exe` 当无窗口的 client（能拿到 `--remote-expr` 的输出和退出码）
* Vim 8.1 以上（用到 `bufadd()` / `win_findbuf()` / `tabpagebuflist()` / `job_start()`）——9.x 实测没问题
* pi 1.4+
* 贴图（`:Img`）额外需要 Windows PowerShell：优先用 `powershell.exe`（系统自带，启动更快），退到 `pwsh`。
  不用装任何东西，也不用管理员权限。

## 安装

先装 Vim（`winget install vim.vim`，或官网安装包），再装扩展。**推荐 git**（能锁 tag）：

```bash
# 锁版本（推荐，行为不会突然变）
pi install git:github.com/LittleGuo/pi-super-vim@v0.3.0

# 跟最新
pi install git:github.com/LittleGuo/pi-super-vim@main
```

以后更新：`pi update git:github.com/LittleGuo/pi-super-vim`（拉到新 tag/main 才会变，不推就不动）。

npm 上也有一份，版本和仓库的 `v*` tag 对齐（推 tag 时由 GitHub Actions 用 Trusted Publishing 自动发）：

```bash
pi install npm:pi-super-vim@0.3.0    # 锁版本
pi install npm:pi-super-vim          # 跟 latest
```

内容一模一样，区别只是 `pi install` 从哪拉。npm 版更新用 `pi update --extensions`。

> 维护者发版：改 `package.json` 版本 → 提交推 main → `git tag vX.Y.Z && git push origin vX.Y.Z`，
> `.github/workflows/publish.yml` 会跑 `npm publish`（OIDC，不用 npm token；版本号不能重复）。

`vim/pi-super-vim.vim` 由扩展从包所在目录直接读，不用手动复制。

本仓库里还有 `.pi/extensions/pi-super-vim.ts`（一行转发），所以在**这个目录**启动 pi 会自动加载
（项目本地扩展需要信任该项目）。注意：如果你已经全局安装过这个包，在这里启动 pi 会加载到两份，
扩展自己会去重（第二次加载直接跳过），不会出现两个 gvim —— **但生效的是全局包那份**。
所以在仓库里改了代码想立刻验证，要么 `pi -ne -e ./pi-super-vim.ts`（只加载这一份），
要么先 `pi remove git:github.com/LittleGuo/pi-super-vim@main`；正式发布还是推 main 后 `pi update`。

也可以显式加载单个文件：

```powershell
pi --extension D:\new-start\PI-EXTENSIONS\pi-super-vim\pi-super-vim.ts
```

不想走 package 也可以手工丢文件（pi 会加载带 `index.ts` 的子目录）：

```
%USERPROFILE%\.pi\agent\extensions\pi-super-vim\index.ts        <- 由 pi-super-vim.ts 改名/复制
%USERPROFILE%\.pi\agent\extensions\pi-super-vim\vim\pi-super-vim.vim
```

如果你还想在自己手动启动的 vim 里也能用 `:Pi`（而不只是 pi 开的 tab/pane 里）：

```
/pivim install      # 复制 vim/pi-super-vim.vim 和 pi-clip.ps1 到 ~/.vim/plugin/
```

## 使用

两种形态，`/pivim pane` 和 `/pivim gvim` 互切，默认是 **WT 分屏**（见下面「分屏模式」）：

* **WT 分屏**（默认）：在 pi 所在的 Windows Terminal 里 split 一个 pane（上下，20 行）
* **gvim 窗口**：一个常驻 gvim，每个 session 一个 tab，一轮结束把 tab 切到前台并清空

下面以 gvim 窗口为例（pane 模式的差异见「分屏模式」）：

1. 正常跟 pi 说话。
2. pi 答完，gvim 自动启动（第一次会慢一点）或切到当前 session 的 tab，标题是 `pi:<session 名称>`
   （没名字时退回 `pi:<id 前 8 位>`），光标已经在插入模式，tab 内容已清空。
3. 写你的下一段 prompt。
4. `Esc` 然后：

| vim 命令 | 作用 |
| --- | --- |
| `:Pi` | 发送（pi 空闲就立刻开始；pi 正忙就排队，等同 followUp） |
| `:PiQueue` | 显式排队，等当前这一轮结束后再处理 |
| `:PiSteer` | 插话 / 打断当前这一轮（steer） |
| `:w` | 和 `:Pi` 一样，等于「提交」（不会写磁盘） |
| `:PiClear` | 清空 buffer（`u` 可以撤销回来） |
| `:PiClose` | 关掉这个 tab（里面有没发的字时会保留） |
| `:Img` | 把剪贴板里的图片贴成一个 `[#imgN]`，随 `:Pi` 一起发给 pi（见下面「贴图」） |

清空规则（按你的要求，但不会吃掉你的草稿）：

* 这一轮结束后打开 tab 时，如果里面是**上次已经发出去的**内容，或者你根本没动过 -> 清空；
* 如果你在 pi 回答期间已经写了下一条、还没发 -> **保留**，绝不覆盖。

pi 里的命令：

| 命令 | 作用 |
| --- | --- |
| `/pivim setting` | 打开设置界面（见下面「设置界面」） |
| `/pivim` / `/pivim show` | 没有 vim 就拉起来（pane 模式：没有 pane 就 split，pane 在等就叫出 vim）；已经开着就什么都不做 |
| `/pivim pane` / `/pivim gvim` | 切换形态，会被记住 |
| `/pivim split up` / `down` / `left` / `right` | vim 在 pi 的哪边（默认 down；`h`/`v` 是旧名字，等同 down/right） |
| `/pivim keep on` / `keep off` | `:Pi` 发出后 pane 是否留着等 pi（默认 on；off = 发完即关、回复后重开） |
| `/pivim lines N` / `cols N` | 分屏大小：文字行数（默认 20）/ 文字列数（默认 60） |
| `/pivim status` | 打印 target / 分屏设置 / gvim / client / 插件 / 控制目录 / session，排查用 |
| `/pivim close` | 关闭当前 session 的 tab（pane 模式发个退出信号：等着的 pane 直接关，正在写的有草稿就等它自己关） |
| `/pivim install` | 把 vim 插件和贴图脚本复制到 `~/.vim/plugin/` |

`/pivim` 的「什么都不做」是字面意思：pane 里 vim 已经开着、或 gvim 已经有这个 session 的 tab，就不切 tab、不改 buffer（不会把正在写的字清掉）；只有没开时才建。

## 设置界面（`/pivim setting`）

比记命令直观（默认英文，在「语言」里切成 `zh` 就整个界面变中文）：

```
Super Vim 设置
[常规]  pane  gvim
Tab/Shift+Tab/←/→：切页 · ↑/↓：移动 · Enter/Space：更改 · Esc/q：关闭
  ──模式──
→ 模式                                   pane
  ──界面──
  语言                                   zh
```

| tab | 行 | 值 |
| --- | --- | --- |
| 常规 | 模式 | `pane` / `gvim` |
| 常规 | 语言 | `en` / `zh`（默认 `en`；目前只影响设置界面本身） |
| pane | 分屏 | 上 / 下 / 左 / 右 |
| pane | 分屏行数 | 数字（Enter 进入输入，输完 Enter 确认、Esc 取消） |
| pane | 分屏常驻 | 是 / 否（= `keep`） |
| gvim | — | 暂时没有要配的 |

改动**立即生效**并写进 `prefs`（重启 pi 也记得）；切到 `gvim` 时会把正在等的 pane 收掉。
`prompt` 模式下没有界面，用 `/pivim ...` 命令代替。

## 细节

* **一个 gvim，多个 tab**：gvim 用固定的 server 名（默认 `PI_SUPER_VIM`）常驻；每个 pi session
  一个 tab（tab 变量 `t:pi_tablabel`、buffer 变量 `b:pi_session`），所以同时开几个 pi 也不会串。
  tab 标签是 `pi:<session 名称>`，session 没名字时退回 `pi:<id 前 8 位>`；改名后标签就地更新，不抢焦点。
* **buffer 是 scratch buffer**：`buftype=acwrite`、无 swap、无 undofile、markdown 语法/折行，
  名字是 `<控制目录>/<session id>.md`，但不会真的写这个文件。
* **通信目录**：默认 `%TEMP%\pi-super-vim\`（`os.tmpdir()`），里面有
  * `<sid>.req` / `.req.tmp`：vim 写给 pi 的请求（JSON：text / mode / sid / ts），扩展监听目录 + 1s 轮询兜底，
    谁先看到谁处理，文件先删再投递，避免重复发送；
  * `<sid>.cmd.vim`：扩展写给 vim 执行的小脚本；
  * `<sid>.draft`：你还没发出去、又关掉 vim 的草稿，下次打开自动恢复；
  * `<sid>.pane.*`（pane 模式）：`.pane` 是这个 vim 的 pid，`.pane.vim` / `.pane.cmd` 是脚本和循环
    launcher，`.pane.loop` 是等待心跳（每秒重写），`.pane.open` / `.pane.sent` / `.pane.quit`
    是“叫 vim 回来 / 已经发出去 / 可以走了”三个信号，谁用谁删；
  * `<sid>.imgN.<ext>` / `<sid>.imgN.res`：`:Img` 抓到的图片和它的结果行（`.res` 读完就删），
    发送成功后图片文件也删；
  * `debug.log`：只有 `PI_SUPER_VIM_DEBUG=1` 时才写。
* **tab 标题**：插件默认会把 `tabline` 换成自己的实现（显示 `pi:<id>`，有没发出去的字时带 `+`；普通 tab 显示文件名），
  但仅在你的 `tabline` 本来就是空的时才接管，不会覆盖你已有的配置；想彻底关掉设
  `let g:pi_super_vim_tabline = 0`。
* **退出**：pi 退出（或 `/new`、`/resume` 换 session）时会关掉对应 tab；最后一个 tab 关掉时 gvim 顺势退出。
  pane 模式会写 `<sid>.pane.quit`：屏幕在等 pi 的 pane 立刻关；正在写 vim 的则等你关掉 vim。
  只在**确实有没发出去的文字**时才拦你：把内容删干净之后 `:q` / `:PiClose` 直接关，
  不会再要你敲 `:q!`；有文字时保留 tab 并写草稿。`/pivim close` 同理。

## 贴图（`:Img`）

在 pi 的 vim 里按 `Esc` 后 `:Img`，或者插入模式里 `<C-o>:Img<CR>`：把剪贴板里的图片贴成一个
短占位符 `[#img1]`，光标位置就是它插入的位置（`Esc` 之后那条路径是插在光标字符**之后**，
因为 Esc 会把光标退到刚打完的那个字上，图跟着它走才落在行尾）。

```
看看这个报错 [#img1] 和正常时的 [#img2] 有什么不一样
```

`:Pi` 时扩展按文本里 `[#imgN]` 出现的顺序读出图片文件，作为 image content 和文本一起交给模型
（`pi.sendUserMessage([{type:"text"},{type:"image"}])`）。文本里的 `[#imgN]` 保留，模型能对上号。

**剪贴板里能是什么**（按优先级试，都在 `vim/pi-clip.ps1` 里）：

| 剪贴板内容 | 典型操作 | 结果 |
| --- | --- | --- |
| 位图 | Win+Shift+S 截图、浏览器「复制图片」 | 转成 PNG 落盘 |
| 文件（资源管理器复制） | 选中 `a.png` 按 Ctrl+C | 拷原文件字节 |
| 文本路径 | 从别处复制了一个 `C:\...\a.png` | 认带引号 / `file://` / `~` / 相对路径，校验后读 |
| 什么都没有 | — | 命令行提示 `pi: 剪贴板里没有图片…`，不插入占位符 |

**几条行为约定**：

* **vim 里永远不出现 base64**。图片字节由 `:Img` 写进 `<控制目录>/<sid>.imgN.<ext>`，
  buffer 里只有 8~10 个字符的占位符；大截图不会拖慢撤销、不会撑爆寄存器。
* **格式看魔数，不看扩展名**：只接受 PNG / JPEG / GIF / WebP，其余在 `:Img` 当场就报错。
* **单张上限 4MB**（`g:pi_super_vim_img_max`）。超了当场拒绝，不会等到提交才失败。
  故意不做压缩/缩放：真被 provider 拒了再加，`System.Drawing` 重采样要几百毫秒，不值。
* **发送成功后文件才删**。删占位符 = 那张图不发；文件丢了（比如草稿恢复后文件已清）会在 pi 里
  提示 `[#imgN] has no image file` 并只发文本，不会发一张空图。
* **编号 = buffer 里现有最大号 + 1**。所以删掉 `[#img5]` 再贴会复用 `[#img5]`，不会撞号。
* **删除是整块的**：`<BS>` / `<C-H>` / `<C-?>`（终端不同发的键不一样，三个都映射了）一次删掉整个
  `[#imgN]`，`<Del>` 从前面删也是整块。旁边的文字不受影响。
* **只在 pi 的 prompt buffer 里生效**：`:Img` 和上面几个映射都是 `-buffer` / `<buffer>` 的。
  `:pivim install` 把插件装到 `~/.vim/plugin/` 之后，你在别的 vim 里（哪怕开着 markdown 文件）
  也不会有 `:Img`，退格也不会变。整个功能想关掉：`let g:pi_super_vim_img = 0`。
* **已知取舍**：手工删掉占位符、那张图的文件就留在 `%TEMP%` 里了（几百 KB，系统会清）。
  真觉得占地方再加清理。

## 分屏模式（Windows Terminal pane）

这是**默认模式**：vim 直接在 pi 所在的 Windows Terminal 里分屏，不再开独立窗口。
（`/pivim gvim` 换回独立 gvim 窗口，设置会被记住。）

```
/pivim setting     # 打开设置界面（推荐）
/pivim show        # 现在就把 vim 叫出来（gvim 切 tab；pane 模式把正在等的那块叫回来）
/pivim pane        # 换成 WT 分屏（默认）
/pivim gvim        # 换回独立 gvim 窗口
/pivim keep on     # 发完 :Pi 后 pane 留着等 pi（默认）
/pivim keep off    # 发完 :Pi 后 pane 直接关，pi 回复后重新 split
/pivim split down  # vim 在 pi 下面（默认）；up / left / right 同理
/pivim lines 20    # 上下分屏时 vim 占多少文字行
/pivim cols 60     # 左右分屏时 vim 占多少文字列
/pivim status       # 看当前 target / 方向 / 大小
```

`上` / `左` 是先按 `-H`/`-V` 分屏、再用 `wt swap-pane up|left` 把两块对调，视觉上是 vim 在上面/左边。

这些设置写在 `<控制目录>/prefs` 里，重启 pi 也记得。

**工作方式**（和 gvim 模式的一个关键区别）：

* 一轮结束后开一个 pane，里面是**一次性的 vim**（不是 server，没法远程调用它）；
* 你 `:Pi` / `:w` 发出去，vim 照旧 `qall!` 退出；pane 默认**留着**（launcher 是个循环，
  这时候先清屏、只显示一行 `waiting for pi...`，不会每轮堆一行）。`/pivim keep off` 就恢复成以前那样：pane 跟着关，
  下一轮再 split 一个新的；
* pi 回答完，扩展写 `<sid>.pane.open`，launcher 看到就在**同一个 pane** 里起一个新的 vim ——
  buffer 在内存里，旧 vim 一退就没了，所以**不需要清屏**，新 vim 天生是空的；
  期间你打的草稿照旧从 `<sid>.draft` 恢复，不会被吃掉；
* 没发就 `:q`：launcher 退出，pane 跟着关（keep on 时只有发出去才留着等）；
* 判断“pane 还在不在”用的是心跳：launcher 每秒重写一次 `<sid>.pane.loop`，
  文件没了或超过 3 秒没更新（pane 被点 X）就当作不在，重新 split；
* 焦点：新 split 的 pane 由 WT 自动给焦点；**已经存在的 pane** 用
  `wt -w 0 move-focus down|right` 把焦点从 pi 那半边拽过来，`PI_SUPER_VIM_PANE_FOCUS=0` 关掉。

**已知限制**：`move-focus` 只作用于“当前 tab / 最近使用的 WT 窗口”，所以
（a）你切到别的 tab 时它会在那个 tab 里挪一下焦点（单 pane 的 tab 是空操作）；
（b）多 pane 布局 + 焦点不在 pi 那半边时可能挪错地方；（c）pi 被强杀时 launcher
不会收到 `.pane.quit`，pane 会停在 waiting，点 X 关掉即可。

行数/列数的换算是 `行数 / pi 终端行数` 得出 `wt --size` 的比例，WT 会按像素取整，所以实际可能差 1~2 行。
也可以用环境变量 `PI_SUPER_VIM_PANE_SPLIT=h|v`、`PI_SUPER_VIM_PANE_LINES`、`PI_SUPER_VIM_PANE_COLS`
作为初始值（`/pivim` 里设的值优先，且会被记住）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_SUPER_VIM_SERVER` | `PI_SUPER_VIM` | gvim server 名 |
| `PI_SUPER_VIM_DIR` | `%TEMP%\pi-super-vim` | 请求/草稿/命令文件目录 |
| `PI_SUPER_VIM_GVIM` | 自动查找 | `gvim.exe` 路径 |
| `PI_SUPER_VIM_CLIENT` | 自动查找 | console `vim.exe` 路径（拿输出用） |
| `PI_SUPER_VIM_PLUGIN` | 本目录 `vim/pi-super-vim.vim` | vim 插件路径 |
| `PI_SUPER_VIM_AUTO` | `1` | `0` = 一轮结束后不自动弹 vim，只用 `/pivim` |
| `PI_SUPER_VIM_STARTINSERT` | `1` | 打开 tab 时是否直接进插入模式 |
| `PI_SUPER_VIM_CLOSE` | `1` | pi 退出时是否关闭 tab |
| `PI_SUPER_VIM_TARGET` | `pane` | `gvim` = 用独立 gvim 窗口（也可用 `/pivim gvim`） |
| `PI_SUPER_VIM_PANE_SPLIT` | `h` | 分屏方向：`h` 上下，`v` 左右 |
| `PI_SUPER_VIM_PANE_LINES` | `20` | 上下分屏时的高度（文字行数） |
| `PI_SUPER_VIM_PANE_COLS` | `60` | 左右分屏时的宽度（文字列数） |
| `PI_SUPER_VIM_PANE_KEEP` | `1` | `0` = `:Pi` 发完就关 pane（回复后重新 split），不留着等 |
| `PI_SUPER_VIM_PANE_WINDOW` | `0` | `wt -w` 的目标：`0` = 最近使用的 WT 窗口；给个名字（如 `pivim`）= 固定用那个窗口，没有就新建 |
| `PI_SUPER_VIM_PANE_FOCUS` | `1` | `0` = pane 里的 vim 回来时不抢焦点（不动 `move-focus`） |
| `PI_SUPER_VIM_WT` | 自动查找 | `wt.exe` 路径 |
| `PI_SUPER_VIM_DEBUG` | `0` | `1` = 往 `<控制目录>/debug.log` 写日志 |

vim 侧变量（可放 vimrc，或者等 pi 打开 tab 后 `:let`，只影响这个 server）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `g:pi_super_vim_startinsert` | `1` | 同 `PI_SUPER_VIM_STARTINSERT` |
| `g:pi_super_vim_draft` | `1` | 关掉 vim 时是否保存未发送草稿 |
| `g:pi_super_vim_tabline` | `1` | 是否接管（空的）`tabline` 显示 tab 名 |
| `g:pi_super_vim_img` | `1` | 是否启用 `:Img` 和它的两个整块删除映射 |
| `g:pi_super_vim_img_max` | `4194304` | `:Img` 单张图片字节上限 |
| `g:pi_super_vim_clip_exe` | 自动（`powershell.exe` → `pwsh`） | 读剪贴板用的 PowerShell |
| `g:pi_super_vim_clip_script` | 插件旁边的 `pi-clip.ps1` | 读剪贴板的脚本路径 |

## 排查

* `/pivim` 报 `Windows Terminal did not open a pane`：WT 的单实例命令通道坏了——`wt.exe` 退出码还是 0，
  但窗口不理它（手动 `wt -w 0 split-pane` 也一样）。这是 WT 自己的状态，重启 Windows Terminal 就好；
  不想重启就先用 `/pivim gvim`。
* `/pivim` 说 `vim is already open in the pane`：那块 pane 还在（可能在别的 tab 或被挤成一条），
  不是新 split；关掉那个 pane（`Ctrl+Shift+W`）或按它的提示回车，再 `/pivim`。
* `/pivim status`：先看 gvim / client / 插件路径是否都找到了。
* `PI_SUPER_VIM_DEBUG=1` 后看 `%TEMP%\pi-super-vim\debug.log`：每次 `--serverlist`、
  `--remote-expr` 的内容和结果都在里面。
* 报 `E449 收到无效的表达式` 一般是 `--remote-expr` 的表达式里混进了 `|` 之类的东西。
  本扩展不自己拼长表达式，而是把整段 vim 脚本写到 `<sid>.cmd.vim` 再
  `execute(readfile(...))`，所以不会踩这个坑。
* 报 `gvim not found`：装官方 Vim for Windows，或者设 `PI_SUPER_VIM_GVIM`。
* 第一次打开要 0.2~1s（启动 gvim + 等 server 注册），之后每次切 tab 大约 2 次 vim client 调用（~0.15s），
  对交互没有影响。

## 自测

不需要模型、不需要 pi：

```powershell
node test/harness.mjs
```

它会：加载扩展 -> 造假 pi API / 假 ctx -> 开 tab -> 用真的 vim 插件写内容并 `:Pi` / `:w` ->
检查 pi 收到的文本、清空规则、草稿保护、第二个 session 的 tab、忙时排队、退出时关 tab。
跑完自己 `qa!` 关掉测试用的 gvim。

分屏模式的自测（会在**自己的**那个名为 `pi-super-vim-test` 的 WT 窗口里跑，不碰你 pi 所在的窗口，跑完自己关掉）：

```powershell
node test/pane.mjs
```

它会检查：pane 真的 split 出来了、`:Pi` 之后 pane 留着在等（launcher 循环）、`/pivim show`
和下一轮结算都把新 vim 放回**同一个** pane（不重新 split）、`:q` 之后 pane 关掉、再下一轮重新 split；
顺带跑一个真 vim 验证 `:Pi` 写出的 `.pane.sent` 信号。

设置界面的自测（只测数据层：tab/行/值/输入校验，不用终端）：

```powershell
node test/settings.mjs
```

贴图的自测（真 gvim、真映射、真往返，但剪贴板用 `test/fake-clip.ps1` 顶替，不碰你的剪贴板）：

```powershell
node test/image.mjs
```

它会检查：`:Img` 插入占位符、文件落盘、编号复用/递增、`<BS>` 和 `<Del>` 整块删除、
剪贴板失败时不插入并报错、别的 buffer 里没有 `:Img`；以及 pi 侧：文本 + 图片按顺序发送、
发完删文件、文件丢了只发文本并 warn。
