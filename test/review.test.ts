import { afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDemo } from '../scripts/demo.ts';
import { ReviewService } from '../runner/review.ts';
// Each integration case performs several bounded real-Git reads.
vi.setConfig({ testTimeout: 15000 });
const roots:string[]=[];const services:ReviewService[]=[];
afterEach(()=>{services.splice(0).forEach(service=>service.close());roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true}));});
function fixture(){const root=mkdtempSync(join(tmpdir(),'codeboost-review-'));roots.push(root);const config=createDemo(join(root,'demo'));const service=new ReviewService(config);services.push(service);return {service,config};}
it('expires a browser token after another view assigns a segment and recomputes scope honestly',()=>{
 const {service}=fixture();const view=service.load();const foreign=view.segments.find(s=>s.row==='Unplanned')!;
 const next=service.act({action:'assign',key:foreign.key,item:'P1',token:view.token});
 expect(next.items[0]!.checks.scope).toContain('out of scope');
 expect(()=>service.act({action:'approve',item:'P1',token:view.token})).toThrow(/Stale/);
});
it('persists bounded per-item notes without creating a plan revision',()=>{
 const {service,config}=fixture();const view=service.load();service.act({action:'note',item:'P1',kind:'question',text:'Why this limit?',token:view.token});
 const reopened=new ReviewService(config);services.push(reopened);expect(reopened.load().notes[0]!.text).toBe('Why this limit?');expect(reopened.load().plan.revision).toBe(1);
 expect(()=>service.act({action:'note',item:'P2',kind:'change',text:'x'.repeat(4001),token:service.load().token})).toThrow(/Invalid/);
});
it('migrates a v1 database without losing its plans or ledger',()=>{
 const {service,config}=fixture();service.close();services.splice(services.indexOf(service),1);
 const db=new DatabaseSync(config.database);db.exec('ALTER TABLE plans DROP COLUMN review_version; DROP TABLE review_notes; PRAGMA user_version=1;');db.close();
 const migrated=new ReviewService(config);services.push(migrated);expect(migrated.load().plan.revision).toBe(1);expect(migrated.store.getLedger(config.identity)).toHaveLength(2);expect(migrated.load().notes).toEqual([]);
});
it('rejects a concurrent store review edit through the atomic review counter',()=>{
 const {service,config}=fixture();const other=new ReviewService(config);services.push(other);const view=service.load();
 other.store.addReviewNote(config.identity,view.expected,'P1','change','Please explain');
 expect(()=>service.store.saveReview(config.identity,view.expected,[],[])).toThrow(/Stale/);
});
it('refuses no-change confirmation while the item still owns ambiguous changes',async()=>{
 const {service,config}=fixture();const {writeFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');
 writeFileSync(join(config.repository,'retry.ts'),'export function delay(attempt: number) {\n  return Math.min(10000, 200 * 2 ** attempt);\n}\n');
 execFileSync('git',['-c','core.hooksPath=/dev/null','commit','-am','P2 changes retry'],{cwd:config.repository,stdio:'pipe'});
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd:config.repository,encoding:'utf8'}).trim();const snapshot=service.store.getSnapshot(config.identity);
 service.store.recordHistory(config.identity,{revision:1,snapshotId:snapshot.id},snapshot.base,head,[{sha:head,owner:'P2',origin:'owned',sourceSha:null}]);
 const view=service.load();expect(view.items[0]!.count).toBe(0);expect(view.segments.some(s=>s.row==='Ambiguous'&&s.owners.includes('P1'))).toBe(true);
 expect(()=>service.act({action:'approve',item:'P1',confirmNoChange:true,token:view.token})).toThrow(/ambiguous/i);
});
