import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { cliQuestionAgent } from '../runner/question-agent.ts';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
afterEach(()=>vi.clearAllMocks());
it.each(['Agent timed out. Try again.','Server stopped. Retry the question.'])('preserves the cancellation reason: %s',async message=>{
 let childProcess:EventEmitter;
 vi.mocked(spawn).mockImplementation(((_command:unknown,_args:unknown,options:{signal:AbortSignal})=>{
  const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),stdin:{on:vi.fn(),end:vi.fn()},kill:vi.fn()});
  childProcess=child;
  options.signal.addEventListener('abort',()=>child.emit('error',new Error('The operation was aborted')),{once:true});
  return child;
 }) as unknown as typeof spawn);
 const controller=new AbortController();const answer=cliQuestionAgent('codex')('Question',controller.signal);
 let settled=false;
 const result=answer.catch(error=>error).finally(()=>{settled=true;});
 await vi.waitFor(()=>expect(spawn).toHaveBeenCalledOnce());
 controller.abort(new Error(message));
 await new Promise(resolve=>setTimeout(resolve,20));expect(settled).toBe(false);
 childProcess!.emit('close',null);
 expect((await result).message).toBe(message);
});
