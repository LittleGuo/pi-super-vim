# pi-super-vim

用 vim 的 tab 来写 pi 的 prompt。pi 还在原来的终端里跑，输出也在原来的地方；pi 答完一轮之后，
它会在一个常驻的 gvim 里把「当前 session 的输入 tab」准备好，你在 vim 里写完 `:Pi`，这段文字就被
当成你刚刚在 pi 里敲下的输入。

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

## 组成

| 文件 | 作用 |
| --- | --- |
| `pi-super-vim.ts` | pi 扩展：管理 gvim server、按 session 开关 tab、监听请求文件、投递给 pi |
| `vim/pi-super-vim.vim` | vim 这一半：维护 prompt buffer、`:Pi` 等命令、tab 标题、草稿保护 |
| `.pi/extensions/pi-super-vim.ts` | 让 pi 在本项目里自动加载上面的扩展（转发一行） |
| `test/harness.mjs` | 不需要模型的自测脚本（假的 pi API + 真 gvim 往返） |

## 环境要求

* **仅 Windows + gvim**。这个扩展是给「Windows 终端里打中文/长 prompt 难受」写的，Linux/macOS 没实测，也不打算支持。
  非 Windows 上请在 gvim 里自己写，别提 issue。
* 官方 Vim for Windows（`C:\Program Files\Vim\vim92\` 里面同时有 `gvim.exe` 和 `vim.exe`）。
  `gvim.exe` 当 server，`vim.exe` 当无窗口的 client（能拿到 `--remote-expr` 的输出和退出码）。
* Vim 8.1 以上（用到 `bufadd()` / `win_findbuf()` / `tabpagebuflist()`）——9.x 实测没问题
* pi 1.4+

## 安装

本项目里已经放好了 `.pi/extensions/pi-super-vim.ts`，在这个目录下启动 pi 就会加载（项目本地
扩展需要信任该项目）。或者显式加载：

```powershell
pi --extension D:\new-start\pi-super-vim\pi-super-vim.ts
```

想全局使用，装成一个 pi package（仓库根目录的 `package.json` 已经按 pi 的 package 规范写好：
`pi.extensions` 指向 `./pi-super-vim.ts`，`files` 带上 `vim/`）：

```bash
pi install git:github.com/gjm/pi-super-vim            # 现在就能用（GitHub 公开仓库直接装，不用 npm）
pi install npm:pi-super-vim                                          # 发布到 npm 之后
```

`vim/pi-super-vim.vim` 由扩展从包所在目录直接读，不用手动复制。发布只需 `npm login` 后
`npm publish`；`pi-package` keyword 会让它出现在 https://pi.dev/packages 里。

不想走 package 也可以手工丢文件（pi 会加载带 `index.ts` 的子目录）：

```
%USERPROFILE%\.pi\agent\extensions\pi-super-vim\index.ts        <- 由 pi-super-vim.ts 改名/复制
%USERPROFILE%\.pi\agent\extensions\pi-super-vim\vim\pi-super-vim.vim
```

如果你还想在自己手动启动的 vim 里也能用 `:Pi`（而不是只在 pi 打开的 tab 里）：

```
/pivim install      # 复制 vim/pi-super-vim.vim 到 ~/.vim/plugin/
```

## 使用

1. 正常跟 pi 说话。
2. pi 答完，gvim 自动启动（第一次会慢一点）或切到当前 session 的 tab，标题是 `pi:<session id 前 8 位>`，
   光标已经在插入模式，tab 内容已清空。
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

清空规则（按你的要求，但不会吃掉你的草稿）：

* 这一轮结束后打开 tab 时，如果里面是**上次已经发出去的**内容，或者你根本没动过 -> 清空；
* 如果你在 pi 回答期间已经写了下一条、还没发 -> **保留**，绝不覆盖。

pi 里的命令：

| 命令 | 作用 |
| --- | --- |
| `/pivim` | 现在就把 vim tab 打开/切过来（不等一轮结束） |
| `/pivim status` | 打印 gvim / client / 插件 / 控制目录 / session 状态，排查用 |
| `/pivim close` | 关闭当前 session 的 tab |
| `/pivim install` | 把 vim 插件复制到 `~/.vim/plugin/` |

## 细节

* **一个 gvim，多个 tab**：gvim 用固定的 server 名（默认 `PI_SUPER_VIM`）常驻；每个 pi session
  一个 tab（tab 变量 `t:pi_tablabel`、buffer 变量 `b:pi_session`），所以同时开几个 pi 也不会串。
* **buffer 是 scratch buffer**：`buftype=acwrite`、无 swap、无 undofile、markdown 语法/折行，
  名字是 `<控制目录>/<session id>.md`，但不会真的写这个文件。
* **通信目录**：默认 `%TEMP%\pi-super-vim\`（`os.tmpdir()`），里面有
  * `<sid>.req` / `.req.tmp`：vim 写给 pi 的请求（JSON：text / mode / sid / ts），扩展监听目录 + 1s 轮询兜底，
    谁先看到谁处理，文件先删再投递，避免重复发送；
  * `<sid>.cmd.vim`：扩展写给 vim 执行的小脚本；
  * `<sid>.draft`：你还没发出去、又关掉 vim 的草稿，下次打开自动恢复；
  * `debug.log`：只有 `PI_SUPER_VIM_DEBUG=1` 时才写。
* **tab 标题**：插件默认会把 `tabline` 换成自己的实现（显示 `pi:<id>`，有没发出去的字时带 `+`；普通 tab 显示文件名），
  但仅在你的 `tabline` 本来就是空的时才接管，不会覆盖你已有的配置；想彻底关掉设
  `let g:pi_super_vim_tabline = 0`。
* **退出**：pi 退出（或 `/new`、`/resume` 换 session）时会关掉对应 tab；最后一个 tab 关掉时 gvim 顺势退出。
  有未发送文字时保留 tab 并写草稿。`/pivim close` 同理。

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
| `PI_SUPER_VIM_DEBUG` | `0` | `1` = 往 `<控制目录>/debug.log` 写日志 |

vim 侧变量（可放 vimrc，或者等 pi 打开 tab 后 `:let`，只影响这个 server）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `g:pi_super_vim_startinsert` | `1` | 同 `PI_SUPER_VIM_STARTINSERT` |
| `g:pi_super_vim_draft` | `1` | 关掉 vim 时是否保存未发送草稿 |
| `g:pi_super_vim_tabline` | `1` | 是否接管（空的）`tabline` 显示 tab 名 |

## 排查

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
