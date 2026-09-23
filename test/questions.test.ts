import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../scripts/demo.ts';
import { ReviewService } from '../runner/review.ts';
import { Questions } from '../runner/questions.ts';
import { agentArguments } from '../runner/question-agent.ts';
// Real-Git context reads match the existing review integration suite budget.
vi.setConfig({testTimeout:15000});
const roots:string[]=[], services:ReviewService[]=[], managers:Questions[]=[];
afterEach(async()=>{for(const manager of managers.splice(0))await manager.close();services.splice(0).forEach(s=>s.close());roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true}));vi.restoreAllMocks();});
function fixture(){const root=mkdtempSync(join(tmpdir(),'codeboost-answers-'));roots.push(root);const service=new ReviewService(createDemo(join(root,'demo')));services.push(service);return service;}
function question(service:ReviewService){const view=service.load();const segment=view.segments.find(s=>s.row==='P1'&&s.operation==='+')!;return service.act({action:'note',item:'P1',kind:'question',text:'Why cap the retry delay?',reference:{key:segment.key,start:segment.newLine,end:segment.newLine},token:view.token});}
it('persists answers with plan, code, selected snippet and prior conversation context',async()=>{
 const service=fixture();let view=service.load();service.act({action:'note',item:'P1',kind:'change',text:'Keep the signature.',token:view.token});const asked=question(service);
 let prompt='';const manager=new Questions(service,async input=>{prompt=input;return 'The cap bounds retry latency.';});managers.push(manager);manager.start(asked.createdNoteId!,asked);
 await vi.waitFor(()=>expect(service.store.getReviewNotes(service.config.identity).at(-1)?.answer?.status).toBe('complete'));
 expect(prompt).toContain('Why cap the retry delay?');expect(prompt).toContain('Math.min');expect(prompt).toContain('Keep the signature.');
 const after=service.load();expect(after.plan.revision).toBe(asked.plan.revision);expect(after.token).toBe(asked.token);expect(after.approved).toBe(0);
 const reopened=new ReviewService(service.config);services.push(reopened);expect(reopened.load().notes.at(-1)?.answer?.text).toContain('bounds retry latency');
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
 const service=fixture(),asked=question(service);const manager=new Questions(service,()=>new Promise(()=>{}));managers.push(manager);manager.start(asked.createdNoteId!,asked);
 expect(()=>manager.start(asked.createdNoteId!,asked)).toThrow(/already answering/);await manager.close();
 expect(service.store.getReviewNotes(service.config.identity)[0]!.answer?.error).toMatch(/Server stopped/);
});
it('persists provider selection and restricts commands to fixed provider launch arguments',()=>{
 const service=fixture();expect(service.store.questionProvider()).toBeNull();service.store.setQuestionProvider('codex');const reopened=new ReviewService(service.config);services.push(reopened);expect(reopened.store.questionProvider()).toBe('codex');expect(()=>service.store.setQuestionProvider('sh -c anything')).toThrow(/Choose/);
 const claude=agentArguments('claude');expect(claude[claude.indexOf('--tools')+1]).toBe('');expect(claude).toContain('--safe-mode');
 const codex=agentArguments('codex');expect(codex).toContain('read-only');expect(codex).toContain('features.shell_tool=false');expect(codex).toContain('features.plugins=false');
});
it('times out an unresponsive agent and allows expired pending attempts to be recovered',async()=>{
 const service=fixture(),asked=question(service);const manager=new Questions(service,()=>new Promise(()=>{}));managers.push(manager);
 vi.useFakeTimers();
 try {manager.start(asked.createdNoteId!,asked);await vi.advanceTimersByTimeAsync(120001);expect(service.store.getReviewNotes(service.config.identity)[0]!.answer?.error).toMatch(/timed out/);
 service.store.beginAnswer(service.config.identity,asked.createdNoteId!,'interrupted');await vi.advanceTimersByTimeAsync(125001);service.store.beginAnswer(service.config.identity,asked.createdNoteId!,'replacement');service.store.finishAnswer(service.config.identity,asked.createdNoteId!,'interrupted',{status:'complete',text:'Old answer'});expect(service.store.getReviewNotes(service.config.identity)[0]!.answer?.attempt).toBe('replacement');
 } finally {vi.useRealTimers();}
});
it('does not replace a locally running job when its persisted lease expires',async()=>{
 const service=fixture(),asked=question(service);let calls=0,signal:AbortSignal|undefined;
 const manager=new Questions(service,(_prompt,currentSignal)=>{calls++;signal=currentSignal;return new Promise(()=>{});});managers.push(manager);
 manager.start(asked.createdNoteId!,asked);
 const original=service.store.getReviewNotes(service.config.identity)[0]!.answer!.attempt;
 const later=Date.now()+130000;vi.spyOn(Date,'now').mockReturnValue(later);
 expect(()=>manager.start(asked.createdNoteId!,asked)).toThrow(/already answering/);
 expect(calls).toBe(1);expect(service.store.getReviewNotes(service.config.identity)[0]!.answer!.attempt).toBe(original);
 await manager.close();expect(signal?.aborted).toBe(true);expect(service.store.getReviewNotes(service.config.identity)[0]!.answer?.error).toMatch(/Server stopped/);
});
