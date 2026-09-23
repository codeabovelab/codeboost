import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDemo } from '../../scripts/demo.ts';
import { startServer } from '../../web/server.ts';
let root: string, app: Awaited<ReturnType<typeof startServer>>;
test.beforeEach(async () => { root=mkdtempSync(join(tmpdir(),'codeboost-browser-'));app=await startServer(createDemo(join(root,'demo')),0); });
test.afterEach(async () => { await app.close();rmSync(root,{recursive:true,force:true}); });
test('reviews real changes, persists approval and conversation, and assigns foreign code',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.url);await expect(page.getByRole('heading',{name:'Bound exponential retries'})).toBeVisible();
  await expect(page.getByText('0 of 3 approved')).toBeVisible();await expect(page.getByText('– No tests defined',{exact:false}).first()).toBeVisible();
  await page.getByRole('button',{name:'Approve P1',exact:true}).click();await expect(page.getByText('1 of 3 approved')).toBeVisible();
  await page.getByRole('button',{name:'Request change',exact:true}).click();await page.getByLabel('Change to request').fill('Add a test for the upper bound.');await page.getByRole('button',{name:'Save change request'}).click();await expect(page.getByText('Add a test for the upper bound.',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByText('1 of 3 approved')).toBeVisible();await expect(page.getByText('Add a test for the upper bound.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/Unplanned changes/}).click();await page.getByLabel('Assign change 1 to').selectOption('P1');await page.getByRole('button',{name:'Assign',exact:true}).first().click();
  await page.getByRole('button',{name:/P1 Bound exponential retries/}).click();await expect(page.getByText('! Stale:',{exact:false})).toBeVisible();await expect(page.getByRole('heading',{name:'At approval'})).toBeVisible();
  await page.screenshot({path:'test-results/review-desktop.png',fullPage:true});expect(errors).toEqual([]);
});
test('shows file metadata and no-change confirmation, supports narrow desktop and keyboard',async({page})=>{
  await page.goto(app.url);await page.getByRole('button',{name:/P2 Document retry behavior/}).click();await expect(page.getByText('File mode changed',{exact:false})).toBeVisible();await expect(page.getByText('✕ Out of scope',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/P3 Confirm API compatibility/}).click();await page.getByRole('button',{name:'Confirm no change needed',exact:true}).click();await expect(page.getByText('1 of 3 approved')).toBeVisible();
  await page.setViewportSize({width:1280,height:900});await expect(page.getByRole('complementary',{name:'Conversation',exact:true})).not.toBeVisible();await page.getByRole('button',{name:'Conversation',exact:true}).click();await expect(page.getByRole('complementary',{name:'Conversation',exact:true})).toBeVisible();
  await page.getByLabel('Question about this item').fill('npa');await expect(page.getByRole('heading',{name:'Confirm API compatibility'})).toBeVisible();
  await page.keyboard.press('Escape');await page.keyboard.press('p');await expect(page.getByRole('heading',{name:'Document retry behavior'})).toBeVisible();
  await page.setViewportSize({width:1000,height:800});await expect(page.getByRole('heading',{name:'A little more room to review'})).toBeVisible();
});
test('refresh makes changed code stale and stale browser actions cannot approve it',async({page,context})=>{
  await page.goto(app.url);await page.getByRole('button',{name:'Approve P1',exact:true}).click();await expect(page.getByText('1 of 3 approved')).toBeVisible();
  const other=await context.newPage();await other.goto(app.url);await expect(other.getByText('1 of 3 approved')).toBeVisible();
  const repository=app.service.config.repository;writeFileSync(join(repository,'retry.ts'),'export function delay(attempt: number) {\n  return 42;\n}\n');execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-am','External change'],{cwd:repository,stdio:'pipe'});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.getByText('! Stale:',{exact:false}).first()).toBeVisible();
  await other.getByRole('button',{name:/P3 Confirm API compatibility/}).click();await other.getByRole('button',{name:'Confirm no change needed',exact:true}).click();await expect(other.getByRole('status').filter({hasText:'Stale review state'})).toBeVisible();
});
test('requires private credentials and rejects foreign origins',async({request})=>{
  const base=app.url.split('#')[0]!;
  expect((await request.get(base+'api/review')).status()).toBe(403);
  expect((await request.get(base+'api/review',{headers:{'x-codeboost-token':app.token,origin:'https://example.invalid'}})).status()).toBe(403);
  expect((await request.get(base+'api/review',{headers:{'x-codeboost-token':app.token}})).status()).toBe(200);
});
test('shows an honest history error and keeps markup in notes as text',async({page})=>{
 await page.goto(app.url);await page.getByLabel('Question about this item').fill('<img src=x onerror=alert(1)>');await page.getByRole('button',{name:'Ask agent'}).click();await expect(page.getByText('<img src=x onerror=alert(1)>',{exact:true})).toBeVisible();await expect(page.locator('#notes img')).toHaveCount(0);
 const repository=app.service.config.repository;execFileSync('git',['checkout','--orphan','unrelated'],{cwd:repository,stdio:'pipe'});execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-m','Unrelated history'],{cwd:repository,stdio:'pipe'});
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.getByText('Could not read this branch’s history.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Approve P1',exact:true})).not.toBeVisible();
});
test('can assign a large foreign change without sending its content back in the command',async({request})=>{
 const repository=app.service.config.repository;writeFileSync(join(repository,'debug.log'),'x'.repeat(20000)+'\n');execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-am','Large foreign change'],{cwd:repository,stdio:'pipe'});
 const base=app.url.split('#')[0]!,headers={'x-codeboost-token':app.token};const view=await(await request.get(base+'api/review',{headers})).json();const segment=view.segments.find((s:{content:string;row:string})=>s.row==='Unplanned'&&s.content.length>19000);
 const response=await request.post(base+'api/action',{headers:{...headers,'Content-Type':'application/json'},data:{action:'assign',item:'P1',key:segment.key,token:view.token}});
 expect(response.status()).toBe(200);
});
test('shows bounded raster previews and byte sizes for file-change cards',async({page})=>{
 const repository=app.service.config.repository;writeFileSync(join(repository,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRHsAAAAASUVORK5CYII=','base64'));execFileSync('git',['add','pixel.png'],{cwd:repository});execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-m','Add image'],{cwd:repository,stdio:'pipe'});
 await page.goto(app.url);await page.getByRole('button',{name:/Unplanned changes/}).click();await expect(page.getByRole('img',{name:'Current image in pixel.png'})).toBeVisible();await expect(page.getByRole('img',{name:'Current image in pixel.png'})).toHaveJSProperty('naturalWidth',1);await expect(page.getByText('Size: N/A → 68 bytes',{exact:true})).toBeVisible();
});
test('rejects malformed non-ASCII credentials consistently',async({request})=>{
 const response=await request.get(app.url.split('#')[0]+'api/review',{headers:{'x-codeboost-token':'é'.repeat(64)}});expect(response.status()).toBe(403);
});
test('keeps stale item controls unavailable after a failed refresh',async({page})=>{
 await page.goto(app.url);const repository=app.service.config.repository;execFileSync('git',['checkout','--orphan','unrelated'],{cwd:repository,stdio:'pipe'});execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-m','Other history'],{cwd:repository,stdio:'pipe'});
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.getByText('Could not read this branch’s history.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:/P3 Confirm API compatibility/})).toHaveCount(0);
});
test('accepts a foreign segment and keeps that choice across reload',async({page})=>{
 await page.goto(app.url);await page.getByRole('button',{name:/Unplanned changes/}).click();await page.getByRole('button',{name:'Accept as is',exact:true}).first().click();await page.getByRole('button',{name:/Accepted 1/}).click();await expect(page.getByRole('article').first()).toBeVisible();await expect(page.getByText('Accepted outside plan',{exact:true})).toBeVisible();await page.reload();await page.getByRole('button',{name:/Accepted 1/}).click();await expect(page.getByRole('article').first()).toBeVisible();
});
test('shows the whole-plan empty state without claiming checks passed',async({page})=>{
 const {repository,identity}=app.service.config;const base=app.service.store.getSnapshot(identity).base;execFileSync('git',['reset','--hard',base],{cwd:repository,stdio:'pipe'});
 await page.goto(app.url);await expect(page.getByRole('heading',{name:'No code changes yet'})).toBeVisible();await expect(page.getByRole('button',{name:'Confirm no change needed',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'AI review: – Not run',exact:true})).toBeVisible();
});
test('routes mixed owned and ambiguous items to attribution resolution',async({page})=>{
 const {repository,identity}=app.service.config;writeFileSync(join(repository,'retry.ts'),'export function delay(attempt: number) {\n  return Math.min(10000, 200 * 2 ** attempt);\n}\n');execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-am','P2 changes retry'],{cwd:repository,stdio:'pipe'});
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),snapshot=app.service.store.getSnapshot(identity);app.service.store.recordHistory(identity,{revision:1,snapshotId:snapshot.id},snapshot.base,head,[{sha:head,owner:'P2',origin:'owned',sourceSha:null}]);
 await page.goto(app.url);await page.getByRole('button',{name:/P2 Document retry behavior/}).click();await page.getByRole('button',{name:'Resolve ambiguous changes',exact:true}).click();await expect(page.getByRole('heading',{name:'Ambiguous',exact:true})).toBeVisible();
});
test('keeps review shortcuts active while a toolbar button has focus',async({page})=>{
 await page.goto(app.url);await expect(page.getByRole('heading',{name:'Bound exponential retries'})).toBeVisible();await page.getByRole('button',{name:'Refresh',exact:true}).focus();await page.keyboard.press('n');await expect(page.getByRole('heading',{name:'Document retry behavior'})).toBeVisible();
});
test('attaches clicked lines to a question, persists and navigates the reference, and shows archived evidence',async({page})=>{
 await page.goto(app.url);
 const line=page.locator('.added [data-line]').first();await line.click();
 await page.getByRole('button',{name:'Ask about selection',exact:true}).click();
 await expect(page.locator('#attachment')).toContainText('retry.ts');
 await page.getByLabel('Question about this item').fill('Why this exact line?');await page.getByRole('button',{name:'Ask agent',exact:true}).click();
 await page.reload();await page.locator('.note-reference').click();await expect(page.locator('.selected-line').first()).toBeVisible();
 execFileSync('git',['-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','another revision'],{cwd:app.service.config.repository,stdio:'pipe'});
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.locator('.note-reference')).toContainText('Outdated');await page.locator('.note-reference').click();await expect(page.getByRole('heading',{name:'! Outdated code reference'})).toBeVisible();await expect(page.locator('#dialog-body pre')).toContainText('Math.min');
});
test('supports shift ranges, highlighted lines, and independent snippet drafts',async({page})=>{
 const repository=app.service.config.repository;
 writeFileSync(join(repository,'retry.ts'),'export const cap = 5000;\nexport const base = 100;\nexport const delay = (n: number) => Math.min(cap, base * 2 ** n);\n');
 execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-am','rewrite retry'],{cwd:repository,stdio:'pipe'});
 let view=app.service.load();
 for(const key of view.segments.filter(s=>s.path==='retry.ts'&&['Unplanned','Ambiguous'].includes(s.row)).map(s=>s.key)) view=app.service.act({action:'assign',key,item:'P1',token:view.token});
 await page.goto(app.url);
 const block=page.locator('.added[data-segment]').filter({hasText:'export const cap'});
 await block.locator('[data-line]').nth(0).click();await block.locator('[data-line]').nth(2).click({modifiers:['Shift']});
 await expect(page.locator('#selection-label')).toContainText('L1–3');
 await page.getByRole('button',{name:'Request change to selection',exact:true}).click();await expect(page.locator('#attachment pre')).toContainText('export const delay');
 await page.getByLabel('Change to request').fill('Please explain these constants.');
 await page.getByRole('button',{name:'Ask',exact:true}).click();await expect(page.locator('#attachment')).toBeHidden();
 await block.locator('.code-lines').evaluate(element=>{const lines=element.querySelectorAll('[data-code-line]');const range=document.createRange();range.setStart(lines[0]!.firstChild!,0);range.setEnd(lines[1]!.firstChild!,6);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);element.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
 await expect(page.locator('#selection-label')).toContainText('L1–2');await page.getByRole('button',{name:'Ask about selection',exact:true}).click();await expect(page.locator('#attachment pre')).not.toContainText('export const delay');
 await page.getByRole('button',{name:'Remove snippet',exact:true}).click();await expect(page.locator('#attachment')).toBeHidden();
 await page.getByRole('button',{name:'Request change',exact:true}).click();await expect(page.locator('#attachment pre')).toContainText('export const delay');
 await page.getByRole('button',{name:'Save change request',exact:true}).click();await expect(page.locator('.note-reference')).toContainText('L1–3');
});
test('configures the question agent in Settings and displays persisted asynchronous answers',async({page})=>{
 const config=app.service.config;await app.close();let providerAtCall:string|null=null;
 app=await startServer(config,0,async prompt=>{providerAtCall=app.service.store.questionProvider();expect(prompt).toContain('Why this cap?');await new Promise(resolve=>setTimeout(resolve,300));return 'The cap prevents unbounded retry delays.';});
 await page.goto(app.url);await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByLabel('Question agent',{exact:true}).selectOption('codex');await page.getByRole('button',{name:'Save settings',exact:true}).click();await expect(page.getByText('Settings saved.',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.getByLabel('Question about this item').fill('Why this cap?');await page.getByRole('button',{name:'Ask agent',exact:true}).click();await expect(page.getByText('Agent · Answering…',{exact:true})).toBeVisible();
 await page.getByLabel('Question about this item').fill('My next draft');await expect(page.getByText('The cap prevents unbounded retry delays.',{exact:true})).toBeVisible({timeout:10000});await expect(page.getByLabel('Question about this item')).toHaveValue('My next draft');expect(providerAtCall).toBe('codex');
 await page.reload();await expect(page.getByText('The cap prevents unbounded retry delays.',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.getByLabel('Question agent',{exact:true})).toHaveValue('codex');
});
test('shows agent errors and retries the saved question',async({page})=>{
 const config=app.service.config;await app.close();let attempts=0;app=await startServer(config,0,async()=>{if(++attempts===1)throw new Error('Test login failure');return 'Answer after retry';});
 await page.goto(app.url);await page.getByLabel('Question about this item').fill('Explain this');await page.getByRole('button',{name:'Ask agent',exact:true}).click();await expect(page.getByText('! Test login failure',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Retry answer',exact:true}).click();await expect(page.getByText('Answer after retry',{exact:true})).toBeVisible({timeout:10000});expect(app.service.store.getReviewNotes(config.identity)).toHaveLength(1);
});
test('shows interrupted questions as retryable without polling indefinitely',async({page})=>{
 const service=app.service,view=service.load();const asked=service.act({action:'note',item:'P1',kind:'question',text:'Interrupted question',token:view.token});
 const now=Date.now;Date.now=()=>now()-200000;
 try {service.store.beginAnswer(service.config.identity,asked.createdNoteId!,'interrupted-attempt');} finally {Date.now=now;}
 let polls=0;page.on('request',request=>{if(request.url().endsWith('/api/questions'))polls++;});
 await page.clock.install();await page.goto(app.url);await expect(page.getByRole('button',{name:'Retry answer',exact:true})).toBeVisible();await page.clock.fastForward(3000);await expect(page.getByText(/Agent was interrupted or timed out/)).toBeVisible();expect(polls).toBe(0);
});
test('opens Settings while the initial review is still loading',async({page})=>{
 let release!:()=>void;const ready=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/review',async route=>{await ready;await route.continue();});
 try {
  await page.goto(app.url);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.getByLabel('Question agent',{exact:true})).toBeVisible();
 } finally {release();}
});
test('acknowledges the first Ask agent click immediately and prevents duplicate submissions',async({page})=>{
 const config=app.service.config;await app.close();let calls=0;
 app=await startServer(config,0,async()=>{calls++;return 'Single-click answer';});
 await page.goto(app.url);await expect(page.getByRole('heading',{name:'Bound exponential retries'})).toBeVisible();
 let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});let submissions=0;
 await page.route('**/api/action',async route=>{submissions++;await pending;await route.continue();});
 try {
  await page.getByLabel('Question about this item').fill('Does one click submit this?');
  await page.getByRole('button',{name:'Ask agent',exact:true}).click();
  await expect(page.locator('#save-note')).toBeDisabled();
  await expect(page.locator('#saved')).toHaveText('Asking agent…');
 } finally {release();}
 await expect(page.getByText('Does one click submit this?',{exact:true})).toBeVisible();
 await expect(page.locator('#saved')).toHaveText('Question submitted. Follow the agent’s response in Conversation.');
 await expect(page.getByText('Single-click answer',{exact:true})).toBeVisible({timeout:10000});
 await expect(page.getByRole('button',{name:'Ask agent',exact:true})).toBeEnabled();
 expect(submissions).toBe(1);expect(calls).toBe(1);expect(app.service.store.getReviewNotes(config.identity)).toHaveLength(1);
});
for (const readingEarlier of [false,true]) test(`answer arrival ${readingEarlier ? 'preserves earlier reading position' : 'follows the conversation bottom'}`,async({page})=>{
 const config=app.service.config;await app.close();let answer!:(text:string)=>void;
 app=await startServer(config,0,()=>new Promise(resolve=>{answer=resolve;}));
 for(let i=0;i<3;i++) app.service.act({action:'note',item:'P1',kind:'change',text:`Earlier message ${i}\n`+'Earlier context.\n'.repeat(20),token:app.service.load().token});
 await page.goto(app.url);await page.getByLabel('Question about this item').fill('Explain the cap');await page.getByRole('button',{name:'Ask agent',exact:true}).click();
 await expect(page.getByText('Agent · Answering…',{exact:true})).toBeVisible();
 const notes=page.locator('#notes');
 await notes.evaluate((element,earlier)=>{element.scrollTop=earlier ? 80 : element.scrollHeight;},readingEarlier);
 const before=await notes.evaluate(element=>element.scrollTop);
 answer('Detailed answer.\n'.repeat(60)+'Answer end.');
 await expect(page.locator('.agent-answer')).toHaveCount(1,{timeout:10000});
 if(readingEarlier) expect(await notes.evaluate(element=>element.scrollTop)).toBeCloseTo(before,0);
 else await expect.poll(()=>notes.evaluate(element=>element.scrollHeight-element.clientHeight-element.scrollTop)).toBeLessThan(2);
});
test('resizes Conversation using its divider and keyboard',async({page})=>{
 await page.goto(app.url);const pane=page.locator('#conversation-pane');const divider=page.getByRole('separator',{name:'Resize conversation'});
 await expect(divider).toBeVisible();const initial=(await pane.boundingBox())!.width;const handle=(await divider.boundingBox())!;
 await page.mouse.move(handle.x+handle.width/2,handle.y+100);await page.mouse.down();await page.mouse.move(handle.x-100,handle.y+100);await page.mouse.up();
 expect((await pane.boundingBox())!.width).toBeGreaterThan(initial+90);
 await divider.press('Home');await expect(divider).toHaveAttribute('aria-valuenow','280');
 await divider.press('ArrowLeft');await expect(divider).toHaveAttribute('aria-valuenow','300');
 await divider.press('End');await expect(divider).toHaveAttribute('aria-valuenow','480');
 expect((await page.locator('.code-pane').boundingBox())?.width ?? 0).toBeGreaterThan(400);
 await page.getByRole('button',{name:'Collapse conversation',exact:true}).click();await expect(divider).toBeHidden();
 await page.getByRole('button',{name:'Conversation',exact:true}).click();await expect(divider).toBeVisible();expect((await pane.boundingBox())!.width).toBe(480);
});
