import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { cliQuestionAgent } from '../runner/question-agent.ts';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
afterEach(()=>vi.clearAllMocks());
it.each(['Agent timed out. Try again.','Server stopped. Retry the question.'])('preserves the cancellation reason: %s',async message=>{
 vi.mocked(spawn).mockImplementation(((_command:unknown,_args:unknown,options:{signal:AbortSignal})=>{
  const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),stdin:{on:vi.fn(),end:vi.fn()},kill:vi.fn()});
  options.signal.addEventListener('abort',()=>child.emit('error',new Error('The operation was aborted')),{once:true});
  return child;
 }) as unknown as typeof spawn);
 const controller=new AbortController();const answer=cliQuestionAgent('codex')('Question',controller.signal);
 const result=answer.catch(error=>error);
 await vi.waitFor(()=>expect(spawn).toHaveBeenCalledOnce());
 controller.abort(new Error(message));
 expect((await result).message).toBe(message);
});
