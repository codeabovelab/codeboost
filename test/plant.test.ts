import { it,expect,afterEach } from 'vitest';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
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
