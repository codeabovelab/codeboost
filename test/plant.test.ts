import { it,expect,afterEach,vi } from 'vitest';
import { mkdtempSync,readFileSync,rmSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDemo } from '../scripts/demo.ts';
import { plant } from '../scripts/plant.ts';
import { ReviewService } from '../runner/review.ts';
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
