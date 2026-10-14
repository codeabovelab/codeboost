import { test, expect } from '@playwright/test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../../scripts/demo.ts';
import { startServer } from '../../web/server.ts';
import type { MergeGateway, MergeQueueGateway } from '../../github/merge.ts';
import { fixtureGit } from '../fixtures/git.ts';

// Issue #48, poll ordering (browser): a merge-queue poll answer computed before a newer poll answer must not be
// applied after it. Before the fix, any render() (for example selecting another item) while a poll was in flight
// scheduled a second poll chain with the same mergeGeneration, so two polls could be outstanding and nothing ordered
// their answers. Now one poll chain runs at a time.
let root: string, app: Awaited<ReturnType<typeof startServer>>;
test.beforeEach(async () => { root=mkdtempSync(join(tmpdir(),'codeboost-browser-'));app=await startServer(createDemo(join(root,'demo')),0); });
test.afterEach(async () => { await app.close();rmSync(root,{recursive:true,force:true}); });

test('a re-render while a merge-queue poll is held starts no second poll chain, so no older answer follows a newer one',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();
 chmodSync(join(config.repository,'run.sh'),0o644);fixtureGit(config.repository,'commit','-am','Restore declared scope');
 let appRef:typeof app,phase:'queued'|'merged'='queued';
 const gateway:MergeGateway&MergeQueueGateway={
  inspect:async()=>{const snapshot=appRef.service.load().snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:true,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},
  queueWatermark:async()=>null,
  merge:async()=>({url:'https://github.com/example/repo/pull/24'}),
  inspectQueue:async head=>phase==='merged'?{state:'merged',reviewedHead:head,mergedAt:'2026-09-24T08:10:00Z'}:{state:'queued',reviewedHead:head,entryId:'MQE_1',phase:'QUEUED',position:1,enqueuedAt:'2026-09-24T08:00:00Z',queueHead:head},
 };
 app=appRef=await startServer(config,0,undefined,gateway);let view=app.service.load();
 for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=app.service.act({action:'accept',key:segment.key,token:view.token});
 for(const item of view.items)view=app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});

 // Poll 1: the server answers (queued) at once, but delivery of that answer to the page is held. Later polls pass.
 let release!:()=>void,arrived!:()=>void;
 const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>arrived=resolve);
 let polls=0,heldState:string|undefined;
 await page.route('**/api/merge',async route=>{
  const n=++polls;
  if(n===1){const response=await route.fetch();const body=await response.json();heldState=body.queue?.state;arrived();await held;await route.fulfill({response,json:body});return;}
  await route.continue();
 });
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.getByRole('button',{name:'Merge queued',exact:true})).toBeDisabled();
 try{
  await started;
  expect(heldState).toBe('queued');
  // GitHub now confirms the merge, so any later answer is newer than the held one.
  phase='merged';
  // Selecting another item re-renders while poll 1 is in flight. It must not start a second poll chain, whose newer
  // answer the held older one could then overwrite (the first poll delay is 2 s; wait past it).
  await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
  await page.waitForTimeout(3000);
  expect(polls).toBe(1);
  // The held answer is still the latest one issued, so it applies; the next poll then reports the merge.
  release();
  await expect(page.getByRole('button',{name:'Merged',exact:true})).toBeDisabled({timeout:10000});
  await expect(page.locator('#banner')).toContainText('GitHub confirmed the reviewed head was merged.');
  expect(polls).toBe(2);
  // Nothing older can arrive later and move the control back.
  await page.waitForTimeout(2500);
  expect(await page.locator('#merge').textContent()).toBe('Merged');
 }finally{release();}
});

// The poll in flight belongs to its generation: after a refresh starts a new generation and its own poll, the old poll's
// late answer is discarded and must not release the new generation's single-chain guard (AGENTS.md: "Poll starts, then
// a user action completes, then the old poll returns").
test('an older generation poll returning late neither applies nor lets a re-render start a second chain',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();
 chmodSync(join(config.repository,'run.sh'),0o644);fixtureGit(config.repository,'commit','-am','Restore declared scope');
 let appRef:typeof app;
 const gateway:MergeGateway&MergeQueueGateway={
  inspect:async()=>{const snapshot=appRef.service.load().snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:true,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},
  queueWatermark:async()=>null,
  merge:async()=>({url:'https://github.com/example/repo/pull/24'}),
  inspectQueue:async head=>({state:'queued',reviewedHead:head,entryId:'MQE_1',phase:'QUEUED',position:1,enqueuedAt:'2026-09-24T08:00:00Z',queueHead:head}),
 };
 app=appRef=await startServer(config,0,undefined,gateway);let view=app.service.load();
 for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=app.service.act({action:'accept',key:segment.key,token:view.token});
 for(const item of view.items)view=app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 // Polls 1 (old generation) and 2 (new generation) are held; any later poll is counted and passes.
 const releases:Array<()=>void>=[],started:Array<()=>void>=[];
 const starts=[0,1].map(index=>new Promise<void>(resolve=>started[index]=resolve));
 const holds=[0,1].map(index=>new Promise<void>(resolve=>releases[index]=resolve));
 let polls=0;
 await page.route('**/api/merge',async route=>{
  const n=++polls;
  if(n<=2){
   const response=await route.fetch();const body=await response.json();
   // The old generation's answer says "merged", so applying it would be visible; the current generation's stays queued.
   if(n===1&&body.queue)body.queue={...body.queue,state:'merged',mergedAt:'2026-09-24T08:10:00Z'};
   started[n-1]!();await holds[n-1];await route.fulfill({response,json:body});return;
  }
  await route.continue();
 });
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.getByRole('button',{name:'Merge queued',exact:true})).toBeDisabled();
 try{
  await starts[0];
  // A refresh starts a new merge generation; its own poll (2) starts after the poll delay and is held too.
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await starts[1];
  expect(polls).toBe(2);
  // The old generation's poll now returns; it must not apply, nor clear the new generation's in-flight poll.
  releases[0]!();
  await page.waitForTimeout(300);
  // Not applied: the control still shows the current generation's queued state.
  await expect(page.getByRole('button',{name:'Merge queued',exact:true})).toBeDisabled();
  await expect(page.locator('#banner')).not.toContainText('confirmed the reviewed head was merged');
  // A re-render now must not start a third poll while poll 2 is in flight (wait past the 2 s poll delay).
  await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
  await page.waitForTimeout(3000);
  expect(polls).toBe(2);
  // Still not applied, however late the old answer arrived.
  await expect(page.locator('#banner')).not.toContainText('confirmed the reviewed head was merged');
  releases[1]!();
  await expect(page.getByRole('button',{name:'Merge queued',exact:true})).toBeDisabled();
 }finally{releases.forEach(release=>release());}
});
