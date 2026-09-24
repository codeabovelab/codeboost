import { isolatedGitEnvironment } from './git-environment.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename, relative, isAbsolute } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Store } from '../runner/store.ts';
import type { ReviewConfig } from '../runner/review.ts';
import { readHistory } from '../git/history.ts';
import { isRepoPath, type BaseEntry } from '../core/plan.ts';
export interface PlantInput { declaredText: string; undeclaredText: string; undeclaredPath: string }
/** Prepare a separate local experiment clone. Never rewrites/pushes the source repository.
 * The experiment operator runs this before the reviewer sees the PR; sealed.json is unblinding data.
 */
export function plant(config: ReviewConfig, destination: string, input: PlantInput): string {
  const root=resolve(destination);
  if(existsSync(root))throw new Error('Experiment destination must not exist.');
  let parent=root; const missing:string[]=[];
  while(!lstatSync(parent,{throwIfNoEntry:false})) { missing.unshift(basename(parent)); parent=dirname(parent); }
  const canonicalDestination=resolve(realpathSync(parent),...missing);
  const sourceRelative=relative(realpathSync(config.repository),canonicalDestination);
  if(sourceRelative===''||(!sourceRelative.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&sourceRelative!=='..'&&!isAbsolute(sourceRelative))) throw new Error('Experiment destination must be outside the source repository.');
  if((!isRepoPath(input.undeclaredPath)||input.undeclaredPath.includes('/'))||!input.declaredText?.trim()||!input.undeclaredText?.trim()||input.declaredText.length>4000||input.undeclaredText.length>4000)throw new Error('Invalid plant input.');
  const pathKey=(path:string)=>{
    if(!config.pathIdentity.caseSensitive && /[^\x20-\x7e]/.test(path)) throw new Error('Non-ASCII case-insensitive paths require a filesystem-specific identity adapter.');
    const p=config.pathIdentity.unicodeNormalization==='NFC'?path.normalize('NFC'):path;
    return config.pathIdentity.caseSensitive?p:p.toLowerCase();
  };
  pathKey(input.undeclaredPath);
  const source=new Store(config.database);
  let plan, snapshot, entries;
  try{plan=source.getPlan(config.identity);snapshot=source.getSnapshot(config.identity);entries=source.getLedger(config.identity);}finally{source.close();}
  if(plan.items.some(item=>item.files.some(file=>pathKey(file.path)===pathKey(input.undeclaredPath)||(file.renamed_from!==null&&pathKey(file.renamed_from)===pathKey(input.undeclaredPath)))))throw new Error('Undeclared plant must be outside every declared file.');
  for(const item of plan.items) for(const file of item.files) { pathKey(file.path); if(file.renamed_from) pathKey(file.renamed_from); }
  const history=readHistory(config.repository,snapshot.base,snapshot.head);
  const owners=new Map(entries.map(entry=>[entry.sha,entry.owner]));
  const candidates=history.commits.flatMap((commit,index)=>{
    const item=plan.items.find(item=>item.id===owners.get(commit.sha));
    return item?.files.filter(file=>file.kind==='edit'&&!file.path.includes('/')).map(file=>({index,item:item.id,path:file.path}))??[];
  });
  if(!candidates.length)throw new Error('No owned commit with an editable top-level file is available for planting.');
  const declared=candidates[randomInt(candidates.length)]!;
  const owned=history.commits.map((commit,index)=>({index,owner:owners.get(commit.sha)})).filter(entry=>entry.owner&&plan!.items.some(item=>item.id===entry.owner));
  const outside=owned[randomInt(owned.length)]!;
  const env=isolatedGitEnvironment();
  const gitRaw=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:32*1024*1024});
  const git=(cwd:string,...args:string[])=>gitRaw(cwd,...args).trim();
  // Refuse existing paths, symlink targets, and unsupported declared-file transitions before creating output.
  for(const sha of [snapshot.base,...history.commits.map(commit=>commit.sha)]){
    const paths=gitRaw(config.repository,'ls-tree','-rz','--name-only',sha).split('\0').filter(Boolean);
    if(paths.some(path=>pathKey(path)===pathKey(input.undeclaredPath)))throw new Error('Undeclared plant path already exists in the source history.');
  }
  for(const commit of history.commits.slice(declared.index)){
    if(!/^100(?:644|755) blob /.test(git(config.repository,'ls-tree',commit.sha,'--',declared.path)))throw new Error('Declared plant needs a regular file retained through the remaining history.');
  }
  mkdirSync(root,{recursive:true});const repository=join(root,'repository');
  git(root,'clone','--no-local','--no-checkout',resolve(config.repository),repository);
  git(repository,'config','user.name','Codeboost Experiment');git(repository,'config','user.email','experiment@example.invalid');
  git(repository,'checkout','-b','review-experiment',snapshot.base);
  const baseEntries:BaseEntry[]=git(repository,'ls-tree','-rz',snapshot.base).split('\0').filter(Boolean).map(record=>{
    const split=record.indexOf('\t'),[mode,,oid]=record.slice(0,split).split(' '),path=record.slice(split+1);
    if(mode==='160000')return {path,kind:'gitlink'};
    if(mode==='120000')return {path,kind:'symlink',target:gitRaw(repository,'cat-file','blob',oid!)};
    return {path,kind:'file'};
  });
  const mappings=[];
  try{
    for(const [index,commit] of history.commits.entries()){
      git(repository,'cherry-pick','--no-commit',commit.sha);
      if(index===declared.index){const path=join(repository,declared.path);if(!lstatSync(path).isFile())throw new Error('Declared plant target is not regular.');appendFileSync(path,'\n'+input.declaredText+'\n');}
      if(index===outside.index){const path=join(repository,input.undeclaredPath);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,input.undeclaredText+'\n',{flag:'wx'});}
      git(repository,'add','-A');git(repository,'commit','--allow-empty','-C',commit.sha);
      mappings.push({oldSha:commit.sha,newSha:git(repository,'rev-parse','HEAD')});
    }
    const identity={repositoryId:config.identity.repositoryId,taskId:randomUUID(),planId:randomUUID()};
    const output:ReviewConfig={...config,repository,database:join(root,'review.sqlite'),identity,demo:false,github:undefined};
    const store=new Store(output.database);
    try{
      store.createPlan(JSON.stringify(plan),'json',{identity,issue:plan.issue,baseEntries,pathKey,allowedCommands:[]},snapshot.base,snapshot.head);
      const validEntries=entries.filter(entry=>entry.owner===null||plan.items.some(item=>item.id===entry.owner));
      store.recordHistory(identity,{revision:1,snapshotId:store.getSnapshot(identity).id},snapshot.base,snapshot.head,validEntries);
      store.recordRebase(identity,{revision:1,snapshotId:store.getSnapshot(identity).id},snapshot.base,mappings.at(-1)!.newSha,mappings);
    }finally{store.close();}
    writeFileSync(join(root,'sealed.json'),JSON.stringify({declared,outside,undeclaredPath:input.undeclaredPath,mappings},null,2),{mode:0o600});
    const configPath=join(root,'review.json');writeFileSync(configPath,JSON.stringify(output,null,2),{mode:0o600});return configPath;
  }catch(error){throw new Error(`Planting stopped. Source is unchanged; inspect the disposable clone at ${repository}. ${error instanceof Error?error.message:String(error)}`);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [configFile,destination,inputFile]=process.argv.slice(2);
  if(!configFile||!destination||!inputFile)throw new Error('Usage: node scripts/plant.ts review.json NEW_DIRECTORY plant-input.json');
  console.log(plant(JSON.parse(readFileSync(configFile,'utf8')),destination,JSON.parse(readFileSync(inputFile,'utf8'))));
}
