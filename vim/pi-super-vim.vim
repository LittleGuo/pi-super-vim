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

" Buffer content without the trailing empty lines, as one string.
function! s:Text() abort
  let l:lines = getline(1, '$')
  while len(l:lines) > 1 && l:lines[-1] =~# '^\s*$'
    call remove(l:lines, -1)
  endwhile
  return join(l:lines, "\n")
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
      continue
    endif
    try
      call writefile(getbufline(l:info.bufnr, 1, '$'), l:dir . '/' . l:sid . '.draft')
    catch
    endtry
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
  setlocal statusline=%#WarningMsg#\ pi\ %#Normal#%{get(b:,'pi_session','')}\ \ \ :Pi\ send\ \ \ :PiClear\ \ \ :PiClose
  let b:pi_session = a:sid
  let b:pi_ctrl_dir = fnamemodify(a:file, ':h')
  let b:pi_ready = 1
  " Buffer local commands: only prompt buffers get them.
  command! -buffer -nargs=0 Pi      call s:Submit('auto')
  command! -buffer -nargs=0 PiSteer call s:Submit('steer')
  command! -buffer -nargs=0 PiQueue call s:Submit('followUp')
  command! -buffer -nargs=0 PiClear call s:Clear()
  command! -buffer -nargs=0 PiClose call PiSuperVimClose(get(b:, 'pi_session', ''))
  augroup pi_super_vim_buffer
    autocmd! * <buffer>
    autocmd BufWriteCmd <buffer> call s:Submit('auto')
  augroup END
endfunction

" Open (or focus) the prompt tab of one pi session.  Returns the tab number.
function! PiSuperVimOpen(file, sid, ...) abort
  let l:clear = a:0 ? a:1 : 1
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
  call s:Configure(l:path, l:sid)
  let t:pi_tablabel = 'pi:' . s:ShortId(l:sid)

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
  if &modified
    call s:SaveDraft()
    echomsg 'pi: tab kept, it has text that was not sent'
    return 0
  endif
  silent! tabclose
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
endfunction

" Tab line --------------------------------------------------------------
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
