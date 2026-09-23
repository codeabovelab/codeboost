const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const credential = location.hash.slice(1) || sessionStorage.getItem('codeboost-token') || '';
if (location.hash) { sessionStorage.setItem('codeboost-token', credential); history.replaceState(null, '', location.pathname); }
let data, selected, change = 0, mode = 'question', since = false, busy = false;
const drafts = new Map();
const statusClass = text => text.startsWith('✓') ? 'good' : text.startsWith('✕') ? 'bad' : text.startsWith('!') ? 'warn' : 'neutral';
async function api(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'x-codeboost-token': credential, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed.'); return value;
}
function rememberDraft() { if (selected) drafts.set(`${selected}:${mode}`, $('message').value); }
async function refresh() {
  if (busy) return; busy = true;
  $('banner').textContent = 'Linking changes to plan items…';
  try { rememberDraft(); data = await api('/api/review'); selected ??= data.items[0]?.id || 'Unplanned'; since = data.items.find(item => item.id === selected)?.state === 'stale'; render(); }
  catch (error) { $('banner').textContent = `Could not read this branch’s history. ${error.message} Use Refresh to retry.`; $('code').innerHTML = '<div class="empty"><h2>Review could not load</h2><p>Retry after resolving the error above. Open task shows the last loaded task, if available.</p></div>'; $('approve').hidden = true; }
  finally { busy = false; }
}
async function act(command) {
  if (busy || !data) return false; busy = true;
  try { rememberDraft(); data = await api('/api/action', { ...command, token: data.token }); render(); return true; }
  catch (error) { $('banner').textContent = `${error.message} Refresh to review the latest state.`; return false; }
  finally { busy = false; }
}
function select(id) { rememberDraft(); selected = id; change = 0; since = data.items.find(item => item.id === id)?.state === 'stale'; render(); }
function render() {
  const item = data.items.find(item => item.id === selected);
  if (!item && !['Unplanned', 'Ambiguous', 'Accepted'].includes(selected)) { selected = data.items[0]?.id || 'Unplanned'; return render(); }
  $('repository').textContent = data.repository;
  $('issue').textContent = `#${data.plan.issue} ${data.plan.summary} · r${data.plan.revision}`;
  $('progress').textContent = `${data.approved} of ${data.items.length} approved`;
  $('banner').textContent = data.demo ? 'Demo repository · real Git changes and local SQLite storage. No tests or AI review have been run for this demo.' : '';
  const unplanned = data.segments.filter(s => s.row === 'Unplanned').length, ambiguous = data.segments.filter(s => s.row === 'Ambiguous').length;
  $('attention').innerHTML = `<button data-select="Unplanned">${unplanned} unplanned</button><span> · </span><button data-select="Ambiguous">${ambiguous} ambiguous changes</button>`;
  const symbols = { approved: '✓', stale: '!', unreviewed: '○' };
  $('items').innerHTML = data.items.map(entry => `<button class="plan-row ${entry.id === selected ? 'selected' : ''}" data-select="${esc(entry.id)}" aria-current="${entry.id === selected ? 'true' : 'false'}"><span class="row-title"><span class="${entry.state === 'approved' ? 'good' : entry.state === 'stale' ? 'warn' : 'neutral'}" aria-label="${esc(entry.state)}">${symbols[entry.state]}</span><code>${esc(entry.id)}</code><span>${esc(entry.title)}</span><span class="count">${entry.count}</span></span><span class="row-sub">${Object.entries(entry.checks).map(([name, text]) => `<span class="${statusClass(text)}" title="${esc(name)}: ${esc(text)}" aria-label="${esc(name)}: ${esc(text)}">${esc(text[0])} ${esc({ attributed:'Attr',scope:'Scope',tests:'Tests',ai:'AI' }[name])}</span>`).join('')}</span>${entry.state === 'stale' ? '<span class="warn">Stale</span>' : ''}${data.notes.some(note => note.item === entry.id && note.kind === 'change') ? `<span class="warn"> · ${data.notes.filter(note => note.item === entry.id && note.kind === 'change').length} pending changes</span>` : ''}</button>${entry.id === selected ? `<div class="selected-files">Declared files${entry.files.map(file => `<code>${esc(file.path)}</code>`).join('')}</div>` : ''}`).join('') + ['Ambiguous','Unplanned','Accepted'].map(row => `<button class="plan-row ${row === selected ? 'selected' : ''}" data-select="${row}"><span class="row-title ${row === 'Unplanned' ? 'bad' : row === 'Ambiguous' ? 'warn' : 'muted'}">${row === 'Unplanned' ? '✕' : row === 'Ambiguous' ? '!' : '✓'} ${row}${row === 'Unplanned' ? ' changes' : ''}<span class="count">${data.segments.filter(s => s.row === row).length}</span></span></button>`).join('');
  document.querySelectorAll('[data-select]').forEach(button => button.addEventListener('click', () => select(button.dataset.select)));
  $('item-id').textContent = item?.id || 'REVIEW EXCEPTIONS'; $('item-title').textContent = item?.title || selected;
  $('item-details').innerHTML = item ? `<p>${esc(item.intent)}</p>${item.reasons.map(reason => `<p class="warn">! Stale: ${esc(reason)}</p>`).join('')}` : '';
  $('approve').hidden = !item; $('approve').textContent = item?.count ? `Approve ${item.id}` : 'Confirm no change needed'; $('approve').disabled = item?.state === 'approved';
  $('view-toggle').innerHTML = item?.state === 'stale' ? `<button data-since="true" aria-pressed="${since}">Since approval</button><button data-since="false" aria-pressed="${!since}">Full change</button>` : '';
  document.querySelectorAll('[data-since]').forEach(button => button.addEventListener('click', () => { since = button.dataset.since === 'true'; renderCode(); }));
  $('checks').innerHTML = item ? Object.entries(item.checks).map(([name,text]) => `<button class="${statusClass(text)}" data-check="${name}" aria-label="${esc(name)}: ${esc(text)}">${esc({ attributed:'Attributed', scope:'In scope', tests:'Tests', ai:'AI review' }[name])}: ${esc(text)}</button>`).join('') : '';
  document.querySelectorAll('[data-check]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.check === 'attributed' && item.checks.attributed.startsWith('!')) select('Ambiguous');
    else showDialog(`<h2>${esc(button.textContent)}</h2><pre>${esc(button.dataset.check === 'scope' ? item.outside.join('\n') || 'Every attributed change is inside this item’s declared files.' : button.dataset.check === 'tests' ? item.acceptance.map(check => `${check.type}: ${check.text}`).join('\n') + '\n\nThis screen does not run commands.' : button.dataset.check === 'ai' ? 'No AI review has run. This does not mean the change has no problems.' : 'Attribution comes from the commit ledger, not commit messages.')}</pre>`);
  }));
  $('notes').innerHTML = item ? data.notes.filter(note => note.item === selected).map(note => `<div class="note"><strong>You · ${note.kind === 'change' ? 'Change requested' : 'Question'}</strong><p>${esc(note.text)}</p><small>r${note.revision} · ${esc(new Date(note.createdAt).toLocaleString())}${note.kind === 'change' ? ' · Pending' : ' · Awaiting discussion'}</small></div>`).join('') || '<p class="muted">No conversation yet. Keep questions and requested changes beside the evidence.</p>' : '<p class="muted">Select a plan item to add a question or request a change.</p>';
  $('message').disabled = !item; $('save-note').disabled = !item; $('message').value = drafts.get(`${selected}:${mode}`) || '';
  renderCode();
}
function renderCode() {
  const item = data.items.find(item => item.id === selected), segments = data.segments.filter(s => s.row === selected);
  change = Math.max(0, Math.min(change, segments.length - 1));
  $('change-count').textContent = segments.length ? `Change ${change + 1} of ${segments.length}` : 'No changes';
  $('previous').disabled = !segments.length || change === 0; $('next').disabled = !segments.length || change === segments.length - 1;
  let comparison = '';
  if (since && item?.state === 'stale' && item.before) {
    const prior = item.before.segments.map(s => `${s.path} ${s.operation || ''}\n${s.content}`).join('\n');
    const now = segments.map(s => `${s.path} ${s.operation || ''}\n${s.content}`).join('\n');
    comparison = `<div class="comparison"><section><h2>At approval</h2><pre>${esc(prior || 'No changes')}</pre><details><summary>Approved plan item</summary><pre>${esc(JSON.stringify(item.before.item,null,2))}</pre></details></section><section><h2>Now</h2><pre>${esc(now || 'No changes')}</pre><details><summary>Current plan item</summary><pre>${esc(JSON.stringify(data.plan.items.find(p=>p.id===item.id),null,2))}</pre></details></section></div>`;
  }
  $('code').innerHTML = comparison + (segments.map((segment,index) => {
    const provenance = segment.row === 'Accepted' ? 'Accepted' : segment.row;
    let content;
    if (segment.kind === 'file') {
      const meta = JSON.parse(segment.content);
      const label = meta.oldPath !== meta.newPath && meta.oldPath && meta.newPath ? 'Renamed file' : meta.oldMode === '160000' || meta.newMode === '160000' ? 'Submodule pointer' : meta.oldMode === '120000' || meta.newMode === '120000' ? 'Symbolic link' : meta.oldMode !== meta.newMode && meta.oldMode && meta.newMode ? 'File mode changed' : 'File change';
      content = `<div class="file-card"><div class="provenance ${provenance === 'Unplanned' ? 'unplanned' : ''}">${esc(provenance)}</div><div class="file-values"><strong>▧ ${label}</strong><dl><dt>Path</dt><dd><code>${esc(meta.oldPath || 'Absent')} → ${esc(meta.newPath || 'Absent')}</code></dd><dt>Mode</dt><dd><code>${esc(meta.oldMode || 'Absent')} → ${esc(meta.newMode || 'Absent')}</code></dd></dl><p class="muted">No preview available · size unavailable</p><details><summary>Details · content IDs</summary><pre>${esc(JSON.stringify(meta,null,2))}</pre></details></div></div>`;
    } else {
      const lines = segment.content.split('\n'); if (lines.at(-1) === '') lines.pop();
      const start = segment.operation === '+' ? segment.newLine : segment.oldLine;
      content = `<div class="diff ${segment.operation === '+' ? 'added' : 'removed'}"><div class="provenance ${provenance === 'Unplanned' ? 'unplanned' : ''}">${esc(provenance)}</div><pre class="line-numbers">${lines.map((_,i)=>start===null?'':start+i).join('\n')}</pre><div class="sign">${esc(segment.operation)}</div><pre>${esc(segment.content)}</pre></div>`;
    }
    const choices = ['Unplanned','Ambiguous'].includes(segment.row) ? `<div class="choice-controls"><p>Assigning this change makes the selected item’s approval stale.</p><select aria-label="Assign change ${index+1} to" data-target="${index}"><option value="">Assign to…</option>${data.items.map(p=>`<option value="${esc(p.id)}">${esc(p.id)} · ${esc(p.title)}</option>`).join('')}</select><button data-assign="${index}">Assign</button><button data-accept="${index}">Accept as is</button></div>` : '';
    return `<article class="change ${index === change ? 'active' : ''}" data-change="${index}" aria-label="Change ${index+1}, ${esc(segment.path)}, ${esc(provenance)}"><div class="file-heading"><code>${esc(segment.path)}</code><span class="${segment.scope === 'out-of-scope' ? 'bad' : 'muted'}">${segment.scope === 'out-of-scope' ? '✕ Out of scope' : esc(segment.scope)}</span></div>${content}<div class="change-meta">${esc(segment.context || 'File-level change')}${segment.sharesHunkWith.length ? ` · Shares a hunk with ${esc(segment.sharesHunkWith.join(', '))}` : ''}</div>${choices}</article>`;
  }).join('') || '<div class="empty"><h2>No changes in this row</h2><p>There are no current segments here. An item with no changes requires explicit confirmation before approval.</p></div>');
  document.querySelectorAll('[data-assign]').forEach(button => button.addEventListener('click', () => { const index = Number(button.dataset.assign); const item = document.querySelector(`[data-target="${index}"]`).value; if (item) act({ action:'assign', key:segments[index].key, item }); }));
  document.querySelectorAll('[data-accept]').forEach(button => button.addEventListener('click', () => act({ action:'accept', key:segments[Number(button.dataset.accept)].key })));
  document.querySelectorAll('[data-since]').forEach(button => button.setAttribute('aria-pressed', String((button.dataset.since === 'true') === since)));
}
function moveChange(delta) { change += delta; renderCode(); document.querySelector(`[data-change="${change}"]`)?.scrollIntoView({ block:'nearest' }); }
function setMode(value) { rememberDraft(); mode = value; $('ask').setAttribute('aria-pressed',String(mode==='question')); $('request').setAttribute('aria-pressed',String(mode==='change')); $('composer-label').textContent = mode==='change'?'Change to request':'Question about this item'; $('save-note').textContent = mode==='change'?'Save change request':'Save question'; $('message').value = drafts.get(`${selected}:${mode}`)||''; }
function showDialog(html) { $('dialog-body').innerHTML = html; $('dialog').showModal(); }
$('approve').onclick = () => { const item=data.items.find(item=>item.id===selected); if(item) act({ action:'approve',item:selected,confirmNoChange:item.count===0 }); };
$('reload').onclick=refresh; $('review-link').onclick=event=>{event.preventDefault();refresh();};
$('next').onclick=()=>moveChange(1); $('previous').onclick=()=>moveChange(-1);
$('ask').onclick=()=>setMode('question'); $('request').onclick=()=>setMode('change');
$('composer').onsubmit=async event=>{event.preventDefault();const item=selected,kind=mode; if(await act({action:'note',item,kind,text:$('message').value})){drafts.delete(`${item}:${kind}`);$('message').value='';$('saved').textContent=kind==='change'?'Saved for the next revision.':'Question saved. No agent has been invoked.';}};
$('conversation-toggle').onclick=()=>{document.body.classList.toggle('conversation-open');document.body.classList.remove('conversation-closed');};
$('collapse-conversation').onclick=()=>{document.body.classList.remove('conversation-open');document.body.classList.add('conversation-closed');};
$('collapse-plan').onclick=()=>{document.querySelector('.plan-pane').hidden=true;$('show-plan').hidden=false;};$('show-plan').onclick=()=>{document.querySelector('.plan-pane').hidden=false;$('show-plan').hidden=true;};
$('help').onclick=()=>showDialog('<h2>Keyboard shortcuts</h2><p>j / k — next / previous change</p><p>n / p — next / previous item</p><p>a — approve item</p><p>r — request change</p><p>? — shortcuts</p><p>Esc — leave a text field or close this dialog</p>');
$('close-dialog').onclick=()=>$('dialog').close();
$('task').onclick=()=>showDialog(data?`<h2>Task #${data.plan.issue}</h2><p>${esc(data.plan.summary)}</p><p>Revision ${data.plan.revision} · ${data.demo?'Demo repository':'Local repository'}</p><pre>Base: ${esc(data.snapshot.base)}\nHead: ${esc(data.snapshot.head)}</pre><p>Source files are read-only in this review app. Approvals and discussion are saved locally.</p>`:'<h2>No task loaded</h2><p>Check the CLI configuration and retry.</p>');
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&['TEXTAREA','INPUT','SELECT'].includes(document.activeElement?.tagName)){document.activeElement.blur();return;}if(event.ctrlKey||event.metaKey||event.altKey||$('dialog').open||['TEXTAREA','INPUT','SELECT','BUTTON'].includes(document.activeElement?.tagName)||!data)return;if(!['j','k','n','p','a','r','?'].includes(event.key))return;event.preventDefault();if(event.key==='j')moveChange(1);if(event.key==='k')moveChange(-1);if(['n','p'].includes(event.key)){const ids=data.items.map(p=>p.id);select(ids[Math.max(0,Math.min(ids.length-1,ids.indexOf(selected)+(event.key==='n'?1:-1)))]);}if(event.key==='a')$('approve').click();if(event.key==='r'){document.body.classList.add('conversation-open');document.body.classList.remove('conversation-closed');setMode('change');$('message').focus();}if(event.key==='?')$('help').click();});
await refresh();
