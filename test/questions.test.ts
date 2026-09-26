import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../scripts/demo.ts';
import { ReviewService } from '../runner/review.ts';
import { Questions } from '../runner/questions.ts';
import { choiceKeys } from '../core/approvals.ts';
// Real-Git context reads can overlap the Docker-backed isolation suite in a full run.
vi.setConfig({testTimeout:30000});
const roots:string[]=[], services:ReviewService[]=[], managers:Questions[]=[];
afterEach(async()=>{for(const manager of managers.splice(0))await manager.close();services.splice(0).forEach(s=>s.close());roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true}));vi.restoreAllMocks();});
function waitForAbort(_prompt:string,signal:AbortSignal):Promise<string>{return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
function fixture(){const root=mkdtempSync(join(tmpdir(),'codeboost-answers-'));roots.push(root);const service=new ReviewService(createDemo(join(root,'demo')));services.push(service);return service;}
function question(service:ReviewService){const view=service.load();const segment=view.segments.find(s=>s.row==='P1'&&s.operation==='+')!;return service.act({action:'note',item:'P1',kind:'question',text:'Why cap the retry delay?',reference:{key:segment.key,start:segment.newLine,end:segment.newLine},token:view.token});}
it('persists answers with plan, code, selected snippet and prior conversation context',async()=>{
 const service=fixture();let view=service.load();service.act({action:'note',item:'P1',kind:'change',text:'Keep the signature.',token:view.token});const asked=question(service);
 let prompt='';const manager=new Questions(service,async input=>{prompt=input;return 'The cap bounds retry latency.';});managers.push(manager);manager.start(asked.createdNoteId!,asked);
 await vi.waitFor(()=>expect(service.store.getReviewNotes(service.config.identity).at(-1)?.answer?.status).toBe('complete'));
 expect(prompt).toContain('Why cap the retry delay?');expect(prompt).toContain('Math.min');expect(prompt).toContain('Keep the signature.');
 const after=service.load();expect(after.plan.revision).toBe(asked.plan.revision);expect(after.token).toBe(asked.token);expect(after.approved).toBe(0);
 const reopened=new ReviewService(service.config);services.push(reopened);expect(reopened.load().notes.at(-1)?.answer?.text).toContain('bounds retry latency');
},30_000);
it('asks about the configured repository at the reviewed snapshot head',async()=>{
 const service=fixture(),asked=question(service);let received:unknown;
 const manager=new Questions(service,async(_prompt,_signal,scope)=>{received=scope;return 'Answer';});managers.push(manager);manager.start(asked.createdNoteId!,asked);
 await vi.waitFor(()=>expect(received).toBeDefined());
 expect(received).toEqual({repository:service.config.repository,head:asked.snapshot.head,snapshotId:asked.snapshot.id,planId:service.config.identity.planId,planRevision:asked.plan.revision,noteId:asked.createdNoteId,attemptId:service.store.getReviewNotes(service.config.identity)[0]!.answer!.attempt,contextId:asked.notes.find(note=>note.id===asked.createdNoteId)!.contextId});
});
it('fails visibly and retries without duplicating the question or accepting stale completions',async()=>{
 const service=fixture(),asked=question(service);let calls=0;
 const manager=new Questions(service,async()=>{if(++calls===1)throw new Error('Login required');return 'Recovered answer';});managers.push(manager);manager.start(asked.createdNoteId!,asked);
 await vi.waitFor(()=>expect(service.store.getReviewNotes(service.config.identity)[0]?.answer?.status).toBe('failed'));
 const first=service.store.getReviewNotes(service.config.identity)[0]!.answer!.attempt;
 manager.start(asked.createdNoteId!,service.load());await vi.waitFor(()=>expect(service.store.getReviewNotes(service.config.identity)[0]?.answer?.status).toBe('complete'));
 service.store.finishAnswer(service.config.identity,asked.createdNoteId!,first,{status:'complete',text:'Late old answer'});
 expect(service.store.getReviewNotes(service.config.identity)).toHaveLength(1);expect(service.store.getReviewNotes(service.config.identity)[0]!.answer!.text).toBe('Recovered answer');
});
it('prevents duplicate invocations and records interruption when the server stops',async()=>{
 const service=fixture(),asked=question(service);const manager=new Questions(service,waitForAbort);managers.push(manager);manager.start(asked.createdNoteId!,asked);
 expect(()=>manager.start(asked.createdNoteId!,asked)).toThrow(/already answering/);await manager.close();
 expect(service.store.getReviewNotes(service.config.identity)[0]!.answer?.error).toMatch(/Server stopped/);
});
it('persists provider selection and rejects anything but a known provider',()=>{
 const service=fixture();expect(service.store.questionProvider()).toBeNull();service.store.setQuestionProvider('codex');const reopened=new ReviewService(service.config);services.push(reopened);expect(reopened.store.questionProvider()).toBe('codex');expect(()=>service.store.setQuestionProvider('sh -c anything')).toThrow(/Choose/);
});
it('times out an unresponsive agent and allows expired pending attempts to be recovered',async()=>{
 const service=fixture(),asked=question(service);const manager=new Questions(service,waitForAbort);managers.push(manager);
 vi.useFakeTimers();
 try {manager.start(asked.createdNoteId!,asked);await vi.advanceTimersByTimeAsync(120001);expect(service.store.getReviewNotes(service.config.identity)[0]!.answer?.error).toMatch(/timed out/);
 service.store.beginAnswer(service.config.identity,asked.createdNoteId!,'interrupted');await vi.advanceTimersByTimeAsync(125001);service.store.beginAnswer(service.config.identity,asked.createdNoteId!,'replacement');service.store.finishAnswer(service.config.identity,asked.createdNoteId!,'interrupted',{status:'complete',text:'Old answer'});expect(service.store.getReviewNotes(service.config.identity)[0]!.answer?.attempt).toBe('replacement');
 } finally {vi.useRealTimers();}
});
it('does not replace a locally running job when its persisted lease expires',async()=>{
 const service=fixture(),asked=question(service);let calls=0,signal:AbortSignal|undefined;
 const manager=new Questions(service,(_prompt,currentSignal)=>{calls++;signal=currentSignal;return waitForAbort(_prompt,currentSignal);});managers.push(manager);
 manager.start(asked.createdNoteId!,asked);
 const original=service.store.getReviewNotes(service.config.identity)[0]!.answer!.attempt;
 const later=Date.now()+130000;vi.spyOn(Date,'now').mockReturnValue(later);
 expect(()=>manager.start(asked.createdNoteId!,asked)).toThrow(/already answering/);
 expect(calls).toBe(1);expect(service.store.getReviewNotes(service.config.identity)[0]!.answer!.attempt).toBe(original);
 await manager.close();expect(signal?.aborted).toBe(true);expect(service.store.getReviewNotes(service.config.identity)[0]!.answer?.error).toMatch(/Server stopped/);
});
it('rejects new work as soon as shutdown begins',async()=>{
 const service=fixture(),first=question(service),second=question(service);let calls=0;
 const manager=new Questions(service,(prompt,signal)=>{calls++;return waitForAbort(prompt,signal);});managers.push(manager);
 manager.start(first.createdNoteId!,first);
 const closing=manager.close();
 expect(()=>manager.start(second.createdNoteId!,second)).toThrow(/stopping/);
 await closing;
 expect(()=>manager.start(second.createdNoteId!,second)).toThrow(/stopping/);
 expect(calls).toBe(1);
 expect(service.store.getReviewNotes(service.config.identity).find(note=>note.id===second.createdNoteId)?.answer).toBeUndefined();
});
it('keeps cancelled invocations tracked until they settle',async()=>{
 const service=fixture(),asked=question(service);let settle!:(value:string)=>void;
 const manager=new Questions(service,()=>new Promise(resolve=>settle=resolve));managers.push(manager);
 vi.useFakeTimers();
 try {
  manager.start(asked.createdNoteId!,asked);await vi.advanceTimersByTimeAsync(120001);
  expect(service.store.getReviewNotes(service.config.identity)[0]!.answer?.status).toBe('failed');
  expect(()=>manager.start(asked.createdNoteId!,asked)).toThrow(/already answering/);
  let closed=false;const closing=manager.close().then(()=>{closed=true;});
  await Promise.resolve();await Promise.resolve();expect(closed).toBe(false);
  settle('Late answer');await closing;expect(closed).toBe(true);
  expect(service.store.getReviewNotes(service.config.identity)[0]!.answer?.status).toBe('failed');
 } finally {settle('Cleanup');vi.useRealTimers();}
});
it('rejects questions whose snippet was reassigned without changing the snapshot',()=>{
 const service=fixture();const initial=service.load(),foreign=initial.segments.find(s=>s.row==='Unplanned'&&s.operation==='+')!;
 const assigned=service.act({action:'assign',item:'P1',key:foreign.key,token:initial.token});
 const asked=service.act({action:'note',item:'P1',kind:'question',text:'Explain this',reference:{key:foreign.key,start:foreign.newLine,end:foreign.newLine},token:assigned.token});
 const note=asked.notes.find(note=>note.id===asked.createdNoteId)!;
 const index=initial.segments.findIndex(segment=>segment.key===foreign.key);
 service.store.saveReview(service.config.identity,asked.expected,[],[{action:'assign',item:'P2',key:choiceKeys(initial.segments,service.config.identity)[index]!}]);
 const moved=service.load();
 expect(moved.snapshot.id).toBe(asked.snapshot.id);expect(moved.notes.find(n=>n.id===note.id)?.outdated).toBe(true);
 const agent=vi.fn(async()=>'Should not run');const manager=new Questions(service,agent);managers.push(manager);
 expect(()=>manager.start(note.id,moved)).toThrow(/older review|outdated/);expect(agent).not.toHaveBeenCalled();
});
it('marks an item-level attempt historical and rejects retry when assigned code changes',async()=>{
 const service=fixture(),initial=service.load(),foreign=initial.segments.find(s=>s.row==='Unplanned')!;
 const asked=service.act({action:'note',item:'P1',kind:'question',text:'Is this item complete?',token:initial.token});
 const agent=vi.fn(async()=>{throw new Error('Provider failed');}),manager=new Questions(service,agent);managers.push(manager);
 manager.start(asked.createdNoteId!,asked);await vi.waitFor(()=>expect(service.store.getReviewNotes(service.config.identity)[0]?.answer?.status).toBe('failed'));
 const index=initial.segments.findIndex(segment=>segment.key===foreign.key);
 service.store.saveReview(service.config.identity,asked.expected,[],[{action:'assign',item:'P1',key:choiceKeys(initial.segments,service.config.identity)[index]!}]);
 const changed=service.load(),note=changed.notes.find(note=>note.id===asked.createdNoteId)!;
 expect(changed.snapshot.id).toBe(asked.snapshot.id);expect(note.answerOutdated).toBe(true);
 expect(()=>manager.start(note.id,changed)).toThrow(/older review/);expect(agent).toHaveBeenCalledTimes(1);
});
