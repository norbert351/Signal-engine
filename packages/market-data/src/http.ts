export async function fetchWithRetry(url:URL,headers:Record<string,string>,timeoutMs=12000,maxAttempts=3):Promise<Response>{
 let lastError:unknown;
 for(let attempt=1;attempt<=maxAttempts;attempt++){
  try{const response=await fetch(url,{headers,signal:AbortSignal.timeout(timeoutMs)});if(response.status!==429&&response.status<500)return response;if(attempt===maxAttempts)return response;const retryAfter=Number(response.headers.get("retry-after"));const delay=Number.isFinite(retryAfter)&&retryAfter>0?Math.min(retryAfter*1000,15000):Math.min(500*2**(attempt-1),8000);await new Promise(resolve=>setTimeout(resolve,delay));}
  catch(error){lastError=error;if(attempt===maxAttempts)throw error;await new Promise(resolve=>setTimeout(resolve,Math.min(500*2**(attempt-1),8000)));}
 }
 throw lastError instanceof Error?lastError:new Error("Market data request failed after retries");
}
