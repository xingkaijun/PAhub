import {build} from 'esbuild';
import {spawn} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {bundleOptions,outdir,root,copySchema,typecheck} from './build.mjs';

await typecheck();
await copySchema();
const files=(await readdir(path.join(root,'hub-server/test'))).filter(name=>name.endsWith('.test.ts')).sort();
await build({...bundleOptions,packages:'external',define:{'import.meta.env':JSON.stringify({MODE:'hub',VITE_DATA_API_BASE_URL:'/api',VITE_DATA_API_TOKEN:''})},entryPoints:files.map(name=>path.join(root,'hub-server/test',name)),outdir,outExtension:{'.js':'.mjs'}});
const child=spawn(process.execPath,['--test','--test-concurrency=1',...files.map(name=>path.join(outdir,name.replace(/\.ts$/,'.mjs')))],{cwd:root,stdio:'inherit'});
child.on('error',error=>{throw error;});
child.on('exit',code=>{process.exitCode=code || 0;});
