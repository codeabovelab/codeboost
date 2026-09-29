import { afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createDemo } from '../scripts/demo.ts';
import { ReviewService } from '../runner/review.ts';
import { startServer } from '../web/server.ts';
import { approveItem, reviewedSegment } from '../core/approvals.ts';
import { fixtureGit } from './fixtures/git.ts';
// A passthrough, so the stale-key test can count how often load() serializes a segment.
vi.mock('../core/approvals.ts', async original => { const actual = await original<typeof import('../core/approvals.ts')>(); return { ...actual, reviewedSegment: vi.fn(actual.reviewedSegment) }; });
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
it('gives each stale state its own stale key, including states whose segments and reasons repeat',()=>{
 const {service,config}=fixture();let view=service.load();const item=(id:string)=>view.items.find(value=>value.id===id)!;
 const own=(id:string)=>view.segments.filter(segment=>segment.row===id).map(segment=>segment.key);
 expect(view.items.every(value=>value.staleKey===null)).toBe(true);
 view=service.act({action:'approve',item:'P1',token:view.token});view=service.act({action:'approve',item:'P3',confirmNoChange:true,token:view.token});expect(item('P1').staleKey).toBeNull();
 const unplanned=()=>view.segments.find(segment=>segment.row==='Unplanned')!.key;
 view=service.act({action:'assign',key:unplanned(),item:'P1',token:view.token});
 const first={p1:item('P1').staleKey,p3:item('P3').staleKey,p3Reasons:item('P3').reasons};
 expect(item('P1').state).toBe('stale');expect(first.p1).toMatch(/^[0-9a-f]{64}$/);expect(item('P3').state).toBe('stale');expect(first.p3).toMatch(/^[0-9a-f]{64}$/);
 view=service.load();expect(item('P1').staleKey).toBe(first.p1);expect(item('P3').staleKey).toBe(first.p3);
 // P1 changes again: P3's own segments and reasons stay the same, but its dependency's stale state is new.
 view=service.act({action:'assign',key:unplanned(),item:'P1',token:view.token});
 const second={p1:item('P1').staleKey,p1Segments:own('P1'),p1Reasons:item('P1').reasons};
 expect(second.p1).not.toBe(first.p1);expect(item('P3').reasons).toEqual(first.p3Reasons);expect(item('P3').staleKey).not.toBe(first.p3);
 // Re-approving P3 while P1 keeps it stale changes only P3's approval.
 const p3Before=item('P3').staleKey;view=service.act({action:'approve',item:'P3',confirmNoChange:true,token:view.token});
 expect(item('P3').state).toBe('stale');expect(item('P3').reasons).toEqual(first.p3Reasons);expect(item('P3').staleKey).not.toBe(p3Before);
 // P1 is approved at its current code, then an ambiguous change it shares makes it stale with the same own segments and reasons as before.
 view=service.act({action:'approve',item:'P1',token:view.token});expect(item('P1').staleKey).toBeNull();
 // P1 adds a line to an existing file and P2 then edits that same line, so the line is ambiguous between them.
 const readme=join(config.repository,'README.md'),original=readFileSync(readme,'utf8');
 const commit=(line:string,message:string)=>{writeFileSync(readme,`${original}${line}\n`);fixtureGit(config.repository,'commit','-am',message);return fixtureGit(config.repository,'rev-parse','HEAD');};
 const byP1=commit('Shared note.','P1 shared line'),byP2=commit('Shared note, revised.','P2 shared line'),snapshot=service.store.getSnapshot(config.identity);
 service.store.recordHistory(config.identity,{revision:view.plan.revision,snapshotId:snapshot.id},snapshot.base,byP2,[{sha:byP1,owner:'P1',origin:'owned',sourceSha:null},{sha:byP2,owner:'P2',origin:'owned',sourceSha:null}]);
 view=service.load();expect(view.segments.some(segment=>segment.row==='Ambiguous'&&segment.owners.includes('P1'))).toBe(true);
 expect(item('P1').state).toBe('stale');expect(own('P1')).toEqual(second.p1Segments);expect(item('P1').reasons).toEqual(second.p1Reasons);
 expect(item('P1').staleKey).not.toBe(second.p1);expect(item('P1').staleKey).not.toBe(first.p1);
},30000);
it('gives a still-stale item a new stale key when it gains an ambiguous change',()=>{
 const {service,config}=fixture();let view=service.load();const item=(id:string)=>view.items.find(value=>value.id===id)!;
 for(const id of ['P1','P2','P3'])view=service.act({action:'approve',item:id,confirmNoChange:item(id).count===0,token:view.token});view=service.act({action:'assign',key:view.segments.find(segment=>segment.row==='Unplanned')!.key,item:'P1',token:view.token});
 const before={key:item('P1').staleKey,reasons:item('P1').reasons,own:view.segments.filter(segment=>segment.row==='P1').map(segment=>segment.key)};expect(item('P1').state).toBe('stale');
 const readme=join(config.repository,'README.md'),original=readFileSync(readme,'utf8');
 const commit=(line:string,message:string)=>{writeFileSync(readme,`${original}${line}\n`);fixtureGit(config.repository,'commit','-am',message);return fixtureGit(config.repository,'rev-parse','HEAD');};
 const byP1=commit('Shared note.','P1 shared line'),byP2=commit('Shared note, revised.','P2 shared line'),snapshot=service.store.getSnapshot(config.identity);
 service.store.recordHistory(config.identity,{revision:view.plan.revision,snapshotId:snapshot.id},snapshot.base,byP2,[{sha:byP1,owner:'P1',origin:'owned',sourceSha:null},{sha:byP2,owner:'P2',origin:'owned',sourceSha:null}]);
 view=service.load();expect(view.segments.some(segment=>segment.row==='Ambiguous'&&segment.owners.includes('P1'))).toBe(true);
 expect(view.segments.filter(segment=>segment.row==='P1').map(segment=>segment.key)).toEqual(before.own);expect(item('P1').reasons).toEqual(before.reasons);expect(item('P1').staleKey).not.toBe(before.key);
 // P3 then edits the same line back to P2's text: the segment keeps its choice key but gains an owner, so the stale state is new.
 const shared=()=>view.segments.find(segment=>segment.row==='Ambiguous'&&segment.path==='README.md')!,second={key:item('P1').staleKey,segment:shared()};
 writeFileSync(readme,`${original}Shared note, draft.\n`);fixtureGit(config.repository,'commit','-am','P3 draft');const byP3=fixtureGit(config.repository,'rev-parse','HEAD');
 const back=commit('Shared note, revised.','P3 restores the line'),current=service.store.getSnapshot(config.identity);
 service.store.recordHistory(config.identity,{revision:view.plan.revision,snapshotId:current.id},current.base,back,[{sha:byP3,owner:'P3',origin:'owned',sourceSha:null},{sha:back,owner:'P3',origin:'owned',sourceSha:null}]);
 view=service.load();expect(shared().key).toBe(second.segment.key);expect(shared().owners).not.toEqual(second.segment.owners);
 expect(view.segments.filter(segment=>segment.row==='P1').map(segment=>segment.key)).toEqual(before.own);expect(item('P1').reasons).toEqual(before.reasons);expect(item('P1').staleKey).not.toBe(second.key);
 // The shared segment belongs to three stale items, yet one load serializes it once.
 vi.mocked(reviewedSegment).mockClear();view=service.load();
 expect(shared().owners.filter(owner=>owner!==null&&item(owner).state==='stale').length).toBeGreaterThanOrEqual(3);
 expect(vi.mocked(reviewedSegment).mock.calls.filter(([segment])=>(segment as {key?:string}).key===shared().key)).toHaveLength(1);
},30000);
it('gives each replaced head after a queue attempt its own stale key',()=>{
 const {service,config}=fixture();let view=service.load();
 service.store.saveReview(config.identity,view.expected,view.items.map(item=>approveItem(view.plan,view.segments,item.id,config.identity,item.count===0)),[]);view=service.load();
 const attempt=service.store.beginMergeAttempt(config.identity,{...view.expected,reviewVersion:view.expected.reviewVersion!},view.snapshot.head);service.store.queueMergeAttempt(config.identity,attempt.id,'https://github.example/pr/24');service.store.finishMergeAttempt(config.identity,attempt.id,{state:'failed',reason:'The pull request head changed after review.',requiresFreshReview:true});
 const replace=()=>{fixtureGit(config.repository,'commit','--allow-empty','-m','Replace reviewed head');return service.load();};
 const first=replace(),second=replace(),p3=(value:typeof view)=>value.items.find(item=>item.id==='P3')!;
 expect(p3(first).state).toBe('stale');expect(p3(second).reasons).toEqual(p3(first).reasons);expect(p3(second).staleKey).not.toBe(p3(first).staleKey);
},30000);
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
