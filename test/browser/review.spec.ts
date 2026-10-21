import { randomUUID } from 'node:crypto';
import { test, expect, type Page, type Route } from '@playwright/test';
import { openReview, refreshReview, reloadReview } from './review-page.ts';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createDemo } from '../../scripts/demo.ts';
import { choiceKeys } from '../../core/approvals.ts';
import { ReviewService } from '../../runner/review.ts';
import { startServer, type PlanningDeps } from '../../web/server.ts';
import { SETTLED_BEFORE_JOB_MERGE, type MergeJobView } from '../../runner/merge-job.ts';
import type { MergeGateway, MergeQueueGateway } from '../../github/merge.ts';
import { fixtureGit } from '../fixtures/git.ts';
let root: string, app: Awaited<ReturnType<typeof startServer>>;
// Resolves once the server has parsed the headers of the request that carries `marker` and is reading its body, so that partial request is provably admitted before shutdown starts.
// Matching the marker matters: any other client on the port (a polling tab, a reused ephemeral port) also emits 'request' and would start shutdown too early.
function requestAdmitted(server: typeof app.server) {
 const id=randomUUID(),marker={'x-codeboost-test-request':id};
 const admitted=new Promise<void>(resolve=>{const onRequest=(req:IncomingMessage)=>{if(req.headers['x-codeboost-test-request']!==id)return;server.off('request',onRequest);resolve();};server.on('request',onRequest);});
 return {admitted,marker};
}
// Reads the review a runner server reloads for a merge click. `route.fetch` with method GET resends the click's POST body,
// which the server never reads for a GET: it closes the connection over the unread body, and the reset surfaced as
// `read ECONNRESET`. A separate body-less GET with the page's token reaches the same handler.
async function clickReview(route: Route) {
 const request=route.request(),response=await fetch(request.url().replace('/api/action','/api/review'),{headers:{'x-codeboost-token':request.headers()['x-codeboost-token']??''}});
 if(!response.ok)throw new Error(`The click's review reload answered ${response.status}.`);
 return await response.json();
}
function removeDemoOutOfScope(config: typeof app.service.config) { chmodSync(join(config.repository,'run.sh'),0o644);fixtureGit(config.repository,'commit','-am','Restore declared scope'); }
test.beforeEach(async () => { root=mkdtempSync(join(tmpdir(),'codeboost-browser-'));app=await startServer(createDemo(join(root,'demo')),0); });
test.afterEach(async () => { await app.close();rmSync(root,{recursive:true,force:true}); });
test('resends the same merge key after a 503, a lost response, an unreadable body or an unknown outcome, and a new key after a definite answer',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const keys:string[]=[],answers:Array<'503'|'lost'|'garbled'|'unknown'|'409'>=['503','lost','garbled','unknown','409','409'];
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}keys.push(body.actionId);const answer=answers[keys.length-1];
  if(answer==='lost'){await route.abort('failed');return;}
  if(answer==='unknown'){await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Direct merge response was lost.',outcomeUnknown:true})});return;}
  if(answer==='garbled'){await route.fulfill({status:200,contentType:'application/json',body:'{"mergeResult":'});return;}
  await route.fulfill({status:answer==='503'?503:409,contentType:'application/json',body:JSON.stringify({error:answer==='503'?'The review server is shutting down.':'Merge is blocked.'})});});
 await openReview(page, app.url);page.on('dialog',dialog=>dialog.accept());
 for(let click=0;click<6;click++){await refreshReview(page);await expect(page.getByRole('button',{name:'Merge PR',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Merge PR',exact:true}).click();await expect.poll(()=>keys.length).toBe(click+1);await expect(page.locator('#banner')).toContainText('Merge blocked');}
 expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);expect(keys.slice(1,5)).toEqual([keys[0],keys[0],keys[0],keys[0]]);expect(keys[5]).not.toBe(keys[4]);
});
test('mints a new merge key for a retry once the attempt started by a retained key has ended',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const keys:string[]=[];
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}keys.push(body.actionId);
  if(keys.length===1){await route.abort('failed');return;}
  await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Merge is blocked.'})});});
 const confirms:string[]=[];
 await openReview(page, app.url);page.on('dialog',dialog=>{confirms.push(dialog.message());void dialog.accept();});
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();await expect.poll(()=>keys.length).toBe(1);await expect(page.locator('#banner')).toContainText('Merge blocked');
 // The lost click did reach GitHub (its response was lost), and that attempt later ends as refused.
 const expected={...view.expected,reviewVersion:view.expected.reviewVersion!};const attempt=app.service.store.beginMergeAttempt(config.identity,expected,view.snapshot.head,null,'direct',keys[0]);
 app.service.store.finishMergeAttempt(config.identity,attempt.id,{state:'failed',reason:'Required status check is expected.'});
 await refreshReview(page);await expect(page.getByRole('button',{name:'Retry merge',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Retry merge',exact:true}).click();await expect.poll(()=>keys.length).toBe(2);
 expect(keys[1]).not.toBe(keys[0]);
 // A direct merge's retry merges the exact reviewed head again (without a runner, nothing prepares or rebases it).
 expect(confirms).toEqual(['Merge this reviewed pull request?','Retry merging this exact reviewed head?']);
});
test('answers 503 when the merge deadline stops a click, so the browser may resend its key',async()=>{
 test.setTimeout(60_000);
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async options=>new Promise((_,reject)=>options?.signal?.addEventListener('abort',()=>reject(options.signal!.reason),{once:true})),merge:async()=>{throw new Error('The deadline stops the click before any merge.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const response=await fetch(new URL('/api/action',app.url),{method:'POST',headers:{'x-codeboost-token':app.token,'content-type':'application/json'},body:JSON.stringify({action:'merge',token:view.token,actionId:randomUUID()})});
 expect(response.status).toBe(503);expect((await response.json()).error).toMatch(/deadline/i);
 expect(app.service.store.getMergeAttempt(app.service.config.identity)).toBeNull();
});
test('resends a retained merge key with the request it was made for, even after a review edit and Refresh',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const sent:{actionId:string;token:string}[]=[];
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}sent.push({actionId:body.actionId,token:body.token});
  if(sent.length===1){await route.abort('failed');return;}
  await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Merge is blocked.'})});});
 await openReview(page, app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();await expect.poll(()=>sent.length).toBe(1);await expect(page.locator('#banner')).toContainText('Merge blocked');
 // A review edit changes the token the next Refresh shows.
 view=await app.service.load();await app.service.act({action:'note',item:view.items[0]!.id,kind:'question',text:'Edited after the lost click.',token:view.token});
 await refreshReview(page);await expect(page.getByRole('button',{name:'Merge PR',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();await expect.poll(()=>sent.length).toBe(2);
 expect(sent[1]).toEqual(sent[0]);
 expect((await app.service.load()).token).not.toBe(sent[0]!.token);
});
test('refuses a merge request without an idempotency key before doing any work',async()=>{
 const view=await app.service.load(),post=(body:object)=>fetch(new URL('/api/action',app.url),{method:'POST',headers:{'x-codeboost-token':app.token,'content-type':'application/json'},body:JSON.stringify(body)});
 for(const actionId of [undefined,'not-a-uuid']){const response=await post({action:'merge',token:view.token,actionId});expect(response.status).toBe(400);expect((await response.json()).error).toMatch(/actionId/);}
 expect(app.service.store.getMergeAttempt(app.service.config.identity)).toBeNull();
});
test('reviews real changes, persists approval and conversation, and assigns foreign code',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await openReview(page, app.url);await expect(page.getByRole('heading',{name:'Bound exponential retries'})).toBeVisible();
  await expect(page.getByText('0 of 3 approved')).toBeVisible();await expect(page.getByText('– No tests defined',{exact:false}).first()).toBeVisible();
  await page.getByRole('button',{name:'Approve P1',exact:true}).click();await expect(page.getByText('1 of 3 approved')).toBeVisible();
  await page.getByRole('button',{name:'Request change',exact:true}).click();await page.getByLabel('Change to request').fill('Add a test for the upper bound.');await page.getByRole('button',{name:'Save change request'}).click();await expect(page.getByText('Add a test for the upper bound.',{exact:true})).toBeVisible();
  await reloadReview(page);await expect(page.getByText('1 of 3 approved')).toBeVisible();await expect(page.getByText('Add a test for the upper bound.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/Unplanned changes/}).click();await page.getByLabel('Assign change 1 to').selectOption('P1');await page.getByRole('button',{name:'Assign',exact:true}).first().click();
  await page.getByRole('button',{name:/P1 Bound exponential retries/}).click();await expect(page.getByText('! Stale:',{exact:false})).toBeVisible();await expect(page.getByRole('heading',{name:'At approval'})).toBeVisible();
  await page.screenshot({path:'test-results/review-desktop.png',fullPage:true});expect(errors).toEqual([]);
});
test('labels a resolved foreign conflict as Unplanned agent-resolved work',async({page})=>{
 const service=app.service,identity=service.config.identity,initial=await service.load(),repository=service.config.repository;
 writeFileSync(join(repository,'resolved-conflict.txt'),'resolved by agent\n');fixtureGit(repository,'add','resolved-conflict.txt');
 fixtureGit(repository,'commit','-m','Resolved foreign conflict');const head=fixtureGit(repository,'rev-parse','HEAD');
 service.store.recordHistory(identity,initial.expected,initial.snapshot.base,head,[
  {sha:head,owner:null,origin:'foreign',sourceSha:initial.snapshot.head,conflictResolved:true},
 ]);
 await openReview(page, app.url);await page.getByRole('button',{name:/Unplanned changes/}).click();
 await expect(page.getByText('Unplanned · conflict resolved by agent',{exact:true}).first()).toBeVisible();
 await expect(page.getByRole('article',{name:/resolved-conflict\.txt, Unplanned · conflict resolved by agent/}).first()).toBeVisible();
});
test('opens an item selected while an assignment is in flight in the view its answered state calls for',async({page})=>{
 await openReview(page, app.url);await page.getByRole('button',{name:'Approve P1',exact:true}).click();await expect(page.getByText('1 of 3 approved')).toBeVisible();
 let release!:()=>void,arrived!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),assignArrived=new Promise<void>(resolve=>{arrived=resolve;});
 await page.route('**/api/action',async route=>{if(route.request().postDataJSON().action==='assign'){arrived();await held;}await route.continue();});
 await page.getByRole('button',{name:/Unplanned changes/}).click();await page.getByLabel('Assign change 1 to').selectOption('P1');await page.getByRole('button',{name:'Assign',exact:true}).first().click();await assignArrived;
 // P1 is still approved in the page when it is selected; the held answer makes it stale.
 await page.getByRole('button',{name:/P1 Bound exponential retries/}).click();await expect(page.getByRole('heading',{name:'Bound exponential retries'})).toBeVisible();await expect(page.getByText('! Stale:',{exact:false})).toHaveCount(0);
 release();await expect(page.getByText('! Stale:',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'Since approval',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('heading',{name:'At approval'})).toBeVisible();
 expect((await app.service.load()).items.find(item=>item.id==='P1')!.state).toBe('stale');
 // An explicit choice survives the next answer.
 await page.getByRole('button',{name:'Full change',exact:true}).click();await expect(page.getByRole('heading',{name:'At approval'})).toHaveCount(0);
 // Every check below already holds before the Refresh answer, so wait until that answer is rendered.
 const answered=page.waitForResponse('**/api/review');await refreshReview(page);await answered;await expect(page.locator('#banner')).not.toContainText('Linking changes');
 await expect(page.getByText('! Stale:',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Full change',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('heading',{name:'At approval'})).toHaveCount(0);
 // A code change on the still-stale item is a new state, so the choice made on the old one no longer holds.
 const repository=app.service.config.repository;writeFileSync(join(repository,'retry.ts'),'export function delay(attempt: number) {\n  return 42;\n}\n');fixtureGit(repository,'commit','-am','External change');
 await refreshReview(page);await expect(page.getByText('! Stale:',{exact:false}).first()).toBeVisible();await expect(page.getByRole('button',{name:'Since approval',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('heading',{name:'At approval'})).toBeVisible();
 // After approval, a new stale state opens the comparison again.
 await page.getByRole('button',{name:'Full change',exact:true}).click();await expect(page.getByRole('heading',{name:'At approval'})).toHaveCount(0);
 await page.getByRole('button',{name:'Approve P1',exact:true}).click();await expect(page.getByText('! Stale:',{exact:false})).toHaveCount(0);
 let view=await app.service.load();view=await app.service.act({action:'assign',key:view.segments.find(segment=>segment.row==='Unplanned'&&segment.path==='retry.ts')!.key,item:'P1',token:view.token});expect(view.items.find(item=>item.id==='P1')!.state).toBe('stale');
 await refreshReview(page);await expect(page.getByText('! Stale:',{exact:false}).first()).toBeVisible();await expect(page.getByRole('button',{name:'Since approval',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('heading',{name:'At approval'})).toBeVisible();
});
test('keeps an explicit view choice only while the server names the same stale state',async({page})=>{
 let view=await app.service.load();view=await app.service.act({action:'approve',item:'P1',confirmNoChange:false,token:view.token});
 view=await app.service.act({action:'assign',key:view.segments.find(segment=>segment.row==='Unplanned')!.key,item:'P1',token:view.token});expect(view.items.find(item=>item.id==='P1')!.state).toBe('stale');
 // The answer is the server's own, except that P1's staleKey can be replaced; nothing else about P1 changes.
 let staleKey:string|null=null;
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();if(staleKey)body.items.find((item:{id:string})=>item.id==='P1').staleKey=staleKey;await route.fulfill({response,json:body});});
 const refresh=async()=>{const answered=page.waitForResponse('**/api/review');await page.getByRole('button',{name:'Refresh',exact:true}).click();await answered;await expect(page.locator('#banner')).not.toContainText('Linking changes');};
 await openReview(page, app.url);await page.getByRole('button',{name:/P1 Bound exponential retries/}).click();await expect(page.getByRole('heading',{name:'At approval'})).toBeVisible();
 await page.getByRole('button',{name:'Full change',exact:true}).click();await expect(page.getByRole('heading',{name:'At approval'})).toHaveCount(0);
 await refresh();await expect(page.getByRole('button',{name:'Full change',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('heading',{name:'At approval'})).toHaveCount(0);
 staleKey='0'.repeat(64);await refresh();
 await expect(page.getByRole('button',{name:'Since approval',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('heading',{name:'At approval'})).toBeVisible();
});
test('shows file metadata and no-change confirmation, supports narrow desktop and keyboard',async({page})=>{
  await openReview(page, app.url);await page.getByRole('button',{name:/P2 Document retry behavior/}).click();await expect(page.getByText('File mode changed',{exact:false})).toBeVisible();await expect(page.getByText('✕ Out of scope',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/P3 Confirm API compatibility/}).click();await page.getByRole('button',{name:'Confirm no change needed',exact:true}).click();await expect(page.getByText('1 of 3 approved')).toBeVisible();
  await page.setViewportSize({width:1280,height:900});await expect(page.getByRole('complementary',{name:'Conversation',exact:true})).not.toBeVisible();await page.getByRole('button',{name:'Conversation',exact:true}).click();await expect(page.getByRole('complementary',{name:'Conversation',exact:true})).toBeVisible();
  await page.getByLabel('Question about this item').fill('npa');await expect(page.getByRole('heading',{name:'Confirm API compatibility'})).toBeVisible();
  await page.keyboard.press('Escape');await page.keyboard.press('p');await expect(page.getByRole('heading',{name:'Document retry behavior'})).toBeVisible();
  await page.setViewportSize({width:1000,height:800});await expect(page.getByRole('heading',{name:'A little more room to review'})).toBeVisible();
});
test('refresh makes changed code stale and stale browser actions cannot approve it',async({page,context})=>{
  await openReview(page, app.url);await page.getByRole('button',{name:'Approve P1',exact:true}).click();await expect(page.getByText('1 of 3 approved')).toBeVisible();
  const other=await context.newPage();await openReview(other, app.url);await expect(other.getByText('1 of 3 approved')).toBeVisible();
  const repository=app.service.config.repository;writeFileSync(join(repository,'retry.ts'),'export function delay(attempt: number) {\n  return 42;\n}\n');fixtureGit(repository,'commit','-am','External change');
  await refreshReview(page);await expect(page.getByText('! Stale:',{exact:false}).first()).toBeVisible();
  await other.getByRole('button',{name:/P3 Confirm API compatibility/}).click();await other.getByRole('button',{name:'Confirm no change needed',exact:true}).click();await expect(other.getByRole('status').filter({hasText:'Stale review state'})).toBeVisible();
});
test('requires private credentials and rejects foreign origins',async({request})=>{
  const base=app.url.split('#')[0]!;
  expect((await request.get(base+'api/review')).status()).toBe(403);
  expect((await request.get(base+'api/review',{headers:{'x-codeboost-token':app.token,origin:'https://example.invalid'}})).status()).toBe(403);
  expect((await request.get(base+'api/review',{headers:{'x-codeboost-token':app.token}})).status()).toBe(200);
});
test('shows merge blockers and submits one exact-head merge',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);let mergeCalls:string[]=[];let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 const gateway:MergeGateway={
  inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},
  merge:async head=>{mergeCalls.push(head);await held;app.service.load=()=>{throw new Error('post-command reload failed');};app.service.store.getMergeAttempt=()=>{throw new Error('post-command queue read failed');};return {url:'https://github.com/example/repo/pull/21'};},
 };
 app=await startServer(config,0,undefined,gateway);await openReview(page, app.url);
 await expect(page.locator('#merge')).toBeDisabled();await page.getByRole('button',{name:'Review blockers'}).click();await expect(page.getByRole('heading',{name:'Merge blockers'})).toBeVisible();await expect(page.getByText(/is unreviewed/).first()).toBeVisible();await page.screenshot({path:'test-results/merge-blockers.png',fullPage:true});await page.getByRole('button',{name:'Close',exact:true}).click();
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 await refreshReview(page);const expectedHead=view.snapshot.head;await expect(page.getByRole('button',{name:'Merge PR',exact:true})).toBeEnabled();page.on('dialog',dialog=>dialog.accept());
 await page.locator('#merge').evaluate((button:HTMLButtonElement)=>{button.click();button.click();});await expect.poll(()=>mergeCalls.length).toBe(1);await expect(page.locator('#merge')).toBeDisabled();release();await expect(page.locator('#banner')).toContainText('Merge submitted.');await expect(page.locator('#merge')).toBeDisabled();await page.locator('#merge').evaluate((button:HTMLButtonElement)=>button.click());expect(mergeCalls).toEqual([expectedHead]);
});
test('keeps the reviewed head queued until confirmed merged and preserves current input',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);let appRef:typeof app,phase:'queued'|'merged'='queued',queueReads=0;
 const gateway:MergeGateway&MergeQueueGateway={
  inspect:async()=>{const snapshot=(await appRef.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:true,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},
  queueWatermark:async()=>null,
  merge:async()=>({url:'https://github.com/example/repo/pull/24'}),
  inspectQueue:async head=>{queueReads++;return phase==='queued'?{state:'queued',reviewedHead:head,entryId:'MQE_1',phase:'AWAITING_CHECKS',position:2,enqueuedAt:'2026-09-24T08:00:00Z',queueHead:head}:{state:'merged',reviewedHead:head,mergedAt:'2026-09-24T08:10:00Z'};},
 };
 app=appRef=await startServer(config,0,undefined,gateway);let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 await openReview(page, app.url);await page.getByRole('button',{name:/P2 Document retry behavior/}).click();await page.getByLabel('Question about this item').fill('Keep this draft while polling.');page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.getByRole('button',{name:'Merge queued',exact:true})).toBeDisabled();await expect(page.getByLabel('Question about this item')).toHaveValue('Keep this draft while polling.');await expect.poll(()=>queueReads).toBeGreaterThan(0);
 phase='merged';await expect(page.getByRole('button',{name:'Merged',exact:true})).toBeDisabled({timeout:10000});await expect(page.locator('#banner')).toContainText('GitHub confirmed the reviewed head was merged.');await expect(page.getByRole('heading',{name:'Document retry behavior'})).toBeVisible();await expect(page.getByLabel('Question about this item')).toHaveValue('Keep this draft while polling.');
});
test('backs off repeated merge-queue polling',async({page})=>{
 await page.addInitScript(()=>{const delays:number[]=[];(window as typeof window&{__mergePollDelays:number[]}).__mergePollDelays=delays;const native=window.setTimeout.bind(window);window.setTimeout=((handler:TimerHandler,timeout?:number,...args:unknown[])=>{if(typeof timeout==='number')delays.push(timeout);return native(handler,timeout,...args);}) as typeof window.setTimeout;});
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);let appRef:typeof app,queueReads=0;
 const gateway:MergeGateway&MergeQueueGateway={inspect:async()=>{const snapshot=(await appRef.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:true,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},queueWatermark:async()=>null,merge:async()=>({url:'https://github.com/example/repo/pull/24'}),inspectQueue:async head=>{queueReads++;return{state:'queued',reviewedHead:head,entryId:'MQE_1',phase:'QUEUED',position:1,enqueuedAt:'2026-09-24T08:00:00Z',queueHead:head};}};
 app=appRef=await startServer(config,0,undefined,gateway);let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 await openReview(page, app.url);page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Merge PR',exact:true}).click();await expect.poll(()=>queueReads,{timeout:20000}).toBeGreaterThanOrEqual(2);
 const delays=await page.evaluate(()=>(window as typeof window&{__mergePollDelays:number[]}).__mergePollDelays.filter(value=>value>=500));expect(delays.slice(0,2)).toEqual([2000,4000]);
});
test('does not queue-poll an ambiguous direct merge attempt',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);let appRef:typeof app,polls=0;
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await appRef.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>({url:''})};
 app=appRef=await startServer(config,0,undefined,gateway);const view=await app.service.load();app.service.store.beginMergeAttempt(config.identity,{...view.expected,reviewVersion:view.expected.reviewVersion!},view.snapshot.head,null,'direct');
 await page.route('**/api/merge',async route=>{polls++;await route.continue();});await openReview(page, app.url);await expect(page.getByRole('button',{name:'Submitting…',exact:true})).toBeDisabled();await page.waitForTimeout(2500);expect(polls).toBe(0);
});
test('surfaces queue removal and retries only the same reviewed head',async({page})=>{
 test.slow();
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);let appRef:typeof app,mergeCalls=0;
 const gateway:MergeGateway&MergeQueueGateway={
  inspect:async()=>{const snapshot=(await appRef.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:true,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},
  queueWatermark:async()=>null,
  merge:async()=>{mergeCalls++;return {url:'https://github.com/example/repo/pull/24'};},
  inspectQueue:async head=>mergeCalls===1?{state:'removed',reviewedHead:head,removedAt:'2026-09-24T08:05:00Z',reason:'Required check failed.'}:{state:'queued',reviewedHead:head,entryId:'MQE_2',phase:'QUEUED',position:1,enqueuedAt:'2026-09-24T08:06:00Z',queueHead:head},
 };
 app=appRef=await startServer(config,0,undefined,gateway);let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 await openReview(page, app.url);page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Merge PR',exact:true}).click();await expect(page.locator('#banner')).toContainText('Refresh to verify retry readiness.',{timeout:10000});await expect(page.getByRole('button',{name:'Retry merge',exact:true})).toHaveCount(0);await expect(page.locator('#merge')).toBeDisabled();await refreshReview(page);await expect(page.getByRole('button',{name:'Retry merge',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Retry merge',exact:true}).click();await expect.poll(()=>mergeCalls).toBe(2);await expect(page.getByRole('button',{name:'Merge queued',exact:true})).toBeDisabled();expect(app.service.store.getMergeAttempt(config.identity)).toMatchObject({state:'queued',reviewedHead:view.snapshot.head});
});
test('ignores a merge poll started before a newer review action',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);let appRef:typeof app;
 const gateway:MergeGateway&MergeQueueGateway={
  inspect:async()=>{const snapshot=(await appRef.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:true,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},
  queueWatermark:async()=>null,
  merge:async()=>({url:'https://github.com/example/repo/pull/24'}),
  inspectQueue:async head=>({state:'removed',reviewedHead:head,removedAt:'2026-09-24T08:05:00Z',reason:'Old poll result.'}),
 };
 app=appRef=await startServer(config,0,undefined,gateway);let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 let release!:()=>void,releaseNew!:()=>void,arrived!:()=>void;const held=new Promise<void>(resolve=>release=resolve),heldNew=new Promise<void>(resolve=>releaseNew=resolve),started=new Promise<void>(resolve=>arrived=resolve);let polls=0;
 await page.route('**/api/merge',async route=>{polls++;if(polls===1){arrived();await held;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:{state:'removed',reviewedHead:view.snapshot.head,url:null,reason:'Old poll result.',phase:null,position:null,occurredAt:'2026-09-24T08:05:00Z',retryable:true}})});return;}await heldNew;await route.continue();});
 await openReview(page, app.url);page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Merge PR',exact:true}).click();await started;
 await page.getByRole('button',{name:'Request change',exact:true}).click();await page.getByLabel('Change to request').fill('New review decision.');await page.getByRole('button',{name:'Save change request'}).click();await expect(page.getByText('New review decision.',{exact:true})).toBeVisible();
 const staleResponse=page.waitForResponse(response=>response.url().endsWith('/api/merge'));release();try{await staleResponse;await page.waitForTimeout(100);await expect(page.locator('#banner')).not.toContainText('Old poll result.');await expect(page.getByRole('button',{name:'Retry merge',exact:true})).toHaveCount(0);await expect(page.locator('#merge')).toBeDisabled();}finally{releaseNew();}
});
test('requires fresh review instead of retry when GitHub replaces the queued head',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);let appRef:typeof app;
 const gateway:MergeGateway&MergeQueueGateway={
  inspect:async()=>{const snapshot=(await appRef.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:true,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},
  queueWatermark:async()=>null,
  merge:async()=>({url:'https://github.com/example/repo/pull/24'}),inspectQueue:async()=>{throw new Error('The pull request head changed after review.');},
 };
 app=appRef=await startServer(config,0,undefined,gateway);let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 await openReview(page, app.url);page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Merge PR',exact:true}).click();await expect(page.locator('#banner')).toContainText('The pull request head changed after review.',{timeout:10000});await expect(page.getByRole('button',{name:'Retry merge',exact:true})).toHaveCount(0);await expect(page.locator('#merge')).toBeDisabled();
});
test('keeps stale merge failures disabled until refresh',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);let appRef:typeof app;const gateway:MergeGateway={inspect:async()=>{const snapshot=(await appRef.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('head changed');}};app=appRef=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 await openReview(page, app.url);page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Merge PR',exact:true}).click();await expect(page.locator('#banner')).toContainText('Merge blocked. head changed');await expect(page.locator('#merge')).toBeDisabled();
});
test('never enables merging for a demo even with an injected gateway',async({page})=>{
 const config=app.service.config;await app.close();let inspections=0;const gateway:MergeGateway={inspect:async()=>{inspections++;throw new Error('must not run');},merge:async()=>({url:''})};app=await startServer(config,0,undefined,gateway);await openReview(page, app.url);await expect(page.locator('#merge')).toBeHidden();expect(inspections).toBe(0);
});
test('shows an honest history error and keeps markup in notes as text',async({page})=>{
 await openReview(page, app.url);await page.getByLabel('Question about this item').fill('<img src=x onerror=alert(1)>');await page.getByRole('button',{name:'Ask agent'}).click();await expect(page.getByText('<img src=x onerror=alert(1)>',{exact:true})).toBeVisible();await expect(page.locator('#notes img')).toHaveCount(0);
 const repository=app.service.config.repository;fixtureGit(repository,'checkout','--orphan','unrelated');fixtureGit(repository,'commit','-m','Unrelated history');
 await refreshReview(page);await expect(page.getByText('Could not read this branch’s history.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Approve P1',exact:true})).not.toBeVisible();
});
test('can assign a large foreign change without sending its content back in the command',async({request})=>{
 const repository=app.service.config.repository;writeFileSync(join(repository,'debug.log'),'x'.repeat(20000)+'\n');fixtureGit(repository,'commit','-am','Large foreign change');
 const base=app.url.split('#')[0]!,headers={'x-codeboost-token':app.token};const view=await(await request.get(base+'api/review',{headers})).json();const segment=view.segments.find((s:{content:string;row:string})=>s.row==='Unplanned'&&s.content.length>19000);
 const response=await request.post(base+'api/action',{headers:{...headers,'Content-Type':'application/json'},data:{action:'assign',item:'P1',key:segment.key,token:view.token,actionId:randomUUID()}});
 expect(response.status()).toBe(200);
});
test('shows bounded raster previews and byte sizes for file-change cards',async({page})=>{
 const repository=app.service.config.repository;writeFileSync(join(repository,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRHsAAAAASUVORK5CYII=','base64'));fixtureGit(repository,'add','pixel.png');fixtureGit(repository,'commit','-m','Add image');
 await openReview(page, app.url);await page.getByRole('button',{name:/Unplanned changes/}).click();await expect(page.getByRole('img',{name:'Current image in pixel.png'})).toBeVisible();await expect(page.getByRole('img',{name:'Current image in pixel.png'})).toHaveJSProperty('naturalWidth',1);await expect(page.getByText('Size: N/A → 68 bytes',{exact:true})).toBeVisible();
});
test('rejects malformed non-ASCII credentials consistently',async({request})=>{
 const response=await request.get(app.url.split('#')[0]+'api/review',{headers:{'x-codeboost-token':'é'.repeat(64)}});expect(response.status()).toBe(403);
});
test('keeps stale item controls unavailable after a failed refresh',async({page})=>{
 await openReview(page, app.url);const repository=app.service.config.repository;fixtureGit(repository,'checkout','--orphan','unrelated');fixtureGit(repository,'commit','-m','Other history');
 await refreshReview(page);await expect(page.getByText('Could not read this branch’s history.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:/P3 Confirm API compatibility/})).toHaveCount(0);
});
test('accepts a foreign segment and keeps that choice across reload',async({page})=>{
 await openReview(page, app.url);await page.getByRole('button',{name:/Unplanned changes/}).click();await page.getByRole('button',{name:'Accept as is',exact:true}).first().click();await page.getByRole('button',{name:/Accepted 1/}).click();await expect(page.getByRole('article').first()).toBeVisible();await expect(page.getByText('Accepted outside plan',{exact:true})).toBeVisible();await reloadReview(page);await page.getByRole('button',{name:/Accepted 1/}).click();await expect(page.getByRole('article').first()).toBeVisible();
});
test('shows the whole-plan empty state without claiming checks passed',async({page})=>{
 const {repository,identity}=app.service.config;const base=app.service.store.getSnapshot(identity).base;fixtureGit(repository,'reset','--hard',base);
 await openReview(page, app.url);await expect(page.getByRole('heading',{name:'No code changes yet'})).toBeVisible();await expect(page.getByRole('button',{name:'Confirm no change needed',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'AI review: – Not run',exact:true})).toBeVisible();
});
test('routes mixed owned and ambiguous items to attribution resolution',async({page})=>{
 const {repository,identity}=app.service.config;writeFileSync(join(repository,'retry.ts'),'export function delay(attempt: number) {\n  return Math.min(10000, 200 * 2 ** attempt);\n}\n');fixtureGit(repository,'commit','-am','P2 changes retry');
 const head=fixtureGit(repository,'rev-parse','HEAD'),snapshot=app.service.store.getSnapshot(identity);app.service.store.recordHistory(identity,{revision:1,snapshotId:snapshot.id},snapshot.base,head,[{sha:head,owner:'P2',origin:'owned',sourceSha:null}]);
 await openReview(page, app.url);await page.getByRole('button',{name:/P2 Document retry behavior/}).click();await page.getByRole('button',{name:'Resolve ambiguous changes',exact:true}).click();await expect(page.getByRole('heading',{name:'Ambiguous',exact:true})).toBeVisible();
});
test('keeps review shortcuts active while a toolbar button has focus',async({page})=>{
 await openReview(page, app.url);await expect(page.getByRole('heading',{name:'Bound exponential retries'})).toBeVisible();await page.getByRole('button',{name:'Refresh',exact:true}).focus();await page.keyboard.press('n');await expect(page.getByRole('heading',{name:'Document retry behavior'})).toBeVisible();
});
test('attaches clicked lines to a question, persists and navigates the reference, and shows archived evidence',async({page})=>{
 await openReview(page, app.url);
 const line=page.locator('.added [data-line]').first();await line.click();
 await page.getByRole('button',{name:'Ask about selection',exact:true}).click();
 await expect(page.locator('#attachment')).toContainText('retry.ts');
 await page.getByLabel('Question about this item').fill('Why this exact line?');const asked=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/action');await page.getByRole('button',{name:'Ask agent',exact:true}).click();await asked;
 await reloadReview(page);await page.locator('.note-reference').click();await expect(page.locator('.selected-line').first()).toBeVisible();
 fixtureGit(app.service.config.repository,'commit','--allow-empty','-m','another revision');
 await refreshReview(page);await expect(page.locator('.note-reference')).toContainText('Outdated');await page.locator('.note-reference').click();await expect(page.getByRole('heading',{name:'! Outdated code reference'})).toBeVisible();await expect(page.locator('#dialog-body pre')).toContainText('Math.min');
});
test('supports shift ranges, highlighted lines, and independent snippet drafts',async({page})=>{
 const repository=app.service.config.repository;
 writeFileSync(join(repository,'retry.ts'),'export const cap = 5000;\nexport const base = 100;\nexport const delay = (n: number) => Math.min(cap, base * 2 ** n);\n');
 fixtureGit(repository,'commit','-am','rewrite retry');
 let view=await app.service.load();
 for(const key of view.segments.filter(s=>s.path==='retry.ts'&&['Unplanned','Ambiguous'].includes(s.row)).map(s=>s.key)) view=await app.service.act({action:'assign',key,item:'P1',token:view.token});
 await openReview(page, app.url);
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
 const config=app.service.config;await app.close();let providerAtCall:string|null=null;let release!:()=>void;const released=new Promise<void>(resolve=>{release=resolve;});
 // The agent answers only once the page has shown the question as answering, however long the server's review loads take.
 app=await startServer(config,0,async prompt=>{providerAtCall=app.service.store.questionProvider();expect(prompt).toContain('Why this cap?');await released;return 'The cap prevents unbounded retry delays.';});
 await openReview(page, app.url);await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.locator('#question-provider option[value="codex"]')).toHaveCount(0);await page.getByLabel('Question agent',{exact:true}).selectOption('claude');await page.getByRole('button',{name:'Save settings',exact:true}).click();await expect(page.getByText('Settings saved.',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.getByLabel('Question about this item').fill('Why this cap?');await page.getByRole('button',{name:'Ask agent',exact:true}).click();await expect(page.getByText('Agent · Answering…',{exact:true})).toBeVisible();
 await page.getByLabel('Question about this item').fill('My next draft');release();await expect(page.getByText('The cap prevents unbounded retry delays.',{exact:true})).toBeVisible({timeout:10000});await expect(page.getByLabel('Question about this item')).toHaveValue('My next draft');expect(providerAtCall).toBe('claude');
 await reloadReview(page);await expect(page.getByText('The cap prevents unbounded retry delays.',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.getByLabel('Question agent',{exact:true})).toHaveValue('claude');
});
test('shows agent errors and retries the saved question',async({page})=>{
 const config=app.service.config;await app.close();let attempts=0;app=await startServer(config,0,async()=>{if(++attempts===1)throw new Error('Test login failure');return 'Answer after retry';});
 await openReview(page, app.url);await page.getByLabel('Question about this item').fill('Explain this');await page.getByRole('button',{name:'Ask agent',exact:true}).click();await expect(page.getByText('! Test login failure',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Retry answer',exact:true}).click();await expect(page.getByText('Answer after retry',{exact:true})).toBeVisible({timeout:10000});expect(app.service.store.getReviewNotes(config.identity)).toHaveLength(1);
});
test('shows interrupted questions as retryable without polling indefinitely',async({page})=>{
 const service=app.service,view=await service.load();const asked=await service.act({action:'note',item:'P1',kind:'question',text:'Interrupted question',token:view.token});
 const now=Date.now;Date.now=()=>now()-200000;
 try {service.store.beginAnswer(service.config.identity,asked.createdNoteId!,'interrupted-attempt');} finally {Date.now=now;}
 let polls=0;page.on('request',request=>{if(request.url().endsWith('/api/questions'))polls++;});
 await page.clock.install();await openReview(page, app.url);await expect(page.getByRole('button',{name:'Retry answer',exact:true})).toBeVisible();await page.clock.fastForward(3000);await expect(page.getByText(/Agent was interrupted or timed out/)).toBeVisible();expect(polls).toBe(1);
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
 await openReview(page, app.url);await expect(page.getByRole('heading',{name:'Bound exponential retries'})).toBeVisible();
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
 for(let i=0;i<3;i++) await app.service.act({action:'note',item:'P1',kind:'change',text:`Earlier message ${i}\n`+'Earlier context.\n'.repeat(20),token:(await app.service.load()).token});
 await openReview(page, app.url);await page.getByLabel('Question about this item').fill('Explain the cap');await page.getByRole('button',{name:'Ask agent',exact:true}).click();
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
 await openReview(page, app.url);const pane=page.locator('#conversation-pane');const divider=page.getByRole('separator',{name:'Resize conversation'});
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
test('places selection actions beside code deep in a scrolled diff',async({page})=>{
 const repository=app.service.config.repository;
 writeFileSync(join(repository,'retry.ts'),Array.from({length:90},(_,i)=>`export const value${i} = ${i};`).join('\n')+'\n');
 fixtureGit(repository,'commit','-am','Long diff');
 let view=await app.service.load();
 for(const key of view.segments.filter(s=>s.path==='retry.ts'&&['Unplanned','Ambiguous'].includes(s.row)).map(s=>s.key)) view=await app.service.act({action:'assign',key,item:'P1',token:view.token});
 await openReview(page, app.url);
 const line=page.locator('.added [data-line]').nth(60);await line.scrollIntoViewIfNeeded();await line.click();
 const actions=page.getByRole('group',{name:'Selected code'});await expect(actions).toBeVisible();
 const selection=(await line.boundingBox())!,toolbar=(await actions.boundingBox())!,code=(await page.locator('#code').boundingBox())!;
 expect(Math.min(Math.abs(toolbar.y+toolbar.height-selection.y),Math.abs(toolbar.y-selection.y-selection.height))).toBeLessThan(40);
 expect(toolbar.y).toBeGreaterThanOrEqual(code.y);expect(toolbar.y+toolbar.height).toBeLessThanOrEqual(code.y+code.height);
 await page.screenshot({path:test.info().outputPath('selection-actions.png')});
 await page.getByRole('button',{name:'Ask about selection',exact:true}).click();await expect(page.locator('#attachment')).toContainText('value60');
 await page.locator('#code').evaluate(element=>{element.scrollTop=0;});await expect(actions).toBeHidden();
 await line.scrollIntoViewIfNeeded();await expect(actions).toBeVisible();await page.getByRole('button',{name:'Clear selection',exact:true}).click();await expect(actions).toBeHidden();
});
test('Clear selection removes native text selection as well as selected lines',async({page})=>{
 await openReview(page, app.url);
 await page.locator('.added .code-lines').first().evaluate(element=>{
  const line=element.querySelector('[data-code-line]')!;
  const range=document.createRange();range.selectNodeContents(line);
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
  element.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
 });
 await expect(page.locator('.selected-line').first()).toBeVisible();
 expect(await page.evaluate(()=>window.getSelection()?.toString())).not.toBe('');
 await page.getByRole('button',{name:'Clear selection',exact:true}).click();
 await expect(page.getByRole('group',{name:'Selected code'})).toBeHidden();
 await expect(page.locator('.selected-line')).toHaveCount(0);
 expect(await page.evaluate(()=>window.getSelection()?.toString())).toBe('');
 await page.locator('#code').press('ArrowRight');
 await expect(page.getByRole('group',{name:'Selected code'})).toBeHidden();
});
test('ignores question polls started before a newer submission',async({page})=>{
 const config=app.service.config;await app.close();app=await startServer(config,0,(_prompt,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
 await openReview(page, app.url);await page.getByLabel('Question about this item').fill('First question');await page.getByRole('button',{name:'Ask agent',exact:true}).click();await expect(page.getByText('Agent · Answering…',{exact:true})).toBeVisible();
 let release!:()=>void,arrived!:()=>void;const held=new Promise<void>(r=>release=r),captured=new Promise<void>(r=>arrived=r);
 await page.route('**/api/questions',async route=>{const response=await route.fetch();arrived();await held;await route.fulfill({response});});
 await captured;
 await page.getByLabel('Question about this item').fill('Second question');await page.getByRole('button',{name:'Ask agent',exact:true}).click();await expect(page.locator('#notes .note')).toHaveCount(2);
 release();await page.waitForResponse(response=>response.url().endsWith('/api/questions'));
 await page.waitForTimeout(100);
 expect(await page.locator('#notes .note').count()).toBe(2);
});
test('polls persisted answer status without rebuilding the review',async({page})=>{
 const config=app.service.config;await app.close();let settle!:(answer:string)=>void;
 app=await startServer(config,0,()=>new Promise(resolve=>settle=resolve));
 await openReview(page, app.url);await page.getByLabel('Question about this item').fill('Why is this bounded?');await page.getByRole('button',{name:'Ask agent',exact:true}).click();
 await expect(page.getByText('Agent · Answering…',{exact:true})).toBeVisible();
 const service=app.service,load=service.load.bind(service);let reviewLoads=0;
 service.load=()=>{reviewLoads++;return load();};
 const polled=page.waitForResponse(response=>response.url().endsWith('/api/questions'));
 settle('The cap bounds retry latency.');
 const statusResponse=await polled,statusBody=await statusResponse.json();
 await expect(page.getByText('The cap bounds retry latency.',{exact:true})).toBeVisible({timeout:10000});
 expect(reviewLoads).toBe(0);
 expect(statusBody.notes.find((note:{id:string})=>note.id)).not.toHaveProperty('text');
 expect(service.store.getReviewNotes(config.identity).find(note=>note.text==='Why is this bounded?')?.answer?.status).toBe('complete');
 await refreshReview(page);await expect.poll(()=>reviewLoads).toBeGreaterThan(0);
});
test('outdated questions explain how to continue without offering a broken retry',async({page})=>{
 const service=app.service;
 await service.act({action:'note',item:'P1',kind:'question',text:'Old question',token:(await service.load()).token});
 fixtureGit(service.config.repository,'commit','--allow-empty','-m','New snapshot');
 await openReview(page, app.url);
 await expect(page.getByText('Old question',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Retry answer',exact:true})).toHaveCount(0);
 await expect(page.getByText('This question refers to an earlier review. Ask again against the current code.',{exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Bound exponential retries'})).toBeVisible();
});
for(const kind of ['question','change']) test(`preserves ${kind} edits and snippets during refresh`,async({page})=>{
 await openReview(page, app.url);await expect(page.getByRole('heading',{name:'Bound exponential retries'})).toBeVisible();
 await page.locator('.added [data-line]').first().click();
 await page.getByRole('button',{name:kind==='question'?'Ask about selection':'Request change to selection',exact:true}).click();
 const composer=page.locator('#message');await composer.fill('Before refresh');
 let release!:()=>void,arrived!:()=>void;const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>arrived=resolve);
 await page.route('**/api/review',async route=>{arrived();await held;await route.continue();});
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await started;
 await composer.fill('Edited during refresh');
 await app.service.act({action:'approve',item:'P3',confirmNoChange:true,token:(await app.service.load()).token});
 release();await expect(page.getByText('1 of 3 approved')).toBeVisible();
 await expect(composer).toHaveValue('Edited during refresh');
 await expect(page.locator(kind==='question'?'#ask':'#request')).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('#attachment')).toContainText('retry.ts');await expect(page.locator('#attachment')).not.toContainText('Outdated');
 await expect(page.locator('#save-note')).toBeEnabled();
 expect((await app.service.load()).approved).toBe(1);expect((await app.service.load()).notes).toHaveLength(0);
});
for(const scenario of ['navigation','snapshot','removed item','failure']) test(`preserves drafts during refresh with ${scenario}`,async({page})=>{
 await openReview(page, app.url);await expect(page.getByRole('heading',{name:'Bound exponential retries'})).toBeVisible();
 await page.locator('.added [data-line]').first().click();await page.getByRole('button',{name:'Ask about selection',exact:true}).click();
 await page.locator('#message').fill('Before refresh');
 let release!:()=>void,arrived!:()=>void;const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>arrived=resolve);
 await page.route('**/api/review',async route=>{arrived();await held;if(scenario==='failure')await route.fulfill({status:500,json:{error:'Temporary read failure'}});else await route.continue();});
 await page.getByRole('button',{name:'Refresh',exact:true}).click();await started;
 await page.locator('#message').fill('Latest question');
 if(scenario==='navigation'){
  await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
  await page.getByRole('button',{name:'Request change',exact:true}).click();await page.locator('#message').fill('Latest change request');
 }
 if(scenario==='snapshot')fixtureGit(app.service.config.repository,'commit','--allow-empty','-m','New snapshot');
 if(scenario==='removed item'){
  const service=app.service,identity=service.config.identity,plan=service.store.getPlan(identity);
  service.store.importRevision(JSON.stringify({...plan,items:plan.items.filter(item=>item.id!=='P1').map(item=>({...item,depends_on:[]}))}),'json',{identity,issue:plan.issue,baseEntries:['retry.ts','README.md','run.sh'].map(path=>({path,kind:'file' as const})),pathKey:path=>path,allowedCommands:[]},plan.revision);
 }
 release();
 if(scenario==='failure'){
  await expect(page.locator('#banner')).toContainText('Temporary read failure');await page.unroute('**/api/review');
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
 }
 await expect(page.locator('#banner')).not.toContainText('Linking changes');await expect(page.locator('#banner')).not.toContainText('Temporary read failure');
 if(scenario==='navigation'){
  await expect(page.getByRole('heading',{name:'Document retry behavior'})).toBeVisible();
  await expect(page.locator('#message')).toHaveValue('Latest change request');await expect(page.locator('#request')).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:/P1 Bound exponential retries/}).click();await page.getByRole('button',{name:'Ask',exact:true}).click();
 }
 await expect(page.locator('#message')).toHaveValue('Latest question');
 if(scenario==='snapshot'){
  await expect(page.locator('#attachment')).toContainText('Outdated');await expect(page.locator('#save-note')).toBeDisabled();
  expect((await app.service.load()).snapshot.head).toBe(fixtureGit(app.service.config.repository,'rev-parse','HEAD'));
 }
 if(scenario==='removed item'){
  await expect(page.locator('#item-details')).toContainText('no longer in the plan');await expect(page.locator('#save-note')).toBeDisabled();
  await expect(page.getByRole('button',{name:'! P1 · Retained draft',exact:true})).toHaveAttribute('aria-current','true');
  await expect(page.getByRole('button',{name:/P1 Bound exponential retries/})).toHaveCount(0);
  await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
  await expect(page.getByRole('button',{name:'! P1 · Retained draft',exact:true})).toHaveAttribute('aria-current','false');
  await page.getByRole('button',{name:'! P1 · Retained draft',exact:true}).click();
  await expect(page.getByRole('button',{name:'! P1 · Retained draft',exact:true})).toHaveAttribute('aria-current','true');
  await expect(page.locator('#message')).toHaveValue('Latest question');await expect(page.locator('#message')).toBeEnabled();
  expect((await app.service.load()).items.map(item=>item.id)).toEqual(['P2','P3']);
 }
 expect((await app.service.load()).notes).toHaveLength(0);
});
for(const switchItem of [false,true]) test(`preserves edits made while a question submission is in flight (switch item: ${switchItem})`,async({page})=>{
 await openReview(page, app.url);await expect(page.getByRole('heading',{name:'Bound exponential retries'})).toBeVisible();
 let release!:()=>void,arrived!:(body:string)=>void;const held=new Promise<void>(resolve=>release=resolve),submitted=new Promise<string>(resolve=>arrived=resolve);
 await page.route('**/api/action',async route=>{arrived(route.request().postData()??'');await held;await route.continue();});
 await page.getByLabel('Question about this item').fill('Submitted question');await page.getByRole('button',{name:'Ask agent',exact:true}).click();
 expect(JSON.parse(await submitted)).toMatchObject({action:'note',item:'P1',kind:'question',text:'Submitted question'});
 await page.getByLabel('Question about this item').fill('New unsent draft');
 if(switchItem){await page.getByRole('button',{name:/P2 Document retry behavior/}).click();await page.getByLabel('Question about this item').fill('Other item draft');}
 release();
 if(switchItem){await expect(page.locator('#saved')).toContainText('Question submitted');await expect(page.getByLabel('Question about this item')).toHaveValue('Other item draft');await page.getByRole('button',{name:/P1 Bound exponential retries/}).click();}
 await expect(page.getByText('Submitted question',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Question about this item')).toHaveValue('New unsent draft');
 expect(app.service.store.getReviewNotes(app.service.config.identity).map(note=>note.text)).toEqual(['Submitted question']);
});
test('warns on completed answers when a snippet assignment changes',async({page})=>{
 const service=app.service,identity=service.config.identity,initial=await service.load();
 const foreign=initial.segments.find(s=>s.row==='Unplanned'&&s.operation==='+')!;
 const assigned=await service.act({action:'assign',item:'P1',key:foreign.key,token:initial.token});
 const asked=await service.act({action:'note',item:'P1',kind:'question',text:'Explain assigned code',reference:{key:foreign.key,start:foreign.newLine,end:foreign.newLine},token:assigned.token});
 service.store.beginAnswer(identity,asked.createdNoteId!,'completed');service.store.finishAnswer(identity,asked.createdNoteId!,'completed',{status:'complete',text:'Historical answer'});
 const index=initial.segments.findIndex(s=>s.key===foreign.key);
 service.store.saveReview(identity,asked.expected,[],[{action:'assign',item:'P2',key:choiceKeys(initial.segments,identity)[index]!}]);
 await openReview(page, app.url);
 await expect(page.locator('.agent-answer')).toContainText('Historical answer');
 await expect(page.locator('.agent-answer')).toContainText('Answer refers to earlier code or review context.');
});
test('drains an in-flight question request before closing its agent manager',async()=>{
 const config=app.service.config;await app.close();let calls=0;
 app=await startServer(config,0,(_prompt,signal)=>{calls++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
 const view=await app.service.load(),body=JSON.stringify({action:'note',item:'P1',kind:'question',text:'Question during shutdown',token:view.token});
 const endpoint=new URL('/api/action',app.url);
 let response='',finish!:()=>void;const {admitted,marker}=requestAdmitted(app.server);
 const completed=new Promise<void>((resolve,reject)=>{
  const req=httpRequest(endpoint,{method:'POST',headers:{...marker,'x-codeboost-token':app.token,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
   res.setEncoding('utf8');res.on('data',chunk=>response+=chunk);res.on('end',resolve);
  });
  req.on('error',reject);req.write(body.slice(0,1));
  finish=()=>req.end(body.slice(1));
 });
 await Promise.race([admitted,completed]);const closing=app.close();finish();
 await Promise.all([closing,completed]);
 const reopened=new ReviewService(config);
 try {
  const note=(await reopened.load()).notes.find(note=>note.text==='Question during shutdown');
  // Shutdown had begun, so no agent was started; the saved question still gets a retryable failed answer.
  expect(calls).toBe(0);expect(note?.answer?.status).toBe('failed');expect(note?.answer?.error).toMatch(/Server stopped/);
  expect(JSON.parse(response).notes.some((candidate:{text:string})=>candidate.text==='Question during shutdown')).toBe(true);
 } finally {reopened.close();app=await startServer(config,0);}
});
test('drains an admitted merge request before closing its coordinator',async()=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);let appRef:typeof app,started!:(value?:void)=>void,release!:(value?:void)=>void,commandSignal:AbortSignal|undefined;
 const commandStarted=new Promise<void>(resolve=>{started=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await appRef.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async(_head,options)=>{commandSignal=options?.signal;started();await held;return {url:'https://github.com/example/repo/pull/24'};}};
 app=appRef=await startServer(config,0,undefined,gateway);let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const endpoint=new URL('/api/action',app.url),body=JSON.stringify({action:'merge',token:view.token,actionId:randomUUID()});let status=0;
 const completed=new Promise<void>((resolve,reject)=>{const req=httpRequest(endpoint,{method:'POST',headers:{'x-codeboost-token':app.token,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{status=res.statusCode??0;res.resume();res.on('end',resolve);});req.on('error',reject);req.end(body);});
 await commandStarted;const closing=app.close();await new Promise(resolve=>setTimeout(resolve,25));expect(commandSignal?.aborted).toBe(false);release();await Promise.all([closing,completed]);expect(status).toBe(200);app=await startServer(config,0);
});
test('bounds shutdown draining before aborting active queue polling',async()=>{
 const config={...app.service.config,demo:false};await app.close();let appRef:typeof app,started!:(value?:void)=>void,settled=false;
 const pollingStarted=new Promise<void>(resolve=>{started=resolve;});
 const gateway:MergeGateway&MergeQueueGateway={inspect:async()=>{const snapshot=(await appRef.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:true,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},queueWatermark:async()=>null,merge:async()=>({url:'https://github.com/example/repo/pull/24'}),inspectQueue:async(_head,options)=>new Promise<never>((_resolve,reject)=>{started();options?.signal?.addEventListener('abort',()=>{settled=true;reject(options.signal?.reason);},{once:true});})};
 app=appRef=await startServer(config,0,undefined,gateway,50);const view=await app.service.load(),attempt=app.service.store.beginMergeAttempt(config.identity,{...view.expected,reviewVersion:view.expected.reviewVersion!},view.snapshot.head);app.service.store.queueMergeAttempt(config.identity,attempt.id,'https://github.com/example/repo/pull/24');
 const response=fetch(new URL('/api/merge',app.url),{headers:{'x-codeboost-token':app.token}});await pollingStarted;await app.close();expect(settled).toBe(true);expect((await response).status).toBe(409);app=await startServer(config,0);
});
test('aborts an admitted review status inspection after the shutdown drain',async()=>{
 const config={...app.service.config,demo:false};await app.close();let started!:(value?:void)=>void,settled=false;const inspectionStarted=new Promise<void>(resolve=>{started=resolve;});
 const gateway:MergeGateway={inspect:async options=>new Promise<never>((_resolve,reject)=>{started();options?.signal?.addEventListener('abort',()=>{settled=true;reject(options.signal?.reason);},{once:true});}),merge:async()=>({url:''})};
 app=await startServer(config,0,undefined,gateway,50);const response=fetch(new URL('/api/review',app.url),{headers:{'x-codeboost-token':app.token}});await inspectionStarted;await app.close();expect(settled).toBe(true);expect((await response).status).toBe(409);app=await startServer(config,0);
});
test('destroys a partial request body after the shutdown drain',async()=>{
 const config=app.service.config;await app.close();app=await startServer(config,0,undefined,undefined,50);
 const endpoint=new URL('/api/action',app.url),body=JSON.stringify({action:'note'}),{admitted,marker}=requestAdmitted(app.server);
 const completed=new Promise<'response'|'error'>(resolve=>{
  const req=httpRequest(endpoint,{method:'POST',headers:{...marker,'x-codeboost-token':app.token,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve('response'));});
  req.on('error',()=>resolve('error'));req.write(body.slice(0,1));
 });
 await admitted;const started=Date.now();await app.close();expect(Date.now()-started).toBeLessThan(1000);expect(await completed).toBe('error');app=await startServer(config,0);
});
test('blocks a partially received merge request when shutdown starts',async()=>{
 const config={...app.service.config,demo:false};await app.close();let mergeCalls=0;let appRef:typeof app;
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await appRef.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{mergeCalls++;return {url:''};}};
 app=appRef=await startServer(config,0,undefined,gateway);let view=await app.service.load();
 for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});
 for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const body=JSON.stringify({action:'merge',token:view.token,actionId:randomUUID()}),endpoint=new URL('/api/action',app.url);let status=0,response='',finish!:()=>void;const {admitted,marker}=requestAdmitted(app.server);
 // Another client, such as a polling tab, reaches the server first; shutdown must still wait for the merge request itself.
 expect((await fetch(new URL('/api/settings',app.url),{headers:{'x-codeboost-token':app.token}})).status).toBe(200);
 const completed=new Promise<void>((resolve,reject)=>{const req=httpRequest(endpoint,{method:'POST',headers:{...marker,'x-codeboost-token':app.token,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{status=res.statusCode??0;res.setEncoding('utf8');res.on('data',chunk=>response+=chunk);res.on('end',resolve);});req.on('error',reject);req.write(body.slice(0,1));finish=()=>req.end(body.slice(1));});
 await Promise.race([admitted,completed]);const closing=app.close();finish();await Promise.all([closing,completed]);
 expect(status).toBe(503);expect(JSON.parse(response).error).toMatch(/shutting down/i);expect(mergeCalls).toBe(0);app=await startServer(config,0);
});
test('hides Retry until a timed-out invocation has actually settled',async({page})=>{
 const config=app.service.config;await app.close();let settle!:(answer:string)=>void;
 app=await startServer(config,0,()=>new Promise(resolve=>settle=resolve));
 await openReview(page, app.url);await page.getByLabel('Question about this item').fill('Slow question');await page.getByRole('button',{name:'Ask agent',exact:true}).click();
 await expect(page.getByText('Agent · Answering…',{exact:true})).toBeVisible();
 const note=app.service.store.getReviewNotes(config.identity).find(note=>note.text==='Slow question')!;
 app.service.store.finishAnswer(config.identity,note.id,note.answer!.attempt,{status:'failed',error:'Agent timed out. Try again.'});
 await reloadReview(page);
 await expect(page.getByText('Agent · Finishing cancellation…',{exact:true})).toBeVisible({timeout:10000});
 await expect(page.getByRole('button',{name:'Retry answer',exact:true})).toHaveCount(0);
 settle('Late answer');
 await expect(page.getByRole('button',{name:'Retry answer',exact:true})).toBeVisible({timeout:10000});
});
/** Whether the element is drawn with the muted surface background a control that cannot act uses (poll it: buttons may animate their background). */
const looksInactive=(locator:import('@playwright/test').Locator)=>locator.evaluate(el=>{const probe=document.createElement('div');probe.style.background='var(--surface)';document.body.append(probe);
 const surface=getComputedStyle(probe).backgroundColor;probe.remove();return getComputedStyle(el).backgroundColor===surface;});
/** The blockers a runner server's review lists while a merge job prepares (runner/merge.ts): preparation has not completed
 * for the review, and a required check is pending. The job resolves both. */
const jobResolvedBlockers=[{code:'preparation',message:'The merge has not been prepared for the current review; merging prepares it.'},{code:'check',message:'ci is pending.'}];
/** A runner server's merge status (runner/merge-job.ts withMergeJob): `merge` with `fields` over it, and the blocker codes a
 * job settles once it asks GitHub to merge, which withMergeJob always sends. Build every runner-mode merge status with it. */
const runnerMerge=(merge:Record<string,unknown>,fields:Record<string,unknown>={})=>({...merge,...fields,settledBeforeJobMerge:SETTLED_BEFORE_JOB_MERGE});
/** A merge job record with every field the server sends (runner/merge-job.ts mergeJobView: the store's record without its
 * token), `fields` overriding the defaults. A job saves its merge action ID before the guarded merge, so one in that step or
 * past it (merged, queued, submitted) carries one by default. Every saved change adds one to a job's revision
 * (runner/store.ts #changeMergeJob): the job is saved at 1 while it prepares, moves to checks at 2 with no waiting checks,
 * saves each inspection that finds checks waiting (runner/merge-job.ts), then moves to merging and ends with one more
 * save each. By default a record follows the course preparing 1, checks 2 (none waiting) or 3 (first wait), merging 4,
 * ended 5; a test that sends a further inspection, a shorter course, or an older record on purpose passes its revision. */
const mergeJobRecord=(fields:Partial<MergeJobView>={}):MergeJobView=>{
 const state=fields.state??'running',step=fields.step===undefined?(state==='running'?'preparing':null):fields.step;
 const mergeActionId=step==='merging'||['merged','queued','submitted'].includes(state)?'0f6b0000-0000-4000-8000-00000000ac01':null;
 const revision=state==='running'?(step==='checks'?((fields.checks??[]).length?3:2):({preparing:1,merging:4} as Record<string,number>)[step??'']??1):5;
 return {id:'0f6b0000-0000-4000-8000-000000000000',mergeActionId,reason:null,checks:[],url:null,sequence:1,revision,startedAt:'2026-10-11T00:00:00Z',updatedAt:'2026-10-11T00:00:00Z',...fields,state,step};
};
/** A blocked job's reason as production saves it: one failing required check (runner/merge-job.ts classify), then the
 * next step that blocking appends (FIX_THEN_RETRY in runner/store.ts). */
const CHECK_FAILED_BLOCK='Required check failed: ci. Fix it, then Retry merge.';
/** The merge control and its dialog once the page saw its job end: the outcome, the refresh request, and only `others`. */
async function expectEndedMergeJob(page:import('@playwright/test').Page,label:string,ended:string,others:string[]=[]){
 await expect(page.locator('#merge')).toHaveText(label);
 await expect(page.locator('#merge')).toHaveAttribute('aria-disabled','true');
 await expect(page.locator('#merge-details')).toHaveText('Merge status');
 await page.locator('#merge-details').click();
 await expect(page.locator('dialog h2')).toHaveText('Merge status');
 await expect(page.locator('dialog li')).toHaveText([ended,...others]);
 await page.keyboard.press('Escape');
}
test('shows only the outcome once a polled merge job ends, not the blockers it resolved (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const job=(state:MergeJobView['state'],step:MergeJobView['step'],checks:MergeJobView['checks']=[])=>mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000f1',state,step,checks});
 const steps=[job('running','checks',[{context:'ci',state:'pending'}]),job('merged',null)];let polls=0;
 // As a runner server answers: Merge PR is offered while only job-resolved blockers remain, and the click's review,
 // reloaded while the job prepares, still lists them.
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route),running=job('running','preparing');
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:running,blockers:[...review.merge.blockers,...jobResolvedBlockers]}),job:running})});});
 await page.route('**/api/merge',async route=>{const next=steps[Math.min(polls,steps.length-1)];polls++;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:next})});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{ready:true,action:'merge',job:null,blockers:[...body.merge.blockers,...jobResolvedBlockers]});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 const answered=page.waitForResponse(response=>response.url().endsWith('/api/action'));
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 // The page follows the job on the click's review, which lists the job-resolved blockers.
 expect((await (await answered).json()).merge.blockers.map((blocker:{code:string})=>blocker.code)).toEqual(['preparation','check']);
 await expect(page.getByRole('button',{name:'Waiting for checks…',exact:true})).toBeVisible({timeout:10_000});
 await expect(page.locator('#banner')).toHaveText('Merged. Refresh to see the result.',{timeout:15_000});
 await expectEndedMergeJob(page,'Merged','Merged. Refresh to see the result.');
});
test('keeps every blocker when the click is answered with a job that ended without merging (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 // A collaborator pushed while the job waited: its inspection listed the moved head first, so the job failed with that
 // reason alone (classify reports the first blocker). The same inspection found a merge conflict, and a required check
 // is still pending; the job settled neither.
 const head={code:'head',message:'The pull request head moved. Refresh the review.'};
 const conflict={code:'mergeable',message:'The pull request has merge conflicts.'};
 const failed=mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000f2',state:'failed',step:null,reason:head.message});
 let polls=0;
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:failed,blockers:[...review.merge.blockers,head,conflict,...jobResolvedBlockers]}),job:failed})});});
 await page.route('**/api/merge',async route=>{polls++;await route.continue();});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{ready:true,action:'merge',job:null,blockers:[...body.merge.blockers,...jobResolvedBlockers]});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 const answered=page.waitForResponse(response=>response.url().endsWith('/api/action'));
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 // This job never merged, so the codes it would have settled (served by the review, pinned in test/runner-publishing.test.ts)
 // stay listed.
 await answered;
 const ended=`Merge stopped. ${head.message} Merge again when ready. Refresh to see the result.`;
 await expect(page.locator('#banner')).toHaveText(ended);
 await expectEndedMergeJob(page,'Merge stopped',ended,[head.message,conflict.message,...jobResolvedBlockers.map(blocker=>blocker.message)]);
 expect(polls).toBe(0);
});
/** Ended jobs with the course production runs before each outcome and the reason it saves (runner/merge-job.ts). */
const endedMergeJobs:{state:MergeJobView['state'];course:MergeJobView[];reason:string;label:string;banner:string}[]=[
 // GitHub refused the job's merge: the job blocks with the refusal and FIX_THEN_RETRY (#endAsAttempt).
 {state:'blocked',course:[mergeJobRecord({step:'merging'})],reason:'GitHub refused the merge: Required status check "ci" is expected. Fix it, then Retry merge.',label:'Merge blocked',
  banner:'Approved, merge blocked. GitHub refused the merge: Required status check "ci" is expected. Fix it, then Retry merge.'},
 // The preparation's rebase made an approval stale (runner/pre-merge.ts): the job ends from its preparing step.
 {state:'review-required',course:[],reason:'P1 requires refreshed attribution or approval.',label:'Review needed',
  banner:'Review needed before merging. P1 requires refreshed attribution or approval.'},
 // GitHub accepted the merge, but saving its outcome failed.
 {state:'submitted',course:[mergeJobRecord({step:'merging'})],reason:'GitHub accepted the merge, but its outcome was not saved; it reconciles from GitHub.',label:'Merge submitted',
  banner:'Merge submitted; GitHub\'s outcome is not confirmed yet. GitHub accepted the merge, but its outcome was not saved; it reconciles from GitHub.'},
 // The task was cancelled while the job waited for checks.
 {state:'cancelled',course:[mergeJobRecord({step:'checks',checks:[{context:'ci',state:'pending'}]})],reason:'Task cancelled.',label:'Merge cancelled',banner:'Merge cancelled.'},
];
for(const variant of endedMergeJobs)test(`names a merge job that ended ${variant.state} on its control and banner (F6b)`,async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 // Each saved change adds one to the revision: preparing 1, then the course, then the end. A job past preparing has
 // checked (revision 2) before it waits (3) or merges (4); the course's records carry those defaults.
 const lastRevision=variant.course.at(-1)?.revision??1;
 const ended=mergeJobRecord({state:variant.state,step:null,reason:variant.reason,revision:lastRevision+1,
  mergeActionId:variant.course.some(job=>job.step==='merging')?'0f6b0000-0000-4000-8000-00000000ac01':null});
 const running=mergeJobRecord({step:'preparing'});
 let polls=0,released=false;
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:running,blockers:[...review.merge.blockers,...jobResolvedBlockers]}),job:running})});});
 // The merging step is held until the test has read its banner.
 await page.route('**/api/merge',async route=>{const next=polls<variant.course.length?variant.course[polls]!:ended;if(next.step!=='merging'||released)polls++;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:next})});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{ready:true,action:'merge',job:null,blockers:[...body.merge.blockers,...jobResolvedBlockers]});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 if(variant.course.some(job=>job.step==='merging')){
  await expect(page.getByRole('button',{name:'Merging…',exact:true})).toHaveAttribute('aria-disabled','true',{timeout:10_000});
  await expect(page.locator('#banner')).toHaveText('Merging the reviewed head.');
  released=true;
 }
 const banner=`${variant.banner} Refresh to see the result.`;
 await expect(page.locator('#banner')).toHaveText(banner,{timeout:15_000});
 // Only a job that asked GitHub to merge and was accepted (submitted) settled the blockers it resolves.
 await expectEndedMergeJob(page,variant.label,banner,variant.state==='submitted'?[]:jobResolvedBlockers.map(blocker=>blocker.message));
});
test('names a failed merge-job poll as a merge-status failure (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const running=mergeJobRecord({id:'0f6b0000-0000-4000-8000-000000000001',state:'running',step:'checks'});
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:running}),job:running})});});
 // A job is running and no merge queue exists; GitHub's status cannot be read.
 await page.route('**/api/merge',route=>route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'GitHub returned HTTP 502.'})}));
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.locator('#banner')).toHaveText(/^Could not refresh merge status\. GitHub returned HTTP 502\./,{timeout:15_000});
});

test('ends a running merge job the poll no longer reports, keeping every blocker (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const running=mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000f3',state:'running',step:'checks'});
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:running,blockers:[...review.merge.blockers,...jobResolvedBlockers]}),job:running})});});
 // The job is no longer reported (no job record and no merge queue): the page cannot tell whether it reached the merge.
 let polls=0;
 await page.route('**/api/merge',async route=>{polls++;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:null})});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{ready:true,action:'merge',job:null,blockers:[...body.merge.blockers,...jobResolvedBlockers]});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.getByRole('button',{name:'Waiting for checks…',exact:true})).toBeVisible({timeout:10_000});
 const ended='The merge job ended. Refresh to see the result.';
 await expect(page.locator('#banner')).toHaveText(ended,{timeout:15_000});
 await expect(page.getByText('Could not refresh merge status')).toHaveCount(0);
 // A job not known to have merged settled nothing, so every blocker the page last read stays listed.
 await expectEndedMergeJob(page,'Merge ended',ended,jobResolvedBlockers.map(blocker=>blocker.message));
 const seen=polls;expect(seen).toBe(1);
 // Past the 2 s poll delay (and its first back-off), no further status poll runs.
 await page.waitForTimeout(5_000);
 expect(polls).toBe(seen);
 await expect(page.locator('#banner')).toHaveText(ended);
});

/** A job's step list as the server saves it: `states` in order of the design's steps, timed from 00:00:00. */
const mergeSteps=(states:string[])=>['fetch','rebase','push','commands','checks','already-fixed','merge'].map((name,index)=>{const state=states[index]??'pending';
 return {name,state,startedAt:state==='pending'||state==='skipped'?null:`2026-10-11T00:00:0${index}Z`,endedAt:['pending','running'].includes(state)?null:`2026-10-11T00:00:0${index+1}Z`};}) as NonNullable<MergeJobView['steps']>;
test('shows the merge step list while a job runs, and cancels the merge alone from it (D16)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const id='0f6b0000-0000-4000-8000-0000000000d1';
 const rebasing=mergeJobRecord({id,state:'running',step:'preparing',revision:3,steps:mergeSteps(['done','running'])});
 const cancelling=mergeJobRecord({...rebasing,revision:4,cancelRequested:true});
 const cancelled=mergeJobRecord({...rebasing,state:'cancelled',step:null,revision:5,cancelRequested:true,reason:'You cancelled the merge; the task and its pull request stay open.',steps:mergeSteps(['done','stopped'])});
 let cancelAsked=false,cancels:unknown[]=[];
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();
  if(body.action==='cancel-merge'){cancels.push(body);cancelAsked=true;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({job:cancelling})});return;}
  if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route),running=mergeJobRecord({id,state:'running',step:'preparing',steps:mergeSteps([])});
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:running,blockers:[...review.merge.blockers,...jobResolvedBlockers]}),job:running})});});
 // The poll shows the rebase running until the cancel was asked. The first poll after it answers the older record (read
 // before the cancel was saved), which must not undo the adopted answer; then the job is cancelling, then cancelled.
 let afterCancel=0;
 await page.route('**/api/merge',async route=>{const job=!cancelAsked?rebasing:[rebasing,cancelling][afterCancel++]??cancelled;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job})});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{ready:true,action:'merge',job:null,blockers:[...body.merge.blockers,...jobResolvedBlockers]});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await expect(page.locator('#merge-steps-bar')).toBeHidden();
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 const steps=page.getByRole('list',{name:'Merge steps'});
 await expect(steps.getByRole('listitem')).toHaveCount(7);
 await expect(steps.getByRole('listitem').first()).toHaveText('✓ Fetch Done, 1 s',{timeout:10_000});
 await expect(steps.getByRole('listitem').nth(1)).toHaveText(/^● Rebase Running, \d+ (s|min \d\d s)$/);
 await expect(steps.getByRole('listitem').nth(2)).toHaveText('○ Push Waiting');
 const cancel=page.getByRole('button',{name:'Cancel merge',exact:true});
 await expect(cancel).toBeVisible();
 await expect(cancel).not.toHaveAttribute('aria-disabled','true');
 // An enabled Cancel is not described by the hidden "GitHub has been asked" note.
 await expect(cancel).toHaveAccessibleDescription('Stop this merge. The task and its pull request stay open.');
 const stalePoll=page.waitForResponse(response=>response.url().endsWith('/api/merge')&&cancelAsked);
 await cancel.click();
 expect(cancels).toEqual([{action:'cancel-merge',jobId:id}]);
 await expect(page.getByRole('button',{name:'Cancel requested',exact:true})).toHaveAttribute('aria-disabled','true');
 await expect(page.locator('#merge')).toHaveText('Cancelling…');
 await expect(page.locator('#banner')).toHaveText('Cancelling the merge. The task and its pull request stay open.');
 // The older record the next poll answers changes nothing on screen.
 expect((await (await stalePoll).json()).job.revision).toBe(3);
 await page.waitForTimeout(200);
 await expect(page.locator('#merge')).toHaveText('Cancelling…');
 await expect(page.locator('#merge-cancel')).toHaveText('Cancel requested');
 // The job ends: the list stays with the stopped step until Refresh, and Cancel goes away.
 await expect(page.locator('#merge')).toHaveText('Merge cancelled',{timeout:15_000});
 await expect(page.locator('#banner')).toContainText('Merge cancelled. You cancelled the merge; the task and its pull request stay open.');
 await expect(steps.getByRole('listitem').nth(1)).toHaveText('! Rebase Stopped, 1 s');
 await expect(page.locator('#merge-cancel')).toBeHidden();
 // The click left focus on Cancel; once it hides, focus moves to the merge control, not the page.
 await expect(page.locator('#merge')).toBeFocused();
 expect(cancels).toHaveLength(1);
});
test('shows the outcome at once when a cancel is answered with a job that already ended (D16)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const id='0f6b0000-0000-4000-8000-0000000000d3';
 const waiting=mergeJobRecord({id,state:'running',step:'checks',revision:3,steps:mergeSteps(['done','skipped','skipped','skipped','running'])});
 const merged=mergeJobRecord({id,state:'merged',step:null,revision:6,url:'https://github.com/owner/repo/pull/7',steps:mergeSteps(['done','skipped','skipped','skipped','done','done','done'])});
 // The job merged before the poll saw it; the cancel is refused with the ended job, and the poll then reports it too.
 let ended=false,polls=0;
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();
  if(body.action==='cancel-merge'){ended=true;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'This merge has already ended.',job:merged})});return;}
  if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:waiting}),job:waiting})});});
 await page.route('**/api/merge',async route=>{polls++;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:ended?merged:waiting})});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{ready:true,action:'merge',job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.locator('#merge-cancel')).toBeVisible({timeout:10_000});
 const before=polls;
 const polled=page.waitForResponse(response=>response.url().endsWith('/api/merge')&&ended);
 const clicked=Date.now();
 await page.locator('#merge-cancel').click();
 // The page asks the poll at once rather than waiting out its delay (2 s at least), and shows the outcome with the list.
 await polled;
 expect(Date.now()-clicked).toBeLessThan(1_500);
 expect(polls).toBe(before+1);
 await expect(page.locator('#merge')).toHaveText('Merged',{timeout:5_000});
 await expect(page.locator('#banner')).toHaveText('Merged. Refresh to see the result.');
 await expect(page.getByRole('list',{name:'Merge steps'}).getByRole('listitem').last()).toHaveText('✓ Merge Done, 1 s');
 await expect(page.locator('#merge-cancel')).toBeHidden();
 await expect(page.locator('#merge')).toBeFocused();
});
test('moves focus off Cancel to the merge control when the whole step bar hides (D16)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const id='0f6b0000-0000-4000-8000-0000000000d7';
 const waiting=mergeJobRecord({id,state:'running',step:'checks',revision:3,steps:mergeSteps(['done','skipped','skipped','skipped','running'])});
 // While Cancel holds focus, the poll stops reporting the job: the page ends it with no record, so the whole bar hides.
 let gone=false;
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:waiting}),job:waiting})});});
 await page.route('**/api/merge',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:gone?null:waiting})}));
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{ready:true,action:'merge',job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.locator('#merge-cancel')).toBeVisible({timeout:10_000});
 await page.locator('#merge-cancel').focus();
 gone=true;
 await expect(page.locator('#merge-steps-bar')).toBeHidden({timeout:15_000});
 await expect(page.locator('#merge')).toHaveText('Merge ended');
 await expect(page.locator('#merge')).toBeFocused();
});
test('shows a cancelled merge within seconds even after the merge-status poll has backed off (D16)',async({page})=>{
 test.setTimeout(120_000);
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const id='0f6b0000-0000-4000-8000-0000000000d4';
 const waiting=mergeJobRecord({id,state:'running',step:'checks',revision:3,steps:mergeSteps(['done','skipped','skipped','skipped','running'])});
 const cancelling=mergeJobRecord({...waiting,revision:4,cancelRequested:true});
 const cancelled=mergeJobRecord({...waiting,state:'cancelled',step:null,revision:5,cancelRequested:true,reason:'You cancelled the merge; the task and its pull request stay open.',steps:mergeSteps(['done','skipped','skipped','skipped','stopped'])});
 let cancelAsked=false;const polls:number[]=[];
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();
  if(body.action==='cancel-merge'){cancelAsked=true;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({job:cancelling})});return;}
  if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:waiting}),job:waiting})});});
 // The job waits unchanged, so the poll backs off (2 s, 4 s, 8 s, ...); once the cancel was asked the job has ended.
 await page.route('**/api/merge',async route=>{polls.push(Date.now());await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:cancelAsked?cancelled:waiting})});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{ready:true,action:'merge',job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 // Three unchanged answers: the next poll waits 16 s.
 await expect.poll(()=>polls.length,{timeout:30_000}).toBeGreaterThanOrEqual(3);
 const clicked=Date.now();
 await page.locator('#merge-cancel').click();
 await expect(page.locator('#merge')).toHaveText('Merge cancelled',{timeout:6_000});
 expect(Date.now()-clicked).toBeLessThan(4_000);
});
for (const answer of ['ended','newer'] as const) test(`polls again within seconds when a cancel is answered with ${answer==='ended'?'an ended job':'a newer job'} while a poll is on its way (D16)`,async({page})=>{
 test.setTimeout(120_000);
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const id='0f6b0000-0000-4000-8000-0000000000d5';
 const waiting=mergeJobRecord({id,state:'running',step:'checks',revision:3,steps:mergeSteps(['done','skipped','skipped','skipped','running'])});
 // Ended: it merged before the poll saw it. Newer: another tab's cancel ended it, then that tab started a new job.
 const later=answer==='ended'
  ?mergeJobRecord({id,state:'merged',step:null,revision:6,url:'https://github.com/owner/repo/pull/7',steps:mergeSteps(['done','skipped','skipped','skipped','done','done','done'])})
  :mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000d6',state:'running',step:'preparing',sequence:2,revision:2,steps:mergeSteps(['running'])});
 let release!:()=>void,arrived!:()=>void,hold=false,ended=false;const polls:number[]=[];
 const held=new Promise<void>(resolve=>release=resolve),inFlight=new Promise<void>(resolve=>arrived=resolve);
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();
  if(body.action==='cancel-merge'){ended=true;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'This merge has already ended.',job:later})});return;}
  if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:waiting}),job:waiting})});});
 // The held poll read the job before it ended, so it answers the running record when released.
 await page.route('**/api/merge',async route=>{polls.push(Date.now());
  if(hold&&!ended){hold=false;arrived();await held;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:waiting})});return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:ended?later:waiting})});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{ready:true,action:'merge',job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 // Let the poll back off (2 s, 4 s, 8 s), then hold the next one in flight.
 await expect.poll(()=>polls.length,{timeout:30_000}).toBeGreaterThanOrEqual(3);
 hold=true;await inFlight;
 await page.locator('#merge-cancel').click();
 // The refusal is shown while the cancelled job is still the one shown; a newer job is followed at once instead.
 if(answer==='ended') await expect(page.locator('#banner')).toHaveText('Could not cancel the merge. This merge has already ended.');
 else await expect(page.locator('#banner')).toHaveText('Preparing the merge: refresh, rebase, push and command checks.');
 const released=Date.now();release();
 // The next poll comes 2 s after the held one, not after its backed-off delay of 16 s or more.
 if(answer==='ended') await expect(page.locator('#merge')).toHaveText('Merged',{timeout:6_000});
 else await expect(page.getByRole('list',{name:'Merge steps'}).getByRole('listitem').first()).toHaveText(/^● Fetch Running/,{timeout:6_000});
 expect(Date.now()-released).toBeLessThan(5_000);
});
for (const reload of ['unavailable','failed','ended'] as const) test(`moves focus off Cancel when a reload ${{failed:'fails',unavailable:'hides the merge control',ended:'shows the job ended'}[reload]} (D16)`,async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const waiting=mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000d8',state:'running',step:'checks',revision:3,steps:mergeSteps(['done','skipped','skipped','skipped','running'])});
 let reloaded=false;
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:waiting}),job:waiting})});});
 await page.route('**/api/merge',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:waiting})}));
 // The reload answers a review whose merging is not available (the merge control hides), or fails (every merge control hides).
 await page.route('**/api/review',async route=>{
  if(reloaded&&reload==='failed'){await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Could not read this branch\'s history.'})});return;}
  const response=await route.fetch(),body=await response.json();
  body.merge=reloaded?(reload==='ended'?runnerMerge(body.merge,{ready:false,action:null,job:mergeJobRecord({...waiting,state:'merged',step:null,revision:6,url:'https://github.com/owner/repo/pull/7'})}):{...body.merge,available:false})
   :runnerMerge(body.merge,{ready:true,action:'merge',job:null});
  await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.locator('#merge-cancel')).toBeVisible({timeout:10_000});
 await page.locator('#merge-cancel').focus();
 reloaded=true;
 const answered=page.waitForResponse(response=>response.url().endsWith('/api/review'));
 // A synthetic click on the Review link reloads the review without moving focus off Cancel.
 await page.locator('#review-link').dispatchEvent('click');
 await answered;
 await expect(page.locator('#merge-steps-bar')).toBeHidden();
 if(reload==='ended'){
  // The merge control is still shown, so focus moves to it.
  await expect(page.locator('#merge')).toBeVisible();
  await expect(page.locator('#merge')).toBeFocused();
 } else {
  await expect(page.locator('#merge')).toBeHidden();
  await expect(page.locator('#reload')).toBeFocused();
 }
});
for (const refusal of ['ended','older','newer'] as const) test(`keeps what the poll showed when a cancel's refusal carrying ${{ended:'the ended job',older:'an older record of it',newer:'a newer running job'}[refusal]} arrives after the poll saw the job end (D16)`,async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const id='0f6b0000-0000-4000-8000-0000000000da';
 const waiting=mergeJobRecord({id,state:'running',step:'checks',revision:3,steps:mergeSteps(['done','skipped','skipped','skipped','running'])});
 const merged=mergeJobRecord({id,state:'merged',step:null,revision:6,url:'https://github.com/owner/repo/pull/7',steps:mergeSteps(['done','skipped','skipped','skipped','done','done','done'])});
 const newer=mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000db',state:'running',step:'preparing',sequence:2,revision:2,steps:mergeSteps(['running'])});
 // The refusal's job: the same ended record, an older running record of it (read before the job ended), or a newer job.
 const carried={ended:merged,older:waiting,newer}[refusal];
 const reason={ended:'This merge has already ended.',older:'GitHub has been asked to merge; wait for its outcome.',newer:'This merge has already ended.'}[refusal];
 let release!:()=>void,asked!:()=>void,ended=false;
 const held=new Promise<void>(resolve=>release=resolve),cancelAsked=new Promise<void>(resolve=>asked=resolve);
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();
  if(body.action==='cancel-merge'){asked();await held;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:reason,job:carried})});return;}
  if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:waiting}),job:waiting})});});
 // Once the cancel was sent, the poll sees the job merged; the refusal is held until then.
 const polls:string[]=[];
 await page.route('**/api/merge',async route=>{const job=ended?merged:waiting;polls.push(job.state);await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job})});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{ready:true,action:'merge',job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.locator('#merge-cancel')).toBeVisible({timeout:10_000});
 await page.locator('#merge-cancel').click();
 await cancelAsked;ended=true;
 await expect(page.locator('#merge')).toHaveText('Merged',{timeout:15_000});
 await expect(page.locator('#banner')).toHaveText('Merged. Refresh to see the result.');
 const pollsBefore=polls.length;
 const refused=page.waitForResponse(response=>response.url().endsWith('/api/action'));
 release();await refused;
 await page.waitForTimeout(300);
 if(refusal==='newer'){
  // The newer job is followed: its step list and step show.
  await expect(page.locator('#merge')).toHaveText('Preparing…');
  await expect(page.getByRole('list',{name:'Merge steps'}).getByRole('listitem').first()).toHaveText(/^● Fetch Running/);
  await expect(page.locator('#banner')).toHaveText('Preparing the merge: refresh, rebase, push and command checks.');
 } else {
  // The outcome, its banner and the step list stay; the refusal is not shown, and no poll is forced.
  await expect(page.locator('#merge')).toHaveText('Merged');
  await expect(page.locator('#banner')).toHaveText('Merged. Refresh to see the result.');
  await expect(page.getByRole('list',{name:'Merge steps'}).getByRole('listitem').last()).toHaveText('✓ Merge Done, 1 s');
  expect(polls.length).toBe(pollsBefore);
 }
});
test('shows the refusal in the banner when an enabled Cancel is refused because GitHub was asked (D16)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 // The Merge step's write failed (steps are display only), so the list still shows it waiting while GitHub was asked.
 const merging=mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000dc',state:'running',step:'merging',steps:mergeSteps(['done','skipped','skipped','skipped','done','running'])});
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();
  if(body.action==='cancel-merge'){await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'GitHub has been asked to merge; wait for its outcome.',job:merging})});return;}
  if(body.action!=='merge'){await route.continue();return;}
  started=true;const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:merging}),job:merging})});});
 let failNext=false;
 await page.route('**/api/merge',route=>{if(failNext){failNext=false;return route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'GitHub returned HTTP 502.'})});}
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:merging})});});
 // As a runner server answers a full review: the running job rides along once the click started it.
 let started=false;
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,started?{ready:false,action:null,job:merging}:{ready:true,action:'merge',job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 const cancel=page.getByRole('button',{name:'Cancel merge',exact:true});
 await expect(cancel).not.toHaveAttribute('aria-disabled','true',{timeout:10_000});
 await cancel.click();
 await expect(page.locator('#banner')).toHaveText('Could not cancel the merge. GitHub has been asked to merge; wait for its outcome.');
 await expect(page.locator('#merge')).toHaveText('Merging…');
 // The next poll answers the same record: the refusal stays, as the only explanation of the enabled Cancel.
 const polled=page.waitForResponse(response=>response.url().endsWith('/api/merge'));
 await polled;await page.waitForTimeout(200);
 await expect(page.locator('#banner')).toHaveText('Could not cancel the merge. GitHub has been asked to merge; wait for its outcome.');
 // One poll fails and rewrites the banner; the next poll, answering the same record, shows the refusal again.
 failNext=true;
 await expect(page.locator('#banner')).toHaveText(/^Could not refresh merge status\./,{timeout:15_000});
 await expect(page.locator('#banner')).toHaveText('Could not cancel the merge. GitHub has been asked to merge; wait for its outcome.',{timeout:40_000});
 // Refresh rewrites the banner too; the next poll, answering the same record, shows the refusal again.
 const reloaded=page.waitForResponse(response=>response.url().endsWith('/api/review'));
 await page.locator('#reload').click();await reloaded;
 await expect(page.locator('#banner')).not.toHaveText(/^Could not cancel the merge\./);
 await expect(page.locator('#banner')).toHaveText('Could not cancel the merge. GitHub has been asked to merge; wait for its outcome.',{timeout:40_000});
});
test('disables Cancel once the merge job asked GitHub to merge (D16)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const merging=mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000d2',state:'running',step:'merging',steps:mergeSteps(['done','skipped','skipped','skipped','done','done','running'])});
 let cancels=0;
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();
  if(body.action==='cancel-merge'){cancels++;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'GitHub has been asked to merge; wait for its outcome.',job:merging})});return;}
  if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:merging}),job:merging})});});
 await page.route('**/api/merge',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:merging})}));
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{ready:true,action:'merge',job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 const cancel=page.locator('#merge-cancel');
 await expect(cancel).toHaveAttribute('aria-disabled','true',{timeout:10_000});
 await expect(cancel).toHaveAttribute('title','GitHub has been asked to merge; wait for its outcome.');
 // A disabled Cancel ignores clicks, so the reason is written beside it and describes it.
 await expect(page.locator('#merge-cancel-note')).toBeVisible();
 await expect(cancel).toHaveAccessibleDescription('GitHub has been asked to merge; wait for its outcome.');
 await expect(page.getByRole('list',{name:'Merge steps'}).getByRole('listitem').nth(1)).toHaveText('– Rebase Skipped');
 await cancel.click({force:true});
 expect(cancels).toBe(0);
});
test('keeps a draft typed while a merge-job click is in flight (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const job=(id:string,state:MergeJobView['state'],step:MergeJobView['step'],sequence=1)=>mergeJobRecord({id,state,step,sequence,reason:state==='blocked'?CHECK_FAILED_BLOCK:null});
 let started:MergeJobView|null=null,release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  await held;const review=await clickReview(route),running=job(body.actionId,'running','preparing');started=running;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:running}),job:running})});});
 await page.route('**/api/merge',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:started})}));
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
 await page.getByLabel('Question about this item').fill('Before the click.');
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 // The person keeps typing while the click's request is in flight.
 await page.getByLabel('Question about this item').fill('Typed while the merge request was in flight.');
 release();
 await expect(page.getByRole('button',{name:'Preparing…',exact:true})).toHaveAttribute('aria-disabled','true');
 await expect(page.getByLabel('Question about this item')).toHaveValue('Typed while the merge request was in flight.');
});

for(const refusal of [{name:'refused',status:409,error:'Issue #1 is not trusted for its current author.'},{name:'not applied',status:503,error:'The review server is shutting down.'}])
test(`keeps a draft typed while a merge-job click is in flight and then ${refusal.name} (F6b)`,async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  // A merge-job refusal (409) carries the task's latest job, none here; a shutdown (503) carries only its error.
  await held;await route.fulfill({status:refusal.status,contentType:'application/json',body:JSON.stringify(refusal.status===409?{error:refusal.error,job:null}:{error:refusal.error})});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
 await page.getByLabel('Question about this item').fill('Before the click.');
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 // The person keeps typing while the click's request is in flight; the click then fails.
 await page.getByLabel('Question about this item').fill('Typed while the merge request was in flight.');
 release();
 await expect(page.locator('#banner')).toContainText(refusal.error);
 await expect(page.getByLabel('Question about this item')).toHaveValue('Typed while the merge request was in flight.');
});

// Records the delay of every timer of 500 ms or more the page schedules: the merge poll's delays, read without timing the
// round trips (which vary with machine load).
const recordPollDelays=(page:Page)=>page.addInitScript(()=>{const delays:number[]=[];(window as typeof window&{__mergePollDelays:number[]}).__mergePollDelays=delays;const native=window.setTimeout.bind(window);window.setTimeout=((handler:TimerHandler,timeout?:number,...args:unknown[])=>{if(typeof timeout==='number'&&timeout>=500)delays.push(timeout);return native(handler,timeout,...args);}) as typeof window.setTimeout;});
const pollDelays=(page:Page)=>page.evaluate(()=>(window as typeof window&{__mergePollDelays:number[]}).__mergePollDelays.slice());
// Runs a merge job whose click answers `steps[0]` and whose polls answer the rest in order, then returns the poll delays.
async function mergeJobPollDelays(page:Page,steps:MergeJobView[]){
 await recordPollDelays(page);
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const [clicked,...polled]=steps;let polls=0;
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:clicked}),job:clicked})});});
 await page.route('**/api/merge',async route=>{const next=polled[Math.min(polls,polled.length-1)];polls++;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:next})});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.locator('#banner')).toHaveText('Merged. Refresh to see the result.',{timeout:30_000});
 expect(polls).toBe(polled.length);
 return pollDelays(page);
}

test('backs off the merge-job poll while the job does not change, and polls soon again once its step changes (F6b)',async({page})=>{
 const checks=[{context:'ci',state:'pending'}],waiting=mergeJobRecord({state:'running',step:'checks',checks}),merging=mergeJobRecord({state:'running',step:'merging',checks});
 // The click shows `waiting`; poll 1 sees it again (no change); poll 2 a new step; poll 3 that step again; poll 4 the end.
 const delays=await mergeJobPollDelays(page,[waiting,waiting,merging,merging,mergeJobRecord({state:'merged',step:null})]);
 // 2 s after the click, doubled to 4 s after the unchanged poll, back to 2 s after the step changed, doubled again after
 // the next unchanged one. The job's end schedules nothing.
 expect(delays).toEqual([2000,4000,2000,4000]);
});

test('does not back off the merge-job poll when only the waiting checks change within a step (F6b)',async({page})=>{
 const waiting=(checks:MergeJobView['checks'],revision:number)=>mergeJobRecord({state:'running',step:'checks',checks,revision});
 // As production saves them: the first wait at revision 3, the changed check list at 4, then merging at 5 (not polled
 // here) and the end at 6.
 const pending=waiting([{context:'ci',state:'pending'}],3),progressed=waiting([{context:'ci',state:'pending'},{context:'lint',state:'pending'}],4);
 // The click shows `pending`; poll 1 sees it again (no change); poll 2 a changed check list in the same step; poll 3 the end.
 const delays=await mergeJobPollDelays(page,[pending,pending,progressed,mergeJobRecord({state:'merged',step:null,revision:6})]);
 // 2 s after the click, doubled to 4 s after the unchanged poll; the changed checks keep it at 4 s (the step is the same,
 // so the delay is not reset to 2 s either).
 expect(delays).toEqual([2000,4000,4000]);
});

test('starts a new action for Retry merge once the job its retained key started has ended (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const job=(id:string,state:MergeJobView['state'],step:MergeJobView['step'],sequence=1)=>mergeJobRecord({id,state,step,sequence,reason:state==='blocked'?CHECK_FAILED_BLOCK:null});
 const clicks:string[]=[];let first:string|null=null,started:MergeJobView|null=null;
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}clicks.push(body.actionId);
  if(clicks.length===1){first=body.actionId;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'The review server is shutting down.'})});return;}
  const review=await clickReview(route),running=job(body.actionId,'running','preparing',2);started=running;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:running}),job:running})});});
 await page.route('**/api/merge',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:started})}));
 // The first click's job was saved and has since ended blocked: the review offers Retry merge.
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{job:first?job(first,'blocked',null):null,...(first?{ready:true,action:'retry'}:{})});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.locator('#banner')).toContainText('Merge blocked.');
 const reloaded=page.waitForResponse(response=>response.url().endsWith('/api/review'));
 await page.locator('#review-link').click();await reloaded;
 await page.getByRole('button',{name:'Retry merge',exact:true}).click();
 await expect.poll(()=>clicks.length).toBe(2);
 // The retry is a new action: resending the first key would only replay the ended job.
 expect(clicks[1]).not.toBe(clicks[0]);
});

test('starts a new action once another job became the latest after a retained key (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const job=(id:string,state:MergeJobView['state'],step:MergeJobView['step'],sequence=1)=>mergeJobRecord({id,state,step,sequence,reason:state==='blocked'?CHECK_FAILED_BLOCK:null});
 const clicks:string[]=[];let first:string|null=null,started:MergeJobView|null=null;
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}clicks.push(body.actionId);
  if(clicks.length===1){first=body.actionId;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'The review server is shutting down.'})});return;}
  const review=await clickReview(route),running=job(body.actionId,'running','preparing',3);started=running;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:running}),job:running})});});
 await page.route('**/api/merge',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:started})}));
 // The first click's job ended, then another client's job ran and ended blocked: the latest job is not this key's.
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{job:first?job('0f6b0000-0000-4000-8000-0000000000b2','blocked',null,2):null,...(first?{ready:true,action:'retry'}:{})});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.locator('#banner')).toContainText('Merge blocked.');
 const reloaded=page.waitForResponse(response=>response.url().endsWith('/api/review'));
 await page.locator('#review-link').click();await reloaded;
 await page.getByRole('button',{name:'Retry merge',exact:true}).click();
 await expect.poll(()=>clicks.length).toBe(2);
 // The retry is a new action: resending the first key would only replay the ended job.
 expect(clicks[1]).not.toBe(clicks[0]);
});

test('resends the same action for Retry merge after a retry failed while an earlier job is shown (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const blocked=mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000a1',state:'blocked',step:null,reason:CHECK_FAILED_BLOCK});
 // Every retry answers 503: nothing was applied, so the click is unresolved and its key must be resent.
 const clicks:string[]=[];
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}clicks.push(body.actionId);
  await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'The review server is shutting down.'})});});
 // An earlier job ended blocked: the review offers Retry merge, and keeps showing that job.
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{job:blocked,ready:true,action:'retry'});await route.fulfill({response,json:body});});
 const confirms:string[]=[];
 await page.goto(app.url);page.on('dialog',dialog=>{confirms.push(dialog.message());void dialog.accept();});
 await page.getByRole('button',{name:'Retry merge',exact:true}).click();
 await expect(page.locator('#banner')).toContainText('Merge blocked. The review server is shutting down.');
 const reloaded=page.waitForResponse(response=>response.url().endsWith('/api/review'));
 await page.locator('#review-link').click();await reloaded;
 await page.getByRole('button',{name:'Retry merge',exact:true}).click();
 await expect.poll(()=>clicks.length).toBe(2);
 // The earlier job is not this click's: the unresolved click is resent with its own key.
 expect(clicks[1]).toBe(clicks[0]);
 // A job's retry prepares again and may rebase onto a new head, so it does not promise the exact reviewed head.
 const retry='Retry the merge? It prepares the merge again, which may rebase onto the current base and need a new review.';
 expect(confirms).toEqual([retry,retry]);
});

// The server orders records of one job by revision, never clock time: the held running record's update time may equal or
// follow the outcome's (two saves in one clock tick, or a clock step back between them).
for(const clock of [{name:'',runningAt:'2026-10-11T00:00:00Z'},{name:' with the same update time',runningAt:'2026-10-11T00:05:00Z'},{name:' with a later update time',runningAt:'2026-10-11T00:09:00Z'}])
test(`keeps a merge-job outcome a poll saw while an older Refresh response was held${clock.name} (F6b)`,async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const running=mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000c1',state:'running',step:'preparing',updatedAt:clock.runningAt});
 const merged=mergeJobRecord({...running,mergeActionId:'0f6b0000-0000-4000-8000-00000000ac01',state:'merged',step:null,url:'https://github.com/owner/repo/pull/7',revision:5,updatedAt:'2026-10-11T00:05:00Z'});
 let ended=false,hold=false,polls=0,release!:()=>void,holding!:()=>void;
 const released=new Promise<void>(resolve=>{release=resolve;}),held=new Promise<void>(resolve=>{holding=resolve;});
 await page.route('**/api/merge',route=>{polls++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:ended?merged:running})});});
 // Every review response was read while the job ran; the Refresh response is held until the poll has seen it end. As a
 // runner server's review read during preparation does, each lists the blockers the job resolves.
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{ready:false,action:null,job:running,blockers:[...body.merge.blockers,...jobResolvedBlockers]});
  if(hold){hold=false;holding();await released;}
  await route.fulfill({response,json:body});});
 await page.goto(app.url);
 await expect(page.getByRole('button',{name:'Preparing…',exact:true})).toBeVisible();
 hold=true;
 const refreshed=page.waitForResponse(response=>response.url().endsWith('/api/review'));
 await page.locator('#review-link').click();await held;
 // Selecting an item while Refresh waits renders the merge control, which schedules a poll; that poll sees the job end.
 ended=true;
 await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
 await expect(page.locator('#banner')).toHaveText('Merged. Refresh to see the result.',{timeout:10_000});
 const seen=polls;
 release();await refreshed;
 // The older Refresh response does not restore the running job: no poll restarts (the poll interval is 2 s), and the
 // page still shows the outcome.
 await page.waitForTimeout(3_000);
 expect(polls).toBe(seen);
 await expect(page.locator('#banner')).toHaveText('Merged. Refresh to see the result.');
 await expect(page.getByRole('button',{name:'Preparing…',exact:true})).toHaveCount(0);
 // The held response's blockers were the job's own: the control and dialog show only the outcome.
 await expectEndedMergeJob(page,'Merged','Merged. Refresh to see the result.');
});

test('keeps a newer merge job a poll saw while a held Refresh response shows an earlier job ended (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 // Job A runs in this tab. Another tab's click starts job B after A ends; B's record is later than any of A's (sequence),
 // while its clock times are earlier, as after a clock step back.
 const jobA=mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000e1',state:'running',step:'preparing',sequence:1,startedAt:'2026-10-11T00:10:00Z',updatedAt:'2026-10-11T00:10:00Z'});
 const blockedA=mergeJobRecord({...jobA,state:'blocked',step:null,reason:CHECK_FAILED_BLOCK,revision:3,updatedAt:'2026-10-11T00:20:00Z'});
 const jobB=mergeJobRecord({...jobA,id:'0f6b0000-0000-4000-8000-0000000000e2',step:'checks',sequence:2,revision:2,startedAt:'2026-10-11T00:00:00Z',updatedAt:'2026-10-11T00:00:00Z'});
 let started=false,hold=false,polls=0,release!:()=>void,holding!:()=>void;
 const released=new Promise<void>(resolve=>{release=resolve;}),held=new Promise<void>(resolve=>{holding=resolve;});
 await page.route('**/api/merge',route=>{polls++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:started?jobB:jobA})});});
 // The page loads with A running. The held Refresh response was read after A ended (blocked, Retry offered) and before B
 // started; it is answered only after the poll has seen B running.
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  if(hold){hold=false;body.merge=runnerMerge(body.merge,{ready:true,action:'retry',job:blockedA});holding();await released;}
  else body.merge=runnerMerge(body.merge,{ready:false,action:null,job:jobA});
  await route.fulfill({response,json:body});});
 await page.goto(app.url);
 await expect(page.getByRole('button',{name:'Preparing…',exact:true})).toBeVisible();
 hold=true;
 const refreshed=page.waitForResponse(response=>response.url().endsWith('/api/review'));
 await page.locator('#review-link').click();await held;
 // Selecting an item while Refresh waits renders the merge control, which schedules a poll; that poll sees job B running.
 started=true;
 await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
 await expect(page.getByRole('button',{name:'Waiting for checks…',exact:true})).toBeVisible({timeout:10_000});
 await expect(page.locator('#banner')).toHaveText('Waiting for required checks.');
 release();
 const answer=await (await refreshed).json();
 // The interleaving happened: the Refresh answer showed job A ended with Retry offered, after the poll saw B.
 expect(answer.merge).toMatchObject({ready:true,action:'retry',job:{id:blockedA.id,state:'blocked'}});
 // The older Refresh response does not restore job A: B stays followed, not ready, and its poll keeps running (2 s).
 const seen=polls;
 await page.waitForTimeout(3_000);
 expect(polls).toBeGreaterThan(seen);
 const merge=page.locator('#merge');
 await expect(merge).toHaveText('Waiting for checks…');
 await expect(merge).toHaveAttribute('aria-disabled','true');
 await expect(page.getByRole('button',{name:'Retry merge',exact:true})).toHaveCount(0);
 // Not ready while B runs: activating the control sends no merge request.
 let actions=0,dialogs=0;page.on('request',request=>{if(request.url().endsWith('/api/action'))actions++;});
 page.on('dialog',dialog=>{dialogs++;void dialog.accept();});
 await merge.dispatchEvent('click');await page.waitForTimeout(500);
 expect(dialogs).toBe(0);expect(actions).toBe(0);
 await expect(page.locator('#banner')).toHaveText('Waiting for required checks.');
});

/** A runner server whose every full review shows a running merge job (each was read while it ran); the job poll reports
 * it merged once `ended` is set. Used to hold one full response while a poll sees the job end. */
async function mergeJobOutcomeRace(page:import('@playwright/test').Page,planning?:PlanningDeps){
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway,undefined,undefined,undefined,planning);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const running=mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000c1',state:'running',step:'preparing'});
 const merged=mergeJobRecord({...running,mergeActionId:'0f6b0000-0000-4000-8000-00000000ac01',state:'merged',step:null,url:'https://github.com/owner/repo/pull/7',revision:5,updatedAt:'2026-10-11T00:05:00Z'});
 const race={ended:false,polls:0,hold:false,config,release:()=>{},held:Promise.resolve()};
 let holding!:()=>void;race.held=new Promise<void>(resolve=>{holding=resolve;});
 const released=new Promise<void>(resolve=>{race.release=resolve;});
 await page.route('**/api/merge',route=>{race.polls++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:race.ended?merged:running})});});
 // A full response (review or action) read while the job ran. The one marked held waits, and the job ends meanwhile.
 const answer=async(route:import('@playwright/test').Route)=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{ready:false,action:null,job:running});
  if(race.hold){race.hold=false;race.ended=true;holding();await released;}
  await route.fulfill({response,json:body});};
 await page.route('**/api/review',answer);
 await page.route('**/api/action',answer);
 await page.goto(app.url);
 await expect(page.getByRole('button',{name:'Preparing…',exact:true})).toBeVisible();
 /** The poll saw the job end while the full response was held; release it and show it does not restore the running job. */
 const settle=async(response:Promise<unknown>)=>{
  await expect(page.locator('#banner')).toHaveText('Merged. Refresh to see the result.',{timeout:10_000});
  const seen=race.polls;
  race.release();await response;
  // No poll restarts (the poll interval is 2 s), and the page still shows the outcome.
  await page.waitForTimeout(3_000);
  expect(race.polls).toBe(seen);
  await expect(page.locator('#banner')).toHaveText('Merged. Refresh to see the result.');
  await expect(page.getByRole('button',{name:'Preparing…',exact:true})).toHaveCount(0);
 };
 return {race,settle};
}

test('keeps a merge-job outcome a poll saw while an older review action response was held (F6b)',async({page})=>{
 const {race,settle}=await mergeJobOutcomeRace(page);
 await page.getByRole('button',{name:'Request change',exact:true}).click();
 await page.getByLabel('Change to request').fill('Keep the merge outcome.');
 race.hold=true;
 const answered=page.waitForResponse(response=>response.url().endsWith('/api/action'));
 await page.getByRole('button',{name:'Save change request',exact:true}).click();await race.held;
 // Selecting an item while the action waits renders the merge control, which schedules a poll; that poll sees the job end.
 await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
 await settle(answered);
 await page.getByRole('button',{name:/P1 Bound exponential retries/}).click();
 await expect(page.getByText('Keep the merge outcome.',{exact:true})).toBeVisible();
});

test('keeps a merge-job outcome a poll saw while an older Plans refresh response was held (F6b)',async({page})=>{
 const {race,settle}=await mergeJobOutcomeRace(page);
 await page.getByRole('link',{name:'Plans',exact:true}).click();
 race.hold=true;
 const refreshed=page.waitForResponse(response=>response.url().endsWith('/api/review'));
 await page.locator('#plans-refresh').click();await race.held;
 await page.getByRole('link',{name:'Review',exact:true}).click();
 await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
 await settle(refreshed);
 await expect(page.locator('#plans-status')).toHaveText('✓ Revision r1 is current.');
});

test('keeps a merge-job outcome a poll saw while an older plan-import reload was held (F6b)',async({page})=>{
 const {race,settle}=await mergeJobOutcomeRace(page);
 const current=app.service.store.getPlan(race.config.identity),next={...structuredClone(current),revision:current.revision+1,summary:'Make retry limits visible to operators'};
 await page.getByRole('link',{name:'Plans',exact:true}).click();
 await page.getByLabel('Plan file').setInputFiles({name:'plan.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(next))});
 race.hold=true;
 const reloaded=page.waitForResponse(response=>response.url().endsWith('/api/review'));
 // The import's success renders the merge control, which schedules a poll; the poll sees the job end during the reload.
 await page.getByRole('button',{name:'Import next revision'}).click();await race.held;
 await settle(reloaded);
 await expect(page.locator('#plans-status')).toHaveText('✓ Revision r2 is current.');
});

test('keeps a merge-job outcome a poll saw while an older Apply draft reload was held (F6b)',async({page})=>{
 let plan:unknown;
 const planning:PlanningDeps={provider:{invoke:async()=>JSON.stringify(plan)},describe:()=>({repo:{name:'retry-service',baseRef:'main'},issue:{number:3,title:'Retries',body:'',comments:[]},approvedLessons:[],validate:()=>undefined})};
 const {race,settle}=await mergeJobOutcomeRace(page,planning);
 const current=app.service.store.getPlan(race.config.identity);
 plan={...structuredClone(current),revision:current.revision+1,summary:'Make retry limits visible to operators'};
 await page.getByRole('link',{name:'Plans',exact:true}).click();
 await page.getByRole('button',{name:'Draft next revision'}).click();
 const apply=page.getByRole('button',{name:'Apply draft',exact:true});
 await expect(apply).toBeVisible();
 race.hold=true;
 const reloaded=page.waitForResponse(response=>response.url().endsWith('/api/review'));
 // Apply's success renders the merge control, which schedules a poll; the poll sees the job end during the reload.
 await apply.click();await race.held;
 await settle(reloaded);
 await expect(page.locator('#plans-status')).toHaveText('✓ Revision r2 is current.');
});

test('keeps the Merge button pending while its click is in flight, across a render (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const running=mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000d1',state:'running',step:'preparing'});
 let release!:()=>void,arrived!:()=>void;const released=new Promise<void>(resolve=>{release=resolve;}),held=new Promise<void>(resolve=>{arrived=resolve;});
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  arrived();await released;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:running}),job:running})});});
 await page.route('**/api/merge',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:running})}));
 // A runner server reports merging as a job (its merge status carries `job`).
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 const button=page.locator('#merge');
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();await held;
 await expect(button).toHaveAttribute('aria-disabled','true');await expect(button).toHaveText('Requesting merge…');
 // Selecting an item renders the page, merge control included, while the click's request is still in flight.
 await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
 await expect(page.getByRole('button',{name:/P2 Document retry behavior/})).toHaveAttribute('aria-current','true');
 await expect(button).toHaveAttribute('aria-disabled','true');await expect(button).toHaveText('Requesting merge…');
 await expect(button).toHaveJSProperty('disabled',false);
 release();
 await expect(page.getByRole('button',{name:'Preparing…',exact:true})).toHaveAttribute('aria-disabled','true');
});

test('keeps the direct Merge button disabled while its click is in flight, across a render',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);let release!:()=>void,arrived!:()=>void;
 const released=new Promise<void>(resolve=>{release=resolve;}),held=new Promise<void>(resolve=>{arrived=resolve;});
 // No runner: the click merges directly, and the server answers once GitHub has.
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},
  merge:async()=>{arrived();await released;return {url:'https://github.com/example/repo/pull/21'};}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 await openReview(page,app.url);page.on('dialog',dialog=>dialog.accept());
 const button=page.locator('#merge');
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();await held;
 await expect(button).toBeDisabled();await expect(button).toHaveText('Requesting merge…');
 // Selecting an item renders the page, merge control included, while the click's request is still in flight.
 await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
 await expect(page.getByRole('button',{name:/P2 Document retry behavior/})).toHaveAttribute('aria-current','true');
 await expect(button).toBeDisabled();await expect(button).toHaveText('Requesting merge…');
 release();
 await expect(page.locator('#banner')).toContainText('Merge submitted.');await expect(button).toBeDisabled();
});

test('keeps focus on the Merge button when a merge-job click is refused (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 let mergeClicks=0;
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}mergeClicks++;
  await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Issue #1 is not trusted for its current author.',job:null})});});
 // A runner server reports merging as a job (its merge status carries `job`).
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 const button=page.locator('#merge');
 // The review loads asynchronously (#170); press only once the page offers the merge.
 await expect(page.getByRole('button',{name:'Merge PR',exact:true})).toBeEnabled();
 await button.focus();await button.press('Enter');
 await expect(page.locator('#banner')).toHaveText(/^Merge blocked\. Issue #1 is not trusted/);
 // The refusal leaves the control marked, not disabled, and focused (AGENTS.md, Async review UI).
 await expect(button).toHaveAttribute('aria-disabled','true');
 await expect(button).toHaveJSProperty('disabled',false);await expect(button).toBeFocused();
 // It is drawn as a control that cannot act, as a disabled one is.
 await expect.poll(()=>looksInactive(button)).toBe(true);
 // Activating it again starts nothing: the merge is not ready. A request would reach the
 // route only after the confirm and the fetch, so give one time to arrive before counting.
 await button.press('Enter');
 await page.waitForTimeout(1000);
 expect(mergeClicks).toBe(1);
});
test('follows the running merge job when a click from an older review is refused because another tab started it (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const job=(state:MergeJobView['state'],step:MergeJobView['step'],checks:MergeJobView['checks']=[])=>mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000b1',state,step,checks});
 const steps=[job('running','checks',[{context:'ci',state:'pending'}]),job('merged',null)];let polls=0,mergeClicks=0;
 // This tab read its review before another tab's click started a job; the server refuses this click and, as
 // web/server.ts does, carries the task's running job.
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}mergeClicks++;
  await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'A merge is already running for this task.',job:job('running','checks',[{context:'ci',state:'pending'}])})});});
 await page.route('**/api/merge',async route=>{const next=steps[Math.min(polls,steps.length-1)];polls++;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:next})});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{ready:true,action:'merge',job:null,blockers:[...body.merge.blockers,...jobResolvedBlockers]});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 // The page follows the other tab's job, as its poll would, rather than asking for a refresh.
 await expect(page.getByRole('button',{name:'Waiting for checks…',exact:true})).toHaveAttribute('aria-disabled','true');
 await expect(page.locator('#banner')).toHaveText('A merge is already running for this task. Waiting for required checks: ci is pending.');
 await expect(page.locator('#banner')).toHaveText('Merged. Refresh to see the result.',{timeout:15_000});
 expect(polls).toBeGreaterThanOrEqual(2);
 expect(mergeClicks).toBe(1);
});
// A refused click's job is followed only when it is running and later than the job this page shows (web/public/app.js):
// the server attaches the task's latest job to every merge-job refusal (web/server.ts), so an ended one comes too, even
// one later than the job this page shows (another tab's job that has ended since this page read its review).
const shownJob=mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000c2',state:'blocked',step:null,reason:CHECK_FAILED_BLOCK,sequence:2,revision:4,updatedAt:'2026-10-11T00:00:05Z'});
for(const refusal of [
 {name:'an ended job',shown:null,button:'Merge PR',job:mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000c1',state:'failed',step:null,reason:'The server restarted before the merge finished.'})},
 {name:'an ended job later than the job shown',shown:shownJob,button:'Retry merge',job:mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000c3',state:'failed',step:null,reason:'The server restarted before the merge finished.',sequence:3,updatedAt:'2026-10-11T00:00:09Z'})},
 // Defensive: the server's latest job only moves forward, so it cannot send a running record no later than the job this
 // page shows. Kept to pin the "later than" half of the follow condition, which the reachable cases above do not reach.
 {name:'a running record no later than the job shown (defensive)',shown:shownJob,button:'Retry merge',job:mergeJobRecord({...shownJob,state:'running',step:'checks',reason:null,checks:[{context:'ci',state:'pending'}],revision:3})},
]){
 test(`asks for a refresh, not following it, when a refused merge click carries ${refusal.name} (F6b)`,async({page})=>{
  const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
  const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
  app=await startServer(config,0,undefined,gateway);
  let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
  let polls=0,mergeClicks=0;
  await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}mergeClicks++;
   await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Stale review state. Refresh before merging.',job:refusal.job})});});
  await page.route('**/api/merge',async route=>{polls++;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:refusal.job})});});
  await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
   body.merge=runnerMerge(body.merge,{ready:true,action:refusal.shown?'retry':'merge',job:refusal.shown,blockers:[...body.merge.blockers,...jobResolvedBlockers]});await route.fulfill({response,json:body});});
  await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:refusal.button,exact:true}).click();
  await expect(page.locator('#banner')).toHaveText('Merge blocked. Stale review state. Refresh before merging.');
  await page.locator('#merge-details').click();
  await expect(page.locator('dialog')).toContainText('Stale review state. Refresh before merging. Refresh before trying again.');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2500); // Past the first poll delay: the refused click's job is not followed.
  expect(polls).toBe(0);
  expect(mergeClicks).toBe(1);
 });
}
test('states the next step a blocked merge job names, once (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 // The reason runner/merge-job.ts saves when the 30-minute wait ends: nothing failed, so the step is to wait.
 const reason='Required checks did not pass within 30 minutes: ci is pending. Wait for the checks to pass, then Retry merge.';
 // The highest revision such a record can reach: preparing saves 1 and the checks step 2. Each inspection that finds checks
 // waiting saves once; with the 30-minute limit and waits of 10 s doubling to 60 s, inspections start at most at 0, 10, 30
 // and 70 s, then every 60 s from 130 to 1750 s: 32 inspections, revisions 3 to 34. The timeout's block saves 35.
 const id='0f6b0000-0000-4000-8000-0000000000b2',blocked=mergeJobRecord({id,state:'blocked',step:null,reason,revision:35});
 // The click is answered while the job prepares; the 30-minute wait ends long after, so the poll delivers the block.
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route),running=mergeJobRecord({id,state:'running',step:'preparing'});
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:running}),job:running})});});
 await page.route('**/api/merge',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:blocked})}));
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.locator('#banner')).toHaveText(`Approved, merge blocked. ${reason} Refresh to see the result.`);
});
test('asks for a refresh when the click is answered with a merge job that has already ended (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 let polls=0;
 // The job failed before the click was answered: its first review load failed, as the click's reload did, so it was saved
 // twice (preparing at revision 1, failed at revision 2) and never reached the merge (no merge action ID).
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({job:mergeJobRecord({state:'failed',step:null,reason:'History work exceeded its overall deadline.',revision:2}),mergeRefreshRequired:true})});});
 await page.route('**/api/merge',async route=>{polls++;await route.continue();});
 // A runner server reports merging as a job (its merge status carries `job`), as production does.
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.locator('#banner')).toContainText('Refresh to see the result.');
 await expect(page.locator('#merge')).toHaveJSProperty('disabled',false); // Marked, not disabled: it keeps focus.
 await expect(page.locator('#merge')).toHaveAttribute('aria-disabled','true');
 await page.locator('#merge-details').click();
 await expect(page.locator('dialog')).toContainText('Refresh to see the result.');
 await page.keyboard.press('Escape');
 await page.waitForTimeout(2500); // Past the first poll delay: an ended job is not polled.
 expect(polls).toBe(0);
});

test('follows a started merge job when the server could not reload the review after the click (F6b, #170)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const job=(state:MergeJobView['state'],step:MergeJobView['step'],checks:MergeJobView['checks']=[],reason:string|null=null)=>mergeJobRecord({state,step,checks,reason});
 const steps=[job('running','checks',[{context:'ci',state:'pending'}]),job('merged',null)];
 let polls=0,reviews=0;
 // The click's job started, but its review reload failed: the server answers only the job and asks for a refresh.
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({job:job('running','preparing'),mergeRefreshRequired:true})});});
 await page.route('**/api/merge',async route=>{const next=steps[Math.min(polls,steps.length-1)];polls++;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:next})});});
 await page.route('**/api/review',async route=>{reviews++;const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await expect(page.locator('#items button').first()).toBeVisible();
 const items=await page.locator('#items button').count();
 expect(items).toBeGreaterThan(0);
 const reloadsBefore=reviews;
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 // The page keeps its review and follows the job: its progress, then its end, with no reload.
 await expect(page.getByRole('button',{name:'Preparing…',exact:true})).toHaveAttribute('aria-disabled','true');
 await expect(page.locator('#banner')).toContainText('Preparing the merge');
 await expect(page.locator('#banner')).toHaveText('Merged. Refresh to see the result.',{timeout:15000});
 expect(polls).toBeGreaterThanOrEqual(2);
 // Give a background reload started by the job's end time to reach the route before counting.
 await page.waitForTimeout(2500);
 expect(reviews).toBe(reloadsBefore);
 expect(await page.locator('#items button').count()).toBe(items);
});

test('follows a one-click merge job from preparation through the required-check wait to merged (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const job=(state:MergeJobView['state'],step:MergeJobView['step'],checks:MergeJobView['checks']=[],reason:string|null=null)=>mergeJobRecord({state,step,checks,reason});
 const steps=[job('running','checks',[{context:'ci',state:'pending'}]),job('running','merging'),job('merged',null)];
 let polls=0,reviews=0,mergeClicks=0;
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}mergeClicks++;
  const review=await clickReview(route),running=job('running','preparing');
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:running}),job:running})});});
 await page.route('**/api/merge',async route=>{const next=steps[Math.min(polls,steps.length-1)];polls++;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:next})});});
 // A runner server reports merging as a job (its merge status carries `job`).
 await page.route('**/api/review',async route=>{reviews++;const response=await route.fetch(),body=await response.json();body.merge=runnerMerge(body.merge,{job:null});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 const button=page.locator('#merge');
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 // The focused control keeps focus while its job runs: marked, not disabled (AGENTS.md, Async review UI).
 await expect(page.getByRole('button',{name:'Preparing…',exact:true})).toHaveAttribute('aria-disabled','true');
 // Not disabled in the DOM (Playwright's toBeEnabled counts aria-disabled as disabled), and still focused.
 await expect(button).toHaveJSProperty('disabled',false);await expect(button).toBeFocused();
 await expect.poll(()=>looksInactive(button)).toBe(true);
 await expect(page.locator('#banner')).toHaveText('Preparing the merge: refresh, rebase, push and command checks.');
 await expect(page.getByRole('button',{name:'Waiting for checks…',exact:true})).toHaveAttribute('aria-disabled','true');
 await expect(button).toBeFocused();
 await expect(page.locator('#banner')).toContainText('Waiting for required checks: ci is pending.');
 // A repeat activation while the job runs starts nothing.
 await button.press('Enter');
 await page.getByRole('button',{name:'Merge status',exact:true}).click();
 // The dialog names the step as the control does, not the job's raw step value.
 await expect(page.locator('dialog strong')).toHaveText('Waiting for checks…');
 await expect(page.locator('dialog')).toContainText('ci: pending');
 await page.keyboard.press('Escape');
 await expect(page.getByRole('button',{name:'Merging…',exact:true})).toHaveAttribute('aria-disabled','true');
 expect(mergeClicks).toBe(1);
 const reloadsBeforeEnd=reviews;
 // The job's end updates only the merge control (AGENTS.md, Async review UI): no background reload erases the
 // person's selection or input.
 await expect(page.locator('#banner')).toHaveText('Merged. Refresh to see the result.');
 // Give a background reload started by the job's end time to reach the route before counting.
 await page.waitForTimeout(2500);
 expect(reviews).toBe(reloadsBeforeEnd);
 await expect(button).toHaveAttribute('aria-disabled','true');await expect(button).toHaveJSProperty('disabled',false);
 expect(polls).toBe(3);
 await page.locator('#merge-details').click();
 await expect(page.locator('dialog')).toContainText('Merged. Refresh to see the result.');
 await page.keyboard.press('Escape');
 // Refresh loads the outcome.
 const reloaded=page.waitForResponse(response=>response.url().endsWith('/api/review'));
 await page.locator('#review-link').click();await reloaded;
 expect(reviews).toBeGreaterThan(reloadsBeforeEnd);
});
test('follows the merge queue a polled job ended in, from a review with no queue, to merged without Refresh (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const head=view.snapshot.head,mergeActionId='0f6b0000-0000-4000-8000-0000000000e9';
 // Shapes as runner/merge-job.ts (mergeJobView) and runner/merge.ts (#queueStatus) answer them: the job's attempt carries
 // the job's merge action ID.
 // With the step list (D16): the Merge step runs, then is done when the job ends queued.
 const jobSteps=(state:MergeJobView['state'],step:MergeJobView['step'])=>state==='running'
  ?mergeSteps(step==='preparing'?['running']:['done','skipped','skipped','skipped','done','done','running'])
  :mergeSteps(['done','skipped','skipped','skipped','done','done','done']);
 const job=(state:MergeJobView['state'],step:MergeJobView['step'],revision:number)=>mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000e1',mergeActionId:step==='preparing'?null:mergeActionId,state,step,revision,steps:jobSteps(state,step)});
 const queue=(state:string)=>({kind:'queue',state,reviewedHead:head,url:'https://github.com/example/repo/pull/7',reason:null,phase:state==='queued'?'AWAITING_CHECKS':null,position:state==='queued'?1:null,occurredAt:state==='merged'?'2026-10-11T00:10:00Z':null,actionId:mergeActionId,retryable:false});
 // The job ends queued; GitHub's queue merges two polls later.
 const steps=[{queue:null,job:job('running','merging',4)},{queue:queue('queued'),job:job('queued',null,5)},{queue:queue('queued'),job:job('queued',null,5)},{queue:queue('merged'),job:job('queued',null,5)}];
 const answered:Array<{queue:unknown;job:{state:string}}>=[];let reviews=0;
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route),running=job('running','preparing',1);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,queue:null,job:running,blockers:[...review.merge.blockers,...jobResolvedBlockers]}),job:running})});});
 await page.route('**/api/merge',async route=>{const next=steps[Math.min(answered.length,steps.length-1)]!;answered.push(next);await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(next)});});
 await page.route('**/api/review',async route=>{reviews++;const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{ready:true,action:'merge',queue:null,job:null,blockers:[...body.merge.blockers,...jobResolvedBlockers]});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 const clicked=page.waitForResponse(response=>response.url().endsWith('/api/action'));
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 // The page started from a review with no queue, and the click's answer has none either.
 expect((await (await clicked).json()).merge.queue).toBeNull();
 const reviewsAfterClick=reviews;
 await expect(page.locator('#merge')).toHaveText('Merged',{timeout:20_000});
 // The interleaving: a poll answered the ended `queued` job with its queue still active, and only a later poll saw the merge.
 expect(answered.map(answer=>`${answer.job.state}/${(answer.queue as {state:string}|null)?.state??'none'}`).slice(0,4)).toEqual(['running/none','queued/queued','queued/queued','queued/merged']);
 await expect(page.locator('#banner')).toHaveText('GitHub confirmed the reviewed head was merged.');
 await expect(page.locator('#merge')).toHaveAttribute('aria-disabled','true');
 // The job's step list stays on screen through the queue polls and after GitHub merged, until Refresh (D16).
 await expect(page.getByRole('list',{name:'Merge steps'}).getByRole('listitem').last()).toHaveText('✓ Merge Done, 1 s');
 await expect(page.locator('#merge-cancel')).toBeHidden();
 // As after a queue merge: the merge status names the confirmed merge, and the blockers the job settled are gone.
 await page.locator('#merge-details').click();
 await expect(page.locator('dialog h2')).toHaveText('Merge status');
 await expect(page.locator('dialog li')).toHaveText(['GitHub confirmed that the reviewed head was merged.']);
 await page.keyboard.press('Escape');
 expect(reviews).toBe(reviewsAfterClick); // No Refresh, and no background reload.
});
test('follows a later running merge job when a resent click replays its own ended job (F6b)',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const record=(id:string,sequence:number,state:MergeJobView['state'],step:MergeJobView['step'],reason:string|null=null)=>mergeJobRecord({id,sequence,state,step,reason,checks:step==='checks'?[{context:'ci',state:'pending'}]:[]});
 // The review shows an earlier job that ended blocked, so it offers Retry merge.
 const shown=record('0f6b0000-0000-4000-8000-0000000000d0',1,'blocked',null,CHECK_FAILED_BLOCK);
 const clicks:string[]=[];let jobB:ReturnType<typeof record>|null=null,polls=0;
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}clicks.push(body.actionId);
  // The first answer is lost before the server admitted the click; the server then saves its job A, which ends blocked,
  // and another tab's retry starts job B.
  if(clicks.length===1){await route.abort('failed');return;}
  const jobA=record(body.actionId,2,'blocked',null,CHECK_FAILED_BLOCK);jobB=record('0f6b0000-0000-4000-8000-0000000000d3',3,'running','checks');
  // As web/server.ts answers a resend: the replayed job A, with the review reloaded meanwhile, whose job is the latest (B).
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,job:jobB}),job:jobA})});});
 await page.route('**/api/merge',async route=>{polls++;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queue:null,job:jobB})});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{job:shown,ready:true,action:'retry'});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>void dialog.accept());
 await page.getByRole('button',{name:'Retry merge',exact:true}).click();
 await expect(page.locator('#banner')).toContainText('Merge blocked.');
 const reloaded=page.waitForResponse(response=>response.url().endsWith('/api/review'));
 await page.locator('#review-link').click();await reloaded;
 const resent=page.waitForResponse(response=>response.url().endsWith('/api/action'));
 await page.getByRole('button',{name:'Retry merge',exact:true}).click();
 const answer=await (await resent).json();
 // The interleaving: the resend carried the first click's key, and its answer replayed that click's ended job A beside
 // the later running job B.
 expect(clicks).toHaveLength(2);expect(clicks[1]).toBe(clicks[0]);
 expect(answer.job).toMatchObject({id:clicks[0],state:'blocked',sequence:2});
 expect(answer.merge.job).toMatchObject({state:'running',sequence:3});
 // The page follows B, not A's outcome.
 await expect(page.getByRole('button',{name:'Waiting for checks…',exact:true})).toHaveAttribute('aria-disabled','true');
 await expect(page.locator('#banner')).toHaveText('Waiting for required checks: ci is pending.');
 await expect.poll(()=>polls,{timeout:10_000}).toBeGreaterThan(0);
 await expect(page.locator('#merge')).toHaveText('Waiting for checks…');
 await expect(page.locator('#banner')).not.toContainText('Merge blocked');
});

/** A runner server whose every full review shows its merge job running in the guarded merge (`merging`), with no merge
 * attempt (each was read before the job asked GitHub). The job poll answers `answer(polls)`, in the shapes
 * runner/merge-job.ts (mergeJobView) and runner/merge.ts (#queueStatus) send: the job's attempt carries its merge action ID.
 * A full review marked `race.hold` waits until `race.release()`. */
async function endedJobQueueServer(page:import('@playwright/test').Page,answer:(polls:number,parts:{job:(state:MergeJobView['state'],revision:number)=>MergeJobView;queue:(state:string,actionId?:string)=>{state:string}})=>{queue:{state:string}|null;job:MergeJobView}){
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const head=view.snapshot.head,mergeActionId='0f6b0000-0000-4000-8000-0000000000e9';
 const jobRecord=(state:MergeJobView['state'],revision:number)=>mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000e1',mergeActionId,state,step:state==='running'?'merging':null,revision});
 const queueRecord=(state:string,actionId=mergeActionId)=>({kind:'queue',state,reviewedHead:head,url:'https://github.com/example/repo/pull/7',reason:state==='removed'?'Required check failed.':null,phase:state==='queued'?'AWAITING_CHECKS':null,position:state==='queued'?1:null,occurredAt:state==='merged'||state==='removed'?'2026-10-11T00:10:00Z':null,actionId,retryable:state==='removed'});
 const race={answered:[] as string[],hold:false,release:()=>{},held:Promise.resolve()};
 let holding!:()=>void;race.held=new Promise<void>(resolve=>{holding=resolve;});
 const released=new Promise<void>(resolve=>{race.release=resolve;});
 await page.route('**/api/merge',async route=>{const next=answer(race.answered.length,{job:jobRecord,queue:queueRecord});
  race.answered.push(`${next.job.state}/${next.queue?.state??'none'}`);await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(next)});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{ready:false,action:null,queue:null,job:jobRecord('running',4),blockers:[...body.merge.blockers,...jobResolvedBlockers]});
  if(race.hold){race.hold=false;holding();await released;}
  await route.fulfill({response,json:body});});
 await page.goto(app.url);
 await expect(page.getByRole('button',{name:'Merging…',exact:true})).toBeVisible();
 return race;
}

for(const variant of [{name:'merged',site:'Refresh',label:'Merged',banner:'GitHub confirmed the reviewed head was merged.'},{name:'still queued',site:'Refresh',label:'Merge queued',banner:'Merge queued at position 1. Waiting for GitHub.'},
 {name:'merged',site:'Plans refresh',label:'Merged',banner:'GitHub confirmed the reviewed head was merged.'}])
test(`keeps the merge attempt a polled job ended queued in, ${variant.name}, while an older ${variant.site} response was held (F6b)`,async({page})=>{
 let ended=false;
 // Before the job ends the poll sees it merging; then it ends `queued` with its attempt queued, and GitHub's queue
 // merges it on the next poll (or still holds it).
 const race=await endedJobQueueServer(page,(polls,{job,queue})=>!ended?{queue:null,job:job('running',4)}
  :{queue:queue(variant.name==='merged'&&race.answered.filter(answer=>answer.startsWith('queued')).length>0?'merged':'queued'),job:job('queued',5)});
 race.hold=true;
 if(variant.site==='Plans refresh')await page.getByRole('link',{name:'Plans',exact:true}).click();
 const refreshed=page.waitForResponse(response=>response.url().endsWith('/api/review'));
 if(variant.site==='Plans refresh'){await page.locator('#plans-refresh').click();await race.held;await page.getByRole('link',{name:'Review',exact:true}).click();}
 else{await page.locator('#review-link').click();await race.held;}
 // Selecting an item while the reload waits renders the merge control, which schedules a poll; it sees the job end.
 ended=true;
 await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
 await expect(page.locator('#merge')).toHaveText(variant.label,{timeout:15_000});
 await expect(page.locator('#banner')).toHaveText(variant.banner);
 // The interleaving: before the held response was released, the poll saw the job end queued and followed its attempt.
 const afterEnd=race.answered.filter(answer=>answer!=='running/none');
 if(variant.name==='merged')expect(afterEnd).toEqual(['queued/queued','queued/merged']);
 else{expect(afterEnd.length).toBeGreaterThan(0);expect([...new Set(afterEnd)]).toEqual(['queued/queued']);}
 const seen=race.answered.length;
 race.release();
 const answer=await (await refreshed).json();
 // The held response was read while the job was merging, before it had an attempt.
 expect(answer.merge).toMatchObject({queue:null,job:{state:'running',step:'merging'}});
 await page.waitForTimeout(3_000);
 if(variant.name==='merged'){
  // Merged survives, and no poll restarts (the poll interval is 2 s).
  expect(race.answered.length).toBe(seen);
  await page.locator('#merge-details').click();
  await expect(page.locator('dialog li')).toHaveText(['GitHub confirmed that the reviewed head was merged.']);
  await page.keyboard.press('Escape');
 }else{
  // The attempt is still followed: the queue poll continues.
  expect(race.answered.length).toBeGreaterThan(seen);
 }
 await expect(page.locator('#merge')).toHaveText(variant.label);
 await expect(page.locator('#banner')).toHaveText(variant.banner);
});

test('does not follow another attempt the poll answers beside a job that ended queued (F6b)',async({page})=>{
 // The job ended queued, but the poll's attempt is another one (its action ID is not the job's merge action ID).
 const race=await endedJobQueueServer(page,(polls,{job,queue})=>polls===0?{queue:null,job:job('running',4)}:{queue:queue('queued','0f6b0000-0000-4000-8000-0000000000ee'),job:job('queued',5)});
 await expect(page.locator('#merge')).toHaveText('Merge queued',{timeout:15_000});
 const ended='Merge queued. Waiting for GitHub to confirm the outcome. Refresh to see the result.';
 await expect(page.locator('#banner')).toHaveText(ended);
 expect(race.answered).toEqual(['running/none','queued/queued']);
 // The view is the job's outcome alone: the other attempt's queue is not shown or polled.
 await page.waitForTimeout(3_000);
 expect(race.answered).toHaveLength(2);
 await expect(page.locator('#banner')).toHaveText(ended);
 await expectEndedMergeJob(page,'Merge queued',ended);
});

for(const variant of [{state:'merged',label:'Merged',banner:'GitHub confirmed the reviewed head was merged.',status:'GitHub confirmed that the reviewed head was merged.'},
 {state:'removed',label:'1 blocker',banner:'Removed from merge queue. Required check failed. Refresh to verify retry readiness.',status:'Required check failed. Refresh to verify retry readiness.'}])
test(`shows at once a job's attempt already ${variant.state} when the poll sees the job end queued (F6b)`,async({page})=>{
 // One poll answers the job ended queued and its attempt already ended.
 const race=await endedJobQueueServer(page,(polls,{job,queue})=>polls===0?{queue:null,job:job('running',4)}:{queue:queue(variant.state),job:job('queued',5)});
 await expect(page.locator('#merge')).toHaveText(variant.label,{timeout:15_000});
 expect(race.answered).toEqual(['running/none',`queued/${variant.state}`]);
 await expect(page.locator('#banner')).toHaveText(variant.banner);
 await page.locator('#merge-details').click();
 await expect(page.locator('dialog h2')).toHaveText('Merge status');
 await expect(page.locator('dialog li')).toHaveText([variant.status]);
 await page.keyboard.press('Escape');
 // Polling stops (the poll interval is 2 s).
 await page.waitForTimeout(3_000);
 expect(race.answered).toHaveLength(2);
});

for(const variant of [{state:'merged',label:'Merged',banner:'GitHub confirmed the reviewed head was merged.',status:'GitHub confirmed that the reviewed head was merged.'},
 {state:'removed',label:'1 blocker',banner:'Removed from merge queue. Required check failed. Refresh to verify retry readiness.',status:'Required check failed. Refresh to verify retry readiness.'},
 {state:'queued',label:'Merge queued',banner:'Merge queued at position 1. Waiting for GitHub.',status:'Merge queued. Waiting for GitHub to confirm the outcome. Refresh to see the result.'}])
test(`shows the job's own attempt, ${variant.state}, when the click is answered with a job that ended queued (F6b)`,async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);
 const gateway:MergeGateway={inspect:async()=>{const snapshot=(await app.service.load()).snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:false,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},merge:async()=>{throw new Error('The browser test answers every merge request itself.');}};
 app=await startServer(config,0,undefined,gateway);
 let view=await app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=await app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=await app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 const head=view.snapshot.head,mergeActionId='0f6b0000-0000-4000-8000-0000000000e9';
 // Shapes as runner/merge-job.ts (mergeJobView) and runner/merge.ts (#queueStatus, #attemptBlocker) send them.
 const queued=mergeJobRecord({id:'0f6b0000-0000-4000-8000-0000000000e1',mergeActionId,state:'queued',step:null});
 const queue=(state:string)=>({kind:'queue',state,reviewedHead:head,url:'https://github.com/example/repo/pull/7',reason:state==='removed'?'Required check failed.':null,phase:state==='queued'?'AWAITING_CHECKS':null,position:state==='queued'?1:null,occurredAt:state==='merged'||state==='removed'?'2026-10-11T00:10:00Z':null,actionId:mergeActionId,retryable:state==='removed'});
 const attemptBlocker={merged:[{code:'queue-merged',message:'GitHub confirmed that the reviewed head was merged.'}],queued:[{code:'queue-active',message:'The reviewed head is queued. Waiting for GitHub to confirm the outcome.'}]}[variant.state]??[];
 const polls:string[]=[];
 // Another client's poll saw the job end queued, and its attempt reach `variant.state`, before this click's review reload
 // read them: the click's answer carries both.
 await page.route('**/api/action',async route=>{const body=route.request().postDataJSON();if(body.action!=='merge'){await route.continue();return;}
  const review=await clickReview(route);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...review,merge:runnerMerge(review.merge,{ready:false,action:null,queue:queue(variant.state),job:queued,blockers:[...attemptBlocker,...review.merge.blockers,...jobResolvedBlockers]}),job:queued})});});
 // A later poll sees GitHub merge an attempt that was still queued.
 await page.route('**/api/merge',async route=>{const next={queue:queue(polls.length===0&&variant.state==='queued'?'queued':'merged'),job:queued};polls.push(`${next.job.state}/${next.queue.state}`);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(next)});});
 await page.route('**/api/review',async route=>{const response=await route.fetch(),body=await response.json();
  body.merge=runnerMerge(body.merge,{ready:true,action:'merge',queue:null,job:null,blockers:[...body.merge.blockers,...jobResolvedBlockers]});await route.fulfill({response,json:body});});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 const clicked=page.waitForResponse(response=>response.url().endsWith('/api/action'));
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 // The interleaving: the click's answer already holds the ended job and its attempt in `variant.state`; this page had polled nothing.
 const answer=await (await clicked).json();
 expect(answer.job).toMatchObject({state:'queued',mergeActionId});
 expect(answer.merge.queue).toMatchObject({state:variant.state,actionId:mergeActionId});
 expect(polls).toEqual([]);
 await expect(page.locator('#merge')).toHaveText(variant.label);
 await expect(page.locator('#banner')).toHaveText(variant.banner);
 await expect(page.locator('#merge')).toHaveAttribute('aria-disabled','true');
 await page.locator('#merge-details').click();
 await expect(page.locator('dialog h2')).toHaveText('Merge status');
 await expect(page.locator('dialog li')).toHaveText([variant.status]);
 await page.keyboard.press('Escape');
 if(variant.state==='queued'){
  // The attempt is still in GitHub's queue: the queue poll follows it until GitHub merges it.
  await expect(page.locator('#merge')).toHaveText('Merged',{timeout:15_000});
  expect(polls.slice(0,2)).toEqual(['queued/queued','queued/merged']);
  await expect(page.locator('#banner')).toHaveText('GitHub confirmed the reviewed head was merged.');
 }else{
  // An ended attempt is not polled (the poll interval is 2 s), so its outcome stays without a Refresh.
  await page.waitForTimeout(3_000);
  expect(polls).toEqual([]);
  await expect(page.locator('#merge')).toHaveText(variant.label);
  await expect(page.locator('#banner')).toHaveText(variant.banner);
 }
});
