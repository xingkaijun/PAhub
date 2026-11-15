export const SAVE_TIMEOUT_MS = 15000;
export type SaveFailure = 'network' | 'timeout' | 'server' | 'login' | 'forbidden' | 'oversize' | 'conflict' | 'invalid';
export type SaveStatus = { phase: 'saving' | 'saved' | 'failed' | 'unconfirmed'; lastSuccess?: number; reason?: string; failure?: SaveFailure; retryAt?: number; attempts: number };
export const retryDelay = (attempt: number) => Math.min(60000, 3000 * 2 ** Math.min(Math.max(0, attempt - 1), 5));
export function saveFailure(error: unknown): SaveFailure {
  const e = error as {status?: number; name?: string};
  if(e?.status===401)return 'login';
  if(e?.status===403)return 'forbidden';
  if(e?.status===413)return 'oversize';
  if(e?.status===409)return 'conflict';
  if(e?.status && e.status>=500)return 'server';
  if(e?.status)return 'invalid';
  if(e?.name==='TimeoutError')return 'timeout';
  return 'network';
}
export const retryable = (failure: SaveFailure) => ['network','timeout','server'].includes(failure);
export const failureText = (failure: SaveFailure) => ({network:'Network unavailable',timeout:'Save request timed out; confirmation is unknown',server:'Server error; confirmation is unknown',login:'Sign in again to continue saving',forbidden:'No permission. Unsaved changes were rolled back',oversize:'Data is too large. Contact an administrator',conflict:'Version conflict. Review the conflict notice',invalid:'Save rejected. Review the error before retrying'}[failure]);
export async function withSaveTimeout<T>(task: (signal: AbortSignal) => Promise<T>, timeout = SAVE_TIMEOUT_MS): Promise<T> {
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(Object.assign(new Error('Save request timed out'),{name:'TimeoutError'}));controller.abort();},timeout);});
  try{return await Promise.race([task(controller.signal),deadline]);}finally{clearTimeout(timer);}
}
// One active save operation for a store. Same-key callers share its result;
// different-key saves wait instead of overlapping requests.
export class SaveLock {
  private active?: {key:string; promise:Promise<boolean>};
  run(key:string,task:()=>Promise<boolean>):Promise<boolean>{
    if(this.active)return this.active.key===key?this.active.promise:this.active.promise.then(()=>this.run(key,task));
    const promise=Promise.resolve().then(task).finally(()=>{if(this.active?.promise===promise)this.active=undefined;});
    this.active={key,promise};return promise;
  }
}
export type RetryOptions={manual?:boolean};
