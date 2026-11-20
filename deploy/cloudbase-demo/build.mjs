// 演示用：把未改动的 Yumeiro 服务打包成 CloudBase HTTP 云函数（不修改任何原文件）。
// 用法：node deploy/cloudbase-demo/build.mjs   → 产物在 .cloudbase-demo/yumeiro/
import {cpSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {execSync} from 'node:child_process';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
const demoPass='Y'+randomBytes(12).toString('hex')+'!'; // 24 位随机管理员密码
const demoKey=randomBytes(32).toString('base64'); // 每次构建随机生成，只写入产物，不进仓库
const root=path.resolve(import.meta.dirname,'../..');
const out=path.join(root,'.cloudbase-demo','yumeiro');
rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
const dockerfile=readFileSync(path.join(root,'Dockerfile'),'utf8');
const mjs=dockerfile.match(/COPY --chown=node:node (server\.mjs[^\n]*?) \.\//)[1].split(/\s+/);
for(const f of mjs)cpSync(path.join(root,f),path.join(out,f));
for(const d of ['scripts','public'])cpSync(path.join(root,d),path.join(out,d),{recursive:true,filter:s=>!/[\/]public[\/]downloads/.test(s)});
for(const f of ['package.json','package-lock.json'])cpSync(path.join(root,f),path.join(out,f));
execSync('npm ci --omit=dev --no-audit --no-fund',{cwd:out,stdio:'inherit'});
// 云函数只有 /tmp 可写；演示数据放 /tmp，实例回收后会重置。
writeFileSync(path.join(out,'scf_bootstrap'),`#!/bin/bash
export PORT=9000 HOST=0.0.0.0 DATA_DIR=/tmp/yumeiro-data TRUST_PROXY=1 COOKIE_SECURE=1
export STORE_ENCRYPTION_KEY="\${STORE_ENCRYPTION_KEY:-${demoKey}}"
export ADMIN_EMAIL="\${ADMIN_EMAIL:-admin@demo.local}" ADMIN_PASSWORD="\${ADMIN_PASSWORD:-${demoPass}}"
mkdir -p "$DATA_DIR"
exec node server.mjs
`,{mode:0o755});
writeFileSync(path.join(out,'..','admin-login.txt'),`邮箱: admin@demo.local
密码: ${demoPass}
`);
console.log('完成：',out,'（管理员账号见 .cloudbase-demo/admin-login.txt）');
