import { test, expect } from '@playwright/test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../../scripts/demo.ts';
import { startServer } from '../../web/server.ts';
import type { MergeGateway, MergeQueueGateway } from '../../github/merge.ts';
import { fixtureGit } from '../fixtures/git.ts';
let root: string, app: Awaited<ReturnType<typeof startServer>>;
function removeDemoOutOfScope(config: typeof app.service.config) { chmodSync(join(config.repository,'run.sh'),0o644);fixtureGit(config.repository,'commit','-am','Restore declared scope'); }
test.beforeEach(async () => { root=mkdtempSync(join(tmpdir(),'codeboost-issue48-')); app=await startServer(createDemo(join(root,'demo')),0); });
test.afterEach(async () => { await app.close(); rmSync(root,{recursive:true,force:true}); });

// Issue #48: an error from an older merge-queue poll must not overwrite the state a newer poll showed. Before the fix,
// selecting an item while poll #1 was held started poll #2 in the same merge generation; poll #2 confirmed "merged",
// and poll #1's later 500 replaced it. Now one poll chain runs at a time, so no newer poll exists while #1 is held:
// the test asserts that, shows #1's error as the latest result, and checks that polling then recovers.
test('a held merge-poll error starts no second poll chain, and polling recovers after it',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);let appRef:typeof app,phase:'queued'|'merged'='queued';
 const gateway:MergeGateway&MergeQueueGateway={
  inspect:async()=>{const snapshot=appRef.service.load().snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:true,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},
  queueWatermark:async()=>null,
  merge:async()=>({url:'https://github.com/example/repo/pull/24'}),
  inspectQueue:async head=>phase==='queued'?{state:'queued',reviewedHead:head,entryId:'MQE_1',phase:'AWAITING_CHECKS',position:2,enqueuedAt:'2026-09-24T08:00:00Z',queueHead:head}:{state:'merged',reviewedHead:head,mergedAt:'2026-09-24T08:10:00Z'},
 };
 app=appRef=await startServer(config,0,undefined,gateway);let view=app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 let release!:()=>void,arrived!:()=>void;const held=new Promise<void>(resolve=>release=resolve),firstPollStarted=new Promise<void>(resolve=>arrived=resolve);let polls=0;
 await page.route('**/api/merge',async route=>{polls++;
  if(polls===1){arrived();await held;await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Stale poll failure.'})});return;}
  await route.continue();});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.getByRole('button',{name:'Merge queued',exact:true})).toBeDisabled();
 try{
  await firstPollStarted;
  // GitHub now reports the merge. A plain item selection (no network write) re-renders while poll 1 is in flight; it
  // must not start a second chain whose newer success the held error could then overwrite (wait past the 2 s delay).
  phase='merged';
  await page.getByRole('button',{name:/P2 Document retry behavior/}).click();
  await page.waitForTimeout(3000);
  expect(polls).toBe(1);
  // The held error is the latest result and is shown; polling then continues and the newer state replaces it.
  release();
  await expect(page.locator('#banner')).toContainText('Could not refresh merge status. Stale poll failure.');
  await expect(page.getByRole('button',{name:'Merged',exact:true})).toBeDisabled({timeout:15000});
  await expect(page.locator('#banner')).toContainText('GitHub confirmed the reviewed head was merged.');
  expect(polls).toBe(2);
 }finally{release();}
});

// A current poll whose answer cannot be applied still reports the failure and keeps polling (an error thrown after the
// poll's result was accepted must not be dropped as if it came from an older poll).
test('reports an unusable current merge-poll answer and keeps polling',async({page})=>{
 const config={...app.service.config,demo:false};await app.close();removeDemoOutOfScope(config);let appRef:typeof app;
 const gateway:MergeGateway&MergeQueueGateway={
  inspect:async()=>{const snapshot=appRef.service.load().snapshot;return {base:snapshot.base,head:snapshot.head,pullRequestState:'OPEN',mergeable:'MERGEABLE',rulesKnown:true,atomicBaseGuard:true,mergeQueue:true,requiredChecks:[],alreadyFixed:'clear',pullRequest:7,draft:false};},
  queueWatermark:async()=>null,
  merge:async()=>({url:'https://github.com/example/repo/pull/24'}),
  inspectQueue:async head=>({state:'merged',reviewedHead:head,mergedAt:'2026-09-24T08:10:00Z'}),
 };
 app=appRef=await startServer(config,0,undefined,gateway);let view=app.service.load();for(const segment of view.segments.filter(value=>value.row==='Unplanned'||value.row==='Ambiguous'))view=app.service.act({action:'accept',key:segment.key,token:view.token});for(const item of view.items)view=app.service.act({action:'approve',item:item.id,confirmNoChange:item.count===0,token:view.token});
 let polls=0;
 // Poll 1 answers 200 with a null body, which the page cannot apply; later polls pass.
 await page.route('**/api/merge',async route=>{if(++polls===1){await route.fulfill({status:200,contentType:'application/json',body:'null'});return;}await route.continue();});
 await page.goto(app.url);page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Merge PR',exact:true}).click();
 await expect(page.locator('#banner')).toContainText('Could not refresh merge status.',{timeout:10000});
 await expect(page.getByRole('button',{name:'Merged',exact:true})).toBeDisabled({timeout:15000});
 expect(polls).toBe(2);
});
