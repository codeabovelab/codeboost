import { afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createDemo } from '../scripts/demo.ts';
import { ReviewService } from '../runner/review.ts';
import { startServer } from '../web/server.ts';
import { approveItem } from '../core/approvals.ts';
// Each integration case performs several bounded real-Git reads.
vi.setConfig({ testTimeout: 15000 });
const roots:string[]=[];const services:ReviewService[]=[];
afterEach(()=>{services.splice(0).forEach(service=>service.close());roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true}));});
function fixture(){const root=mkdtempSync(join(tmpdir(),'codeboost-review-'));roots.push(root);const config=createDemo(join(root,'demo'));const service=new ReviewService(config);services.push(service);return {service,config};}
it('closes the review service when merge gateway construction fails', async()=>{
 const root=mkdtempSync(join(tmpdir(),'codeboost-review-'));roots.push(root);const demo=createDemo(join(root,'demo'));
 const close=vi.spyOn(ReviewService.prototype,'close');
 const config={...demo,demo:false,github:{repository:'owner/repo',pullRequest:7,issue:3,method:'invalid' as 'merge'}};
 await expect(startServer(config,0)).rejects.toThrow(/merge method/i);
 expect(close).toHaveBeenCalledTimes(1);close.mockRestore();
});
it('expires a browser token after another view assigns a segment and recomputes scope honestly',()=>{
 const {service}=fixture();const view=service.load();const foreign=view.segments.find(s=>s.row==='Unplanned')!;
 const next=service.act({action:'assign',key:foreign.key,item:'P1',token:view.token});
 expect(next.items[0]!.checks.scope).toContain('out of scope');
 expect(()=>service.act({action:'approve',item:'P1',token:view.token})).toThrow(/Stale/);
});
it('keeps both sides of a declared rename in scope after manual reassignment',()=>{
 const {service,config}=fixture(),identity=config.identity,plan=service.store.getPlan(identity);
 plan.items=[{...plan.items[0]!,files:[{path:'renamed.ts',kind:'rename',renamed_from:'retry.ts',change:'Rename the implementation.'}],depends_on:[]}];
 expect(plan.items.map(item=>item.id)).toEqual(['P1']);
 service.store.importRevision(JSON.stringify(plan),'json',{identity,issue:plan.issue,baseEntries:['retry.ts','README.md','run.sh'].map(path=>({path,kind:'file' as const})),pathKey:path=>path,allowedCommands:[]},plan.revision);
 renameSync(join(config.repository,'retry.ts'),join(config.repository,'renamed.ts'));
 writeFileSync(join(config.repository,'renamed.ts'),'export function delay(attempt: number) {\n  return Math.min(5000, 200 * 2 ** attempt);\n}\n');
 execFileSync('git',['-c','core.hooksPath=/dev/null','add','-A'],{cwd:config.repository});
 execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-m','Rename retry implementation'],{cwd:config.repository,stdio:'pipe'});
 let view=service.load();const segmentPath=(segment:typeof view.segments[number]):string=>{
  const path=segment.operation==='-'?(segment.oldPath??segment.path):segment.path;return path??'';
 };
 const candidates=view.segments.filter(segment=>segment.row==='Unplanned'&&segment.kind==='text'&&(segment.operation==='-'||segment.operation==='+')&&['retry.ts','renamed.ts'].includes(segmentPath(segment)));
 expect(new Set(candidates.map(segment=>segment.operation))).toEqual(new Set(['-','+']));
 expect(new Set(candidates.map(segmentPath))).toEqual(new Set(['retry.ts','renamed.ts']));
 for(const candidate of candidates){view=service.act({action:'assign',key:candidate.key,item:'P1',token:view.token});expect(view.segments.find(segment=>segment.key===candidate.key)?.scope).toBe('in-scope');}
});
it('persists bounded per-item notes without creating a plan revision',()=>{
 const {service,config}=fixture();const view=service.load();service.act({action:'note',item:'P1',kind:'question',text:'Why this limit?',token:view.token});
 const reopened=new ReviewService(config);services.push(reopened);expect(reopened.load().notes[0]!.text).toBe('Why this limit?');expect(reopened.load().plan.revision).toBe(1);
 expect(()=>service.act({action:'note',item:'P2',kind:'change',text:'x'.repeat(4001),token:service.load().token})).toThrow(/Invalid/);
});
it('migrates a v1 database without losing its plans or ledger',()=>{
 const {service,config}=fixture();service.close();services.splice(services.indexOf(service),1);
 const db=new DatabaseSync(config.database);db.exec('ALTER TABLE plans DROP COLUMN review_version; DROP TABLE review_notes; DROP TABLE app_settings; ALTER TABLE requests DROP COLUMN reason; ALTER TABLE requests DROP COLUMN snapshot_id; PRAGMA user_version=1;');db.close();
 const migrated=new ReviewService(config);services.push(migrated);expect(migrated.load().plan.revision).toBe(1);expect(migrated.store.getLedger(config.identity)).toHaveLength(2);expect(migrated.load().notes).toEqual([]);
});
it('rejects a concurrent store review edit through the atomic review counter',()=>{
 const {service,config}=fixture();const other=new ReviewService(config);services.push(other);const view=service.load();
 other.store.addReviewNote(config.identity,view.expected,'P1','change','Please explain');
 expect(()=>service.store.saveReview(config.identity,view.expected,[],[])).toThrow(/Stale/);
});
it('requires every item to be reviewed again after a queued head is replaced',()=>{
 const {service,config}=fixture();let view=service.load();
 service.store.saveReview(config.identity,view.expected,view.items.map(item=>approveItem(view.plan,view.segments,item.id,config.identity,item.count===0)),[]);view=service.load();
 const attempt=service.store.beginMergeAttempt(config.identity,{...view.expected,reviewVersion:view.expected.reviewVersion!},view.snapshot.head);service.store.queueMergeAttempt(config.identity,attempt.id,'https://github.example/pr/24');service.store.finishMergeAttempt(config.identity,attempt.id,{state:'failed',reason:'The pull request head changed after review.',requiresFreshReview:true});
 execFileSync('git',['-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','Replace reviewed head'],{cwd:config.repository,stdio:'pipe'});
 view=service.load();expect(view.items.every(item=>item.state==='stale'&&item.reasons.includes('Pull request snapshot changed after the queue attempt'))).toBe(true);
 const [first,...remaining]=view.items;service.store.saveReview(config.identity,view.expected,[approveItem(view.plan,view.segments,first!.id,config.identity,first!.count===0)],[]);view=service.load();expect(view.items.find(item=>item.id===first!.id)?.state).toBe('approved');expect(view.items.filter(item=>item.id!==first!.id).every(item=>item.state==='stale')).toBe(true);
 service.store.saveReview(config.identity,view.expected,remaining.map(item=>approveItem(view.plan,view.segments,item.id,config.identity,item.count===0)),[]);view=service.load();
 expect(view.items.every(item=>item.state==='approved')).toBe(true);
},30000);
it('marks unchanged items stale after a same-snapshot plan amendment',()=>{
 const {service,config}=fixture();let view=service.load();
 service.store.saveReview(config.identity,view.expected,view.items.map(item=>approveItem(view.plan,view.segments,item.id,config.identity,item.count===0)),[]);view=service.load();
 const attempt=service.store.beginMergeAttempt(config.identity,{...view.expected,reviewVersion:view.expected.reviewVersion!},view.snapshot.head);service.store.queueMergeAttempt(config.identity,attempt.id,'https://github.example/pr/24');service.store.finishMergeAttempt(config.identity,attempt.id,{state:'removed',reason:'Checks failed.'});
 const amended={...view.plan,summary:'Amended review requirements'};service.store.importRevision(JSON.stringify(amended),'json',{identity:config.identity,issue:amended.issue,baseEntries:['retry.ts','README.md','run.sh'].map(path=>({path,kind:'file' as const})),pathKey:path=>path,allowedCommands:[]},amended.revision);
 view=service.load();expect(view.items.every(item=>item.state==='stale'&&item.reasons.includes('Plan revision changed after the queue attempt'))).toBe(true);
 const first=view.items[0]!;view=service.act({action:'approve',item:first.id,confirmNoChange:first.count===0,token:view.token});expect(view.items.find(item=>item.id===first.id)?.state).toBe('approved');
});
it('refuses no-change confirmation while the item still owns ambiguous changes',async()=>{
 const {service,config}=fixture();const {writeFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');
 writeFileSync(join(config.repository,'retry.ts'),'export function delay(attempt: number) {\n  return Math.min(10000, 200 * 2 ** attempt);\n}\n');
 execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-am','P2 changes retry'],{cwd:config.repository,stdio:'pipe'});
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd:config.repository,encoding:'utf8'}).trim();const snapshot=service.store.getSnapshot(config.identity);
 service.store.recordHistory(config.identity,{revision:1,snapshotId:snapshot.id},snapshot.base,head,[{sha:head,owner:'P2',origin:'owned',sourceSha:null}]);
 const view=service.load();expect(view.items[0]!.count).toBe(0);expect(view.segments.some(s=>s.row==='Ambiguous'&&s.owners.includes('P1'))).toBe(true);
 expect(()=>service.act({action:'approve',item:'P1',confirmNoChange:true,token:view.token})).toThrow(/ambiguous/i);
 expect(view.items[1]!.count).toBeGreaterThan(0);
 expect(()=>service.act({action:'approve',item:'P2',token:view.token})).toThrow(/ambiguous/i);
});
it('anchors notes to server-owned code and rejects invalid ranges and cross-item references',()=>{
 const {service,config}=fixture();let view=service.load();const segment=view.segments.find(s=>s.row==='P1'&&s.kind!=='file'&&s.operation==='+')!;
 const start=segment.newLine!;
 expect(()=>service.act({action:'note',item:'P2',kind:'question',text:'Why?',reference:{key:segment.key,start,end:start},token:view.token})).toThrow(/Invalid snippet/);
 expect(()=>service.act({action:'note',item:'P1',kind:'question',text:'Why?',reference:{key:segment.key,start:0,end:start},token:view.token})).toThrow(/changed block/);
 view=service.act({action:'note',item:'P1',kind:'question',text:'Why?',reference:{key:segment.key,start,end:start,text:'forged',path:'forged'},token:view.token});
 const ref=view.notes[0]!.reference!;expect(ref.text).toBe(segment.content.split('\n')[0]);expect(ref.path).toBe(segment.path);expect(ref.head).toBe(view.snapshot.head);expect(view.notes[0]!.outdated).toBe(false);
 const reopened=new ReviewService(config);services.push(reopened);expect(reopened.load().notes[0]!.reference).toEqual(ref);
});
it('preserves removed-side snippets and marks their references outdated after HEAD changes',async()=>{
 const {service,config}=fixture();let view=service.load();const segment=view.segments.find(s=>s.row==='P1'&&s.kind!=='file'&&s.operation==='-')!;
 view=service.act({action:'note',item:'P1',kind:'change',text:'Keep this?',reference:{key:segment.key,start:segment.oldLine,end:segment.oldLine},token:view.token});
 const ref=view.notes[0]!.reference!;expect(ref.side).toBe('old');
 const {execFileSync}=await import('node:child_process');execFileSync('git',['-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','new revision'],{cwd:config.repository,stdio:'pipe'});
 view=service.load();expect(view.notes[0]!.outdated).toBe(true);expect(view.notes[0]!.reference).toEqual(ref);
});
