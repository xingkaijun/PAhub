import test from 'node:test';
import assert from 'node:assert/strict';
import { Router, basicAuthResponse, normalizeError } from '../src/router.ts';

test('router parses JSON once, rejects malformed input and normalizes text errors', async () => {
  const router = new Router().add({ pattern: /^\/api\/test\/([^/]+)$/, methods: ['POST'], handle: async ctx => {
    const a = await ctx.json(), b = await ctx.json(); assert.equal(a,b);
    return Response.json({ id:ctx.params[0],value:a.value });
  } });
  const send = (body: string, method='POST') => router.handle(new Request('http://local/api/test/hello%20there',{method,body:method === 'POST' ? body : undefined}));
  assert.deepEqual(await (await send('{"value":1}')).json(),{id:'hello there',value:1});
  assert.equal((await send('{')).status,400);
  assert.equal((await send('[]')).status,400);
  const wrongMethod = await send('', 'GET'); assert.equal(wrongMethod.status,405); assert.equal(wrongMethod.headers.get('allow'),'POST');
  assert.deepEqual(await (await normalizeError(new Response('PASSWORD_REQUIRED',{status:401}))).json(),{error:'PASSWORD_REQUIRED'});
});
test('router API token and Basic Auth remain optional, and API CORS works', async () => {
  const router = new Router({API_TOKEN:'test',ALLOW_CORS_ORIGIN:'http://trusted'}).add({pattern:/^\/api\/test$/,methods:['GET'],handle:() => Response.json({ok:true})});
  assert.equal((await router.handle(new Request('http://local/api/test'))).status,401);
  assert.equal((await router.handle(new Request('http://local/api/test',{headers:{Authorization:'Bearer test'}}))).status,200);
  const options = await router.handle(new Request('http://local/api/test',{method:'OPTIONS'})); assert.equal(options.status,204); assert.equal(options.headers.get('access-control-allow-origin'),'http://trusted');
  assert.equal(basicAuthResponse(undefined,''),undefined);
  assert.equal(basicAuthResponse('Basic ' + Buffer.from('user:pass').toString('base64'),'user:pass'),undefined);
  const denied = basicAuthResponse('Bearer pass','user:pass')!; assert.equal(denied.status,401); assert.deepEqual(await denied.json(),{error:'Unauthorized'});
});
