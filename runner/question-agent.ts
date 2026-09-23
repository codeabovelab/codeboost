import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QuestionAgent } from './questions.ts';
export type Provider = 'claude' | 'codex';
export function agentArguments(provider: Provider): string[] {
  if(provider==='claude') return ['--print','--output-format','json','--tools','','--safe-mode','--strict-mcp-config','--no-session-persistence','--disable-slash-commands'];
  return ['exec','--ignore-user-config','--ignore-rules','--sandbox','read-only','--skip-git-repo-check','--ephemeral','--json',
    '-c','approval_policy="never"','-c','web_search="disabled"','-c','project_doc_max_bytes=0',
    ...['shell_tool','apps','plugins','hooks','memories','multi_agent','multi_agent_v2','skill_search','skill_mcp_dependency_install'].flatMap(key=>['-c',`features.${key}=false`]),'-'];
}
export function cliQuestionAgent(provider: Provider): QuestionAgent {
  return async(prompt,signal)=>{
    const cwd=await mkdtemp(join(tmpdir(),'codeboost-question-'));
    try {
      signal.throwIfAborted();
      const stdout=await new Promise<string>((resolve,reject)=>{
        const env={...process.env};delete env.CLAUDECODE;delete env.NODE_OPTIONS;
        const child=spawn(provider,agentArguments(provider),{cwd,env,stdio:['pipe','pipe','pipe'],signal,killSignal:'SIGKILL'});
        const chunks:Buffer[]=[];let bytes=0,diagnostic='';let failure:Error|undefined;
        child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1024*1024){failure ??= new Error('Agent output exceeded its limit.');child.kill('SIGKILL');}else chunks.push(chunk);});
        child.stderr.on('data',(chunk:Buffer)=>{diagnostic=(diagnostic+chunk.toString()).slice(-2000);});
        child.on('error',error=>{failure = signal.aborted && signal.reason instanceof Error ? signal.reason : new Error(signal.aborted?'Agent cancelled.':`Could not start ${provider}. Check that its CLI is installed and signed in. (${error.name})`);});
        child.on('close',code=>failure?reject(failure):code===0?resolve(Buffer.concat(chunks).toString('utf8')):reject(new Error(`${provider} exited with status ${code}. Check its login and usage limits.${/auth|login|sign.in/i.test(diagnostic)?' Authentication may be required.':''}`)));
        child.stdin.on('error',()=>{});child.stdin.end(prompt);
      });
      if(provider==='claude') {
        const result=JSON.parse(stdout);
        if(result.is_error || typeof result.result!=='string') throw new Error('Claude could not answer. Check its login and usage limits.');
        return result.result;
      }
      const events=stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line));
      const failure=events.find(event=>event.type==='turn.failed'||event.type==='error');
      if(failure) throw new Error('Codex could not answer. Check its login and usage limits.');
      return events.filter(event=>event.type==='item.completed'&&event.item?.type==='agent_message').map(event=>event.item.text).join('\n\n');
    } finally {await rm(cwd,{recursive:true,force:true});}
  };
}
