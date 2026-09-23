import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Store } from '../runner/store.ts';
import type { ReviewConfig } from '../runner/review.ts';
import type { Plan } from '../core/plan.ts';
import { isolatedGitEnvironment } from './git-environment.ts';
/** Disposable fixture only. Never runs against the user's working repository. */
export function createDemo(directory: string): ReviewConfig {
  const root = resolve(directory), configPath = join(root, 'review.json');
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('Demo fixture root must not be a symlink.');
  if (existsSync(configPath)) {
    const check = (path: string, directory: boolean) => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Demo fixture paths must be ordinary local files and directories.');
    };
    check(configPath, false);
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as ReviewConfig;
    if (config.demo !== true || config.repository !== join(root, 'retry-service') || config.database !== join(root, 'review.sqlite')) throw new Error('Demo configuration must refer to its own fixture.');
    check(config.repository, true); check(join(config.repository, '.git'), true); check(config.database, false);
    for (const suffix of ['-wal', '-shm']) if (existsSync(config.database + suffix)) check(config.database + suffix, false);
    return config;
  }
  if (existsSync(root)) throw new Error('Demo directory exists without a configuration. Choose a new empty path.');
  mkdirSync(root, { recursive: true }); const repository = join(root, 'retry-service'); mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', ['-c','core.hooksPath=/dev/null',...args], { cwd: repository, env: isolatedGitEnvironment(), encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git('init','-b','main'); git('config','user.name','Codeboost Demo'); git('config','user.email','demo@example.invalid'); git('config','commit.gpgsign','false');
  const write = (path: string, text: string | Buffer) => writeFileSync(join(repository,path),text);
  const commit = (message: string) => { git('add','-A');git('commit','-m',message);return git('rev-parse','HEAD'); };
  write('retry.ts', 'export function delay(attempt: number) {\n  return 100 * attempt;\n}\n');
  write('README.md','# Retry service\n\nRetries use a fixed delay.\n');write('run.sh','#!/bin/sh\nprintf "ready\\n"\n');
  const base=commit('Initial service');
  write('retry.ts','export function delay(attempt: number) {\n  return Math.min(5000, 100 * 2 ** attempt);\n}\n');const first=commit('Bound exponential retries\n\nPlan-Item: P1');
  write('README.md','# Retry service\n\nRetries use bounded exponential backoff.\n');chmodSync(join(repository,'run.sh'),0o755);const second=commit('Document retry behavior\n\nPlan-Item: P2');
  write('debug.log','temporary debug output\n');const head=commit('Unrelated diagnostic output');
  const identity={repositoryId:randomUUID(),taskId:randomUUID(),planId:randomUUID()};
  const plan: Plan={schema_version:1,revision:1,issue:3,summary:'Make retries predictable and document the behavior',questions:[],items:[
    {id:'P1',title:'Bound exponential retries',intent:'Cap the backoff at five seconds so callers have a predictable upper bound.',files:[{path:'retry.ts',kind:'edit',renamed_from:null,change:'Use capped exponential backoff.'}],acceptance:[{type:'check',text:'The delay grows exponentially and never exceeds five seconds.'}],depends_on:[]},
    {id:'P2',title:'Document retry behavior',intent:'Describe the retry strategy for maintainers.',files:[{path:'README.md',kind:'edit',renamed_from:null,change:'Explain the capped exponential delay.'}],acceptance:[{type:'check',text:'Documentation agrees with the implementation.'}],depends_on:['P1']},
    {id:'P3',title:'Confirm API compatibility',intent:'Confirm the function signature is unchanged.',files:[{path:'retry.ts',kind:'edit',renamed_from:null,change:'Keep the public function signature.'}],acceptance:[{type:'check',text:'No API change is needed.'}],depends_on:['P1']},
  ]};
  const probe=mkdtempSync(join(root,'identity-'));
  let pathIdentity:ReviewConfig['pathIdentity'];
  try { writeFileSync(join(probe,'case'),'');writeFileSync(join(probe,'café'),'');pathIdentity={caseSensitive:!existsSync(join(probe,'CASE')),unicodeNormalization:existsSync(join(probe,'cafe\u0301'))?'NFC':'none'}; }
  finally {rmSync(probe,{recursive:true});}
  const config:ReviewConfig={database:join(root,'review.sqlite'),repository,identity,pathIdentity,demo:true};
  const store=new Store(config.database);
  try { store.createPlan(JSON.stringify(plan),'json',{identity,issue:3,baseEntries:['retry.ts','README.md','run.sh'].map(path=>({path,kind:'file' as const})),pathKey:p=>p,allowedCommands:[]},base,head);
    store.recordHistory(identity,{revision:1,snapshotId:store.getSnapshot(identity).id},base,head,[{sha:first,owner:'P1',origin:'owned',sourceSha:null},{sha:second,owner:'P2',origin:'owned',sourceSha:null}]);
  } finally {store.close();}
  writeFileSync(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600});return config;
}
