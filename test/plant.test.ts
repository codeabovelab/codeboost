import { it,expect,afterEach,vi } from 'vitest';
import { mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDemo } from '../scripts/demo.ts';
import { plant } from '../scripts/plant.ts';
import { ReviewService } from '../runner/review.ts';
import { Store } from '../runner/store.ts';
import type { Plan } from '../core/plan.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
it('plants in an isolated clone, retains ledger attribution, and leaves source history unchanged',()=>{
 const root=mkdtempSync(join(tmpdir(),'codeboost-plant-'));roots.push(root);const config=createDemo(join(root,'source'));
 const head=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:config.repository,encoding:'utf8'}).trim();const before=head();
 const path=plant(config,join(root,'experiment'),{declaredText:'// planted extra behavior',undeclaredText:'unrelated diagnostic',undeclaredPath:'extra.txt'});
 expect(head()).toBe(before);const output=JSON.parse(readFileSync(path,'utf8'));const service=new ReviewService(output);
 try {const view=service.load();expect(view.segments.some(s=>s.path==='extra.txt'&&s.scope==='out-of-scope')).toBe(true);expect(view.segments.some(s=>s.content.includes('// planted extra behavior')&&s.row.startsWith('P'))).toBe(true);}finally{service.close();}
 expect(JSON.parse(readFileSync(join(root,'experiment','sealed.json'),'utf8')).mappings).toHaveLength(3);
},15000);
it('refuses non-ASCII plants on case-insensitive filesystems pending an identity adapter', () => {
 const root=mkdtempSync(join(tmpdir(),'codeboost-plant-path-'));roots.push(root);
 const config=createDemo(join(root,'source'));config.pathIdentity.caseSensitive=false;
 expect(()=>plant(config,join(root,'experiment'),{declaredText:'// extra',undeclaredText:'diagnostic',undeclaredPath:'café.txt'})).toThrow(/filesystem-specific identity adapter/);
},15000);
it('rejects canonical declared and existing path collisions before creating a clone', () => {
 const root=mkdtempSync(join(tmpdir(),'codeboost-plant-collision-'));roots.push(root);
 const config=createDemo(join(root,'source'));config.pathIdentity.caseSensitive=false;
 for (const path of ['RETRY.TS','RUN.SH']) expect(()=>plant(config,join(root,'experiment'),{declaredText:'// extra',undeclaredText:'diagnostic',undeclaredPath:path})).toThrow(/outside every declared file|already exists/);
},15000);
it('treats metacharacters literally when checking declared-file transitions',()=>{
 const root=mkdtempSync(join(tmpdir(),'codeboost-plant-literal-'));roots.push(root);const repository=join(root,'source');mkdirSync(repository);
 const git=(...args:string[])=>execFileSync('git',args,{cwd:repository,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');git('config','commit.gpgsign','false');
 const commit=(message:string)=>{git('add','-A');git('commit','-m',message);return git('rev-parse','HEAD');};
 writeFileSync(join(repository,'*.txt'),'base\n');writeFileSync(join(repository,'a.txt'),'decoy\n');const base=commit('Base');
 writeFileSync(join(repository,'*.txt'),'owned change\n');const owned=commit('Owned change');
 rmSync(join(repository,'*.txt'));writeFileSync(join(repository,'a.txt'),'changed decoy\n');const head=commit('Remove literal path');
 const identity={repositoryId:'literal-repo',taskId:'literal-task',planId:'literal-plan'};
 const plan:Plan={schema_version:1,revision:1,issue:10,summary:'Literal path validation',questions:[],items:[{id:'P1',title:'Edit literal path',intent:'Exercise path handling.',files:[{path:'*.txt',kind:'edit',renamed_from:null,change:'Edit the literal file.'}],acceptance:[{type:'check',text:'Literal file remains present.'}],depends_on:[]}]};
 const config={database:join(root,'review.sqlite'),repository,identity,pathIdentity:{caseSensitive:true as const,unicodeNormalization:'none' as const},demo:false};
 const store=new Store(config.database);
 try{store.createPlan(JSON.stringify(plan),'json',{identity,issue:10,baseEntries:['*.txt','a.txt'].map(path=>({path,kind:'file' as const})),pathKey:path=>path,allowedCommands:[]},base,head);store.recordHistory(identity,{revision:1,snapshotId:store.getSnapshot(identity).id},base,head,[{sha:owned,owner:'P1',origin:'owned',sourceSha:null}]);}finally{store.close();}
 expect(()=>plant(config,join(root,'experiment'),{declaredText:'planted',undeclaredText:'outside',undeclaredPath:'extra.txt'})).toThrow(/Declared plant needs a regular file retained/);
},15000);

it('rejects experiment destinations inside the source, including symlink aliases', () => {
 const root=mkdtempSync(join(tmpdir(),'codeboost-plant-destination-'));roots.push(root);
 const config=createDemo(join(root,'source'));symlinkSync(config.repository,join(root,'alias'));
 for(const destination of [join(config.repository,'experiment'),join(config.repository,'.git','experiment'),join(root,'alias','nested','experiment')]) {
   expect(()=>plant(config,destination,{declaredText:'// extra',undeclaredText:'diagnostic',undeclaredPath:'extra.txt'})).toThrow(/outside the source repository/);
 }
},15000);
it('passes its isolated environment to every planting Git process', () => {
 const root=mkdtempSync(join(tmpdir(),'codeboost-plant-env-'));roots.push(root);
 const config=createDemo(join(root,'source'));
 vi.stubEnv('GIT_DIR',join(root,'outside.git'));vi.stubEnv('GIT_WORK_TREE',join(root,'outside'));
 try {expect(plant(config,join(root,'experiment'),{declaredText:'// extra',undeclaredText:'diagnostic',undeclaredPath:'extra.txt'})).toBe(join(root,'experiment','review.json'));}
 finally {vi.unstubAllEnvs();}
},15000);
