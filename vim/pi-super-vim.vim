" pi-super-vim.vim -- the vim half of pi-super-vim
"
" pi runs in its own terminal.  When pi is done answering, it asks an already
" running gvim (vim server) to show a tab for the session.  You write the next
" prompt there and hit :Pi -- the buffer is written to a request file that pi
" watches, and pi receives it as if you had typed it in the pi terminal.
"
" This file is sourced by the pi extension, but it can also be copied to
" ~/.vim/plugin/pi-super-vim.vim so :Pi works in a vim you started yourself.

if exists('g:loaded_pi_super_vim')
  finish
endif
let g:loaded_pi_super_vim = 1

let s:cpo_save = &cpo
set cpo&vim

" Options ---------------------------------------------------------------
if !exists('g:pi_super_vim_startinsert')
  let g:pi_super_vim_startinsert = 1
endif
if !exists('g:pi_super_vim_tabline')
  let g:pi_super_vim_tabline = 1
endif
if !exists('g:pi_super_vim_draft')
  let g:pi_super_vim_draft = 1
endif
if !exists('g:pi_super_vim_img')
  let g:pi_super_vim_img = 1
endif
if !exists('g:pi_super_vim_img_max')
  let g:pi_super_vim_img_max = 4194304
endif

" Absolute directory of this file, so pi-clip.ps1 is found next to it even
" when :pivim install copied the pair to ~/.vim/plugin.
let s:here = expand('<sfile>:p:h')

" Helpers ---------------------------------------------------------------
function! s:SamePath(a, b) abort
  let l:a = simplify(fnamemodify(a:a, ':p'))
  let l:b = simplify(fnamemodify(a:b, ':p'))
  return has('win32') ? (l:a ==? l:b) : (l:a ==# l:b)
endfunction

function! s:FindBuf(file) abort
  for l:info in getbufinfo()
    if l:info.name !=# '' && s:SamePath(l:info.name, a:file)
      return l:info.bufnr
    endif
  endfor
  return -1
endfunction

function! s:FindBufBySession(sid) abort
  for l:info in getbufinfo()
    if getbufvar(l:info.bufnr, 'pi_session', '') ==# a:sid
      return l:info.bufnr
    endif
  endfor
  return -1
endfunction

function! s:CtrlDir() abort
  return get(b:, 'pi_ctrl_dir', expand('%:p:h'))
endfunction

function! s:CtrlPath(ext) abort
  let l:sid = get(b:, 'pi_session', '')
  if l:sid ==# ''
    let l:sid = expand('%:t:r')
  endif
  return s:CtrlDir() . '/' . l:sid . '.' . a:ext
endfunction

function! s:ShortId(sid) abort
  return strpart(a:sid, 0, 8)
endfunction

" Tab label: the session name when it has one, the short id otherwise.
function! s:TabLabel(sid, name) abort
  return 'pi:' . (a:name ==# '' ? s:ShortId(a:sid) : a:name)
endfunction

" Buffer content without the trailing empty lines, as one string.
function! s:Text() abort
  let l:lines = getline(1, '$')
  while len(l:lines) > 1 && l:lines[-1] =~# '^\s*$'
    call remove(l:lines, -1)
  endwhile
  return join(l:lines, "\n")
endfunction

" Clipboard images ------------------------------------------------------
" :Img, only in pi prompt buffers, see s:Configure().

" The placeholder the extension picks out of the submitted text
" (pi-super-vim.ts, IMAGE_PLACEHOLDER) has to stay identical.
let s:img_pat = '\[#img\d\+\]'

function! s:ClipExe() abort
  if get(g:, 'pi_super_vim_clip_exe', '') !=# ''
    return g:pi_super_vim_clip_exe
  endif
  " Windows PowerShell starts about twice as fast as pwsh; both need -Sta,
  " otherwise [Clipboard]::GetImage() throws.
  return executable('powershell.exe') ? 'powershell.exe' : 'pwsh'
endfunction

function! s:ClipScript() abort
  return get(g:, 'pi_super_vim_clip_script', '') !=# ''
        \ ? g:pi_super_vim_clip_script
        \ : s:here . '/pi-clip.ps1'
endfunction

" [start, end) byte range of the placeholder covering byte {idx} of {line}, or
" an empty list.  matchend() takes the same optional start index as match().
function! s:ImageAt(line, idx) abort
  let l:from = 0
  while 1
    let l:start = match(a:line, s:img_pat, l:from)
    if l:start < 0
      return []
    endif
    let l:end = matchend(a:line, s:img_pat, l:start)
    if a:idx >= l:start && a:idx < l:end
      return [l:start, l:end]
    endif
    let l:from = l:end
  endwhile
endfunction

" One past the highest placeholder in the buffer: a second :Img must not reuse a
" number and overwrite that image's file.  Matches anywhere in the line, because
" :Img inserts right where the cursor is - usually glued to the text
" ("见图[#img1]，"), not as a whitespace-separated word.
function! s:NextImageId() abort
  let l:max = 0
  for l:line in getline(1, '$')
    let l:from = 0
    while 1
      let l:start = match(l:line, s:img_pat, l:from)
      if l:start < 0
        break
      endif
      let l:max = max([l:max, str2nr(matchstr(l:line, '\d\+', l:start))])
      let l:from = l:start + 1
    endwhile
  endfor
  return l:max + 1
endfunction

function! s:SizeLabel(bytes) abort
  if a:bytes >= 1048576
    return printf('%.1f MB', a:bytes / 1048576.0)
  endif
  if a:bytes >= 1024
    return printf('%d KB', (a:bytes + 512) / 1024)
  endif
  return a:bytes . ' bytes'
endfunction

" Put the clipboard image into the buffer as [#imgN].  The bytes are written
" to <ctrl>/<sid>.imgN.<ext> by pi-clip.ps1; this buffer only ever holds the
" short placeholder, never base64.
"
" job_start() and not system(): system() opens a console window for a moment
" on MS-Windows, job_start() does not.  The wait keeps :Img synchronous, so the
" placeholder lands at the cursor without async callback bookkeeping.
function! s:Img() abort
  if !get(b:, 'pi_ready', 0)
    echohl ErrorMsg | echomsg 'pi: this buffer is not a pi prompt' | echohl None
    return
  endif
  let l:id = s:NextImageId()
  let l:base = s:CtrlPath('img' . l:id)
  let l:res = l:base . '.res'
  call delete(l:res)
  let l:cmd = [s:ClipExe(), '-NoProfile', '-NonInteractive', '-Sta',
        \ '-ExecutionPolicy', 'Bypass', '-File', s:ClipScript(),
        \ '-Out', l:base, '-MaxBytes', string(g:pi_super_vim_img_max)]
  try
    let l:job = job_start(l:cmd, {'in_io': 'null', 'err_io': 'null'})
  catch
    echohl ErrorMsg | echomsg 'pi: cannot start the clipboard helper: ' . v:exception | echohl None
    return
  endtry
  let l:spins = 0
  while job_status(l:job) ==# 'run' && l:spins < 500
    sleep 10m
    let l:spins += 1
  endwhile
  if job_status(l:job) ==# 'run'
    call job_stop(l:job)
    echohl WarningMsg | echomsg 'pi: the clipboard helper did not answer' | echohl None
    return
  endif
  if job_status(l:job) ==# 'fail'
    echohl ErrorMsg | echomsg 'pi: cannot run ' . l:cmd[0] . ' (set g:pi_super_vim_clip_exe)' | echohl None
    return
  endif
  if !filereadable(l:res)
    echohl WarningMsg | echomsg 'pi: the clipboard helper wrote no result' | echohl None
    return
  endif
  let l:lines = readfile(l:res)
  call delete(l:res)
  let l:answer = empty(l:lines) ? '' : l:lines[0]
  if l:answer =~# '^ERROR: '
    echohl WarningMsg | echomsg 'pi: ' . substitute(l:answer, '^ERROR: ', '', '') | echohl None
    return
  endif
  if !filereadable(l:answer)
    echohl WarningMsg | echomsg 'pi: the image file is gone: ' . l:answer | echohl None
    return
  endif
  " Put the placeholder at the cursor.  :Img runs either from insert mode
  " (<C-o>:Img) or from the command line after Esc, and mode() reports 'n' in
  " both - only mode(1) shows the pending insert ('niI').  With an insert
  " pending, feedkeys() lands on the insertion point by itself; feeding the same
  " keys after Esc would run them as normal-mode commands (one backspace per
  " character, '#' = search backwards) and insert nothing.
  let l:text = '[#img' . l:id . ']'
  if mode(1) =~# 'I'
    silent! call feedkeys(l:text, 'n')
  else
    " After Esc the cursor sits on the character that was typed last, so the
    " image goes right after it (like 'a'); 'i' would split the last word.
    " :normal! instead of byte arithmetic in setline(): a multi-byte character
    " must not be cut in half.
    let l:hit = s:ImageAt(getline('.'), col('.') - 1)
    " Cursor inside an existing placeholder: step behind it (and behind any
    " placeholder sitting right next to it) so [#imgN] is never split.  On the
    " closing bracket nothing has to move - 'a' inserts behind the whole match.
    while !empty(l:hit) && col('.') - 1 < l:hit[1] - 1
      if l:hit[1] >= len(getline('.'))
        call cursor(line('.'), len(getline('.')))
        break
      endif
      call cursor(line('.'), l:hit[1] + 1)
      let l:hit = s:ImageAt(getline('.'), col('.') - 1)
    endwhile
    silent! execute 'normal! a' . l:text
  endif
  echomsg printf('pi: attached [#img%d] (%s)', l:id, s:SizeLabel(getfsize(l:answer)))
  " shortcut: deleting the placeholder by hand leaves the file behind in the
  " control dir.  It is a few hundred KB in %TEMP% and Windows cleans that up;
  " add a sweep at :Img time when it starts to matter.
endfunction

" Backspace removes a whole [#imgN] and leaves text next to it alone.  The
" count comes from the placeholder itself, not from a word motion, so the
" result does not depend on what surrounds it.
function! s:Backspace() abort
  " In insert mode the cursor is on the character after the insertion point,
  " one past the last character at the end of the line, so col('.') - 1 is the
  " length of the text before it in both cases.
  let l:before = strpart(getline('.'), 0, col('.') - 1)
  let l:m = matchlist(l:before, s:img_pat . '$')
  if empty(l:m)
    return "\<BS>"
  endif
  return repeat("\<BS>", len(l:m[0]))
endfunction

" The same forwards, for <Del> in insert mode: deleting inside a placeholder
" must not leave a broken [#img fragment behind.
function! s:DeleteChar() abort
  let l:after = strpart(getline('.'), col('.') - 1)
  let l:m = matchlist(l:after, '^' . s:img_pat)
  if empty(l:m)
    return "\<Del>"
  endif
  return repeat("\<Del>", len(l:m[0]))
endfunction

" Keeps 'modified' honest while the buffer is edited by hand: the buffer is
" acwrite, so deleting all text leaves it "modified" and :q / :PiClose would
" refuse to close an empty buffer forever.  Only clears it when there is
" nothing to lose - typing again sets 'modified' again on its own.
function! s:SyncModified() abort
  if &modified && s:Text() =~# '^\s*$'
    silent! setlocal nomodified
    silent! call delete(s:CtrlPath('draft'))
  endif
endfunction

function! s:Clear() abort
  if line('$') == 1 && getline(1) ==# ''
    return
  endif
  " %delete _ keeps the text in the undo history, so `u` brings it back.
  silent! undojoin
  silent! %delete _
  silent! setlocal nomodified
endfunction

function! s:SaveDraft() abort
  if !g:pi_super_vim_draft
    return
  endif
  if !&modified
    call delete(s:CtrlPath('draft'))
    return
  endif
  try
    call writefile(split(s:Text(), "\n", 1), s:CtrlPath('draft'))
  catch
  endtry
endfunction

function! s:RestoreDraft() abort
  if !g:pi_super_vim_draft
    return 0
  endif
  let l:file = s:CtrlPath('draft')
  if !filereadable(l:file)
    return 0
  endif
  try
    let l:lines = readfile(l:file)
  catch
    return 0
  endtry
  if empty(l:lines)
    return 0
  endif
  call setline(1, l:lines)
  silent! setlocal nomodified
  return 1
endfunction

function! s:SaveAllDrafts() abort
  if !g:pi_super_vim_draft
    return
  endif
  for l:info in getbufinfo()
    let l:sid = getbufvar(l:info.bufnr, 'pi_session', '')
    let l:dir = getbufvar(l:info.bufnr, 'pi_ctrl_dir', '')
    if l:sid ==# '' || l:dir ==# ''
      continue
    endif
    if !getbufvar(l:info.bufnr, '&modified')
      call delete(l:dir . '/' . l:sid . '.draft')
      " Pane mode liveness marker: gone once this vim is gone.
      call delete(l:dir . '/' . l:sid . '.pane')
      continue
    endif
    try
      call writefile(getbufline(l:info.bufnr, 1, '$'), l:dir . '/' . l:sid . '.draft')
    catch
    endtry
    call delete(l:dir . '/' . l:sid . '.pane')
  endfor
endfunction

" Configure the current buffer as a pi prompt buffer.
function! s:Configure(file, sid) abort
  silent! setlocal filetype=markdown
  setlocal buftype=acwrite
  setlocal noswapfile noundofile nobackup nowritebackup
  setlocal buflisted
  setlocal nolist wrap linebreak
  setlocal textwidth=0
  setlocal statusline=%#WarningMsg#\ pi\ %#Normal#%{get(b:,'pi_label',\ get(b:,'pi_session',''))}\ \ \ :Img\ \ \ :Pi\ send\ \ \ :PiClear\ \ \ :PiClose
  " Window title: the tab label, not the control file name.
  let &titlestring = '%{get(b:, ''pi_label'', expand(''%:t''))} - %{v:servername}'
  " gvim on Windows draws GUI tab pages (guioptions has 'e'): those use
  " 'guitablabel' and ignore 'tabline'.  Set both so either kind of vim agrees.
  let &guitablabel = ' %{get(b:, ''pi_label'', expand(''%:t''))}%{get(b:, ''&modified'', 0) ? '' +'' : ''''} '
  let b:pi_session = a:sid
  let b:pi_ctrl_dir = fnamemodify(a:file, ':h')
  let b:pi_ready = 1
  " Buffer local commands: only prompt buffers get them.
  command! -buffer -nargs=0 Pi      call s:Submit('auto')
  command! -buffer -nargs=0 PiSteer call s:Submit('steer')
  command! -buffer -nargs=0 PiQueue call s:Submit('followUp')
  command! -buffer -nargs=0 PiClear call s:Clear()
  command! -buffer -nargs=0 PiClose call PiSuperVimClose(get(b:, 'pi_session', ''))
  " Clipboard images: the command and the mapping exist only in this buffer,
  " so a plain vim (:pivim install copies this file to ~/.vim/plugin) is not
  " affected.
  if g:pi_super_vim_img
    command! -buffer -nargs=0 Img call s:Img()
    " gvim's Backspace key is <BS>, a terminal sends <C-H> or <C-?> (0x7f): all
    " three must be mapped or the placeholder is deleted character by character.
    " <Del> is a different key and deletes forwards.
    inoremap <buffer> <expr> <BS> <SID>Backspace()
    inoremap <buffer> <expr> <C-H> <SID>Backspace()
    inoremap <buffer> <expr> <C-?> <SID>Backspace()
    inoremap <buffer> <expr> <Del> <SID>DeleteChar()
  endif
  " Pane mode: pi has no vim server to talk to, so the vim half is its own
  " process and writes its pid here; the extension reopens a pane when it is gone.
  call writefile([string(getpid()), string(&lines), string(&columns)], s:CtrlPath('pane'))
  augroup pi_super_vim_buffer
    autocmd! * <buffer>
    autocmd BufWriteCmd <buffer> call s:Submit('auto')
    " TextChanged for interactive editing (also keeps the tab's '+' honest),
    " QuitPre for :q - vim checks 'modified' right after it, and an emptied
    " buffer must not make :q ask for '!' forever.
    autocmd TextChanged,TextChangedI <buffer> call s:SyncModified()
    autocmd QuitPre <buffer> call s:SyncModified()
  augroup END
endfunction

" Open (or focus) the prompt tab of one pi session.  Returns the tab number.
" Optional args: 1 = clear the buffer, 2 = session name for the tab label.
function! PiSuperVimOpen(file, sid, ...) abort
  let l:clear = a:0 >= 1 ? a:1 : 1
  let l:name = a:0 >= 2 ? a:2 : ''
  let l:path = fnamemodify(a:file, ':p')
  let l:buf = s:FindBuf(l:path)
  if l:buf == -1
    if exists('*bufadd')
      let l:buf = bufadd(l:path)
      call bufload(l:buf)
    else
      execute 'badd ' . fnameescape(l:path)
      let l:buf = s:FindBuf(l:path)
    endif
  endif
  if l:buf == -1
    throw 'pi-super-vim: cannot create buffer ' . l:path
  endif

  " :buffer refuses to leave a modified buffer when 'hidden' is off.
  let l:saved_hidden = &hidden
  set hidden
  try
    let l:wins = win_findbuf(l:buf)
    if empty(l:wins)
      tabnew
      execute 'buffer ' . l:buf
    else
      call win_gotoid(l:wins[0])
    endif
  finally
    let &hidden = l:saved_hidden
  endtry

  let l:sid = a:sid ==# '' ? get(b:, 'pi_session', '') : a:sid
  let l:label = s:TabLabel(l:sid, l:name)
  let b:pi_label = l:label
  call s:Configure(l:path, l:sid)
  let t:pi_tablabel = l:label

  if l:clear
    " Clear the tab unless you already started typing a new prompt.
    if get(b:, 'pi_submitted', 0) || !&modified
      call s:Clear()
    endif
    let b:pi_submitted = 0
    if line('$') == 1 && getline(1) ==# ''
      call s:RestoreDraft()
    endif
  endif

  if g:pi_super_vim_startinsert && mode() !=# 'i'
    " :startinsert does not survive a remote request, feeding the key does.
    silent! call feedkeys('i', 'n')
  endif
  return tabpagenr()
endfunction

" Relabel the tab of one session without touching focus or buffer contents.
function! PiSuperVimRelabel(sid, name) abort
  let l:buf = s:FindBufBySession(a:sid)
  if l:buf == -1
    return 0
  endif
  let l:wins = win_findbuf(l:buf)
  if empty(l:wins)
    return 0
  endif
  let l:tab = win_id2tabwin(l:wins[0])[0]
  let l:label = s:TabLabel(a:sid, a:name)
  call settabvar(l:tab, 'pi_tablabel', l:label)
  call setbufvar(l:buf, 'pi_label', l:label)
  " 'redrawtabline' is a command in modern Vim; older ones need a full redraw.
  if exists(':redrawtabline')
    redrawtabline
  else
    redraw!
  endif
  return 1
endfunction

" Close the prompt tab of one session (kept when it has unsent text).
function! PiSuperVimClose(sid) abort
  let l:buf = s:FindBufBySession(a:sid)
  if l:buf == -1
    return 0
  endif
  let l:wins = win_findbuf(l:buf)
  if empty(l:wins)
    execute 'bwipeout ' . l:buf
    return 1
  endif
  call win_gotoid(l:wins[0])
  " Not 'modified': emptying the buffer by hand leaves it set (see
  " s:SyncModified) and an empty buffer has nothing worth keeping.
  if &modified && s:Text() !~# '^\s*$'
    call s:SaveDraft()
    echomsg 'pi: tab kept, it has text that was not sent'
    return 0
  endif
  silent! setlocal nomodified
  " :tabclose refuses the last tab page (E784) - in the pane's one-shot vim that
  " is always the case, there closing the tab means quitting.  qall without !
  " so a modified buffer somewhere else is not thrown away silently.
  if tabpagenr('$') == 1 && winnr('$') == 1
    silent! qall
  else
    silent! tabclose
  endif
  return 1
endfunction

" Submit the buffer to pi.
function! s:Submit(mode) abort
  if !get(b:, 'pi_ready', 0)
    echohl ErrorMsg | echomsg 'pi: not a pi prompt buffer' | echohl None
    return
  endif
  let l:text = s:Text()
  if l:text =~# '^\s*$'
    echohl WarningMsg | echomsg 'pi: buffer is empty, nothing sent' | echohl None
    return
  endif
  let l:req = {
        \ 'sid': get(b:, 'pi_session', ''),
        \ 'text': l:text,
        \ 'mode': a:mode,
        \ 'ts': localtime(),
        \ }
  let l:path = s:CtrlPath('req')
  let l:tmp = l:path . '.tmp'
  try
    call writefile([json_encode(l:req)], l:tmp)
    if filereadable(l:path)
      call delete(l:path)
    endif
    if rename(l:tmp, l:path) != 0
      throw 'rename() failed'
    endif
  catch
    echohl ErrorMsg | echomsg 'pi: cannot write request: ' . v:exception | echohl None
    return
  endtry
  let b:pi_submitted = 1
  silent! setlocal nomodified
  call delete(s:CtrlPath('draft'))
  echomsg 'pi: sent ' . len(split(l:text, "\n", 1)) . ' line(s), waiting for pi'
  " Pane mode: the launcher loop reads pane.sent (= the text went to pi) and
  " keeps the pane waiting for the next run; without it vim was closed by :q and
  " the pane goes away with it.
  if get(g:, 'pi_super_vim_quit_after_send', 0)
    call writefile([string(localtime())], s:CtrlPath('pane.sent'))
    qall!
  endif
endfunction

" Tab line --------------------------------------------------------------
" Only terminal vim uses this: gvim has GUI tab pages (see 'guitablabel').
function! PiSuperVimTabline() abort
  let l:out = ''
  for l:i in range(1, tabpagenr('$'))
    let l:pi_label = gettabvar(l:i, 'pi_tablabel', '')
    let l:label = l:pi_label
    if l:label ==# ''
      let l:buf = winbufnr(tabpagebuflist(l:i)[0])
      let l:label = fnamemodify(bufname(l:buf), ':t')
      if l:label ==# ''
        let l:label = '[No Name]'
      endif
    else
      " show unsent text in pi tabs
      try
        if gettabwinvar(l:i, 1, '&modified')
          let l:label .= ' +'
        endif
      catch
      endtry
    endif
    let l:out .= '%' . l:i . 'T'
    let l:out .= l:i == tabpagenr() ? '%#TabLineSel#' : '%#TabLine#'
    let l:out .= ' ' . l:i . ' ' . substitute(l:label, '%', '%%', 'g') . ' '
  endfor
  return l:out . '%#TabLineFill#%T'
endfunction

if g:pi_super_vim_tabline && &tabline ==# ''
  set tabline=%!PiSuperVimTabline()
endif

augroup pi_super_vim
  autocmd!
  autocmd VimLeavePre * call s:SaveAllDrafts()
augroup END

let &cpo = s:cpo_save
unlet s:cpo_save
