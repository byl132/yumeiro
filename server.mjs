import http from 'node:http';
import { isIP, connect as tcpConnect } from 'node:net';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { createReadStream, readFileSync } from 'node:fs';
import { readFile, writeFile, rm, mkdir, stat as statFile, readdir as readDir, statfs } from 'node:fs/promises';
import os from 'node:os';
import dns from 'node:dns/promises';
import { buildChecks, summarize as summarizeChecks, reportText } from './doctor.mjs';
import { DOC_LIMITS, docText, docsPrompt } from './docs.mjs';
import { parseDocument } from './docparse.mjs';
import { cleanMcpServers, maskMcpServers, mcpForEngine, MCP_ENGINES } from './mcp.mjs';
import { BUILTIN as MCP_BUILTIN, REGISTRY_BASE, searchRegistry, buildServer as buildMcpServer, slugName as mcpSlug, matches as mcpMatches, publicItem as mcpPublicItem } from './mcp-market.mjs';
import { gzipSync, inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStorage, readSecretKey } from './storage.mjs';
import { modelAccessBase, fetchGatewayCredentials, fetchModelCatalog, detectChatBase, pingChat, accessTokenExpiry, CindyModelError, modelEngines as cindyEngines } from './platform-models.mjs';
import { runCollaboration, validatePlan, LIMITS } from './collab.mjs';
import { BUILTIN_SKILLS, BUILTIN_BOTS, ENGINE_HINTS } from './market.mjs';
import { createMarketSources } from './market-sources.mjs';
import { LANGS as ASR_LANGS, PRESETS as ASR_PRESETS, AUDIO_TYPES, MAX_AUDIO_BYTES, normalizeAsrConfig, publicAsrConfig, asrKinds, silenceWav, transcribe as asrTranscribe } from './asr.mjs';
import { loadAsrExtras } from './asr-native.mjs';
import { addAudit, queryAudit, summarize, toCsv, categoryOf, CATEGORY, dashboardData } from './audit.mjs';
import { TARGETS, VENDORS, VENDOR_NAMES, DEFAULT_RESTRICTED, normalizeGuard, validProxyUrl, maskProxy, vendorOfUrl, vendorOfEngine, usesProxy, probeTarget, detectEgress, evaluate } from './envcheck.mjs';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { normalizeTtsConfig, publicTtsConfig, defaultTtsConfig, speechEndpoint, cleanSpeechRequest, buildSpeechRequest, speechCacheKey, sniffAudio, parseMultipart, audioTypeOf, LIMITS as TTS_LIMITS } from './tts.mjs';
import { createZip, readZip, safeEntryName } from './ziputil.mjs';
import { VISION_LIMITS, VISION_DIALECTS, DEFAULT_VISION_MODELS, DEFAULT_PROMPT, NO_ROUTE_MESSAGE, defaultVisionConfig, normalizeVisionConfig, publicVisionConfig, visionRoute, isVisionModel, buildVisionRequest, parseVisionResponse, dataUrl, imageParts, describedText, testPng } from './vision.mjs';
import { REMOTE_LIMITS, OS_LABELS, newPairCode, normalizePairCode, cleanInputEvents, countEvents, isJpeg, cleanDeviceName } from './remote.mjs';
import { RECOVERY, newRecoveryKey, normalizeRecoveryKey, passwordProblem, createLimiter, createPhoneStore } from './recover.mjs';
import { PROJECT_LIMITS, PROJECT_DIR, MANIFEST_NAME, mimeOf, renderMarkdownPage, signPreview, verifyPreview, previewHeaders, previewPath, manifestFor, planImport, localKit, cleanGuideMessages, parseGuideReply, guidePrompt } from './project.mjs';
import { normalizeImageConfig, publicImageConfig, defaultImageConfig, imagesEndpoint, imageAuthHeaders, buildComfyWorkflow, comfyImageRefs, cleanImageRequest, buildImageRequest, parseImageResponse, sniffImage, safeResultUrl, DIALECTS as IMAGE_DIALECTS, BATCH_MODES, LIMITS as IMAGE_LIMITS } from './images.mjs';
import { readPrefs, userMemories, upsertMemory, explicitRemember, selectMemories, relatedConversations, buildMemoryBlock, extractionMessages, parseExtraction, pendingSummaryRange, summaryMessages, cleanText, looksSecret, MEMORY_LIMITS } from './memory.mjs';
await loadAsrExtras();
import { templates as providerTemplates, normalizeBaseUrl, chatEndpoint, slugify, validSlug, maskKey, cleanModels, cleanLabels, modelAliases, probeProvider } from './providers.mjs';

const scrypt=promisify(scryptCallback);
const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=process.env.DATA_DIR||path.join(root,'data');
const port=Number(process.env.PORT||8787);
const sessionMs=7*24*60*60*1000;
const cookieSecure=process.env.COOKIE_SECURE!=='false';
const storeKey=await readSecretKey();
const modelBase=(process.env.MODEL_BASE_URL||'').replace(/\/+$/,'');
const modelKey=process.env.MODEL_API_KEY_FILE
  ? (await readFile(process.env.MODEL_API_KEY_FILE,'utf8')).trim()
  : (process.env.MODEL_API_KEY||'');
const modelName=process.env.MODEL_NAME||'';
const systemPrompt=(process.env.MODEL_SYSTEM_PROMPT||'').trim().slice(0,4000);
const contextMessages=Math.min(100,Math.max(2,Number(process.env.MODEL_CONTEXT_MESSAGES)||24));
let modelBaseSecure=false;
try{
  const parsed=new URL(modelBase);
  // 仅允许 HTTPS；本机回环地址（开发/测试用）可使用 HTTP。
  modelBaseSecure=parsed.protocol==='https:'||(parsed.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname));
}catch{}
const modelConfigured=Boolean(modelBase&&modelBaseSecure&&modelKey&&modelName&&!/^(replace|your-)/i.test(modelKey)&&!/^your-/i.test(modelName));
// ---- Cindy 官方托管模型：每个已绑定的 Cindy 账号一份（仅该账号所属的本站用户可用）----
// 网关密钥和模型目录只缓存在内存里（不落盘、不回传浏览器）；重启后按需重新同步。
const cindyCache=new Map();
const mcpRegistryCache=new Map(),mcpMarketItems=new Map();
const cindyProvider=account=>'cindy-'+account.id.slice(0,8);
const userCindyAccounts=user=>(user?.cindyAccounts||[]);
// 用户能用的 Cindy 账号 = 自己绑定的 + 主账号选择“共享给团队成员”的账号（共享的调用扣的是该账号自己的额度）
function accessibleCindyAccounts(user){
  if(!user)return Object.values(db.users).flatMap(item=>item.cindyAccounts||[]);
  const list=[...userCindyAccounts(user)];
  for(const owner of Object.values(db.users)){
    if(owner.id===user.id||owner.role!=='admin'||owner.disabled)continue;
    for(const account of owner.cindyAccounts||[])if(account.shared&&!account.needsRebind)list.push(account);
  }
  return list;
}
const cindyOwnerOf=account=>Object.values(db.users).find(item=>(item.cindyAccounts||[]).includes(account));
async function ensureFreshAccessToken(account,{force=false,skewMs=60000}={}){
  const credentials=account.credentials||{},exp=accessTokenExpiry(credentials.accessToken);
  if(!force&&credentials.accessToken&&(!exp||exp>Date.now()+skewMs))return;
  // 续期：官方 auth 服务的 /api/auth/token 接受 refresh_token 授权（路径与授权类型取自登录流程，未用真实账号验证过）
  try{
    const outcome=await cindyAuthRequest(account.region,'/api/auth/token',{grantType:'refresh_token',refreshToken:credentials.refreshToken});
    if(!outcome?.accessToken)throw new Error('empty');
    account.credentials={...credentials,accessToken:outcome.accessToken,refreshToken:outcome.refreshToken||credentials.refreshToken,updatedAt:Date.now()};
    await persist();
  }catch{
    account.needsRebind=true;
    throw new CindyModelError('Cindy 授权令牌已过期且自动续期失败，请解绑后重新绑定这个账号',{status:401,step:'令牌续期'});
  }
}
async function syncCindyAccount(account){
  const entry={at:Date.now(),models:[],error:null,step:null};
  try{
    await ensureFreshAccessToken(account);
    const credentials=await fetchGatewayCredentials(account.credentials.accessToken,account.region);
    const models=await fetchModelCatalog(account.credentials.accessToken,account.region);
    const detected=await detectChatBase(credentials.endpoint,credentials.apiKey);
    if(detected.rejected)throw new CindyModelError('网关拒绝了官方下发的密钥（HTTP 401/403）',{status:401,step:'探测网关'});
    Object.assign(entry,{apiKey:credentials.apiKey,endpoint:credentials.endpoint,base:detected.base,tried:detected.tried,guessed:Boolean(detected.guessed),models});
    if(!models.length)entry.error='官方模型目录里没有可用于对话的模型';
    account.needsRebind=false;
  }catch(error){entry.error=error.message;entry.step=error.step||null;if(error.status===401||error.status===403)entry.authError=true}
  cindyCache.set(account.id,entry);
  return entry;
}
// Cindy 的访问令牌很短命（约 1 小时），靠刷新令牌续期。后台每 5 分钟把 15 分钟内要过期的提前续上，失败则标记“需要重新绑定”。
setInterval(()=>{
  for(const user of Object.values(db.users))for(const account of user.cindyAccounts||[]){
    if(account.needsRebind||!account.credentials?.refreshToken)continue;
    ensureFreshAccessToken(account,{skewMs:15*60*1000}).catch(()=>{});
  }
},5*60*1000).unref();
const cindySummary=account=>{const entry=cindyCache.get(account.id);return {models:entry?.models?.length||0,syncedAt:entry?.at||null,syncError:entry?.error||null,syncStep:entry?.step||null,needsRebind:Boolean(account.needsRebind),gatewayGuessed:Boolean(entry?.guessed)}};
// 后台按需同步：没有缓存或缓存超过 30 分钟时，触发一次（不阻塞当前请求）。
function refreshCindyModelsInBackground(user){
  for(const account of accessibleCindyAccounts(user)){
    const entry=cindyCache.get(account.id);
    if(entry&&(entry.pending||Date.now()-entry.at<(entry.error?120000:1800000)))continue;
    cindyCache.set(account.id,{at:Date.now(),pending:true,models:[],error:null});
    syncCindyAccount(account).catch(()=>{});
  }
}

// ---- AI 服务商：环境变量里的是“内置”服务商（模型名不带前缀，向后兼容）；管理员在网页里添加的按 slug/模型 引用 ----
const envModels=modelConfigured?[...new Set([modelName,...(process.env.MODEL_EXTRA_NAMES||'').split(',').map(item=>item.trim())].filter(Boolean))]:[];
const loginAttempts=new Map();
const recoverLimiter=createLimiter({max:6,windowMs:15*60*1000}),recoverStartLimiter=createLimiter({max:8,windowMs:10*60*1000}),phoneStore=createPhoneStore();
const codeAttempts=new Map();
const pendingCindyLogins=new Map();
const pendingCindySocial=new Map();
const authProviderCache=new Map();
// 官方认证服务地址可用环境变量覆盖（自建/测试用）
const trimSlash=value=>value.replace(/\/+$/,'');
const authRegions={cn:{baseUrl:trimSlash(process.env.CINDY_AUTH_URL_CN||'https://auth.cindy.com.cn'),region:'cn'},global:{baseUrl:trimSlash(process.env.CINDY_AUTH_URL_GLOBAL||'https://auth.cindy.app'),region:'global'}};
await mkdir(dataDir,{recursive:true,mode:0o700});
const storage=await openStorage({key:storeKey,dataDir});
let db=storage.db;
console.log('数据存储：'+storage.describe);
db.users||={};db.sessions||={};db.conversations||={};db.memories||={};db.images||={};db.attachments||={};db.remoteDevices||={};db.audit||=[];
db.usage||=[];db.security||={};db.tokens||={};db.agents||={};db.providers||={};db.settings||={};db.workspaces||={};db.runs||={};db.skills||={};db.bots||={};
db.security.loginPolicy||={adminAllowedIps:[],maxFailedAttempts:5,windowMinutes:15,maxSessions:5};
db.security.events||=[];
for(const user of Object.values(db.users))if(!user.role)user.role=user.passwordHash?'admin':'member';

async function hashPassword(password,saltHex){
  const salt=saltHex?Buffer.from(saltHex,'hex'):randomBytes(16);
  const key=await scrypt(password,salt,64);
  return salt.toString('hex')+':'+Buffer.from(key).toString('hex');
}
async function verifyPassword(password,saved){
  try{
    const parts=saved.split(':');
    const expected=Buffer.from(parts[1],'hex');
    const actual=Buffer.from((await hashPassword(password,parts[0])).split(':')[1],'hex');
    return expected.length===actual.length&&timingSafeEqual(expected,actual);
  }catch{return false}
}
const sha=value=>createHash('sha256').update(value).digest('hex');
const persist=()=>storage.save(db);
if(storage.fresh||storage.legacyPlaintext){
  await persist();
  console.log('Store is encrypted at rest.');
}
if(!Object.keys(db.users).length){
  const email=(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
  // 管理员初始密码可放在 ADMIN_PASSWORD_FILE（推荐，安装脚本使用）或 ADMIN_PASSWORD；仅在库里还没有任何账号时读取。
  const password=process.env.ADMIN_PASSWORD_FILE?(await readFile(process.env.ADMIN_PASSWORD_FILE,'utf8').catch(()=>'')).trim():(process.env.ADMIN_PASSWORD||'');
  if(!email||password.length<16||/^(change|replace|your-)/i.test(password)){
    throw new Error('数据库里还没有管理员账号：请先运行 ./install.sh 完成安装设置，或手动设置 ADMIN_EMAIL 与至少 16 位的 ADMIN_PASSWORD_FILE / ADMIN_PASSWORD（不能是示例值）。');
  }
  const id=randomUUID();
  db.users[id]={id,email,passwordHash:await hashPassword(password),role:'admin',authType:'local',createdAt:Date.now()};
  await persist();
  console.log('已初始化管理员账号：'+email);
}
function json(res,status,value){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(value));
}
function cookieToken(req){
  for(const pair of (req.headers.cookie||'').split(';')){
    const i=pair.indexOf('=');
    if(i>0&&pair.slice(0,i).trim()==='ym_sid')return decodeURIComponent(pair.slice(i+1).trim());
  }
  return '';
}
function setCookie(res,token,age){
  res.setHeader('Set-Cookie','ym_sid='+encodeURIComponent(token)+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(cookieSecure?'; Secure':''));
}
async function getSession(req){
  const token=cookieToken(req);
  if(!token)return null;
  const tokenHash=sha(token),record=db.sessions[tokenHash];
  if(!record||record.expiresAt<Date.now()){
    if(record){delete db.sessions[tokenHash];await persist()}
    return null;
  }
  const user=db.users[record.userId];
  return user&&!user.disabled?{tokenHash,record,user}:null;
}
async function readBody(req,limit=128*1024){
  let size=0;const chunks=[];
  for await(const chunk of req){
    size+=chunk.length;
    if(size>limit)throw Object.assign(new Error('请求内容过大'),{status:413});
    chunks.push(chunk);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}
  catch{throw Object.assign(new Error('请求格式无效'),{status:400})}
}
function sameOrigin(req){
  const origin=req.headers.origin;
  if(!origin)return true;
  try{return new URL(origin).host===req.headers.host}catch{return false}
}
function clientIp(req){
  // 直接暴露端口（没有反向代理）时必须 TRUST_PROXY=false，否则客户端可伪造 X-Forwarded-For 绕过限流和 IP 白名单。
  const forwarded=process.env.TRUST_PROXY==='false'?undefined:req.headers['x-forwarded-for'];
  const candidate=typeof forwarded==='string'?forwarded.split(',').pop().trim():'';
  const raw=candidate||req.socket.remoteAddress||'unknown';
  return raw.startsWith('::ffff:')?raw.slice(7):raw;
}
function loginKey(req,email){return sha(clientIp(req)+'|'+email)}
function currentAdminPolicy(){return db.security.loginPolicy}
function rateLimited(req,email){
  const now=Date.now(),windowMs=currentAdminPolicy().windowMinutes*60*1000;
  return [loginKey(req,email),loginKey(req,'*')].some(key=>{
    const value=loginAttempts.get(key);if(!value)return false;
    value.failures=value.failures.filter(at=>now-at<windowMs);
    if(!value.failures.length){loginAttempts.delete(key);return false}
    return value.lockedUntil>now;
  });
}
function recordFailedAdminLogin(req,email){
  const now=Date.now(),policy=currentAdminPolicy(),windowMs=policy.windowMinutes*60*1000;
  for(const key of [loginKey(req,email),loginKey(req,'*')]){
    const value=loginAttempts.get(key)||{failures:[],lockedUntil:0};
    value.failures=value.failures.filter(at=>now-at<windowMs);value.failures.push(now);
    if(value.failures.length>=policy.maxFailedAttempts)value.lockedUntil=now+windowMs;
    loginAttempts.set(key,value);
  }
}
function resetAdminLoginFailures(req,email){loginAttempts.delete(loginKey(req,email));loginAttempts.delete(loginKey(req,'*'))}
function hitWindowLimit(map,key,limit,windowMs){
  const now=Date.now(),value=map.get(key)||[];
  const fresh=value.filter(at=>now-at<windowMs);
  if(fresh.length>=limit){map.set(key,fresh);return Math.max(1,Math.ceil((windowMs-(now-fresh[0]))/1000))}
  fresh.push(now);map.set(key,fresh);return 0;
}
async function recordSecurityEvent(type,req,userId=null,details={}){
  db.security.events.push({id:randomUUID(),type,at:Date.now(),ip:clientIp(req),userId,...details});
  addAudit(db,{userId,action:type,target:details.targetUserId||details.slug||details.key||details.inviteId||details.engine||'',detail:Object.keys(details).length?JSON.stringify(details).slice(0,400):'',ip:clientIp(req),ok:!/fail|denied|blocked/.test(type)});
  if(db.security.events.length>200)db.security.events.splice(0,db.security.events.length-200);
  await persist();
}
function validCsrf(req,session){
  const a=Buffer.from(req.headers['x-csrf-token']||''),b=Buffer.from(session?.record.csrfToken||'');
  return a.length>0&&a.length===b.length&&timingSafeEqual(a,b);
}
function cookieValue(req,name){
  for(const pair of (req.headers.cookie||'').split(';')){
    const i=pair.indexOf('=');if(i>0&&pair.slice(0,i).trim()===name)return decodeURIComponent(pair.slice(i+1).trim());
  }
  return '';
}
function setChallengeCookie(res,token,age){
  res.setHeader('Set-Cookie','ym_challenge='+encodeURIComponent(token)+'; Path=/api/cindy; HttpOnly; SameSite=Lax; Max-Age='+age+(cookieSecure?'; Secure':''));
}
async function cindyAuthRequest(region,pathname,body,token){
  const config=authRegions[region];if(!config)throw Object.assign(new Error('登录区域无效'),{status:400});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch(config.baseUrl+pathname,{method:body===undefined?'GET':'POST',headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});
    let data={};try{data=await response.json()}catch{}
    if(!response.ok){const info=data&&typeof data.error==='object'&&data.error?data.error:data;throw Object.assign(new Error(typeof info.message==='string'?info.message:'Cindy 登录服务暂不可用'),{status:response.status,code:typeof info.code==='string'?info.code:'AUTH_REQUEST_FAILED',retryAfter:response.headers.get('retry-after')})}
    return data;
  }catch(error){if(error.name==='AbortError')throw Object.assign(new Error('Cindy 登录服务请求超时'),{status:504,code:'REQUEST_TIMEOUT'});throw error}
  finally{clearTimeout(timer)}
}
async function getCindyProviders(region){
  const cached=authProviderCache.get(region);if(cached&&cached.expiresAt>Date.now())return cached.value;
  const value=await cindyAuthRequest(region,'/api/auth/providers');
  if(value.region!==region||typeof value.email!=='boolean'||typeof value.phone!=='boolean'||!Array.isArray(value.social))throw Object.assign(new Error('Cindy 登录服务返回了无效的区域配置'),{status:502});
  authProviderCache.set(region,{value,expiresAt:Date.now()+5*60*1000});return value;
}
// 把官方认证服务的错误转成给用户看的说明，并带上 code 供前端处理（例如重置验证组件）。
function authFailure(error,fallback){
  const code=error.code||'';
  if(code==='CAPTCHA_REQUIRED'||code==='CAPTCHA_INVALID')return {status:400,code,message:'安全验证未通过，请重新完成验证后再获取验证码'};
  if(code==='INVALID_REDIRECT_URI')return {status:409,code,message:'Cindy 官方服务没有放行本站的回调地址，第三方登录暂不可用'};
  if(error.status===429)return {status:429,code,message:'Cindy 登录服务限制了请求，请稍后再试'};
  if(error.status>=400&&error.status<500&&error.message&&error.message!=='Cindy 登录服务暂不可用')return {status:400,code,message:error.message};
  return {status:502,code,message:fallback};
}
function callbackUri(req){
  const proto=String(req.headers['x-forwarded-proto']||'http').split(',')[0].trim();
  return ['http','https'].includes(proto)&&req.headers.host?proto+'://'+req.headers.host+'/api/cindy/callback':null;
}
// 探测官方服务是否放行了本站的回调地址（redirect_uri 白名单由官方维护）。只有明确返回 INVALID_REDIRECT_URI 才判定不可用；探测失败按可用处理，让用户自己试。
const socialProbeCache=new Map();
async function socialStatus(region,providers,redirectUri){
  const key=region+'|'+redirectUri,cached=socialProbeCache.get(key);
  if(cached&&cached.expiresAt>Date.now())return cached.value;
  const value={};
  await Promise.all(providers.social.map(async provider=>{
    try{
      const probe=new URL(authRegions[region].baseUrl+'/api/auth/social/'+encodeURIComponent(provider)+'/authorize');
      probe.search=new URLSearchParams({client_type:'web',device_id:randomUUID(),redirect_uri:redirectUri,code_challenge:createHash('sha256').update(randomBytes(32)).digest('base64url'),code_challenge_method:'S256',client_state:randomBytes(16).toString('base64url'),ui_locale:region==='cn'?'zh-CN':'en'}).toString();
      const response=await fetch(probe,{redirect:'manual',signal:AbortSignal.timeout(8000)});
      if(response.status===400){const data=await response.json().catch(()=>({}));value[provider]=data?.error?.code==='INVALID_REDIRECT_URI'?'blocked':'unknown'}
      else value[provider]='ok';
    }catch{value[provider]='unknown'}
  }));
  socialProbeCache.set(key,{value,expiresAt:Date.now()+5*60*1000});
  return value;
}
function tokenExpiry(token){
  try{const part=token.split('.')[1],payload=JSON.parse(Buffer.from(part,'base64url').toString('utf8'));return Number.isFinite(payload.exp)?payload.exp*1000:null}catch{return null}
}
function safeUser(user){
  const credentials=user.cindyCredentials;
  return {id:user.id,email:user.email||null,displayName:user.displayName||user.email||'Cindy 用户',role:user.role,region:user.region||null,authType:user.authType||'local',disabled:Boolean(user.disabled),lastLoginAt:user.lastLoginAt||null,token:credentials?{connected:true,accessExpiresAt:tokenExpiry(credentials.accessToken),refreshAvailable:Boolean(credentials.refreshToken),fingerprint:sha(credentials.accessToken).slice(0,10),updatedAt:credentials.updatedAt}:null};
}
function sessionCount(userId){return Object.values(db.sessions).filter(item=>item.userId===userId&&item.expiresAt>Date.now()).length}
async function issueAppSession(res,user){
  // 达到上限时自动踢掉最旧的会话（总数仍不超过上限）：用户往往找不到“其他会话”在哪，直接拒绝登录会把自己锁在外面
  const limit=Math.max(1,currentAdminPolicy().maxSessions),alive=Object.entries(db.sessions).filter(([,item])=>item.userId===user.id&&item.expiresAt>Date.now()).sort((a,b)=>(a[1].createdAt||0)-(b[1].createdAt||0));
  for(const [key] of alive.slice(0,Math.max(0,alive.length-limit+1)))delete db.sessions[key];
  const token=randomBytes(32).toString('base64url'),csrfToken=randomBytes(24).toString('base64url'),tokenHash=sha(token);
  db.sessions[tokenHash]={userId:user.id,csrfToken,expiresAt:Date.now()+sessionMs,createdAt:Date.now()};
  await persist();setCookie(res,token,Math.floor(sessionMs/1000));
  return {authenticated:true,...safeUser(user),csrfToken};
}
const safeCindyAccount=account=>({id:account.id,region:account.region,displayName:account.displayName,email:account.email,kind:account.kind,role:account.role,orgName:account.orgName,boundAt:account.boundAt,shared:Boolean(account.shared),accessExpiresAt:tokenExpiry(account.credentials?.accessToken),refreshAvailable:Boolean(account.credentials?.refreshToken)});
// 绑定用的接口都要求先登录本站账号（写请求同时校验 CSRF）。
async function bindAuth(req,res){
  const session=await getSession(req);
  if(!session){json(res,401,{error:'请先登录本站账号，再绑定 Cindy 账号'});return null}
  if(req.method!=='GET'&&!validCsrf(req,session)){json(res,403,{error:'安全校验过期，请刷新页面后重试'});return null}
  return session;
}
async function bindCindyAccount(req,userId,region,outcome){
  const user=db.users[userId];
  if(!user||user.disabled)throw Object.assign(new Error('本站账号不可用'),{status:403,local:true});
  const membership=outcome.membership;
  if(!membership||typeof membership.id!=='string'||!outcome.accessToken||!outcome.refreshToken)throw Object.assign(new Error('Cindy 登录服务返回了不完整的账号信息'),{status:502});
  let passportId=membership.passportId;
  if(typeof passportId!=='string'||!passportId){const profile=await cindyAuthRequest(region,'/api/me',undefined,outcome.accessToken);passportId=profile.passportId}
  if(typeof passportId!=='string'||!passportId)throw Object.assign(new Error('Cindy 登录服务未返回账号标识'),{status:502});
  const identityKey=sha(region+'|'+passportId+'|'+membership.id),now=Date.now();
  const owner=Object.values(db.users).find(item=>(item.cindyAccounts||[]).some(account=>account.identityKey===identityKey));
  if(owner&&owner.id!==userId)throw Object.assign(new Error('这个 Cindy 账号已经绑定到本站的另一个账号'),{status:409,local:true});
  user.cindyAccounts||=[];
  let account=user.cindyAccounts.find(item=>item.identityKey===identityKey);
  if(!account){
    if(user.cindyAccounts.length>=5)throw Object.assign(new Error('每个账号最多绑定 5 个 Cindy 账号，请先解绑不用的'),{status:400,local:true});
    account={id:randomUUID(),identityKey,boundAt:now};user.cindyAccounts.push(account);
  }
  Object.assign(account,{region,displayName:membership.displayName||membership.email||'Cindy 账号',email:membership.email||null,kind:membership.kind||null,role:membership.role||null,orgName:membership.orgName||null,credentials:{accessToken:outcome.accessToken,refreshToken:outcome.refreshToken,accountToken:outcome.accountToken||null,accountRefreshToken:outcome.accountRefreshToken||null,updatedAt:now}});
  await recordSecurityEvent('cindy_account_bound',req,userId,{region});
  cindyCache.set(account.id,{at:Date.now(),pending:true,models:[],error:null});
  syncCindyAccount(account).catch(()=>{});
  return safeCindyAccount(account);
}
function ownedConversation(id,userId){
  const item=db.conversations[id];
  return item&&item.userId===userId?item:null;
}
const envProvider=()=>modelConfigured?{baseUrl:modelBase,apiKey:modelKey}:null;
// 语音识别：复用「AI 接入」里的服务商（地址 + 密钥）；provider 为服务商 id 或 'builtin'（环境变量里的内置服务）
const asrConfig=()=>db.settings.asr||{enabled:false,provider:'',kind:'transcriptions',model:'',defaultLang:'auto',hotwords:'',maxSeconds:60};
const asrProviderTarget=config=>{if(config.provider==='custom')return config.baseUrl||config.apiKey?{baseUrl:config.baseUrl||'',apiKey:config.apiKey||'',extraParams:config.extraParams||{}}:null;const item=config.provider==='builtin'?envProvider():db.providers[config.provider];return item?.baseUrl?{baseUrl:item.baseUrl,apiKey:item.apiKey||'',extraParams:config.extraParams||{}}:null};
const asrHits=new Map(),asrBusy=new Map();
const enabledProviders=()=>Object.values(db.providers).filter(item=>item.enabled);
// 当前用户可用的模型引用：内置服务商用原模型名；管理员接入的用 "服务商标识/模型名"。成员只能用“成员可用”的服务商。
function modelCatalog(user){
  const admin=!user||user.role==='admin',list=envModels.map(ref=>({ref,provider:'default',providerName:'内置',model:ref}));
  for(const account of accessibleCindyAccounts(user)){
    const entry=cindyCache.get(account.id),mine=userCindyAccounts(user).includes(account);
    for(const model of entry?.models||[])list.push({ref:cindyProvider(account)+'/'+model.id,provider:cindyProvider(account),providerName:mine?'Cindy · '+account.displayName+(account.shared?'（已共享）':''):'Cindy · 团队共享',model:model.id,label:model.name&&model.name!==model.id?model.name:'',engines:cindyEngines(model)});
  }
  for(const provider of enabledProviders()){
    if(!admin&&!provider.membersAllowed)continue;
    const aliases=modelAliases(provider.models,provider.modelLabels).byModel;
    for(const model of provider.models)list.push({ref:provider.slug+'/'+model,provider:provider.slug,providerName:provider.name,model,label:provider.modelLabels?.[model]||'',alias:aliases.has(model)?provider.slug+'/'+aliases.get(model):''});
  }
  return list;
}
// 把模型引用解析成调用所需信息；不可用（被删除/停用/成员无权）返回 null。
function resolveModel(ref,user){
  ref=String(ref||'');if(!ref)return null;
  const admin=!user||user.role==='admin';
  if(ref.startsWith('cindy-')){
    const slash=ref.indexOf('/'),prefix=ref.slice(6,slash),model=ref.slice(slash+1);
    const accounts=accessibleCindyAccounts(user);
    const account=slash>0?accounts.find(item=>item.id.slice(0,8)===prefix):null,entry=account&&cindyCache.get(account.id);
    return entry?.base&&entry.apiKey&&entry.models.some(item=>item.id===model)?{baseUrl:entry.base,apiKey:entry.apiKey,model,ref}:null;
  }
  if(envModels.includes(ref))return {...envProvider(),model:ref,ref};
  const index=ref.indexOf('/'),provider=index>0?Object.values(db.providers).find(item=>item.slug===ref.slice(0,index)):null,model=index>0?ref.slice(index+1):'';
  if(!provider||!provider.enabled||(!admin&&!provider.membersAllowed))return null;
  if(provider.models.includes(model))return {baseUrl:provider.baseUrl,apiKey:provider.apiKey,model,ref};
  const real=modelAliases(provider.models,provider.modelLabels).byAlias.get(model);
  return real?{baseUrl:provider.baseUrl,apiKey:provider.apiKey,model:real,ref:provider.slug+'/'+real}:null;
}
function defaultModelRef(user){
  const wanted=db.settings.defaultModel;
  if(wanted&&resolveModel(wanted,user))return wanted;
  if(envModels.length&&resolveModel(envModels[0],user))return envModels[0];
  return modelCatalog(user)[0]?.ref||'';
}
const safeProvider=item=>({id:item.id,slug:item.slug,name:item.name,template:item.template,baseUrl:item.baseUrl,models:item.models,modelLabels:item.modelLabels||{},enabled:item.enabled,membersAllowed:item.membersAllowed,keyMask:maskKey(item.apiKey),hasKey:Boolean(item.apiKey),createdAt:item.createdAt});
function contentText(value){
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.map(part=>typeof part==='string'?part:(part?.text||'')).join('');
  return '';
}
function modelMessages(history,system=systemPrompt){return system?[{role:"system",content:system},...history]:history}
// ---- 环境检测与防封守卫（实现见 envcheck.mjs）----
const appMode=()=>db.settings.mode==='personal'||db.settings.mode==='team'?db.settings.mode:(process.env.YUMEIRO_USAGE==='personal'?'personal':'team');
const personalOnly=res=>json(res,403,{error:'个人使用模式下已关闭团队功能。如需添加成员，请在“站点设置”里切换为团队模式。'});
const guardConfig=()=>normalizeGuard(db.settings.guard);
let proxyAgent=null,proxyAgentUrl='';
const proxyDispatcher=()=>{const url=guardConfig().proxyUrl;if(!url)return null;if(proxyAgentUrl!==url){proxyAgent=new ProxyAgent(url);proxyAgentUrl=url}return proxyAgent};
// 发往 Claude / OpenAI 官方域名的请求，配置了出口代理就走代理；其他请求不受影响
function upstreamFetch(url,init={}){const dispatcher=usesProxy(vendorOfUrl(String(url)))?proxyDispatcher():null;return dispatcher?undiciFetch(url,{...init,dispatcher}):fetch(url,init)}
const viaConfiguredProxy=(url,init={})=>{const dispatcher=proxyDispatcher();return dispatcher?undiciFetch(url,{...init,dispatcher}):fetch(url,init)};
const engineActive={claude:0,codex:0};
const envState={result:null,at:0,probing:null,regions:[],levels:{}};
function guardUsage(now=Date.now()){
  const out={claude:{lastHour:0,concurrent:engineActive.claude,users:new Set()},codex:{lastHour:0,concurrent:engineActive.codex,users:new Set()},gemini:{lastHour:0,concurrent:0,users:new Set()},deepseek:{lastHour:0,concurrent:0,users:new Set()}};
  for(let i=db.audit.length-1;i>=0;i--){
    const item=db.audit[i];if(item.at<now-86400000)break;
    if(item.action!=='engine.run')continue;
    const vendor=vendorOfEngine(item.target);if(!vendor)continue;
    out[vendor].users.add(item.userId);if(item.at>=now-3600000)out[vendor].lastHour++;
  }
  for(const value of Object.values(out)){value.users24h=value.users.size;delete value.users}
  return out;
}
async function refreshEnv(force=false){
  if(!force&&envState.result&&Date.now()-envState.at<8000)return envState.result;
  if(envState.probing)return envState.probing;
  envState.probing=(async()=>{
    try{
      const [egress,probes]=await Promise.all([detectEgress({fetchFn:viaConfiguredProxy,extended:process.env.ENV_CHECK_EXTENDED!=='false'}),Promise.all(TARGETS.map(target=>probeTarget(target,{fetchFn:upstreamFetch})))]);
      const now=Date.now();
      if(egress.country)envState.regions.push({at:now,country:egress.country});
      envState.regions=envState.regions.filter(item=>item.at>now-86400000);
      const guard=guardConfig(),result=evaluate({egress,probes,guard,usage:guardUsage(now),regionHistory:envState.regions.map(item=>item.country)});
      result.proxy=guard.proxyUrl?maskProxy(guard.proxyUrl):'';
      for(const [vendor,info] of Object.entries(result.vendors)){
        const key=info.level+(info.block?'!':'');
        if(envState.levels[vendor]!==undefined&&envState.levels[vendor]!==key){addAudit(db,{userId:null,action:'env.risk',target:vendor,detail:VENDOR_NAMES[vendor]+'：'+envState.levels[vendor]+' → '+key+'；'+info.reasons.map(r=>r.text).join('；').slice(0,300),ok:info.level!=='danger'});await persist()}
        envState.levels[vendor]=key;
      }
      envState.result=result;envState.at=now;return result;
    }finally{envState.probing=null}
  })();
  return envState.probing;
}
// 在封号风险发生之前拒绝：受限地区出口、调用过于密集、并发过高。守卫只会“拒绝”，不会去绕过任何风控。
function guardCheck(vendor,{user,req,what}={}){
  if(!vendor)return;
  const guard=guardConfig();if(!guard.enabled)return;
  const fail=(status,message)=>{addAudit(db,{userId:user?.id||null,action:'guard.block',target:vendor,detail:message,ip:req?clientIp(req):'',ok:false});throw Object.assign(new Error(message),{status,guard:true})};
  const result=envState.result;
  if(result&&Date.now()-envState.at<30*60*1000&&result.egress?.country&&VENDORS[vendor]?.regions&&guard.restricted.includes(result.egress.country))fail(403,'已拒绝：服务器出口位于受限地区（'+result.egress.country+'），继续访问 '+VENDOR_NAMES[vendor]+' 可能导致账号被限制。请先在“环境检测”里按建议处理。');
  if(what==='engine'){
    const usage=guardUsage()[vendor];
    if(usage.lastHour>=guard.hourlyLimit)fail(429,'已拒绝：最近 1 小时 '+VENDOR_NAMES[vendor]+' 引擎已调用 '+usage.lastHour+' 次，达到上限 '+guard.hourlyLimit+'，为避免触发风控请稍后再试。');
    if(usage.concurrent>=guard.maxConcurrent)fail(429,'已拒绝：'+VENDOR_NAMES[vendor]+' 引擎并发已达上限 '+guard.maxConcurrent+'，请等当前任务结束。');
  }
}
// 服务器体检：采集现状快照（磁盘/内存/权限/DNS/时间/反代/模型/运行器…），交给 doctor.mjs 逐项评估。只读，不改任何配置。
async function collectDoctor(req,user,deep){
  const timed=async fn=>{const t=Date.now();try{await fn();return {ok:true,ms:Date.now()-t}}catch(error){return {ok:false,ms:Date.now()-t,error:String(error?.cause?.code||error?.cause?.errors?.[0]?.code||error?.code||error?.message||'失败')}}};
  let disk=null;try{const s=await statfs(dataDir);disk={total:s.blocks*s.bsize,free:s.bavail*s.bsize}}catch{}
  const writableTask=timed(async()=>{const file=path.join(dataDir,'.doctor-'+randomUUID());await writeFile(file,'ok');await rm(file,{force:true})});
  const dnsTask=Promise.all(['www.cloudflare.com','api.deepseek.com'].map(async host=>({host,...await timed(()=>dns.lookup(host))})));
  const clockTask=(async()=>{
  try{const t0=Date.now(),response=await fetch('https://www.cloudflare.com/cdn-cgi/trace',{method:'HEAD',signal:AbortSignal.timeout(6000)}),t1=Date.now(),remote=Date.parse(response.headers.get('date')||'');if(Number.isFinite(remote))return {driftMs:Math.max(0,Math.abs((t0+t1)/2-(remote+500))-500)}}catch{}return null})();
  const providers=enabledProviders(),ref=defaultModelRef(user);
  let probes=null;
  if(deep)probes=await Promise.all(providers.filter(item=>item.baseUrl).map(async item=>({name:item.name||item.slug||item.baseUrl,...await timed(async()=>{const response=await upstreamFetch(item.baseUrl,{method:'GET',signal:AbortSignal.timeout(6000)});try{await response.body?.cancel()}catch{}})})));
  const passwordFilePath=process.env.ADMIN_PASSWORD_FILE||'';
  let passwordExists=false;if(passwordFilePath){try{passwordExists=(await statFile(passwordFilePath)).size>0}catch{}}
  let wallpapers=0;try{wallpapers=(await readDir(wallpapersDir)).length}catch{}
  const remoteAddress=req.socket.remoteAddress||'',forwardedSeen=Boolean(req.headers['x-forwarded-for']||req.headers['x-forwarded-proto']);
  const envTask=envState.result?Promise.resolve(envState.result):refreshEnv().catch(()=>null);
  const load=os.loadavg();
  const [writable,dnsResults,clock,env]=await Promise.all([writableTask,dnsTask,clockTask,envTask]);
  return {
    node:process.version,platform:os.platform(),arch:os.arch(),uptimeSec:process.uptime(),cpus:os.cpus().length,load1:load[0],
    memTotal:os.totalmem(),memFree:os.freemem(),rss:process.memoryUsage().rss,disk,writable,port,storage:storage.describe,hasStoreKey:Boolean(storeKey),
    https:Boolean(req.socket.encrypted)||String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()==='https',forwardedSeen,
    local:['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remoteAddress),trustProxy:process.env.TRUST_PROXY!=='false',cookieSecure,
    passwordFile:{configured:Boolean(passwordFilePath),exists:passwordExists},adminIpRestricted:currentAdminPolicy().adminAllowedIps.length>0,
    providers:{enabled:providers.length,defaultModel:ref,resolved:Boolean(ref&&resolveModel(ref,user)),probes},
    runner:{enabled:runnerEnabled,health:runnerEnabled?await runnerHealth(true):null},
    features:{voice:Boolean(asrConfig().enabled),tts:Boolean(ttsConfig().enabled),vision:Boolean(visionConfig().enabled),imagegen:Boolean(db.settings.imagegen?.enabled)},
    dns:dnsResults,clock,env,downloads:Object.values(await listDownloads()).map(item=>item.name),wallpapers,
    counts:{users:Object.keys(db.users).length,conversations:Object.keys(db.conversations).length,audit:db.audit.length}
  };
}
const TRANSLATE_PROMPT='你是一个翻译器。把用户给出的全部文字翻译成自然、准确的简体中文：保留 Markdown 格式、代码块（代码本身不翻译）、链接、变量名和专有名词原文。只输出译文，不要解释、不要加前后缀；如果原文已经是中文，就原样输出。';
async function askModel(messages,ref=defaultModelRef(),system=systemPrompt){
  const target=resolveModel(ref);if(!target)throw Object.assign(new Error('模型不可用或尚未接入：'+ref),{status:503});
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),Math.max(10000,Number(process.env.MODEL_TIMEOUT_MS||120000)));
  try{
    guardCheck(vendorOfUrl(target.baseUrl));
    const response=await upstreamFetch(chatEndpoint(target.baseUrl),{
      method:'POST',signal:controller.signal,redirect:'error',
      headers:{...(target.apiKey?{Authorization:'Bearer '+target.apiKey}:{}),'Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify({model:target.model,messages:modelMessages(messages,system),stream:false})
    });
    if(!response.ok)throw Object.assign(new Error('模型服务返回 HTTP '+response.status),{status:502});
    const data=await response.json();
    const reply=contentText(data?.choices?.[0]?.message?.content).trim();
    if(!reply)throw Object.assign(new Error('模型服务没有返回文本内容'),{status:502});
    const input=data?.usage?.prompt_tokens??data?.usage?.input_tokens,output=data?.usage?.completion_tokens??data?.usage?.output_tokens,total=data?.usage?.total_tokens;
    const count=value=>Number.isFinite(value)&&value>=0?Math.floor(value):null;
    const inputTokens=count(input),outputTokens=count(output),totalTokens=count(total)??(inputTokens!==null&&outputTokens!==null?inputTokens+outputTokens:null);
    return {reply,usage:inputTokens===null&&outputTokens===null&&totalTokens===null?null:{inputTokens,outputTokens,totalTokens}};
  }catch(error){
    if(error.name==='AbortError')throw Object.assign(new Error('模型请求超时'),{status:504});
    throw error;
  }finally{clearTimeout(timeout)}
}
const pickModel=(ref,user)=>ref&&resolveModel(ref,user)?ref:'';
// user：把该用户自己的 Cindy 托管模型也算进去（之前只看全站模型，导致只有 Cindy 模型的用户被误拦）
function ensureModelReady(user){
  if(modelBase&&!modelBaseSecure&&!enabledProviders().length)throw Object.assign(new Error('模型服务地址必须使用 HTTPS，避免消息和 API key 以明文传输。'),{status:503});
  if(!modelCatalog(user).length)throw Object.assign(new Error('还没有可用的 AI 模型。请管理员在“⌘ → AI 接入”添加服务商，或在“⌘ → Cindy 账号”绑定账号并点“同步模型”。'),{status:503});
}
function normalizeUsage(usage){
  const count=value=>Number.isFinite(value)&&value>=0?Math.floor(value):null;
  const inputTokens=count(usage?.prompt_tokens??usage?.input_tokens),outputTokens=count(usage?.completion_tokens??usage?.output_tokens),total=count(usage?.total_tokens);
  const totalTokens=total??(inputTokens!==null&&outputTokens!==null?inputTokens+outputTokens:null);
  return inputTokens===null&&outputTokens===null&&totalTokens===null?null:{inputTokens,outputTokens,totalTokens};
}
// 流式调用：逐段回调增量文本；signal 中止（用户停止/断开）时返回已生成的部分。
async function streamModel(messages,onDelta,signal,ref=defaultModelRef(),system=systemPrompt){
  const target=resolveModel(ref);if(!target)throw Object.assign(new Error('模型不可用或尚未接入：'+ref),{status:503});
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),Math.max(10000,Number(process.env.MODEL_TIMEOUT_MS||120000)));
  const onAbort=()=>controller.abort();signal?.addEventListener('abort',onAbort);
  let reply='',usage=null,aborted=false;
  try{
    guardCheck(vendorOfUrl(target.baseUrl));
    const response=await upstreamFetch(chatEndpoint(target.baseUrl),{
      method:'POST',signal:controller.signal,redirect:'error',
      headers:{...(target.apiKey?{Authorization:'Bearer '+target.apiKey}:{}),'Content-Type':'application/json',Accept:'text/event-stream'},
      body:JSON.stringify({model:target.model,messages:modelMessages(messages,system),stream:true,stream_options:{include_usage:true}})
    });
    if(!response.ok)throw Object.assign(new Error('模型服务返回 HTTP '+response.status),{status:502});
    if(!response.body)throw Object.assign(new Error('模型服务没有返回数据流'),{status:502});
    const decoder=new TextDecoder();let buffer='';
    const handle=line=>{
      if(!line.startsWith('data:'))return;
      const payload=line.slice(5).trim();if(!payload||payload==='[DONE]')return;
      let data;try{data=JSON.parse(payload)}catch{return}
      const delta=contentText(data?.choices?.[0]?.delta?.content);
      if(delta){reply+=delta;onDelta(delta)}
      if(data?.usage)usage=normalizeUsage(data.usage);
    };
    for await(const chunk of response.body){
      buffer+=decoder.decode(chunk,{stream:true});
      let index;while((index=buffer.indexOf('\n'))>=0){handle(buffer.slice(0,index).replace(/\r$/,''));buffer=buffer.slice(index+1)}
    }
    handle(buffer.trim());
  }catch(error){
    if(error.name==='AbortError'||error.code==='ABORT_ERR'){
      aborted=true;
      if(!signal?.aborted)throw Object.assign(new Error('模型请求超时'),{status:504});
    }else throw error;
  }finally{clearTimeout(timeout);signal?.removeEventListener('abort',onAbort)}
  if(!reply.trim()&&!aborted)throw Object.assign(new Error('模型服务没有返回文本内容'),{status:502});
  return {reply,usage,aborted};
}
const busyConversations=new Set();
// 用量聚合：按成员 → 月/日累计，不受 db.usage 明细上限（10000 条）影响。时间按服务器本地时区。
const pad=n=>String(n).padStart(2,'0');
const monthKey=(at=Date.now())=>{const d=new Date(at);return d.getFullYear()+'-'+pad(d.getMonth()+1)};
const dayKey=(at=Date.now())=>{const d=new Date(at);return monthKey(at)+'-'+pad(d.getDate())};
function addStat(userId,at,usage,model,source){
  const stats=db.stats[userId]||={months:{},days:{}},month=stats.months[monthKey(at)]||={calls:0,inputTokens:0,outputTokens:0,totalTokens:0,unreportedCalls:0,models:{},sources:{}};
  const total=usage?.totalTokens??((usage?.inputTokens||0)+(usage?.outputTokens||0));
  month.calls++;month.inputTokens+=usage?.inputTokens||0;month.outputTokens+=usage?.outputTokens||0;month.totalTokens+=total||0;
  if(!usage||usage.totalTokens==null)month.unreportedCalls++;
  const m=month.models[model]||={calls:0,totalTokens:0};m.calls++;m.totalTokens+=total||0;
  month.sources[source]=(month.sources[source]||0)+1;
  const day=dayKey(at);stats.days[day]=(stats.days[day]||0)+1;
  const cutoff=dayKey(at-40*24*60*60*1000);
  for(const key of Object.keys(stats.days))if(key<cutoff)delete stats.days[key];
}
if(!db.stats){
  db.stats={};
  for(const item of db.usage)addStat(item.userId,item.at,item.totalTokens==null&&item.inputTokens==null?null:{inputTokens:item.inputTokens,outputTokens:item.outputTokens,totalTokens:item.totalTokens},item.model||modelName,item.source||'web');
  if(db.usage.length)console.log('已从 '+db.usage.length+' 条旧用量明细生成月度统计（仅覆盖明细保留的范围）。');
  await persist();
}
function recordUsage(userId,usage,model=defaultModelRef(),source="web"){
  const at=Date.now();
  db.usage.push({id:randomUUID(),userId,at,model,source,inputTokens:usage?.inputTokens??null,outputTokens:usage?.outputTokens??null,totalTokens:usage?.totalTokens??null});
  if(db.usage.length>10000)db.usage.splice(0,db.usage.length-10000);
  addStat(userId,at,usage,model,source);
  addAudit(db,{userId,action:'call.'+source,target:model,detail:usage?.totalTokens!=null?'tokens '+usage.totalTokens:''},at);
}
const emptyMonth=()=>({calls:0,inputTokens:0,outputTokens:0,totalTokens:0,unreportedCalls:0,models:{},sources:{}});
const monthStat=(userId,key=monthKey())=>db.stats[userId]?.months[key]||emptyMonth();
const dailyCalls=userId=>db.stats[userId]?.days[dayKey()]||0;
// 返回超额原因；null 表示可以继续。Token 额度按已记录用量判断，单次调用可能略微超出。
function quotaError(user){
  if(user.dailyLimit>0&&dailyCalls(user.id)>=user.dailyLimit)return '今日调用次数已达主账号设置的上限';
  const month=monthStat(user.id);
  if(user.monthlyCallLimit>0&&month.calls>=user.monthlyCallLimit)return '本月调用次数已达主账号设置的额度';
  if(user.monthlyTokenLimit>0&&month.totalTokens>=user.monthlyTokenLimit)return '本月 Token 用量已达主账号设置的额度';
  return null;
}
// 用量达到提醒线（默认 80%，QUOTA_WARN_PERCENT 可设 50–99）时给成员的提醒；达到 100% 为 exceeded。
const warnPercent=Math.min(99,Math.max(50,Math.floor(Number(process.env.QUOTA_WARN_PERCENT))||80));
function quotaAlerts(user){
  const month=monthStat(user.id);
  return [['daily','今日调用',dailyCalls(user.id),user.dailyLimit],['monthlyCalls','本月调用',month.calls,user.monthlyCallLimit],['monthlyTokens','本月 Token',month.totalTokens,user.monthlyTokenLimit]]
    .filter(([,,,limit])=>limit>0)
    .map(([key,label,used,limit])=>({key,label,used,limit,percent:Math.floor(used/limit*100)}))
    .filter(item=>item.percent>=warnPercent)
    .map(item=>({...item,level:item.percent>=100?'exceeded':'warning'}));
}
const alertHeader=alerts=>alerts.length?{'X-Yumeiro-Quota-Warning':alerts.map(item=>item.key+'='+item.percent+'%').join('; ')}:{};
const quotaView=user=>({dailyLimit:user.dailyLimit||0,monthlyCallLimit:user.monthlyCallLimit||0,monthlyTokenLimit:user.monthlyTokenLimit||0});
// ---- 团队、智能体与 API 令牌 ----
const fail=(status,message)=>Object.assign(new Error(message),{status});
const limitFields={dailyLimit:[100000,'每日调用上限'],monthlyCallLimit:[10000000,'每月调用上限'],monthlyTokenLimit:[10000000000,'每月 Token 上限']};
function readLimits(body){
  const out={};
  for(const [key,[max,label]]of Object.entries(limitFields)){
    if(body[key]===undefined)continue;
    const value=Number(body[key]);
    if(!Number.isInteger(value)||value<0||value>max)throw fail(400,label+'必须是 0–'+max+' 的整数（0 表示不限）');
    out[key]=value;
  }
  return out;
}
function visibleAgent(id,user){const agent=db.agents[id];return agent&&(agent.shared||agent.ownerId===user.id)?agent:null}
const visibleAgents=user=>Object.values(db.agents).filter(agent=>agent.shared||agent.ownerId===user.id).sort((a,b)=>a.createdAt-b.createdAt);
const safeAgent=(agent,user)=>({id:agent.id,name:agent.name,description:agent.description,skillIds:(agent.skillIds||[]).filter(id=>db.skills[id]),model:agent.model||null,shared:agent.shared,mine:agent.ownerId===user.id,...(agent.ownerId===user.id||user.role==='admin'?{systemPrompt:agent.systemPrompt}:{})});
function parseAgent(body,user,existing){
  const name=String(body.name??existing?.name??'').trim().slice(0,60);
  if(!name)throw fail(400,'智能体名称不能为空');
  const model=body.model===undefined?(existing?.model||null):(String(body.model||'').trim()||null);
  if(model&&!resolveModel(model,user))throw fail(400,'模型不可用或你无权使用：'+model);
  const skillIds=body.skillIds===undefined?(existing?.skillIds||[]):[...new Set((Array.isArray(body.skillIds)?body.skillIds:[]).map(String))];
  if(skillIds.length>8)throw fail(400,'一个智能体最多绑定 8 个技能');
  if(skillIds.some(id=>!usableSkill(id,user)&&!(existing?.skillIds||[]).includes(id)))throw fail(400,'所选技能不存在或不可用');
  return {name,skillIds,description:String(body.description??existing?.description??'').trim().slice(0,200),systemPrompt:String(body.systemPrompt??existing?.systemPrompt??'').trim().slice(0,8000),model,shared:user.role==='admin'?Boolean(body.shared??existing?.shared):false};
}
function safeMember(user){
  return {id:user.id,email:user.email,displayName:user.displayName||user.email,role:user.role,disabled:Boolean(user.disabled),...quotaView(user),todayCalls:dailyCalls(user.id),month:monthStat(user.id),lastLoginAt:user.lastLoginAt||null,createdAt:user.createdAt||null,activeSessions:sessionCount(user.id),tokens:Object.values(db.tokens).filter(item=>item.userId===user.id).length};
}
function removeUserData(userId){
  for(const [key,value]of Object.entries(db.images))if(value.userId===userId)delete db.images[key];
  for(const [key,value]of Object.entries(db.attachments))if(value.userId===userId)delete db.attachments[key];
  for(const [key,value]of Object.entries(db.remoteDevices))if(value.ownerId===userId){delete db.remoteDevices[key];remoteDrop(key)}
  rm(path.join(dataDir,'attachments',userId),{recursive:true,force:true}).catch(()=>{});
  rm(path.join(dataDir,'images',userId),{recursive:true,force:true}).catch(()=>{});
  for(const [key,value]of Object.entries(db.sessions))if(value.userId===userId)delete db.sessions[key];
  for(const [key,value]of Object.entries(db.tokens))if(value.userId===userId)delete db.tokens[key];
  for(const [key,value]of Object.entries(db.conversations))if(value.userId===userId)delete db.conversations[key];
  for(const [key,value]of Object.entries(db.agents))if(value.ownerId===userId)delete db.agents[key];
  for(const [key,value]of Object.entries(db.memories))if(value.userId===userId||value.ownerId===userId)delete db.memories[key];
  delete db.stats[userId];
  for(const [key,workspace]of Object.entries(db.workspaces)){
    if(workspace.ownerId===userId){for(const [runKey,run]of Object.entries(db.runs))if(run.workspaceId===key)delete db.runs[runKey];delete db.workspaces[key]}
    else workspace.memberIds=workspace.memberIds.filter(id=>id!==userId);
  }
  for(const [key,run]of Object.entries(db.runs))if(run.userId===userId)delete db.runs[key];
}
function bearerUser(req){
  const match=/^Bearer\s+((?:ymr|gsh|cak)_[A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization||'')||/^((?:ymr|gsh|cak)_[A-Za-z0-9_-]{20,})$/.exec(String(req.headers['x-api-key']||''));
  if(!match)return null;
  const record=db.tokens[sha(match[1])],user=record&&db.users[record.userId];
  if(!user||user.disabled)return null;
  record.lastUsedAt=Date.now();
  return {user,record};
}
// Anthropic Messages 兼容接口：让 Claude Code / Anthropic SDK 把 ANTHROPIC_BASE_URL 指到本站，用个人令牌（x-api-key 或 Bearer）调用；
// 实际由本站已接入的任意模型服务商回答，所以也记入用量、额度与审计。
async function handleAnthropic(req,res,user){
  const fail=(status,type,message)=>{if(res.headersSent)return res.end();res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({type:'error',error:{type,message}}))};
  const wait=hitWindowLimit(codeAttempts,'api:'+user.id,60,60*1000);
  if(wait)return fail(429,'rate_limit_error','请求过于频繁，请稍后再试');
  const over=quotaError(user);if(over)return fail(429,'rate_limit_error',over);
  let body;try{body=await readBody(req,2*1024*1024)}catch(e){return fail(e.status||400,'invalid_request_error',e.message)}
  const text=value=>typeof value==='string'?value:Array.isArray(value)?value.map(part=>part?.type==='text'?String(part.text||''):'').join(''):'';
  const clean=(Array.isArray(body.messages)?body.messages:[]).map(item=>({role:item?.role,content:text(item?.content)})).filter(item=>(item.role==='user'||item.role==='assistant')&&item.content);
  if(!clean.length||clean.length>200)return fail(400,'invalid_request_error','messages 必须是 1–200 条有效的文本消息');
  let system=text(body.system),model=String(body.model||defaultModelRef(user)),agentSystem='';
  if(model.startsWith('agent:')){const agent=visibleAgent(model.slice(6),user);if(!agent)return fail(404,'not_found_error','智能体不存在或不可用');agentSystem=agentPrompt(agent);model=agent.model&&resolveModel(agent.model,user)?agent.model:defaultModelRef(user)}
  else if(!resolveModel(model,user))model=defaultModelRef(user); // Claude Code 会发 claude-* 模型名：映射到本站默认模型
  if(!model||!resolveModel(model,user))return fail(404,'not_found_error','没有可用的模型，请先在管理设置里接入');
  const label=String(body.model||model),id='msg_'+randomBytes(12).toString('hex');
  const lastUser=[...clean].reverse().find(item=>item.role==='user')?.content||'';
  const memScope=apiMemoryScope(user,req,body),memory=apiMemoryPrepare(user,memScope,clean,lastUser);
  const system2=[agentSystem,system,memory.block].filter(Boolean).join('\n\n');
  const usageOf=usage=>({input_tokens:usage?.inputTokens||0,output_tokens:usage?.outputTokens||0});
  try{
    if(!body.stream){
      const result=await askModel(clean,model,system2);recordUsage(user.id,result.usage,model,'api');await persist();
      if(memScope)memoryAfterTurn(user,{id:memScope.id,messages:clean},lastUser,result.reply,model,memScope);
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...memHeader(memScope,memory)});
      return res.end(JSON.stringify({id,type:'message',role:'assistant',model:label,content:[{type:'text',text:result.reply}],stop_reason:'end_turn',stop_sequence:null,usage:usageOf(result.usage)}));
    }
    ensureModelReady(user);
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no',...memHeader(memScope,memory)});
    const send=(event,data)=>{if(!res.writableEnded&&!res.destroyed)res.write('event: '+event+'\ndata: '+JSON.stringify({type:event,...data})+'\n\n')};
    const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort()});
    send('message_start',{message:{id,type:'message',role:'assistant',model:label,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}});
    send('content_block_start',{index:0,content_block:{type:'text',text:''}});
    try{
      const result=await streamModel(clean,delta=>send('content_block_delta',{index:0,delta:{type:'text_delta',text:delta}}),abort.signal,model,system2);
      recordUsage(user.id,result.usage,model,'api');await persist();
      if(memScope&&!result.aborted)memoryAfterTurn(user,{id:memScope.id,messages:clean},lastUser,result.reply,model,memScope);
      send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:result.usage?.outputTokens||0}});send('message_stop',{});
    }catch(e){send('error',{error:{type:'api_error',message:e.message}})}
    return res.end();
  }catch(e){console.error('Anthropic 兼容调用失败：',e.message);return fail(e.status||502,'api_error',e.message||'模型服务请求失败')}
}
// OpenAI 兼容接口：用个人 API 令牌（Authorization: Bearer ymr_…）调用，不使用 cookie。
async function handleV1(req,res,pathname){
  const error=(status,message,code,headers)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify({error:{message,type:'invalid_request_error',code}}))};
  const auth=bearerUser(req);
  if(!auth)return error(401,'无效或缺少 API 令牌','invalid_api_key');
  const {user}=auth;
  if(req.method==='GET'&&pathname==='/v1/models'){
    const data=[...modelCatalog(user).map(item=>({id:item.alias||item.ref,object:'model',owned_by:item.provider,name:item.label||item.model,display_name:item.label||item.model})),...visibleAgents(user).map(agent=>({id:'agent:'+agent.id,object:'model',owned_by:'cindy-agent',name:agent.name,description:agent.description}))];
    return json(res,200,{object:'list',data});
  }
  if(req.method==='POST'&&pathname==='/v1/messages')return handleAnthropic(req,res,user);
  if(req.method==='POST'&&pathname==='/v1/images/generations')return handleImagesApi(req,res,user);
  if(req.method==='POST'&&(pathname==='/v1/audio/speech'||pathname==='/v1/audio/transcriptions'))return handleAudioApi(req,res,user,pathname);
  if(req.method!=='POST'||pathname!=='/v1/chat/completions')return error(404,'未找到','not_found');
  const wait=hitWindowLimit(codeAttempts,'api:'+user.id,60,60*1000);
  if(wait)return error(429,'请求过于频繁，请稍后再试','rate_limited',{'Retry-After':String(wait)});
  const over=quotaError(user);if(over)return error(429,over,'quota_exceeded');
  let body;try{body=await readBody(req,1024*1024)}catch(e){return error(e.status||400,e.message,'invalid_request')}
  const messages=Array.isArray(body.messages)?body.messages:[];
  let total=0;
  const clean=messages.map(item=>{const role=item?.role,content=contentText(item?.content);total+=content.length;return ['system','user','assistant'].includes(role)&&content?{role,content}:null});
  if(!clean.length||clean.length>200||clean.includes(null)||total>400000)return error(400,'messages 必须是 1–200 条有效的 system/user/assistant 文本消息','invalid_messages');
  let model=String(body.model||defaultModelRef(user)),system='';
  if(model.startsWith('agent:')){
    const agent=visibleAgent(model.slice(6),user);
    if(!agent)return error(404,'智能体不存在或不可用','model_not_found');
    system=agentPrompt(agent);model=agent.model&&resolveModel(agent.model,user)?agent.model:defaultModelRef(user);
  }else if(!resolveModel(model,user))return error(404,'模型不可用：'+model,'model_not_found');
  const lastUser=[...clean].reverse().find(item=>item.role==='user')?.content||'';
  const memScope=apiMemoryScope(user,req,body),memory=apiMemoryPrepare(user,memScope,clean,lastUser);
  system=[system,memory.block].filter(Boolean).join('\n\n');
  const label=String(body.model||model),id='chatcmpl-'+randomBytes(12).toString('hex'),created=Math.floor(Date.now()/1000);
  const openaiUsage=usage=>usage?{prompt_tokens:usage.inputTokens,completion_tokens:usage.outputTokens,total_tokens:usage.totalTokens}:undefined;
  try{
    if(!body.stream){
      const result=await askModel(clean,model,system);recordUsage(user.id,result.usage,model,'api');await persist();
      if(memScope)memoryAfterTurn(user,{id:memScope.id,messages:clean},lastUser,result.reply,model,memScope);
      // 非流式：响应头反映本次调用后的用量；流式：响应头在生成前发出，反映调用前的用量。
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...alertHeader(quotaAlerts(user)),...memHeader(memScope,memory)});
      return res.end(JSON.stringify({id,object:'chat.completion',created,model:label,choices:[{index:0,message:{role:'assistant',content:result.reply},finish_reason:'stop'}],usage:openaiUsage(result.usage)}));
    }
    ensureModelReady(user);
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no',...alertHeader(quotaAlerts(user)),...memHeader(memScope,memory)});
    const chunk=(delta,finish,extra)=>{if(!res.writableEnded&&!res.destroyed)res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created,model:label,choices:[{index:0,delta,finish_reason:finish}],...extra})+'\n\n')};
    const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort()});
    chunk({role:'assistant'},null);
    try{
      const result=await streamModel(clean,text=>chunk({content:text},null),abort.signal,model,system);
      recordUsage(user.id,result.usage,model,'api');await persist();
      if(memScope&&!result.aborted)memoryAfterTurn(user,{id:memScope.id,messages:clean},lastUser,result.reply,model,memScope);
      chunk({},'stop',result.usage?{usage:openaiUsage(result.usage)}:undefined);res.write('data: [DONE]\n\n');
    }catch(e){if(!res.writableEnded)res.write('data: '+JSON.stringify({error:{message:e.message,type:'upstream_error'}})+'\n\n')}
    return res.end();
  }catch(e){
    console.error('API 调用失败：',e.message);
    if(res.headersSent)return res.end();
    return error(e.status||502,e.message||'模型服务请求失败','upstream_error');
  }
}
// 校验并生成服务商记录。更新时：API Key 留空 = 保持原密钥；slug 创建后不可改（模型引用依赖它）。
function buildProvider(body,existing){
  const name=String(body.name??existing?.name??'').trim().slice(0,60);
  if(!name)throw fail(400,'请填写服务商名称');
  const template=String(body.template??existing?.template??'custom'),tpl=providerTemplates.find(item=>item.id===template);
  if(!tpl)throw fail(400,'未知的服务商模板');
  let baseUrl;try{baseUrl=normalizeBaseUrl(body.baseUrl??existing?.baseUrl)}catch(error){throw fail(400,error.message)}
  const typedKey=body.apiKey===undefined?'':String(body.apiKey).trim(),apiKey=typedKey||existing?.apiKey||'';
  if(!apiKey&&!tpl.keyOptional)throw fail(400,'请填写 API Key');
  const models=cleanModels(body.models??existing?.models);
  if(!models.length)throw fail(400,'请至少填写一个模型名（可先点“拉取模型”）');
  const modelLabels=cleanLabels(body.modelLabels??existing?.modelLabels,models);
  let slug=existing?.slug;
  if(!slug){
    const explicit=slugify(body.slug);
    slug=explicit||slugify(template==='custom'?name:template)||'provider';
    const taken=value=>Object.values(db.providers).some(item=>item.slug===value);
    if(explicit&&taken(slug))throw fail(409,'标识已被使用：'+slug);
    for(let i=2;!explicit&&taken(slug);i++)slug=(slugify(template==='custom'?name:template)||'provider')+'-'+i;
    if(!validSlug(slug))throw fail(400,'标识只能用小写字母、数字和连字符，且不能是 default / agent');
  }
  const flag=(value,fallback)=>typeof value==='boolean'?value:fallback;
  return {id:existing?.id||randomUUID(),slug,name,template,baseUrl,apiKey,models,modelLabels,enabled:flag(body.enabled,existing?.enabled??true),membersAllowed:flag(body.membersAllowed,existing?.membersAllowed??true),createdAt:existing?.createdAt||Date.now()};
}
// ---- 智能体运行器（Claude Code / Codex / Pi）与工作区协作 ----
// 运行器是独立容器（见 runner/），应用通过内部地址 + 令牌调用它；应用本身不执行任何智能体命令。
const runnerUrl=(process.env.RUNNER_URL||'').replace(/\/+$/,'');
const runnerToken=process.env.RUNNER_TOKEN_FILE?(await readFile(process.env.RUNNER_TOKEN_FILE,'utf8').catch(()=>'')).trim():(process.env.RUNNER_TOKEN||'');
const runnerEnabled=Boolean(runnerUrl&&runnerToken);
const uploadLimit=Math.min(200,Math.max(1,Number(process.env.WORKSPACE_UPLOAD_MAX_MB)||25))*1048576;
const ENGINES=['claude','codex','pi'],ENGINE_LABELS={claude:'Claude Code',codex:'Codex',pi:'Pi'};
const MODE_RANK={readonly:0,edit:1};
const PI_KEY_NAMES={anthropic:'ANTHROPIC_API_KEY',openai:'OPENAI_API_KEY',google:'GEMINI_API_KEY',gemini:'GEMINI_API_KEY',deepseek:'DEEPSEEK_API_KEY',groq:'GROQ_API_KEY',openrouter:'OPENROUTER_API_KEY',xai:'XAI_API_KEY',mistral:'MISTRAL_API_KEY'};
const activeRuns=new Map();
const runnerFetch=(pathname,init={})=>fetch(runnerUrl+pathname,{...init,redirect:'error',headers:{Authorization:'Bearer '+runnerToken,...(init.headers||{})}});
let healthCache=null;
async function runnerHealth(force=false){
  if(!runnerEnabled)return null;
  if(!force&&healthCache&&healthCache.at>Date.now()-15000)return healthCache.value;
  let value;
  try{const response=await runnerFetch('/health',{signal:AbortSignal.timeout(6000)});value=response.ok?await response.json():{ok:false,error:'运行器返回 HTTP '+response.status}}
  catch{value={ok:false,error:'无法连接运行器'}}
  healthCache={at:Date.now(),value};return value;
}
const engineConfig=engine=>db.settings.engines?.[engine]||{};
const availableEngines=(user,health)=>ENGINES.filter(engine=>{const config=engineConfig(engine);return config.enabled&&(user.role==='admin'||config.membersAllowed)&&health?.engines?.[engine]?.installed});
function engineEnv(engine,config){
  const key=config.apiKey,env={};
  if(!key)return env;
  if(engine==='claude'){env.ANTHROPIC_API_KEY=key;if(config.baseUrl)env.ANTHROPIC_BASE_URL=config.baseUrl}
  else if(engine==='codex'){env.OPENAI_API_KEY=key;if(config.baseUrl)env.OPENAI_BASE_URL=config.baseUrl}
  else env[PI_KEY_NAMES[config.provider]||String(config.provider||'anthropic').toUpperCase().replace(/-/g,'_')+'_API_KEY']=key;
  return env;
}
const safeEngine=(engine,health,user)=>{
  const config=engineConfig(engine);
  return {engine,label:ENGINE_LABELS[engine],installed:Boolean(health?.engines?.[engine]?.installed),version:health?.engines?.[engine]?.version||null,enabled:Boolean(config.enabled),membersAllowed:Boolean(config.membersAllowed),maxMode:config.maxMode==='edit'?'edit':'readonly',model:config.model||'',models:config.models||[],hint:ENGINE_HINTS[engine],baseUrl:config.baseUrl||'',provider:config.provider||'',keyMask:maskKey(config.apiKey||''),hasKey:Boolean(config.apiKey)};
};
// 在运行器里执行一次智能体调用，逐段回调文本；返回最终文本与用量。
async function runEngine({engine,prompt,workspaceId,mode,system,model,gateway,signal,onDelta,userId}){
  const config=engineConfig(engine),vendor=vendorOfEngine(engine);
  guardCheck(vendor,{user:db.users[userId],what:'engine'});
  addAudit(db,{userId,action:'engine.run',target:engine,detail:'workspace '+workspaceId+' · '+mode});
  if(vendor)engineActive[vendor]++;
  try{return await runEngineInner({engine,prompt,workspaceId,mode,system,model,gateway,signal,onDelta,config})}finally{if(vendor)engineActive[vendor]--}
}
async function runEngineInner({engine,prompt,workspaceId,mode,system,model,gateway,signal,onDelta,config}){
  const response=await runnerFetch('/run',{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({engine,prompt,workspace:workspaceId,mode,mcp:mcpForEngine(db.settings.mcp,engine),system:system||undefined,model:model||config.model||undefined,provider:gateway?undefined:config.provider||undefined,gateway:gateway?{baseUrl:gateway.baseUrl,model:gateway.model}:undefined,env:gateway?{YUMEIRO_GW_API_KEY:gateway.apiKey}:engineEnv(engine,config),timeoutSec:Number(process.env.RUNNER_STEP_TIMEOUT_SEC)||600})});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw Object.assign(new Error(data.error||'运行器返回 HTTP '+response.status),{status:response.status===429?429:502})}
  const decoder=new TextDecoder();let buffer='',text='',end=null;
  const handle=line=>{
    if(!line.trim())return;
    let event;try{event=JSON.parse(line)}catch{return}
    if(event.type==='text'){text+=event.text;onDelta(event.text)}
    else if(event.type==='tool')onDelta('\n› '+event.name+(event.detail?' '+event.detail:'')+'\n');
    else if(event.type==='end')end=event;
  };
  try{
    for await(const chunk of response.body){buffer+=decoder.decode(chunk,{stream:true});let index;while((index=buffer.indexOf('\n'))>=0){handle(buffer.slice(0,index));buffer=buffer.slice(index+1)}}
    handle(buffer);
  }catch(error){if(signal?.aborted)throw Object.assign(new Error('已停止'),{aborted:true});throw error}
  if(!end)throw Object.assign(new Error(ENGINE_LABELS[engine]+' 的运行器连接中断'),{status:502});
  if(end.status!=='completed'){
    const reason={timeout:'运行超时',stopped:'已停止',output_limit:'输出超过上限',failed:'执行失败'}[end.status]||end.status;
    throw Object.assign(new Error(ENGINE_LABELS[engine]+' '+reason+(end.error?'：'+end.error:'')),{status:502});
  }
  const usage=end.usage&&(end.usage.inputTokens!=null||end.usage.outputTokens!=null)?{inputTokens:end.usage.inputTokens??null,outputTokens:end.usage.outputTokens??null,totalTokens:(end.usage.inputTokens||0)+(end.usage.outputTokens||0)}:null;
  return {text:(end.final||text||'').trim(),usage};
}
const workspaceFor=(id,user)=>{
  const workspace=db.workspaces[id];
  return workspace&&(user.role==='admin'||workspace.ownerId===user.id||workspace.memberIds.includes(user.id))?workspace:null;
};
// ---- 工作区文件管理：版本备份、过期清理（文件在运行器里，备份逻辑见 runner/filestore.mjs）----
const retentionOf=workspace=>({days:Number(workspace.retention?.days)||0,autoDelete:Boolean(workspace.retention?.autoDelete&&workspace.retention?.days),protect:Array.isArray(workspace.retention?.protect)?workspace.retention.protect:[],autoEnabledBy:workspace.retention?.autoEnabledBy||null,autoEnabledAt:workspace.retention?.autoEnabledAt||null});
async function runnerJson(pathname,init={}){
  const response=await runnerFetch(pathname,{signal:AbortSignal.timeout(60000),...init});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(data.error||'运行器返回 HTTP '+response.status),{status:response.status});
  return data;
}
const isProtected=(file,protect)=>protect.some(prefix=>file===prefix||file.startsWith(prefix.replace(/\/?$/,'/')));
async function expiredFiles(workspace,now=Date.now()){
  const policy=retentionOf(workspace);
  const tree=await runnerJson('/tree?workspace='+workspace.id);
  const total=tree.files.reduce((sum,file)=>sum+file.size,0);
  if(!policy.days)return {policy,files:[],truncated:tree.truncated,total,count:tree.files.length};
  const cutoff=now-policy.days*86400000;
  const files=tree.files.filter(file=>file.mtime<cutoff&&!isProtected(file.path,policy.protect)).map(file=>({...file,ageDays:Math.floor((now-file.mtime)/86400000)}));
  return {policy,files,truncated:tree.truncated,total,count:tree.files.length};
}
function logCleanup(workspace,entry){workspace.cleanupLog=[{at:Date.now(),...entry},...(workspace.cleanupLog||[])].slice(0,50)}
// 删除一批过期文件：运行器会逐个先备份再删除，审核后又被改过的会跳过。
async function deleteExpired(workspace,items,by,auto){
  const result=await runnerJson('/delete-batch?workspace='+workspace.id,{method:'POST',body:JSON.stringify({items})});
  logCleanup(workspace,{by,auto,deleted:result.deleted.length,skipped:result.skipped.length,paths:result.deleted.slice(0,30)});
  const actor=Object.values(db.users).find(user=>user.email===by);
  for(const path of result.deleted.slice(0,100))addAudit(db,{userId:actor?.id||null,action:'expiry.delete',target:path,detail:(auto?'自动清理':'人工确认')+' · 工作区 '+workspace.name+'（删除前已备份）'});
  if(result.skipped.length)addAudit(db,{userId:actor?.id||null,action:'expiry.skip',target:workspace.name,detail:result.skipped.slice(0,10).map(item=>item.path+'：'+item.reason).join('；')});
  await persist();return result;
}
async function autoCleanup(){
  if(!runnerEnabled)return;
  for(const workspace of Object.values(db.workspaces)){
    const policy=retentionOf(workspace);
    if(!policy.autoDelete)continue;
    try{
      const expired=await expiredFiles(workspace);
      if(!expired.files.length)continue;
      if(expired.truncated||expired.files.length>200){logCleanup(workspace,{by:'系统',auto:true,deleted:0,skipped:expired.files.length,blocked:true,note:'待清理文件超过 200 个，已暂停自动清理，请手动审核'});await persist();continue}
      await deleteExpired(workspace,expired.files.map(file=>({path:file.path,mtime:file.mtime})),policy.autoEnabledBy||'系统',true);
    }catch(error){console.error('自动清理失败：',workspace.id,error.message)}
  }
}
const canManageWorkspace=(workspace,user)=>user.role==='admin'||workspace.ownerId===user.id;
const safeWorkspace=(workspace,user)=>({id:workspace.id,name:workspace.name,createdAt:workspace.createdAt,mine:workspace.ownerId===user.id,owner:db.users[workspace.ownerId]?.email||null,members:workspace.memberIds.map(id=>db.users[id]?.email).filter(Boolean)});
const runSummary=run=>({id:run.id,task:run.task.slice(0,120),mode:run.mode,status:run.status,createdAt:run.createdAt,endedAt:run.endedAt||null,participants:run.participants,userEmail:db.users[run.userId]?.email||null});
// 把请求里的参与者解析成可执行的描述；任何不可用的引用都在开始前报错，而不是跑到一半才失败。
// Cindy 托管模型 + 引擎：引擎直接用网关的地址和密钥。只有目录里声明支持该引擎的模型才行（Pi 例外，所有网关模型都可用）。
function gatewayFor(ref,engine,user){
  const resolved=resolveModel(ref,user);
  if(!resolved)throw fail(400,'所选模型不可用：'+ref);
  const slash=ref.indexOf('/'),account=accessibleCindyAccounts(user).find(item=>item.id.slice(0,8)===ref.slice(6,slash)),entry=account&&cindyCache.get(account.id),info=entry?.models?.find(item=>item.id===resolved.model);
  if(!info||!cindyEngines(info).includes(engine))throw fail(400,'这个模型不支持 '+(ENGINE_LABELS[engine]||engine)+' 引擎');
  return {baseUrl:resolved.baseUrl,apiKey:resolved.apiKey,model:resolved.model};
}
function resolveParticipant(item,user,health){
  const kind=item?.kind==='engine'?'engine':'agent',role=String(item?.role||'').trim().slice(0,1000);
  if(kind==='engine'){
    const engine=String(item.engine||'');
    if(!ENGINES.includes(engine)||!availableEngines(user,health).includes(engine))throw fail(400,'引擎不可用：'+(ENGINE_LABELS[engine]||engine)+'（需要管理员安装并启用）');
    const cap=engineConfig(engine).maxMode==='edit'?'edit':'readonly',wanted=item.mode==='edit'?'edit':'readonly';
    const config=engineConfig(engine),wantedModel=String(item.model||'').trim();
    const gateway=wantedModel.startsWith('cindy-')?gatewayFor(wantedModel,engine,user):null;
    const model=gateway?gateway.model:wantedModel&&(wantedModel===config.model||(config.models||[]).includes(wantedModel))?wantedModel:'';
    if(wantedModel&&!model)throw fail(400,'引擎 '+ENGINE_LABELS[engine]+' 不允许使用模型：'+wantedModel);
    return {kind,engine,model,gateway,label:String(item.label||'').trim().slice(0,30)||ENGINE_LABELS[engine],role,mode:MODE_RANK[wanted]<=MODE_RANK[cap]?wanted:cap};
  }
  const agent=item?.agentId?visibleAgent(String(item.agentId),user):null;
  if(item?.agentId&&!agent)throw fail(400,'所选智能体不存在或不可用');
  const model=pickModel(agent?.model,user)||pickModel(String(item?.model||''),user)||defaultModelRef(user);
  if(!model)throw fail(400,'没有可用的 AI 模型');
  const system=[agentPrompt(agent),role&&'你在本次协作中的职责：'+role].filter(Boolean).join('\n\n');
  return {kind,label:String(item?.label||'').trim().slice(0,30)||agent?.name||'助手',role,agentId:agent?.id||null,model,system};
}
// ---- 壁纸文件 ----
const wallpapersDir=path.join(dataDir,'wallpapers');
const startsWith=(data,bytes,offset=0)=>bytes.every((byte,i)=>data[offset+i]===byte);
const WALLPAPER_KINDS={
  webp:{type:'image/webp',label:'WebP 图片',magic:d=>startsWith(d,[0x52,0x49,0x46,0x46])&&startsWith(d,[0x57,0x45,0x42,0x50],8)},
  png:{type:'image/png',label:'PNG 图片',magic:d=>startsWith(d,[0x89,0x50,0x4e,0x47])},
  jpg:{type:'image/jpeg',label:'JPEG 图片',magic:d=>startsWith(d,[0xff,0xd8,0xff])},
  jpeg:{type:'image/jpeg',label:'JPEG 图片',magic:d=>startsWith(d,[0xff,0xd8,0xff])},
  mp4:{type:'video/mp4',label:'MP4 视频',video:true,magic:d=>startsWith(d,[0x66,0x74,0x79,0x70],4)}
};
const wallpaperKind=name=>WALLPAPER_KINDS[(String(name).split('.').pop()||'').toLowerCase()]&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)&&!name.includes('..')?WALLPAPER_KINDS[name.split('.').pop().toLowerCase()]:null;
async function listWallpapers(){
  try{
    const {readdir,stat}=await import('node:fs/promises');
    const items=[];
    for(const name of (await readdir(wallpapersDir)).sort()){
      const kind=wallpaperKind(name);if(!kind)continue;
      const info=await stat(path.join(wallpapersDir,name));
      if(info.isFile())items.push({name,kind:kind.video?'video':'image',size:info.size});
    }
    return items;
  }catch{return []}
}
async function readRaw(req,limit){
  const declared=Number(req.headers['content-length']||0);
  if(declared>limit)throw Object.assign(new Error('文件过大（上限 '+Math.round(limit/1048576)+' MB），当前 '+(declared/1048576).toFixed(1)+' MB'),{status:413});
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('文件过大（上限 '+Math.round(limit/1048576)+' MB）'),{status:413});chunks.push(chunk)}
  return Buffer.concat(chunks);
}
// ---- 技能工坊与机器人 ----
const skillSummary=(skill,user)=>({id:skill.id,title:skill.title,description:skill.description,content:skill.content,shared:skill.shared,mine:skill.ownerId===user.id,origin:skill.origin||null,owner:db.users[skill.ownerId]?.email||null,createdAt:skill.createdAt});
const visibleSkill=(id,user)=>{const skill=db.skills[id];return skill&&(skill.shared||skill.ownerId===user.id||user.role==='admin')?skill:null};
// 可使用（列表、绑定到智能体）：只有自己的和被共享的；管理员查看他人技能走“用户技能”总览，不混进自己的列表
const usableSkill=(id,user)=>{const skill=db.skills[id];return skill&&(skill.shared||skill.ownerId===user.id)?skill:null};
function parseSkillBody(body,user,existing){
  const title=String(body.title??existing?.title??'').trim().slice(0,60);
  if(!title)throw fail(400,'技能名称不能为空');
  const content=String(body.content??existing?.content??'').trim();
  if(!content)throw fail(400,'技能内容不能为空');
  if(content.length>20000)throw fail(400,'技能内容不能超过 20000 个字符');
  return {title,description:String(body.description??existing?.description??'').trim().slice(0,300),content,shared:user.role==='admin'?Boolean(body.shared??existing?.shared):false};
}
// 解析 SKILL.md：可选的 --- 前言里取 name / description，其余是正文
function parseSkillMarkdown(text){
  const source=String(text||'').replace(/^﻿/,'').replace(/\r\n/g,'\n').trim();
  const match=source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if(!match)return {title:(source.match(/^#\s+(.+)$/m)?.[1]||'').trim(),description:'',content:source};
  const meta={};
  // 支持常见的 YAML 写法：单行、`key: >` / `key: |` 多行块、以及缩进续行
  const fm=match[1].split('\n');
  for(let i=0;i<fm.length;i++){
    const pair=fm[i].match(/^([A-Za-z_-]+):\s*(.*)$/);if(!pair)continue;
    let value=pair[2].trim();const block=/^[>|][+-]?$/.test(value),literal=value.startsWith('|'),extra=[];
    while(i+1<fm.length&&/^\s+\S/.test(fm[i+1]))extra.push(fm[++i].trim());
    if(block)value=extra.join(literal?'\n':' ');else if(extra.length)value=[value,...extra].filter(Boolean).join(' ');
    meta[pair[1].toLowerCase()]=value.replace(/^["']|["']$/g,'');
  }
  return {title:meta.name||'',description:meta.description||'',content:match[2].trim()};
}
// 极简 zip 读取：只解析中央目录并就地解压需要的文件，不把任何内容写到磁盘，不执行其中的脚本。
const ZIP_LIMITS={archive:2*1024*1024,entry:256*1024,total:2*1024*1024,entries:2000};
function readZipEntries(buffer,wanted){
  if(buffer.length>ZIP_LIMITS.archive)throw fail(400,'压缩包不能超过 2 MB');
  let eocd=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--){if(buffer.readUInt32LE(i)===0x06054b50){eocd=i;break}}
  if(eocd<0)throw fail(400,'不是有效的 zip 文件');
  const count=buffer.readUInt16LE(eocd+10);let offset=buffer.readUInt32LE(eocd+16);
  if(count===0xffff||offset===0xffffffff)throw fail(400,'不支持 zip64 压缩包');
  if(count>ZIP_LIMITS.entries)throw fail(400,'压缩包里文件太多');
  const out=[];let total=0,ignored=0;
  for(let n=0;n<count;n++){
    if(offset+46>buffer.length||buffer.readUInt32LE(offset)!==0x02014b50)throw fail(400,'zip 目录损坏');
    const flags=buffer.readUInt16LE(offset+8),method=buffer.readUInt16LE(offset+10),compSize=buffer.readUInt32LE(offset+20),size=buffer.readUInt32LE(offset+24);
    const nameLen=buffer.readUInt16LE(offset+28),extraLen=buffer.readUInt16LE(offset+30),commentLen=buffer.readUInt16LE(offset+32),local=buffer.readUInt32LE(offset+42);
    const name=buffer.subarray(offset+46,offset+46+nameLen).toString((flags&0x800)?'utf8':'utf8');
    offset+=46+nameLen+extraLen+commentLen;
    if(name.endsWith('/'))continue;
    if(!wanted(name)){ignored++;continue}
    if(flags&1)throw fail(400,'不支持加密的压缩包');
    if(size>ZIP_LIMITS.entry)throw fail(400,name+' 超过 256 KB');
    total+=size;if(total>ZIP_LIMITS.total)throw fail(400,'解压后内容过大');
    if(local+30>buffer.length||buffer.readUInt32LE(local)!==0x04034b50)throw fail(400,'zip 数据损坏');
    const start=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28),raw=buffer.subarray(start,start+compSize);
    let data;
    try{data=method===0?raw:method===8?inflateRawSync(raw,{maxOutputLength:ZIP_LIMITS.entry}):null}catch{throw fail(400,name+' 解压失败或超过大小限制')}
    if(!data)throw fail(400,'不支持的压缩方式');
    out.push({name,text:data.toString('utf8')});
  }
  return {entries:out,ignored};
}
// 把若干 SKILL.md 文本变成当前用户的技能；逐个报告成功/跳过，不会因为其中一个出错而全部失败。
async function importSkills(items,user){
  const created=[],skipped=[];let mine=Object.values(db.skills).filter(skill=>skill.ownerId===user.id).length;
  for(const item of items){
    try{
      if(mine>=100)throw fail(400,'技能数量已达上限（100）');
      const parsed=parseSkillMarkdown(item.text);
      if(!parsed.title&&item.fallbackTitle)parsed.title=item.fallbackTitle;
      if(!parsed.title)throw fail(400,'没有找到技能名称');
      const skill={id:randomUUID(),ownerId:user.id,createdAt:Date.now(),...parseSkillBody(parsed,user)};
      db.skills[skill.id]=skill;mine++;created.push(skillSummary(skill,user));
    }catch(error){skipped.push({name:item.name,reason:error.message})}
  }
  if(created.length)await persist();
  return {created,skipped};
}
// ---- 市场：技能与机器人模板 ----
// 内置条目来自 market.mjs；社区条目存放在 db.settings.market.items，由成员投稿、管理员审核后上架。安装 = 复制成用户自己的技能 / 智能体 / 机器人。
// ---- 外部市场来源（管理员添加）----
// 每种来源由一个“适配器”负责（见 market-sources.mjs 顶部的接口说明）：GitHub 仓库、JSON 索引、ClawHub（原站 / 中国镜像）。
// 这里只管：保存来源配置、缓存目录（10 分钟）、后台刷新、对外给出统一的条目。想接新来源：新增适配器文件并设置 MARKET_ADAPTER_FILES，不用改这里。
const marketSources=()=>((db.settings.marketSources)||=[]);
const marketCache=new Map(),marketPreviewCache=new Map(),marketLoading=new Map(),MARKET_TTL=10*60*1000;
async function refreshSource(source,force){
  const cached=marketCache.get(source.id);
  if(!force&&cached&&Date.now()-cached.at<MARKET_TTL)return cached;
  if(marketLoading.has(source.id))return marketLoading.get(source.id);
  const job=refreshSourceNow(source,cached);marketLoading.set(source.id,job);
  try{return await job}finally{marketLoading.delete(source.id)}
}
async function refreshSourceNow(source,cached){
  let entry;
  try{
    const adapter=marketKit.adapterFor(source.kind);if(!adapter)throw fail(400,'不支持的来源类型：'+source.kind);
    entry={at:Date.now(),items:await adapter.load(source,marketKit.ctx),error:''};
  }catch(error){entry={at:Date.now(),items:cached?.items||[],error:error.message||'抓取失败'}}
  marketCache.set(source.id,entry);return entry;
}
async function refreshMarketSources(force){
  const active=marketSources().filter(source=>source.enabled);
  await Promise.race([Promise.all(active.map(source=>refreshSource(source,force).catch(()=>{}))),new Promise(resolve=>setTimeout(resolve,3000))]);
}
const sourceView=source=>{
  const cached=marketCache.get(source.id),adapter=marketKit.adapterFor(source.kind);
  return {id:source.id,name:source.name,kind:source.kind,option:marketKit.optionOf(source),target:adapter?adapter.describe(source):'（适配器未加载：'+source.kind+'）',enabled:source.enabled,hasToken:Boolean(source.token),searchable:typeof adapter?.search==='function',loading:marketLoading.has(source.id),warning:cached?.items?.failed?'有 '+cached.items.failed+' 个文件读取失败，可点“刷新”重试':'',count:cached?.items.length??null,error:cached?.error||'',checkedAt:cached?.at||null};
};
// 条目带 lazy:true（目录里没有正文）时，预览 / 安装才向对应的适配器要完整内容
async function resolveExternal(key){
  const parsed=marketKit.parseKey(key),source=parsed&&marketSources().find(item=>item.id===parsed.sourceId&&item.enabled),adapter=source&&marketKit.adapterFor(source.kind);
  if(typeof adapter?.resolve!=='function')throw fail(404,'市场里没有这个条目（可能已被下架）');
  return {...await adapter.resolve(source,parsed.rest,marketKit.ctx),sourceName:source.name};
}
const marketItems=()=>((db.settings.market||={}).items||={});
const marketTags=value=>[...new Set((Array.isArray(value)?value:String(value||'').split(/[,，\s]+/)).map(item=>String(item).trim().slice(0,12)).filter(Boolean))].slice(0,5);
const marketPreview=(entry,limit=0)=>{
  if(entry.type==='skill')return String(entry.content||'').slice(0,limit||700);
  const parts=[String(entry.prompt||'').slice(0,limit||500)];
  if(entry.skills?.length)parts.push(limit?entry.skills.map(skill=>'—— 附带技能：'+skill.title+' ——\n'+skill.content).join('\n\n'):'技能：'+entry.skills.map(skill=>skill.title).join('、'));
  return parts.join('\n\n');
};
// 来源适配器套件（需要 marketTags / parseSkillMarkdown / readZipEntries，所以放在它们之后）；MARKET_ADAPTER_FILES 可加载额外适配器
const marketKit=createMarketSources({fail,marketTags,parseSkillMarkdown,readZipEntries});
try{const extra=await marketKit.loadExtra();if(extra.length)console.log('已加载额外的市场适配器：'+extra.join('、'))}catch(error){console.error('加载额外市场适配器失败：',error.message)}
function marketCatalog(){
  const list=[];
  for(const item of BUILTIN_SKILLS)list.push({key:'builtin:'+item.key,type:'skill',source:'builtin',title:item.title,description:item.description,tags:item.tags,content:item.content});
  for(const item of BUILTIN_BOTS)list.push({key:'builtin:'+item.key,type:'bot',source:'builtin',title:item.title,description:item.description,tags:item.tags,prompt:item.prompt,skills:item.skills.map(k=>BUILTIN_SKILLS.find(s=>s.key===k)).filter(Boolean).map(s=>({key:'builtin:'+s.key,title:s.title,description:s.description,content:s.content}))});
  for(const source of marketSources().filter(item=>item.enabled))for(const item of marketCache.get(source.id)?.items||[])list.push({...item,sourceName:source.name});
  for(const item of Object.values(marketItems()))if(item.status==='published')list.push({key:'community:'+item.id,type:item.type,source:'community',id:item.id,ownerId:item.ownerId,title:item.title,description:item.description,tags:item.tags||[],content:item.content,prompt:item.prompt,skills:(item.skills||[]).map((s,i)=>({key:'community:'+item.id+'#'+i,title:s.title,description:s.description,content:s.content})),publishedAt:item.reviewedAt||item.createdAt});
  return list;
}
const marketAuthor=ownerId=>ownerId?(db.users[ownerId]?.displayName||db.users[ownerId]?.email||'已删除用户'):'官方';
function marketView(entry,user,own){
  return {key:entry.key,type:entry.type,source:entry.source,title:entry.title,description:entry.description,tags:entry.tags||[],author:entry.source==='builtin'?'官方':entry.source==='external'?(entry.owner?entry.sourceName+' · @'+entry.owner:entry.sourceName):marketAuthor(entry.ownerId),sourceName:entry.sourceName||'',url:entry.url||'',lazy:Boolean(entry.lazy),mine:entry.ownerId===user.id,installed:entry.type==='skill'?own.skills.has(entry.key):own.agents.has(entry.key),preview:marketPreview(entry),skillCount:entry.skills?.length||0};
}
const marketOwn=user=>({skills:new Set(Object.values(db.skills).filter(skill=>skill.ownerId===user.id&&skill.marketKey).map(skill=>skill.marketKey)),agents:new Set(Object.values(db.agents).filter(agent=>agent.ownerId===user.id&&agent.marketKey).map(agent=>agent.marketKey))});
function installMarketSkill(entry,user,{sub=false}={}){
  const existing=Object.values(db.skills).find(skill=>skill.ownerId===user.id&&skill.marketKey===entry.key);
  if(existing)return {skill:existing,created:false};
  if(Object.values(db.skills).filter(skill=>skill.ownerId===user.id).length>=100)throw fail(400,'技能数量已达上限（100），请先删除一些');
  const skill={id:randomUUID(),ownerId:user.id,createdAt:Date.now(),title:entry.title.slice(0,60),description:String(entry.description||'').slice(0,300),content:entry.content,shared:false,marketKey:entry.key,origin:{kind:entry.source||'builtin',name:entry.sourceName||''}};
  db.skills[skill.id]=skill;return {skill,created:true};
}
function installMarketBot(entry,user){
  if(Object.values(db.agents).some(agent=>agent.ownerId===user.id&&agent.marketKey===entry.key))throw fail(409,'你已经安装过这个机器人模板');
  if(Object.values(db.agents).filter(agent=>agent.ownerId===user.id).length>=50)throw fail(400,'智能体数量已达上限');
  if(Object.values(db.bots).filter(bot=>bot.ownerId===user.id).length>=10)throw fail(400,'每个账号最多 10 个机器人');
  const skillIds=(entry.skills||[]).slice(0,8).map(item=>installMarketSkill({key:item.key,title:item.title,description:item.description,content:item.content,source:entry.source,sourceName:entry.sourceName},user).skill.id);
  const agent={id:randomUUID(),ownerId:user.id,createdAt:Date.now(),name:entry.title.slice(0,60),description:String(entry.description||'').slice(0,200),systemPrompt:String(entry.prompt||'').slice(0,8000),model:null,skillIds,shared:false,marketKey:entry.key};
  db.agents[agent.id]=agent;
  const token=newBotToken(),bot={id:randomUUID(),ownerId:user.id,name:entry.title.slice(0,40),agentId:agent.id,tokenHash:sha(token),tokenPrefix:token.slice(0,8),createdAt:Date.now(),marketKey:entry.key};
  db.bots[bot.id]=bot;return {agent,bot,token};
}
const marketMine=user=>Object.values(marketItems()).filter(item=>item.ownerId===user.id).sort((a,b)=>b.createdAt-a.createdAt).map(item=>({id:item.id,type:item.type,title:item.title,status:item.status,note:item.note||'',createdAt:item.createdAt}));
const marketAdminView=item=>({id:item.id,type:item.type,title:item.title,description:item.description,tags:item.tags||[],status:item.status,author:marketAuthor(item.ownerId),note:item.note||'',createdAt:item.createdAt,preview:marketPreview(item,20000)});
const exportSkillMarkdown=skill=>'---\nname: '+skill.title.replace(/\n/g,' ')+'\ndescription: '+(skill.description||'').replace(/\n/g,' ')+'\n---\n\n'+skill.content+'\n';
// 智能体的完整系统提示词 = 自己的提示词 + 绑定的技能（总长度封顶，防止撑爆上下文）
function agentPrompt(agent){
  if(!agent)return '';
  const parts=[agent.systemPrompt||''];
  let budget=12000;const skills=[];
  for(const id of agent.skillIds||[]){
    const skill=db.skills[id];if(!skill)continue;
    const block='## '+skill.title+(skill.description?'\n'+skill.description:'')+'\n\n'+skill.content;
    if(block.length>budget)break;
    budget-=block.length;skills.push(block);
  }
  if(skills.length)parts.push('# 技能\n你掌握以下技能；遇到相关任务时按其中的说明执行。\n\n'+skills.join('\n\n'));
  return parts.filter(Boolean).join('\n\n');
}
const botMemoryItems=bot=>Object.values(db.memories).filter(item=>item.ownerId===bot.ownerId&&String(item.userId).startsWith('bot:'+bot.id+':'));
const botSummary=bot=>({id:bot.id,memory:bot.memory!==false,memoryCount:botMemoryItems(bot).length,name:bot.name,agentId:bot.agentId||null,agentName:bot.agentId?db.agents[bot.agentId]?.name||'（智能体已删除）':null,tokenPrefix:bot.tokenPrefix,createdAt:bot.createdAt,lastUsedAt:bot.lastUsedAt||null});
const newBotToken=()=>'bot_'+randomBytes(24).toString('base64url');
// 机器人入口：POST /bot/<id>，Authorization: Bearer bot_… ；请求 {text, session?}，响应 {reply}。同一个 session 保留上下文。
async function handleBot(req,res,pathname){
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
  if(req.method!=='POST')return send(405,{error:'只支持 POST'});
  const match=pathname.match(/^\/bot\/([0-9a-f-]{36})$/i),bot=match&&db.bots[match[1]];
  const given=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'')||String(req.headers['x-bot-token']||'');
  const wanted=Buffer.from(bot?.tokenHash||''),actual=Buffer.from(sha(given));
  if(!bot||wanted.length!==actual.length||!timingSafeEqual(wanted,actual))return send(401,{error:'机器人不存在或令牌错误'});
  const owner=db.users[bot.ownerId];
  if(!owner||owner.disabled)return send(403,{error:'机器人所属账号不可用'});
  const wait=hitWindowLimit(codeAttempts,'bot:'+bot.id,30,60*1000);
  if(wait)return send(429,{error:'请求过于频繁，请稍后再试',retryAfterSeconds:wait});
  const limit=quotaError(owner);if(limit)return send(429,{error:limit});
  let body;try{body=await readBody(req,256*1024)}catch(error){return send(error.status||400,{error:error.message})}
  const text=String(body.text??body.message??body.content??body.query??'').trim(),key=String(body.session??body.user??body.conversation??'default').slice(0,80)||'default';
  if(!text||text.length>12000)return send(400,{error:'text 不能为空，且不能超过 12000 个字符'});
  const agent=bot.agentId?db.agents[bot.agentId]:null,ref=pickModel(agent?.model,owner)||defaultModelRef(owner);
  try{ensureModelReady(owner)}catch(error){return send(503,{error:error.message})}
  const title='机器人：'+bot.name+' · '+key;
  let conversation=Object.values(db.conversations).find(item=>item.botId===bot.id&&item.botKey===key);
  if(!conversation){const id=randomUUID(),now=Date.now();conversation=db.conversations[id]={id,userId:owner.id,title,createdAt:now,updatedAt:now,messages:[],botId:bot.id,botKey:key}}
  if(busyConversations.has(conversation.id))return send(409,{error:'这个会话正在处理上一条消息'});
  busyConversations.add(conversation.id);
  try{
    conversation.messages.push({role:'user',content:text,createdAt:Date.now()});
    const history=conversation.messages.slice(-contextMessages).map(item=>({role:item.role,content:item.content}));
    // 记忆按“机器人 + 会话”隔离：对话对象是第三方，不会带上主人自己的个人记忆
    const scope={id:'bot:'+bot.id+':'+key,disabled:bot.memory===false};
    const remembered=!scope.disabled&&readPrefs(owner).enabled?explicitRemember(text):null;
    if(remembered)upsertMemory(db,scope.id,{text:remembered,kind:'note',pinned:true,source:'manual',conversationId:conversation.id,ownerId:owner.id});
    const memory=memoryContext(owner,conversation,text,scope);
    const result=await askModel(history,ref,[agent?agentPrompt(agent):systemPrompt,memory.block].filter(Boolean).join('\n\n'));
    conversation.messages.push({role:'assistant',content:result.reply,createdAt:Date.now()});
    const cut=conversation.messages.length-200;
    if(cut>0){conversation.messages.splice(0,cut);if(conversation.summary)conversation.summary.upTo=Math.max(0,(conversation.summary.upTo||0)-cut)}
    conversation.updatedAt=Date.now();bot.lastUsedAt=Date.now();
    recordUsage(owner.id,result.usage,ref,'bot');await persist();
    memoryAfterTurn(owner,conversation,text,result.reply,ref,scope);
    return send(200,{reply:result.reply,text:result.reply,session:key,usage:result.usage,memory_used:memory.used});
  }catch(error){
    conversation.messages.pop();
    return send(error.status||502,{error:error.message||'模型服务请求失败'});
  }finally{busyConversations.delete(conversation.id)}
}
// 仅按白名单提供 public 下的静态文件，不拼接请求路径，避免目录穿越。
const staticFiles={
  '/index.html':{name:'index.html',type:'text/html; charset=utf-8',html:true},
  '/admin':{name:'index.html',type:'text/html; charset=utf-8',html:true},
  '/settings':{name:'index.html',type:'text/html; charset=utf-8',html:true},
  '/market':{name:'index.html',type:'text/html; charset=utf-8',html:true},
  '/workspaces':{name:'index.html',type:'text/html; charset=utf-8',html:true},
  '/admin/settings':{name:'index.html',type:'text/html; charset=utf-8',html:true},
  '/portal.js':{name:'portal.js',type:'text/javascript; charset=utf-8'},
  '/auth-extra.js':{name:'auth-extra.js',type:'text/javascript; charset=utf-8'},
  '/team.js':{name:'team.js',type:'text/javascript; charset=utf-8'},
  '/voice.js':{name:'voice.js',type:'text/javascript; charset=utf-8'},
  '/memory.js':{name:'memory.js',type:'text/javascript; charset=utf-8'},
  '/history.js':{name:'history.js',type:'text/javascript; charset=utf-8'},
  '/charts.js':{name:'charts.js',type:'text/javascript; charset=utf-8'},
  '/draw.js':{name:'draw.js',type:'text/javascript; charset=utf-8'},
  '/speak.js':{name:'speak.js',type:'text/javascript; charset=utf-8'},
  '/guide.js':{name:'guide.js',type:'text/javascript; charset=utf-8'},
  '/vision.js':{name:'vision.js',type:'text/javascript; charset=utf-8'},
  '/remote':{name:'remote.html',type:'text/html; charset=utf-8',html:true},
  '/remote.js':{name:'remote.js',type:'text/javascript; charset=utf-8'},
  '/remote/agent.mjs':{name:'agent.mjs',type:'text/javascript; charset=utf-8'},
  '/pwa.js':{name:'pwa.js',type:'text/javascript; charset=utf-8'},
  '/mascot.js':{name:'mascot.js',type:'text/javascript; charset=utf-8'},
  '/mascot.png':{name:'mascot.png',type:'image/png'},
  '/pet.js':{name:'pet.js',type:'text/javascript; charset=utf-8'},
  '/pet-sense.js':{name:'pet-sense.js',type:'text/javascript; charset=utf-8'},
  '/side.js':{name:'side.js',type:'text/javascript; charset=utf-8'},
  '/side-tools.js':{name:'side-tools.js',type:'text/javascript; charset=utf-8'},
  '/recover.js':{name:'recover.js',type:'text/javascript; charset=utf-8'},
  '/pet/idle.png':{name:'pet/idle.png',type:'image/png'},
  '/pet/blink.png':{name:'pet/blink.png',type:'image/png'},
  '/pet/happy.png':{name:'pet/happy.png',type:'image/png'},
  '/pet/sleepy.png':{name:'pet/sleepy.png',type:'image/png'},
  '/pet/walk1.png':{name:'pet/walk1.png',type:'image/png'},
  '/pet/walk2.png':{name:'pet/walk2.png',type:'image/png'},
  '/pet/walk3.png':{name:'pet/walk3.png',type:'image/png'},
  '/pet/walk4.png':{name:'pet/walk4.png',type:'image/png'},
  '/pet/peek.png':{name:'pet/peek.png',type:'image/png'},
  '/pet/sit.png':{name:'pet/sit.png',type:'image/png'},
  '/pet/angry1.png':{name:'pet/angry1.png',type:'image/png'},
  '/pet/angry2.png':{name:'pet/angry2.png',type:'image/png'},
  '/pet/sad1.png':{name:'pet/sad1.png',type:'image/png'},
  '/pet/sad2.png':{name:'pet/sad2.png',type:'image/png'},
  '/pet/laugh1.png':{name:'pet/laugh1.png',type:'image/png'},
  '/pet/laugh2.png':{name:'pet/laugh2.png',type:'image/png'},
  '/pet/surprised.png':{name:'pet/surprised.png',type:'image/png'},
  '/pet/shy.png':{name:'pet/shy.png',type:'image/png'},
  '/sw.js':{name:'sw.js',type:'text/javascript; charset=utf-8'},
  '/manifest.webmanifest':{name:'manifest.webmanifest',type:'application/manifest+json; charset=utf-8'},
  '/icon.svg':{name:'icon.svg',type:'image/svg+xml'},
  '/offline.html':{name:'offline.html',type:'text/html; charset=utf-8',html:true},
  '/icon-192.png':{name:'icon-192.png',type:'image/png'},
  '/icon-512.png':{name:'icon-512.png',type:'image/png'},
  '/theme.js':{name:'theme.js',type:'text/javascript; charset=utf-8'},
  '/theme.css':{name:'theme.css',type:'text/css; charset=utf-8'}
};
// 客户端安装包（Windows 安装版 / 便携版、Android APK、SHA256.txt）：放在数据目录的 downloads/（Docker 是数据卷，直装版是 /var/lib/yumeiro/downloads），不再打进镜像；仍兼容旧位置 public/downloads。
// 文件名必须符合固定格式，不拼接请求路径，所以不会目录穿越。上传用 scripts/install-clients.mjs。
const downloadDirs=[path.join(dataDir,'downloads'),path.join(root,'public','downloads')];
const DOWNLOAD_NAME=/^(Yumeiro-(?:Setup|Portable)-\d[0-9A-Za-z.-]*\.exe|Yumeiro-[A-Za-z0-9.-]+\.apk|SHA256\.txt)$/;
const downloadType=name=>name.endsWith('.apk')?'application/vnd.android.package-archive':name.endsWith('.exe')?'application/vnd.microsoft.portable-executable':'text/plain; charset=utf-8';
async function findDownload(name){
  if(!DOWNLOAD_NAME.test(name))return null;
  for(const dir of downloadDirs){const file=path.join(dir,name);try{const info=await statFile(file);if(info.isFile())return {file,size:info.size,name,type:downloadType(name)}}catch{}}
  return null;
}
const versionParts=name=>((/(\d+(?:\.\d+)*)/.exec(name)||['','0'])[1]).split('.').map(Number);
const byVersion=(a,b)=>{const x=versionParts(a),y=versionParts(b);for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]||0)-(y[i]||0);if(d)return d}return 0};
async function listDownloads(){
  const names=new Set();
  for(const dir of downloadDirs){try{for(const name of await readDir(dir))if(DOWNLOAD_NAME.test(name))names.add(name)}catch{}}
  const out={};
  for(const [key,re] of [['windows',/^Yumeiro-Setup-/],['portable',/^Yumeiro-Portable-/],['android',/\.apk$/],['checksums',/^SHA256\.txt$/]]){
    const name=[...names].filter(item=>re.test(item)).sort(byVersion).pop(),found=name&&await findDownload(name);
    if(found)out[key]={name,size:found.size};
  }
  return out;
}
// ---- 记忆连续系统：取回 / 提取 / 滚动摘要（实现见 memory.mjs）----
const memoryBusyUsers=new Set(),summaryBusy=new Set();
const safeMemory=item=>({id:item.id,text:item.text,kind:item.kind,pinned:!!item.pinned,source:item.source,createdAt:item.createdAt,updatedAt:item.updatedAt,uses:item.uses||0});
// scope：机器人会话 {id:'bot:<机器人>:<会话>',disabled}。机器人的对话对象是第三方，所以只读写该会话自己的记忆，也不参考主人的往期对话。
function memoryContext(user,item,message,scope=null){
  const prefs=readPrefs(user);
  if(!prefs.enabled||scope?.disabled)return {block:'',used:0};
  const recent=item.messages.filter(m=>m.role==='user').slice(-3).map(m=>m.content).join(' ');
  const memories=selectMemories(userMemories(db,scope?scope.id:user.id),message+' '+recent),now=Date.now();
  for(const memory of memories){memory.uses=(memory.uses||0)+1;memory.lastUsedAt=now}
  const related=(!scope&&prefs.crossChat)?relatedConversations(Object.values(db.conversations),item.id,user.id,message):[];
  const summary=item.summary?.text||'';
  return {block:buildMemoryBlock({memories,summary,related}),used:memories.length+related.length+(summary?1:0)};
}
// 回复完成后在后台整理：提取长期记忆 + 把滚出上下文窗口的内容折进对话摘要。失败不影响聊天。
async function memoryAfterTurn(user,item,message,reply,modelRef,scope=null){
  const prefs=readPrefs(user),key=scope?scope.id:user.id;
  if(!prefs.enabled||scope?.disabled||!reply.trim())return;
  const range=scope?.noSummary?null:pendingSummaryRange(item,contextMessages);
  if(range&&!summaryBusy.has(item.id)){
    summaryBusy.add(item.id);
    try{
      const result=await askModel(summaryMessages(item.summary?.text||'',item.messages.slice(range.from,range.to)),modelRef,'');
      const text=result.reply.trim().slice(0,MEMORY_LIMITS.summaryMax);
      if(text&&db.conversations[item.id]){item.summary={text,upTo:range.to,at:Date.now()};recordUsage(user.id,result.usage,modelRef,'memory');await persist()}
    }catch(error){console.error('对话摘要失败：',error.message)}finally{summaryBusy.delete(item.id)}
  }
  if(!prefs.auto||message.length<8||memoryBusyUsers.has(key))return;
  memoryBusyUsers.add(key);
  try{
    const known=selectMemories(userMemories(db,key),message,{picks:15});
    const result=await askModel(extractionMessages(message,reply,known),modelRef,'');
    recordUsage(user.id,result.usage,modelRef,'memory');
    for(const entry of parseExtraction(result.reply))upsertMemory(db,key,{...entry,source:'auto',conversationId:item.id,...(scope?{ownerId:user.id}:{})});
    await persist();
  }catch(error){console.error('记忆提取失败：',error.message)}finally{memoryBusyUsers.delete(key)}
}
// 接口调用（/v1/chat/completions、/v1/messages）的记忆：调用方传会话标识才启用（请求头 X-Session-Id，或 body.session / OpenAI 的 user / Anthropic 的 metadata.user_id）。
// 同机器人一样按“令牌所有者 + 会话”隔离，不带所有者的个人记忆；没有会话标识就保持无状态。
function apiMemoryScope(user,req,body){
  const raw=req.headers['x-session-id']??body.session??body.user??body.metadata?.user_id;
  const id=(typeof raw==='string'||typeof raw==='number')?String(raw).trim().slice(0,80):'';
  if(!id||!readPrefs(user).enabled)return null;
  return {id:'api:'+user.id+':'+id,disabled:false,noSummary:true,session:id};
}
function apiMemoryPrepare(user,scope,clean,lastUser){
  if(!scope)return {block:'',used:0};
  const remembered=explicitRemember(lastUser);
  if(remembered)upsertMemory(db,scope.id,{text:remembered,kind:'note',pinned:true,source:'manual',ownerId:user.id});
  return memoryContext(user,{id:scope.id,messages:clean},lastUser,scope);
}
const memHeader=(scope,memory)=>scope?{'X-Memory-Used':String(memory.used)}:{};
// ---- 文生图（实现见 images.mjs）：服务商用 OpenAI 兼容的 /images/generations；生成结果存到 DATA_DIR/images/<用户>/ ----
const imageConfig=()=>({...defaultImageConfig(),...(db.settings.image||{})});
const imageTarget=config=>{if(config.provider==='custom')return config.baseUrl?{baseUrl:config.baseUrl,apiKey:config.apiKey||''}:null;const item=config.provider==='builtin'?envProvider():db.providers[config.provider];return item?.baseUrl?{baseUrl:item.baseUrl,apiKey:item.apiKey||''}:null};
const imageDir=userId=>path.join(dataDir,'images',userId);
const imagesBusy=new Set();
const imageDayCount=user=>user.imageUsage?.day===dayKey()?user.imageUsage.count:0;
const imageError=(message,status)=>Object.assign(new Error(message),{status});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// 下载一张结果图（上游给 base64 或图片地址），校验大小和文件头
async function fetchImageBuffer(item,target,headers={}){
  let buffer;
  if(item.b64)buffer=Buffer.from(item.b64,'base64');
  else{
    const got=await upstreamFetch(safeResultUrl(item.url,target.baseUrl),{redirect:'error',headers,signal:AbortSignal.timeout(IMAGE_LIMITS.fetchTimeoutMs)});
    if(!got.ok)throw imageError('下载生成的图片失败（HTTP '+got.status+'）',502);
    if(Number(got.headers.get('content-length')||0)>IMAGE_LIMITS.maxBytes)throw imageError('生成的图片太大',502);
    buffer=Buffer.from(await got.arrayBuffer());
  }
  if(buffer.length>IMAGE_LIMITS.maxBytes)throw imageError('生成的图片太大',502);
  const kind=sniffImage(buffer);if(!kind)throw imageError('上游返回的内容不是图片',502);
  return {buffer,...kind,revised:item.revised};
}
// OpenAI 兼容 / 硅基流动 / 本机 SD WebUI：一次 POST，返回若干张
async function requestImages(config,target,params){
  const response=await upstreamFetch(imagesEndpoint(target.baseUrl,config.dialect),{method:'POST',redirect:'error',signal:AbortSignal.timeout(IMAGE_LIMITS.apiTimeoutMs),headers:{'Content-Type':'application/json',Accept:'application/json',...imageAuthHeaders(config,target.apiKey)},body:JSON.stringify(buildImageRequest(config,params))});
  const data=await response.json().catch(()=>null);
  if(!response.ok){const detail=String(data?.error?.message||data?.message||data?.detail||'').slice(0,200);throw imageError('绘画服务返回 HTTP '+response.status+(detail?'：'+detail:''),response.status===429?429:502)}
  const items=parseImageResponse(data);if(!items.length)throw imageError('绘画服务没有返回图片',502);
  const out=[];
  for(const item of items.slice(0,params.n))out.push(await fetchImageBuffer(item,target));
  return out;
}
// ComfyUI：提交工作流 → 轮询 /history → 逐张取 /view
async function comfyGenerate(config,target,params){
  const [width,height]=params.size.split('x').map(Number);
  let workflow;try{workflow=buildComfyWorkflow(config.workflow,{...params,width,height,model:config.model})}catch{throw imageError('ComfyUI 工作流不是合法的 JSON',400)}
  const headers={'Content-Type':'application/json',Accept:'application/json',...imageAuthHeaders(config,target.apiKey)},base=target.baseUrl.replace(/\/+$/,'');
  const queued=await upstreamFetch(base+'/prompt',{method:'POST',redirect:'error',headers,body:JSON.stringify({prompt:workflow,client_id:randomUUID()}),signal:AbortSignal.timeout(30000)});
  const queuedData=await queued.json().catch(()=>null);
  if(!queued.ok||!queuedData?.prompt_id){const detail=String(queuedData?.error?.message||queuedData?.message||'').slice(0,200);throw imageError('ComfyUI 拒绝了任务（HTTP '+queued.status+'）'+(detail?'：'+detail:'')+'。请检查检查点文件名和工作流。',502)}
  const id=queuedData.prompt_id,deadline=Date.now()+IMAGE_LIMITS.apiTimeoutMs;
  let refs=null;
  while(Date.now()<deadline){
    await sleep(Number(process.env.COMFY_POLL_MS)||1000);
    const history=await upstreamFetch(base+'/history/'+encodeURIComponent(id),{redirect:'error',headers,signal:AbortSignal.timeout(15000)});
    if(!history.ok)throw imageError('读取 ComfyUI 任务状态失败（HTTP '+history.status+'）',502);
    refs=comfyImageRefs(await history.json().catch(()=>null),id);
    if(refs)break;
  }
  if(!refs)throw imageError('ComfyUI 生成超时',504);
  if(!refs.length)throw imageError('ComfyUI 没有输出图片（工作流里需要有 SaveImage 节点）',502);
  const out=[];
  for(const ref of refs.slice(0,params.n)){
    const view=base+'/view?'+new URLSearchParams({filename:ref.filename,subfolder:ref.subfolder,type:ref.type});
    const got=await upstreamFetch(view,{redirect:'error',headers:imageAuthHeaders(config,target.apiKey),signal:AbortSignal.timeout(IMAGE_LIMITS.fetchTimeoutMs)});
    if(!got.ok)throw imageError('从 ComfyUI 取图失败（HTTP '+got.status+'）',502);
    const buffer=Buffer.from(await got.arrayBuffer());
    if(buffer.length>IMAGE_LIMITS.maxBytes)throw imageError('生成的图片太大',502);
    const kind=sniffImage(buffer);if(!kind)throw imageError('ComfyUI 返回的内容不是图片',502);
    out.push({buffer,...kind});
  }
  return out;
}
// 多张：先按服务商支持的方式一次要 n 张；模型只允许 1 张（上游报 400）时自动改成并发的多次单张；也可以固定为拆分模式
async function splitImages(config,target,params){
  const results=await Promise.allSettled(Array.from({length:params.n},()=>requestImages(config,target,{...params,n:1})));
  const ok=results.filter(item=>item.status==='fulfilled').flatMap(item=>item.value);
  if(!ok.length)throw results[0].reason;
  return ok;
}
async function callImageApi(config,params){
  const target=imageTarget(config);if(!target)throw imageError('绘画服务商还没配置好',503);
  guardCheck(vendorOfUrl(target.baseUrl));
  if(config.dialect==='comfyui')return comfyGenerate(config,target,params);
  if(params.n>1&&config.batchMode==='split')return splitImages(config,target,params);
  try{return await requestImages(config,target,params)}
  catch(error){
    if(params.n>1&&/HTTP 400/.test(error.message))return splitImages(config,target,params);
    throw error;
  }
}
async function saveImages(user,config,params,images,source){
  await mkdir(imageDir(user.id),{recursive:true,mode:0o700});
  const saved=[];
  for(const image of images){
    const id=randomUUID(),file=id+'.'+image.ext;
    await writeFile(path.join(imageDir(user.id),file),image.buffer,{mode:0o600});
    saved.push(db.images[id]={id,userId:user.id,prompt:params.prompt,model:config.model||config.dialect,size:params.size,file,mime:image.mime,bytes:image.buffer.length,source,createdAt:Date.now()});
  }
  const mine=Object.values(db.images).filter(item=>item.userId===user.id).sort((a,b)=>a.createdAt-b.createdAt);
  for(const old of mine.slice(0,Math.max(0,mine.length-IMAGE_LIMITS.perUserKeep))){delete db.images[old.id];rm(path.join(imageDir(user.id),old.file),{force:true}).catch(()=>{})}
  return saved;
}
async function generateForUser(user,body,source){
  const config=imageConfig();
  if(!config.enabled||!imageTarget(config))throw imageError('管理员还没有开启绘画功能',503);
  const params=cleanImageRequest(config,body);
  const over=quotaError(user);if(over)throw imageError(over,429);
  if(config.dailyLimit>0&&imageDayCount(user)+params.n>config.dailyLimit)throw imageError('今天的绘画张数已用完（每人每天 '+config.dailyLimit+' 张）',429);
  if(imagesBusy.has(user.id))throw imageError('上一张还在生成中，请稍候',409);
  imagesBusy.add(user.id);
  try{
    const images=await callImageApi(config,params);
    const saved=await saveImages(user,config,params,images,source);
    user.imageUsage={day:dayKey(),count:imageDayCount(user)+saved.length};
    recordUsage(user.id,null,config.model||config.dialect,'image');
    addAudit(db,{userId:user.id,action:'image.generate',target:params.prompt.slice(0,120),detail:(config.model||config.dialect)+' · '+params.size+' · '+saved.length+' 张 · '+source});
    await persist();
    return {saved,images};
  }catch(error){
    addAudit(db,{userId:user.id,action:'image.generate',target:params.prompt.slice(0,120),detail:error.message,ok:false});
    throw error;
  }finally{imagesBusy.delete(user.id)}
}
const safeImage=record=>({id:record.id,url:'/api/images/'+record.id+'/file',prompt:record.prompt,model:record.model,size:record.size,bytes:record.bytes,mime:record.mime,createdAt:record.createdAt});
// OpenAI 兼容的 POST /v1/images/generations：返回 b64_json（令牌调用没有 cookie，没法直接取图片文件）
// ---- 语音合成 / 朗读（实现见 tts.mjs）：服务商用 OpenAI 兼容的 /audio/speech；同一段重复朗读走内存缓存，不重复计费 ----
const ttsConfig=()=>({...defaultTtsConfig(),...(db.settings.tts||{})});
const ttsTarget=config=>{if(config.provider==='custom')return config.baseUrl?{baseUrl:config.baseUrl,apiKey:config.apiKey||''}:null;const item=config.provider==='builtin'?envProvider():db.providers[config.provider];return item?.baseUrl?{baseUrl:item.baseUrl,apiKey:item.apiKey||''}:null};
const ttsCache=new Map(),ttsBusy=new Map();let ttsCacheBytes=0;
const ttsDayChars=user=>user.ttsUsage?.day===dayKey()?user.ttsUsage.chars:0;
const ttsError=(message,status)=>Object.assign(new Error(message),{status});
async function requestSpeech(config,target,params){
  guardCheck(vendorOfUrl(target.baseUrl));
  const response=await upstreamFetch(speechEndpoint(target.baseUrl),{method:'POST',redirect:'error',signal:AbortSignal.timeout(TTS_LIMITS.apiTimeoutMs),headers:{'Content-Type':'application/json',Accept:'audio/*',...(target.apiKey?{Authorization:'Bearer '+target.apiKey}:{})},body:JSON.stringify(buildSpeechRequest(config,params))});
  if(!response.ok){const data=await response.json().catch(()=>null);const detail=String(data?.error?.message||data?.message||'').slice(0,200);throw ttsError('语音合成服务返回 HTTP '+response.status+(detail?'：'+detail:''),response.status===429?429:502)}
  if(Number(response.headers.get('content-length')||0)>TTS_LIMITS.maxBytes)throw ttsError('合成的音频太大',502);
  const buffer=Buffer.from(await response.arrayBuffer());
  if(buffer.length>TTS_LIMITS.maxBytes)throw ttsError('合成的音频太大',502);
  const kind=sniffAudio(buffer);if(!kind)throw ttsError('语音合成服务返回的不是音频',502);
  return {buffer,mime:kind.mime};
}
async function speakForUser(user,body){
  const config=ttsConfig(),target=ttsTarget(config);
  if(!config.enabled||!target)throw ttsError('管理员还没有开启语音朗读',503);
  const params=cleanSpeechRequest(config,body),chars=params.text.length,key=speechCacheKey(config,params);
  const hit=ttsCache.get(key);
  if(hit){ttsCache.delete(key);ttsCache.set(key,hit);return {...hit,chars,cached:true}}
  const over=quotaError(user);if(over)throw ttsError(over,429);
  if(config.dailyChars>0&&ttsDayChars(user)+chars>config.dailyChars)throw ttsError('今天的朗读字数已用完（每人每天 '+config.dailyChars+' 字）',429);
  if((ttsBusy.get(user.id)||0)>=2)throw ttsError('上一段还在合成，请稍等',429);
  ttsBusy.set(user.id,(ttsBusy.get(user.id)||0)+1);
  try{
    const audio=await requestSpeech(config,target,params);
    user.ttsUsage={day:dayKey(),chars:ttsDayChars(user)+chars};
    recordUsage(user.id,null,config.model,'tts');
    addAudit(db,{userId:user.id,action:'tts.speak',target:params.text.slice(0,60),detail:config.model+' · '+params.voice+' · '+chars+' 字'});
    ttsCache.set(key,audio);ttsCacheBytes+=audio.buffer.length;
    while(ttsCache.size>TTS_LIMITS.cacheEntries||ttsCacheBytes>TTS_LIMITS.cacheBytes){const [oldKey,old]=ttsCache.entries().next().value;ttsCache.delete(oldKey);ttsCacheBytes-=old.buffer.length}
    await persist();
    return {...audio,chars,cached:false};
  }catch(error){
    addAudit(db,{userId:user.id,action:'tts.speak',target:params.text.slice(0,60),detail:error.message,ok:false});
    throw error;
  }finally{const n=(ttsBusy.get(user.id)||1)-1;if(n>0)ttsBusy.set(user.id,n);else ttsBusy.delete(user.id)}
}
const sendAudio=(res,audio)=>{res.writeHead(200,{'Content-Type':audio.mime,'Content-Length':audio.buffer.length,'X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=3600','X-Tts-Chars':String(audio.chars),'X-Tts-Cached':audio.cached?'1':'0'});res.end(audio.buffer)};
// OpenAI 兼容的 POST /v1/audio/speech（文字转语音）与 /v1/audio/transcriptions（语音转文字，multipart 上传）
async function handleAudioApi(req,res,user,pathname){
  const fail=(status,message)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:{message,type:'invalid_request_error'}}))};
  const wait=hitWindowLimit(codeAttempts,'api:'+user.id,60,60*1000);
  if(wait)return fail(429,'请求过于频繁，请稍后再试');
  try{
    if(pathname==='/v1/audio/speech')return sendAudio(res,await speakForUser(user,await readBody(req,256*1024)));
    const config=asrConfig(),target=config.enabled?asrProviderTarget(config):null;
    if(!target)return fail(503,'管理员还没有开启语音识别');
    const over=quotaError(user);if(over)return fail(429,over);
    const raw=await readRaw(req,MAX_AUDIO_BYTES+512*1024),form=parseMultipart(raw,req.headers['content-type']);
    const file=form.files.find(item=>item.name==='file');
    if(!file||file.data.length<200)return fail(400,'缺少 file 字段，或没有录到声音');
    const mime=audioTypeOf(file);if(!AUDIO_TYPES.has(mime))return fail(415,'不支持的音频格式');
    if(file.data.length>MAX_AUDIO_BYTES)return fail(413,'音频过大（上限 '+Math.round(MAX_AUDIO_BYTES/1048576)+' MB）');
    const langId=ASR_LANGS.some(item=>item.id===form.fields.language)?form.fields.language:(config.defaultLang||'auto');
    if((asrBusy.get(user.id)||0)>=2)return fail(429,'上一段还在识别，请稍等');
    asrBusy.set(user.id,(asrBusy.get(user.id)||0)+1);
    try{
      const text=await asrTranscribe({...target,kind:config.kind,model:config.model,langId,audio:file.data,mime,hotwords:config.hotwords||''});
      recordUsage(user.id,null,config.model||'asr','asr');await persist();
      if(form.fields.response_format==='text'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});return res.end(text)}
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});return res.end(JSON.stringify({text}));
    }finally{const n=(asrBusy.get(user.id)||1)-1;if(n>0)asrBusy.set(user.id,n);else asrBusy.delete(user.id)}
  }catch(error){return fail(error.status||502,error.message||'语音服务失败')}
}
async function handleImagesApi(req,res,user){
  const fail=(status,message)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:{message,type:'invalid_request_error'}}))};
  const wait=hitWindowLimit(codeAttempts,'api:'+user.id,60,60*1000);
  if(wait)return fail(429,'请求过于频繁，请稍后再试');
  let body;try{body=await readBody(req,256*1024)}catch(error){return fail(error.status||400,error.message)}
  try{
    const {saved,images}=await generateForUser(user,{prompt:body.prompt,n:body.n,size:body.size},'api');
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    return res.end(JSON.stringify({created:Math.floor(Date.now()/1000),data:saved.map((record,index)=>({b64_json:images[index].buffer.toString('base64'),...(images[index].revised?{revised_prompt:images[index].revised}:{})}))}));
  }catch(error){return fail(error.status||502,error.message||'绘画失败')}
}
const safeConversation=item=>({id:item.id,title:item.title,createdAt:item.createdAt,updatedAt:item.updatedAt,agentId:item.agentId||null,model:item.model||null});

// ---- Cindy 桌面端的浏览器桌面（noVNC），仅管理员可访问 ----
// DESKTOP_VIEW_URL 例如 http://desktop:6080（见 docker-compose.desktop.yml）。未配置时整个功能关闭。
const desktopView=(()=>{try{const u=new URL(process.env.DESKTOP_VIEW_URL||'');return u.protocol==='http:'?{host:u.hostname,port:Number(u.port||80)}:null}catch{return null}})();
const DESKTOP_PREFIX='/desktop/';
async function desktopAllowed(req){
  if(!desktopView)return false;
  if(req.headers.origin&&!sameOrigin(req))return false;
  const session=await getSession(req);
  return Boolean(session&&session.user.role==='admin');
}
function desktopHttp(req,res,pathname,search){
  const upstream=http.request({host:desktopView.host,port:desktopView.port,method:req.method,path:'/'+pathname.slice(DESKTOP_PREFIX.length)+search,headers:{...req.headers,host:desktopView.host+':'+desktopView.port,cookie:'',authorization:''}},up=>{
    res.writeHead(up.statusCode||502,{...up.headers,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN'});up.pipe(res);
  });
  upstream.on('error',()=>{if(!res.headersSent)json(res,502,{error:'桌面端容器未运行或还没准备好'});else res.end()});
  req.pipe(upstream);
}
function desktopUpgrade(req,socket,head,pathname,search){
  const upstream=tcpConnect(desktopView.port,desktopView.host,()=>{
    const lines=[req.method+' /'+pathname.slice(DESKTOP_PREFIX.length)+search+' HTTP/1.1','Host: '+desktopView.host+':'+desktopView.port];
    for(const [key,value] of Object.entries(req.headers)){if(['host','cookie','authorization','origin'].includes(key))continue;lines.push(key+': '+value)}
    upstream.write(lines.join('\r\n')+'\r\n\r\n');if(head?.length)upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close=()=>{socket.destroy();upstream.destroy()};
  upstream.on('error',close);socket.on('error',close);socket.on('close',close);
}

const gzipCache=new Map();
const INVITE_PAGE=/^\/invite\/[A-Za-z0-9_-]{16,80}$/;
// 邀请记录放在 db.settings.invites（随 settings 一起加密存储）；令牌原文保存，方便管理员随时复制链接。
const inviteState=invite=>invite.revokedAt?'revoked':invite.expiresAt<=Date.now()?'expired':invite.uses>=invite.maxUses?'used':'active';
const findInvite=token=>Object.values(db.settings.invites||{}).find(item=>{const a=Buffer.from(item.token),b=Buffer.from(String(token));return a.length===b.length&&timingSafeEqual(a,b)});
const safeInvite=invite=>({id:invite.id,token:invite.token,note:invite.note||'',email:invite.email||'',maxUses:invite.maxUses,uses:invite.uses,expiresAt:invite.expiresAt,createdAt:invite.createdAt,state:inviteState(invite),dailyLimit:invite.limits.dailyLimit||0,monthlyCallLimit:invite.limits.monthlyCallLimit||0,monthlyTokenLimit:invite.limits.monthlyTokenLimit||0});

// 公开预览入口：靠链接里的签名放行（只读、12 小时过期、可撤销），页面在沙箱里运行
async function handlePreview(req,res,pathname){
  const plain=(status,text)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end(text)};
  if(req.method!=='GET')return plain(405,'只支持 GET');
  const match=pathname.match(/^\/preview\/([^/]+)(\/.*)?$/),claim=match&&verifyPreview(storeKey,match[1]),workspace=claim&&db.workspaces[claim.workspaceId];
  if(!workspace||(workspace.previewEpoch||0)!==claim.epoch)return plain(403,'预览链接无效或已过期，请回到 Yumeiro 重新生成。');
  if(!runnerEnabled)return plain(503,'智能体运行器不可用');
  const rel=previewPath((match[2]||'/').slice(1));
  if(!rel)return plain(404,'找不到文件');
  const fetchRaw=target=>runnerFetch('/raw?workspace='+workspace.id+'&path='+encodeURIComponent(target),{signal:AbortSignal.timeout(60000)});
  let upstream;try{upstream=await fetchRaw(rel)}catch{return plain(502,'无法连接运行器')}
  if(!upstream.ok&&!pathname.endsWith('/')){
    try{const index=await fetchRaw(rel+'/index.html');if(index.ok){await index.arrayBuffer();res.writeHead(302,{Location:pathname+'/','Cache-Control':'no-store'});return res.end()}}catch{/* 继续按 404 处理 */}
  }
  if(!upstream.ok){await upstream.arrayBuffer().catch(()=>{});return plain(upstream.status===413?413:404,upstream.status===413?'文件太大，无法预览':'找不到文件')}
  const type=mimeOf(rel);
  if(/\.(md|markdown)$/i.test(rel)){
    const text=Buffer.from(await upstream.arrayBuffer()).toString('utf8').slice(0,2*1024*1024);
    res.writeHead(200,previewHeaders('text/html; charset=utf-8'));return res.end(renderMarkdownPage(text,rel.split('/').pop()));
  }
  const headers=previewHeaders(type),length=upstream.headers.get('content-length');if(length)headers['Content-Length']=length;
  res.writeHead(200,headers);Readable.fromWeb(upstream.body).pipe(res);
}
const guideDay=new Map(),guideBusy=new Set(),petLineHits=new Map(),petSenseHits=new Map(),petStickerHits=new Map(),sideAiHits=new Map();
// 侧边栏的便签 / 待办 / 片段同步：每人一份，按 id 合并（u = 最后修改时间，删除记在 del），多台设备同时改不会互相覆盖。规则和 public/side-tools.js 的 mergeSide 一致。
function cleanSideData(input){
  const src=input&&typeof input==='object'?input:{};
  const num=(value,lo,hi)=>Number.isFinite(Number(value))?Math.max(lo,Math.min(hi,Number(value))):0;
  const str=(value,max)=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,' ').slice(0,max);
  const idOf=value=>{const id=String(value??'');return /^[a-z0-9_-]{3,24}$/i.test(id)?id:''};
  const list=(value,max)=>(Array.isArray(value)?value:[]).slice(0,max);
  const TS=4102444800000;
  const notes=list(src.notes,100).map(item=>({id:idOf(item?.id),title:str(item?.title,60).trim(),body:str(item?.body,20000),pin:Boolean(item?.pin),at:num(item?.at,0,TS),u:num(item?.u,0,TS)})).filter(item=>item.id);
  const todos=list(src.todos,500).map(item=>({id:idOf(item?.id),t:str(item?.t,200).trim(),done:Boolean(item?.done),da:num(item?.da,0,TS),pri:Math.round(num(item?.pri,0,2)),due:/^\d{4}-\d{2}-\d{2}$/.test(item?.due)?item.due:'',remind:/^\d{2}:\d{2}$/.test(item?.remind)?item.remind:'',asked:Boolean(item?.asked),group:str(item?.group,24).trim(),tags:list(item?.tags,5).map(tag=>str(tag,20).trim()).filter(Boolean),sub:list(item?.sub,30).map(sub=>({id:idOf(sub?.id),t:str(sub?.t,120).trim(),done:Boolean(sub?.done)})).filter(sub=>sub.id&&sub.t),o:num(item?.o,-1e9,1e9),at:num(item?.at,0,TS),u:num(item?.u,0,TS)})).filter(item=>item.id&&item.t);
  const snippets=list(src.snippets,100).map(item=>({id:idOf(item?.id),t:str(item?.t,2000),u:num(item?.u,0,TS)})).filter(item=>item.id&&item.t);
  const habits=list(src.habits,50).map(item=>({id:idOf(item?.id),name:str(item?.name,30).trim(),icon:str(item?.icon,8).trim(),pom:Math.round(num(item?.pom,0,16)),days:Array.from({length:7},(_,i)=>Array.isArray(item?.days)?item.days[i]!==false:true),remind:/^\d{2}:\d{2}$/.test(item?.remind)?item.remind:'',o:num(item?.o,-1e9,1e9),at:num(item?.at,0,TS),u:num(item?.u,0,TS)})).filter(item=>item.id&&item.name);
  const checks=list(src.checks,5000).map(item=>({id:idOf(item?.id),h:idOf(item?.h),day:/^\d{4}-\d{2}-\d{2}$/.test(item?.day)?item.day:'',v:item?.v?1:0,u:num(item?.u,0,TS)})).filter(item=>item.id&&item.h&&item.day);
  const sessions=list(src.sessions,1000).map(item=>({id:idOf(item?.id),day:/^\d{4}-\d{2}-\d{2}$/.test(item?.day)?item.day:'',min:Math.round(num(item?.min,0,180)),todo:idOf(item?.todo),at:num(item?.at,0,TS),u:num(item?.u,0,TS)})).filter(item=>item.id&&item.day&&item.min>0);
  const del={};for(const [id,ts] of Object.entries(src.del&&typeof src.del==='object'?src.del:{}).slice(0,1000))if(idOf(id))del[id]=num(ts,0,TS);
  return {notes,todos,snippets,sessions,habits,checks,del,u:num(src.u,0,TS)};
}
function mergeSideData(a,b,now=Date.now()){
  const del={};for(const source of [a.del,b.del])for(const [id,ts] of Object.entries(source||{}))if(ts>(del[id]||0))del[id]=ts;
  const out={del:{},u:Math.max(a.u||0,b.u||0)};
  for(const col of ['notes','todos','snippets','sessions','habits','checks']){
    const map=new Map();
    for(const item of [...(a[col]||[]),...(b[col]||[])]){const cur=map.get(item.id);if(!cur||(item.u||0)>(cur.u||0))map.set(item.id,item)}
    out[col]=[...map.values()].filter(item=>!(del[item.id]>=(item.u||0)));
    out[col].sort(col==='todos'||col==='habits'?(x,y)=>(x.o||0)-(y.o||0)||(y.at||0)-(x.at||0):(x,y)=>(y.u||0)-(x.u||0));
  }
  for(const [id,ts] of Object.entries(del))if(now-ts<=60*864e5)out.del[id]=ts;
  out.notes=out.notes.slice(0,100);out.todos=out.todos.slice(0,500);out.snippets=out.snippets.slice(0,100);
  out.sessions=out.sessions.filter(item=>now-(item.at||item.u||now)<120*864e5).slice(0,1000);
  out.habits=out.habits.slice(0,50);
  const alive=new Set(out.habits.map(item=>item.id)),cutoff=new Date(now-400*864e5).toISOString().slice(0,10);
  out.checks=out.checks.filter(item=>alive.has(item.h)&&item.day>=cutoff).slice(0,5000);          // 习惯已删 / 超过 400 天的打卡记录丢掉
  return out;
}
// 桌宠的情绪记忆：只存“发生过什么情绪事件”的短摘要（每条 ≤ 40 字）和好感度，每人一份，网页 / 桌面端共用。
// 清空用 clearedAt 表示（合并时早于它的事件一律丢弃），这样另一台设备上的旧副本不会把已忘掉的事写回来。
const PET_MEMORY_KINDS=new Set(['scold','praise','sad','comfort','error','repeat','sticker']);
function cleanPetMemory(input){
  const src=input&&typeof input==='object'?input:{},num=(value,lo,hi)=>Number.isFinite(Number(value))?Math.max(lo,Math.min(hi,Number(value))):0;
  const events=(Array.isArray(src.events)?src.events:[]).slice(0,60).map(item=>({t:num(item?.t,0,4102444800000),k:String(item?.k||''),v:Math.round(num(item?.v,-1,1)*100)/100,s:String(item?.s||'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,40),p:String(item?.p||'').replace(/[^a-z0-9:_.-]/gi,'').slice(0,30)})).filter(item=>item.t>0&&PET_MEMORY_KINDS.has(item.k));
  return {affinity:Math.round(num(src.affinity,-100,100)),events,at:num(src.at,0,4102444800000),clearedAt:num(src.clearedAt,0,4102444800000),lastSeen:num(src.lastSeen,0,4102444800000)};
}
function mergePetMemory(a,b){
  const clearedAt=Math.max(a.clearedAt||0,b.clearedAt||0),cutoff=Math.max(clearedAt,Date.now()-30*86400000),seen=new Set(),events=[];
  for(const item of [...(a.events||[]),...(b.events||[])].sort((x,y)=>y.t-x.t)){const key=item.t+'|'+item.k;if(item.t<=cutoff||seen.has(key))continue;seen.add(key);events.push(item);if(events.length>=40)break}
  const newer=(b.at||0)>=(a.at||0)?b:a;
  return {affinity:clearedAt>(newer.at||0)?0:(newer.affinity||0),events,at:Math.max(a.at||0,b.at||0),clearedAt,lastSeen:Math.max(a.lastSeen||0,b.lastSeen||0)};
}
function guideState(user){
  const asr=asrConfig(),tts=ttsConfig(),image=imageConfig();
  return {admin:user.role==='admin',personal:appMode()==='personal',model:modelCatalog(user).length>0,runner:runnerEnabled,asr:Boolean(asr.enabled),tts:Boolean(tts.enabled),images:Boolean(image.enabled),workspaces:Object.values(db.workspaces).filter(item=>workspaceFor(item.id,user)).length};
}

// ---- 图片理解：识图服务 / 把图片放进模型输入 ----
const visionConfig=()=>({...defaultVisionConfig(),...(db.settings.vision||{})});
const attachDir=userId=>path.join(dataDir,'attachments',userId);
const safeAttachment=item=>({id:item.id,name:item.name,mime:item.mime,bytes:item.bytes,...(item.kind==='doc'?{kind:'doc'}:{})});
const visionDay=new Map(),visionBusy=new Set();
async function callVision(config,buffer,mime){
  const {url,init}=buildVisionRequest(config,{buffer,mime,prompt:config.prompt});
  let response;
  try{response=await upstreamFetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(config.timeoutSec*1000)})}
  catch(error){throw Object.assign(new Error('无法连接识图服务：'+(error.cause?.code||error.name==='TimeoutError'&&'超时'||error.message)),{status:502})}
  if(!response.ok)throw Object.assign(new Error('识图服务返回 HTTP '+response.status),{status:502});
  const data=await response.json().catch(()=>null);
  if(data===null)throw Object.assign(new Error('识图服务返回的不是 JSON'),{status:502});
  return parseVisionResponse(config,data);
}
async function describeImage(user,record,config){
  const today=new Date().toISOString().slice(0,10),slot=visionDay.get(user.id),used=slot&&slot.day===today?slot.count:0,limit=Math.max(1,Number(process.env.VISION_DAILY_LIMIT)||300);
  if(used>=limit)throw Object.assign(new Error('今天的识图次数已用完（'+limit+' 次），请明天再试，或换一个能直接看图的模型'),{status:429});
  if(visionBusy.has(user.id))throw Object.assign(new Error('上一张图片还在识别中，请稍等'),{status:429});
  visionBusy.add(user.id);
  try{
    const result=await callVision(config,await readFile(path.join(attachDir(record.userId),record.file)),record.mime);
    visionDay.set(user.id,{day:today,count:used+1});
    if(result.usage)recordUsage(user.id,result.usage,'vision/'+(config.model||config.dialect),'vision');
    return result.text||'（没有识别出内容）';
  }finally{visionBusy.delete(user.id)}
}
// 文本类文件：最近 3 条带文件的消息把文件内容带给模型，更早的只留占位说明
async function withDocs(m,full){
  if(!full)return (m.content||'')+'\n[此处曾有 '+m.files.length+' 个文件（'+m.files.map(f=>f.name).join('、')+'），已省略]';
  const files=[];
  for(const f of m.files){
    const record=db.attachments[f.id];
    if(!record){files.push({name:f.name,text:'（文件已被删除）'});continue}
    const buffer=await readFile(path.join(attachDir(record.userId),record.file)).catch(()=>null);
    files.push({name:f.name,text:buffer?docText(buffer,Number(process.env.DOC_MAX_CHARS)||undefined):'（文件已丢失）'});
  }
  return docsPrompt(m.content||'',files,Number(process.env.DOC_MAX_TOTAL_CHARS)||undefined);
}
// 组装发给聊天模型的历史：最近 3 条带图的消息带图片（或识别文字），更早的只留占位说明
async function chatHistory(item,user,modelRef){
  const target=resolveModel(modelRef,user),config=visionConfig(),route=visionRoute(config,target?.model||modelRef);
  const slice=item.messages.slice(-contextMessages),keep=new Set();
  for(let i=slice.length-1;i>=0&&keep.size<3;i--)if(slice[i].role==='user'&&slice[i].images?.length)keep.add(slice[i]);
  const out=[];
  const keepDocs=new Set();
  for(let i=slice.length-1;i>=0&&keepDocs.size<3;i--)if(slice[i].role==='user'&&slice[i].files?.length)keepDocs.add(slice[i]);
  for(const m0 of slice){
    const m=m0.role==='user'&&m0.files?.length?{...m0,content:await withDocs(m0,keepDocs.has(m0))}:m0;
    if(m.role!=='user'||!m.images?.length){out.push({role:m.role,content:m.content});continue}
    if(!keep.has(m0)){out.push({role:m.role,content:(m.content||'')+'\n[此处曾有 '+m.images.length+' 张图片，已省略]'});continue}
    const records=m.images.map(image=>db.attachments[image.id]);
    if(records.every(record=>!record)){out.push({role:m.role,content:(m.content||'')+'\n[图片已被删除]'});continue}
    if(route==='direct'){
      const images=[];for(const record of records)if(record)images.push({url:dataUrl(record.mime,await readFile(path.join(attachDir(record.userId),record.file)))});
      out.push({role:m.role,content:imageParts(m.content,images)});
    }else if(route==='service'){
      const descriptions=[];
      for(const [index,image] of m.images.entries()){
        if(!records[index]){descriptions.push('（图片已删除）');continue}
        if(!image.desc)image.desc=await describeImage(user,records[index],config);
        descriptions.push(image.desc);
      }
      out.push({role:m.role,content:describedText(m.content,descriptions)});
    }else out.push({role:m.role,content:(m.content||'')+'\n[含图片，但当前没有可用的看图方式]'});
  }
  return out;
}

// ---- 远程控制：被控端代理（Windows / Mac）通过出站 HTTP 与服务器通信 ----
const remotePairs=new Map(),remoteRuntime=new Map(),remotePairFails=new Map();
function remoteRt(id){
  let rt=remoteRuntime.get(id);
  if(!rt){rt={frame:null,seq:0,w:0,h:0,sw:0,sh:0,viewerAt:0,viewAuditAt:0,frameWaiters:new Set(),queue:[],poll:null,sentWatching:false,caps:{control:false},stats:{events:0,keys:0,textChars:0,clicks:0},statsAt:0,rate:{at:0,n:0}};remoteRuntime.set(id,rt)}
  return rt;
}
const remoteOnline=device=>Date.now()-(device.lastSeen||0)<REMOTE_LIMITS.offlineMs;
const remoteWatching=rt=>Date.now()-rt.viewerAt<REMOTE_LIMITS.viewerIdleMs;
const safeRemoteDevice=device=>{const rt=remoteRt(device.id);return {id:device.id,name:device.name,os:device.os,osLabel:OS_LABELS[device.os]||device.os||'',hostname:device.hostname||'',online:remoteOnline(device),lastSeen:device.lastSeen||0,pairedAt:device.pairedAt,allowControl:Boolean(device.allowControl),agentControl:Boolean(rt.caps.control),screen:rt.sw?{w:rt.sw,h:rt.sh}:null,watching:remoteWatching(rt)}};
function remoteDrop(id){
  const rt=remoteRuntime.get(id);if(!rt)return;
  if(rt.poll){clearTimeout(rt.poll.timer);try{json(rt.poll.res,401,{error:'设备已被取消配对'})}catch{}rt.poll=null}
  for(const waiter of rt.frameWaiters){clearTimeout(waiter.timer);try{waiter.res.writeHead(204,{'X-Online':'0'});waiter.res.end()}catch{}}
  remoteRuntime.delete(id);
}
function remotePollReply(res,device,rt){
  rt.sentWatching=remoteWatching(rt);
  json(res,200,{watching:rt.sentWatching,fps:3,quality:55,maxWidth:1280,allowControl:Boolean(device.allowControl),commands:device.allowControl?rt.queue.splice(0,100):(rt.queue.length=0,[])});
}
function remoteWake(rt){
  if(!rt.poll)return;
  const poll=rt.poll;rt.poll=null;clearTimeout(poll.timer);
  const device=db.remoteDevices[poll.deviceId];
  if(device)remotePollReply(poll.res,device,rt);else json(poll.res,401,{error:'设备已被取消配对'});
}
const remoteHeaders=(device,rt)=>({'Cache-Control':'no-store','X-Online':remoteOnline(device)?'1':'0','X-Control':device.allowControl&&rt.caps.control?'1':'0','X-Screen-Width':String(rt.sw||0),'X-Screen-Height':String(rt.sh||0)});
function remoteSendFrame(res,device,rt){
  res.writeHead(200,{...remoteHeaders(device,rt),'Content-Type':'image/jpeg','Content-Length':rt.frame.length,'X-Seq':String(rt.seq),'X-Width':String(rt.w),'X-Height':String(rt.h),'X-Content-Type-Options':'nosniff'});
  res.end(rt.frame);
}
function remoteNoFrame(res,device,rt){if(!res.writableEnded&&!res.headersSent){res.writeHead(204,remoteHeaders(device,rt));res.end()}}
function remoteFlushFrameWaiters(rt,device,empty=false){
  for(const waiter of [...rt.frameWaiters]){
    if(empty||(rt.frame&&rt.seq>waiter.since)){rt.frameWaiters.delete(waiter);clearTimeout(waiter.timer);if(empty)remoteNoFrame(waiter.res,device,rt);else remoteSendFrame(waiter.res,device,rt)}
  }
}
async function handleRemoteAgent(req,res,pathname,url){
  const ip=clientIp(req);
  if(pathname==='/remote/agent/pair'&&req.method==='POST'){
    const fails=remotePairFails.get(ip);
    if(fails&&Date.now()-fails.at<10*60*1000&&fails.n>=10)return json(res,429,{error:'尝试次数太多，请 10 分钟后再试'});
    const body=await readBody(req,16*1024),code=normalizePairCode(body.code),pair=code&&remotePairs.get(code);
    if(!pair||pair.expires<Date.now()){remotePairFails.set(ip,{n:(fails&&Date.now()-fails.at<10*60*1000?fails.n:0)+1,at:fails&&Date.now()-fails.at<10*60*1000?fails.at:Date.now()});return json(res,400,{error:'配对码无效或已过期，请回到网页重新生成'})}
    remotePairs.delete(code);
    const owner=db.users[pair.ownerId];
    if(!owner||owner.disabled)return json(res,400,{error:'账号不可用'});
    if(Object.values(db.remoteDevices).filter(item=>item.ownerId===owner.id).length>=REMOTE_LIMITS.maxDevices)return json(res,400,{error:'设备数量已达上限'});
    const token='rda_'+randomBytes(32).toString('base64url'),device={id:randomUUID(),ownerId:owner.id,name:pair.name||cleanDeviceName(body.name)||cleanDeviceName(body.hostname)||'我的电脑',os:String(body.os||'').slice(0,12),hostname:cleanDeviceName(body.hostname),tokenHash:sha(token),pairedAt:Date.now(),lastSeen:Date.now(),allowControl:Boolean(pair.control)};
    db.remoteDevices[device.id]=device;remoteRt(device.id).caps.control=Boolean(body.caps?.control);
    addAudit(db,{userId:owner.id,action:'remote.pair',target:device.name,detail:(OS_LABELS[device.os]||device.os)+(device.allowControl?' · 允许控制':' · 仅查看'),ip});await persist();
    return json(res,201,{deviceId:device.id,token,name:device.name,allowControl:device.allowControl});
  }
  const bearer=/^Bearer (rda_[\w-]{20,})$/.exec(req.headers.authorization||''),hash=bearer&&sha(bearer[1]);
  const device=hash&&Object.values(db.remoteDevices).find(item=>item.tokenHash===hash);
  if(!device)return json(res,401,{error:'设备未配对或已被取消'});
  const rt=remoteRt(device.id);device.lastSeen=Date.now();
  if(pathname==='/remote/agent/poll'&&req.method==='GET'){
    rt.caps.control=url.searchParams.get('control')==='1';
    const wait=Math.min(25,Math.max(0,Number(url.searchParams.get('wait'))||0))*1000;
    if(rt.poll)remoteWake(rt);
    if(!wait||(device.allowControl&&rt.queue.length)||remoteWatching(rt)!==rt.sentWatching)return remotePollReply(res,device,rt);
    const poll={res,deviceId:device.id,timer:setTimeout(()=>{if(rt.poll===poll){rt.poll=null;remotePollReply(res,db.remoteDevices[device.id]||device,rt)}},wait)};
    rt.poll=poll;res.on('close',()=>{clearTimeout(poll.timer);if(rt.poll===poll)rt.poll=null});return;
  }
  if(pathname==='/remote/agent/frame'&&req.method==='POST'){
    const data=await readRaw(req,REMOTE_LIMITS.frameMaxBytes);
    if(!isJpeg(data))return json(res,400,{error:'不是 JPEG 图片'});
    const num=name=>Math.max(0,Math.min(20000,Math.floor(Number(req.headers[name])||0)));
    rt.frame=data;rt.w=num('x-width');rt.h=num('x-height');rt.sw=num('x-screen-width')||rt.w;rt.sh=num('x-screen-height')||rt.h;rt.seq++;
    remoteFlushFrameWaiters(rt,device);
    return json(res,200,{ok:true,watching:remoteWatching(rt)});
  }
  return json(res,404,{error:'未找到'});
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://'+(req.headers.host||'localhost'));
    const pathname=url.pathname;
    if(pathname.startsWith('/remote/agent/'))return handleRemoteAgent(req,res,pathname,url);
    if(pathname.startsWith('/preview/'))return handlePreview(req,res,pathname);
    if(pathname.startsWith('/v1/'))return handleV1(req,res,pathname);
    if(pathname.startsWith('/bot/'))return handleBot(req,res,pathname);
    if(pathname.startsWith(DESKTOP_PREFIX)){
      if(!await desktopAllowed(req))return json(res,desktopView?403:404,{error:desktopView?'仅管理员可以打开桌面端':'未启用桌面端'});
      return desktopHttp(req,res,pathname,url.search);
    }
    // 桌面端“软件更新”：版本信息来自桌面端容器里的更新状态服务（只在容器内网，用 desktop_key 鉴权）
    if((pathname==='/api/admin/desktop/update'||pathname==='/api/admin/desktop/versions')&&(req.method==='GET'||req.method==='POST')){
      const viewer=await getSession(req);
      if(!viewer||viewer.user.role!=='admin')return json(res,403,{error:'仅主账号可以执行此操作'});
      if(!desktopView)return json(res,200,{enabled:false});
      if(req.method==='POST'&&!validCsrf(req,viewer))return json(res,403,{error:'安全校验失败，请刷新页面后重试'});
      let base=null,key='';
      try{base=new URL(process.env.DESKTOP_STATUS_URL||'');key=readFileSync(process.env.DESKTOP_KEY_FILE||'','utf8').trim()}catch{}
      if(!base||base.protocol!=='http:'||!key)return json(res,200,{enabled:true,reachable:false,reason:'not-configured'});
      try{
        let target=req.method==='POST'?'/check':(pathname.endsWith('/versions')?'/versions':'/status'),picked='',pickedVersion='latest';
        if(req.method==='POST'){const body=await readBody(req,4096).catch(()=>({}));if(body.flavor!==undefined){if(body.flavor!=='global'&&body.flavor!=='cn')return json(res,400,{error:'版本只能选 国际版（global）或 国内版（cn）'});picked=body.flavor;if(body.version!==undefined&&body.version!=='latest'){if(!/^\d+\.\d+\.\d+$/.test(String(body.version)))return json(res,400,{error:'版本号格式不对，应为 latest 或 0.1.136 这样的数字'});pickedVersion=String(body.version)}target='/switch?flavor='+picked+'&version='+encodeURIComponent(pickedVersion)}}
        const r=await fetch(new URL(target,base),{method:req.method,headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(8000)});
        const data=await r.json().catch(()=>({}));
        if(req.method==='POST'){
          if(r.status===409)return json(res,409,{error:data.error||'正在检查或下载更新，请稍后'});
          if(!r.ok)return json(res,502,{error:data.error||'桌面端没有响应'});
          await recordSecurityEvent('desktop_update_check',req,viewer.user.id,picked?{flavor:picked,version:pickedVersion}:{});
          return json(res,202,{started:true});
        }
        if(!r.ok)return json(res,200,{enabled:true,reachable:false,reason:'http-'+r.status});
        return json(res,200,{enabled:true,reachable:true,status:data});
      }catch{return json(res,200,{enabled:true,reachable:false,reason:'unreachable'})}
    }
    if(pathname==='/api/admin/desktop'&&req.method==='GET'){
      const viewer=await getSession(req);
      if(!viewer||viewer.user.role!=='admin')return json(res,403,{error:'仅主账号可以执行此操作'});
      return json(res,200,{enabled:Boolean(desktopView),url:'/desktop/vnc.html?autoconnect=1&resize=scale&path=desktop/websockify'});
    }
    if((req.method==='GET'||req.method==='HEAD')&&!pathname.startsWith('/api/')){
      const download=pathname.startsWith('/downloads/')?await findDownload(pathname.slice(11)):null;
      if(pathname.startsWith('/downloads/')&&!download)return json(res,404,{error:'下载文件暂不可用（管理员还没有上传安装包）'});
      if(download){
        const filePath=download.file;
        const info={size:download.size};
        let start=0,end=info.size-1,status=200;
        const range=String(req.headers.range||'');
        if(range){
          const match=/^bytes=(\d*)-(\d*)$/.exec(range);
          if(!match)return res.writeHead(416,{'Content-Range':`bytes */${info.size}`}).end();
          if(match[1]===''){const suffix=Number(match[2]);if(!suffix)return res.writeHead(416,{'Content-Range':`bytes */${info.size}`}).end();start=Math.max(0,info.size-suffix)}
          else start=Number(match[1]);
          if(match[2]!==''&&match[1]!=='')end=Math.min(info.size-1,Number(match[2]));
          if(start>=info.size||end<start)return res.writeHead(416,{'Content-Range':`bytes */${info.size}`}).end();
          status=206;
        }
        const headers={'Content-Type':download.type,'Content-Length':String(end-start+1),'Content-Disposition':`attachment; filename="${download.name}"`,'Accept-Ranges':'bytes','Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'};
        if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;
        res.writeHead(status,headers);
        if(req.method==='HEAD')return res.end();
        const stream=createReadStream(filePath,{start,end});stream.on('error',()=>res.destroy());stream.pipe(res);return;
      }
      const file=INVITE_PAGE.test(pathname)?{name:'invite.html',type:'text/html; charset=utf-8',html:true}:staticFiles[pathname==='/'?'/index.html':pathname];
      if(!file)return json(res,404,{error:'未找到'});
      let body=await readFile(path.join(root,'public',file.name));
      // 设置页：服务器直接在 <html> 上加 settings-boot，页面一出来就隐藏登录壳/应用壳，不依赖后面才加载的脚本
      if(file.html&&/^\/(admin\/)?settings$|^\/(market|workspaces)$/.test(pathname)){body=Buffer.from(body.toString('utf8').replace('<html lang="zh-CN">','<html lang="zh-CN" class="settings-boot">'))}
      // 登录态由服务器在返回 HTML 时就确定：已登录的请求直接把登录壳藏起来，浏览器不会再“先画登录页、等脚本确认后再切走”。
      // 3 秒后兜底移除，万一会话在这几秒里失效，登录页仍会出来。
      if(file.html&&file.name==='index.html'&&await getSession(req)){
        body=Buffer.from(body.toString('utf8').replace('<html lang="zh-CN"',()=>'<html lang="zh-CN" data-authed="1"').replace('</head>',()=>'<style>html[data-authed] #loginShell{display:none!important}</style><script>setTimeout(function(){document.documentElement.removeAttribute("data-authed")},3000)</script></head>'));
      }
      // 带 ETag 的协商缓存 + gzip：慢速链路（例如小带宽云主机）上，页面脚本体积直接决定白屏多久
      const etag='"'+createHash('sha1').update(body).digest('base64url').slice(0,22)+'"';
      if(req.headers['if-none-match']===etag){res.writeHead(304,{ETag:etag,'Cache-Control':'no-cache'});return res.end()}
      const gz=String(req.headers['accept-encoding']||'').includes('gzip');
      let payload=body;
      if(gz){let hit=gzipCache.get(etag);if(!hit){hit=gzipSync(body,{level:9});gzipCache.set(etag,hit);if(gzipCache.size>64)gzipCache.delete(gzipCache.keys().next().value)}payload=hit}
      res.writeHead(200,{
        'Content-Type':file.type,'Cache-Control':'no-cache',ETag:etag,Vary:'Accept-Encoding, Cookie',...(gz?{'Content-Encoding':'gzip'}:{}),
        'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY',
        ...(file.html?{'Content-Security-Policy':"default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; frame-src https: https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"}:{})
      });
      return res.end(req.method==='HEAD'?undefined:payload);
    }
    if(req.method==='GET'&&pathname==='/api/downloads')return json(res,200,await listDownloads());
    if(req.method==='GET'&&pathname==='/api/site'){
      const site=db.settings.site||{};
      return json(res,200,{mode:appMode(),name:site.name||'',notice:site.notice||'',adminRestricted:currentAdminPolicy().adminAllowedIps.length>0});
    }
    const inviteApi=pathname.match(/^\/api\/invite\/([A-Za-z0-9_-]{16,80})(\/accept)?$/);
    if(inviteApi){
      const invite=findInvite(inviteApi[1]);
      if(rateLimited(req,'invite'))return json(res,429,{error:'尝试过多，请稍后再试'});
      if(!invite){recordFailedAdminLogin(req,'invite');return json(res,404,{error:'邀请链接无效，请向管理员重新索取'})}
      const state=inviteState(invite);
      if(req.method==='GET'&&!inviteApi[2]){
        const site=db.settings.site||{};
        return json(res,200,{state,email:invite.email||'',note:invite.note||'',siteName:site.name||'',expiresAt:invite.expiresAt});
      }
      if(req.method==='POST'&&inviteApi[2]){
        if(state!=='active')return json(res,410,{error:state==='used'?'这个邀请已被使用完':state==='expired'?'这个邀请已过期':'这个邀请已被撤销'});
        const body=await readBody(req),email=String(invite.email||body.email||'').trim().toLowerCase(),password=String(body.password||'');
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return json(res,400,{error:'邮箱格式无效'});
        if(password.length<12||password.length>200)return json(res,400,{error:'密码至少 12 个字符'});
        if(Object.values(db.users).some(user=>user.email===email))return json(res,409,{error:'该邮箱已注册，请直接登录'});
        const user={id:randomUUID(),email,displayName:String(body.displayName||'').trim().slice(0,60)||email,passwordHash:await hashPassword(password),role:'member',authType:'local',...invite.limits,createdAt:Date.now(),createdBy:invite.createdBy,inviteId:invite.id};
        db.users[user.id]=user;invite.uses+=1;(invite.usedBy||=[]).push({userId:user.id,at:Date.now()});user.lastLoginAt=Date.now();
        try{const result=await issueAppSession(res,user);await persist();await recordSecurityEvent('member_joined_by_invite',req,user.id,{inviteId:invite.id});return json(res,201,result)}
        catch(error){delete db.users[user.id];invite.uses-=1;invite.usedBy.pop();return json(res,error.status||429,{error:error.message})}
      }
    }
    if(req.method==='GET'&&pathname==='/api/health'){const viewer=await getSession(req);return json(res,200,{ok:true,status:'ok',modelConfigured:modelCatalog(viewer?.user).length>0})}
    if(!pathname.startsWith('/api/'))return json(res,404,{error:'未找到'});
    if(req.method!=='GET'&&(!sameOrigin(req)||(pathname.startsWith('/api/cindy/')&&!req.headers.origin)))return json(res,403,{error:'来源校验失败'});
    if(req.method==='GET'&&pathname==='/api/cindy/callback'){
      const state=url.searchParams.get('client_state')||url.searchParams.get('state')||'',pending=pendingCindySocial.get(state),challenge=cookieValue(req,'ym_challenge');
      const fail=()=>{setChallengeCookie(res,'',0);res.writeHead(303,{Location:'/?panel=cindy&cindy_error=login_failed','Cache-Control':'no-store'});res.end()};
      if(!pending||pending.expiresAt<Date.now()||!challenge||pending.challengeHash!==sha(challenge)||url.searchParams.get('error')){pendingCindySocial.delete(state);return fail()}
      const code=String(url.searchParams.get('code')||'');if(!code){pendingCindySocial.delete(state);return fail()}
      pendingCindySocial.delete(state);
      try{
        const outcome=await cindyAuthRequest(pending.region,'/api/auth/token',{grantType:'authorization_code',code,codeVerifier:pending.codeVerifier,deviceId:pending.deviceId});
        if(outcome.status==='ok'){await bindCindyAccount(req,pending.userId,pending.region,outcome);setChallengeCookie(res,'',0);res.writeHead(303,{Location:'/?panel=cindy&cindy_bound=1','Cache-Control':'no-store'});return res.end()}
        if(outcome.status==='select_account'){const challengeId=randomUUID();pendingCindyLogins.set(challengeId,{userId:pending.userId,region:pending.region,deviceId:pending.deviceId,challengeHash:sha(challenge),expiresAt:Date.now()+10*60*1000,loginTicket:outcome.loginTicket,accounts:outcome.accounts});res.writeHead(303,{Location:'/?panel=cindy&cindy_select='+encodeURIComponent(challengeId),'Cache-Control':'no-store'});return res.end()}
        return fail();
      }catch{return fail()}
    }
    if(req.method==='GET'&&pathname==='/api/auth/session'){
      const session=await getSession(req);
      return json(res,200,session?{authenticated:true,...safeUser(session.user),mode:appMode(),csrfToken:session.record.csrfToken}:{authenticated:false});
    }
    if(req.method==='GET'&&pathname==='/api/cindy/providers'){
      if(!await bindAuth(req,res))return;
      const region=url.searchParams.get('region')||'';if(!authRegions[region])return json(res,400,{error:'请选择有效的登录区域'});
      try{
        const providers=await getCindyProviders(region),redirectUri=callbackUri(req);
        const status=redirectUri&&providers.social.length?await socialStatus(region,providers,redirectUri):{};
        return json(res,200,{...providers,redirectUri,socialAvailable:providers.social.filter(item=>status[item]!=='blocked'),socialBlocked:providers.social.filter(item=>status[item]==='blocked')});
      }catch(error){return json(res,error.status||502,{error:'无法连接该区域的 Cindy 登录服务，请稍后重试'})}
    }
    if(req.method==='GET'&&pathname==='/api/cindy/select-account'){
      if(!await bindAuth(req,res))return;
      const challengeId=url.searchParams.get('challengeId')||'',pending=pendingCindyLogins.get(challengeId),challenge=cookieValue(req,'ym_challenge');
      if(!pending?.loginTicket||pending.expiresAt<Date.now()||pending.challengeHash!==sha(challenge||''))return json(res,410,{error:'账号选择已过期，请重新登录'});
      return json(res,200,{accounts:(pending.accounts||[]).map(item=>({id:item.id,displayName:item.displayName,kind:item.kind,orgName:item.orgName,role:item.role}))});
    }
    if(req.method==='POST'&&pathname==='/api/cindy/social/start'){
      const bindSession=await bindAuth(req,res);if(!bindSession)return;
      const body=await readBody(req),region=String(body.region||''),provider=String(body.provider||''),providers=await getCindyProviders(region);
      if(!providers.social.includes(provider))return json(res,400,{error:'此区域不支持该登录方式'});
      const state=randomBytes(32).toString('base64url'),challengeToken=randomBytes(32).toString('base64url'),codeVerifier=randomBytes(32).toString('base64url'),codeChallenge=createHash('sha256').update(codeVerifier).digest('base64url'),deviceId=randomUUID();
      const redirectUri=callbackUri(req);if(!redirectUri)return json(res,400,{error:'登录回调地址无效'});
      if((await socialStatus(region,providers,redirectUri))[provider]==='blocked')return json(res,409,{error:'Cindy 官方服务没有放行本站的回调地址（'+redirectUri+'），第三方登录暂不可用。请使用验证码登录。',code:'INVALID_REDIRECT_URI'});
      const authorizeUrl=new URL(authRegions[region].baseUrl+`/api/auth/social/${encodeURIComponent(provider)}/authorize`);
      authorizeUrl.search=new URLSearchParams({client_type:'web',device_id:deviceId,redirect_uri:redirectUri,code_challenge:codeChallenge,code_challenge_method:'S256',client_state:state,ui_locale:region==='cn'?'zh-CN':'en'}).toString();
      for(const [key,item]of pendingCindySocial)if(item.expiresAt<Date.now())pendingCindySocial.delete(key);
      pendingCindySocial.set(state,{userId:bindSession.user.id,region,provider,deviceId,codeVerifier,challengeHash:sha(challengeToken),expiresAt:Date.now()+10*60*1000});setChallengeCookie(res,challengeToken,600);return json(res,200,{authorizeUrl:authorizeUrl.toString()});
    }
    if(req.method==='POST'&&pathname==='/api/cindy/request-code'){
      const bindSession=await bindAuth(req,res);if(!bindSession)return;
      const body=await readBody(req),region=String(body.region||''),identifier=String(body.identifier||'').trim(),providers=await getCindyProviders(region),kind=providers.attribution;
      if(!providers[kind]||!identifier||identifier.length>254)return json(res,400,{error:'账号格式无效或该区域暂不支持此登录方式'});
      if(kind==='phone'&&!/^\+?[0-9 ()-]{7,24}$/.test(identifier))return json(res,400,{error:'请输入有效的手机号码'});
      if(kind==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier))return json(res,400,{error:'请输入有效的邮箱地址'});
      const key=sha(region+'|'+kind+'|'+identifier.toLowerCase()),ipKey=sha(clientIp(req));
      const wait=Math.max(hitWindowLimit(codeAttempts,'send-ip:'+ipKey,5,15*60*1000),hitWindowLimit(codeAttempts,'send-id:'+key,3,15*60*1000));
      if(wait)return json(res,429,{error:'验证码请求过于频繁，请稍后再试',retryAfterSeconds:wait});
      const captchaToken=String(body.captchaToken||'');
      if(providers.captcha?.requiredFor?.includes(kind+'_request_code')&&!captchaToken)return json(res,400,{error:'请先完成安全验证'});
      try{
        await cindyAuthRequest(region,`/api/auth/${kind}/request-code`,{[kind]:identifier,locale:region==='cn'?'zh-CN':'en',...(captchaToken?{captchaToken}:{})});
        for(const [id,item]of pendingCindyLogins)if(item.expiresAt<Date.now())pendingCindyLogins.delete(id);
        const challengeId=randomUUID(),challengeToken=randomBytes(32).toString('base64url');
        pendingCindyLogins.set(challengeId,{userId:bindSession.user.id,region,kind,identifier,deviceId:randomUUID(),challengeHash:sha(challengeToken),expiresAt:Date.now()+10*60*1000,attempts:0});
        setChallengeCookie(res,challengeToken,600);return json(res,200,{sent:true,challengeId,expiresInSeconds:600});
      }catch(error){const failure=authFailure(error,'验证码发送失败，请确认账号后重试');return json(res,failure.status,{error:failure.message,code:failure.code})}
    }
    if(req.method==='POST'&&pathname==='/api/cindy/verify-code'){
      const bindSession=await bindAuth(req,res);if(!bindSession)return;
      const body=await readBody(req),challengeId=String(body.challengeId||''),code=String(body.code||'').trim(),pending=pendingCindyLogins.get(challengeId),challenge=cookieValue(req,'ym_challenge');
      if(!pending||pending.userId!==bindSession.user.id||pending.expiresAt<Date.now()||!challenge||pending.challengeHash!==sha(challenge)){pendingCindyLogins.delete(challengeId);setChallengeCookie(res,'',0);return json(res,410,{error:'验证已过期，请重新获取验证码'})}
      if(!/^\d{4,10}$/.test(code))return json(res,400,{error:'验证码格式无效'});
      const attemptWait=hitWindowLimit(codeAttempts,'verify:'+challengeId,6,10*60*1000);if(attemptWait)return json(res,429,{error:'验证码尝试过多，请重新获取验证码'});
      pending.attempts++;
      try{
        const outcome=await cindyAuthRequest(pending.region,`/api/auth/${pending.kind}/verify-code`,{[pending.kind]:pending.identifier,code,deviceId:pending.deviceId,clientType:'web',locale:pending.region==='cn'?'zh-CN':'en'});
        if(outcome.status==='ok'){pendingCindyLogins.delete(challengeId);setChallengeCookie(res,'',0);return json(res,200,{bound:true,account:await bindCindyAccount(req,pending.userId,pending.region,outcome)})}
        if(outcome.status==='select_account'){pending.loginTicket=outcome.loginTicket;pending.accounts=outcome.accounts;return json(res,200,{status:'select_account',accounts:outcome.accounts.map(item=>({id:item.id,displayName:item.displayName,kind:item.kind,orgName:item.orgName,role:item.role}))})}
        if(outcome.status==='binding_required'){pendingCindyLogins.delete(challengeId);setChallengeCookie(res,'',0);return json(res,409,{error:'此账号需要先在 Cindy 官方客户端完成账号绑定'})}
        pendingCindyLogins.delete(challengeId);setChallengeCookie(res,'',0);return json(res,409,{error:'该登录方式暂不支持此账号，请尝试 Cindy 官方客户端'})
      }catch(error){if(pending.attempts>=6){pendingCindyLogins.delete(challengeId);setChallengeCookie(res,'',0)}if(error.local)return json(res,error.status,{error:error.message});const status=error.status===429?429:error.status===400?401:502;return json(res,status,{error:status===429?'验证码尝试过多，请稍后重试':status===401?'验证码不正确或已过期':'Cindy 登录服务暂不可用，请稍后重试'})}
    }
    if(req.method==='POST'&&pathname==='/api/cindy/select-account'){
      const bindSession=await bindAuth(req,res);if(!bindSession)return;
      const body=await readBody(req),challengeId=String(body.challengeId||''),accountId=String(body.accountId||''),pending=pendingCindyLogins.get(challengeId),challenge=cookieValue(req,'ym_challenge');
      if(!pending?.loginTicket||pending.userId!==bindSession.user.id||pending.expiresAt<Date.now()||pending.challengeHash!==sha(challenge||''))return json(res,410,{error:'账号选择已过期，请重新绑定'});
      if(!pending.accounts.some(item=>item.id===accountId))return json(res,400,{error:'所选账号无效'});
      try{const outcome=await cindyAuthRequest(pending.region,'/api/auth/select-account',{loginTicket:pending.loginTicket,accountId});if(outcome.status!=='ok')return json(res,409,{error:'Cindy 账号选择未完成'});pendingCindyLogins.delete(challengeId);setChallengeCookie(res,'',0);return json(res,200,{bound:true,account:await bindCindyAccount(req,pending.userId,pending.region,outcome)})}catch(error){if(error.local)return json(res,error.status,{error:error.message});return json(res,502,{error:'Cindy 登录服务暂不可用，请稍后重试'})}
    }
    if(req.method==='POST'&&pathname==='/api/auth/login'){
      const body=await readBody(req),email=String(body.email||'').trim().toLowerCase(),password=String(body.password||'');
      if(rateLimited(req,email))return json(res,429,{error:'管理员登录尝试过多，请稍后再试'});
      const policy=currentAdminPolicy(),ip=clientIp(req);
      const user=Object.values(db.users).find(item=>item.email===email&&item.passwordHash);
      // IP 允许列表只约束主账号；团队成员不受限。
      if(user?.role==='admin'&&policy.adminAllowedIps.length&&!policy.adminAllowedIps.includes(ip)){await recordSecurityEvent('admin_ip_blocked',req,null,{accountHash:sha(email).slice(0,10)});return json(res,403,{error:'当前网络地址不在管理员允许列表中'});}
      const passwordOk=await verifyPassword(password,user?.passwordHash||'');
      if(!user||!passwordOk){recordFailedAdminLogin(req,email);await recordSecurityEvent('login_failed',req,null,{accountHash:sha(email).slice(0,10)});return json(res,401,{error:'邮箱或密码不正确'})}
      if(user.disabled)return json(res,403,{error:'此账号已被主账号停用'});
      const portal=body.portal==='admin'||body.portal==='member'?body.portal:null;
      if(portal==='admin'&&user.role!=='admin')return json(res,403,{error:'这个账号不是管理员，请从成员入口登录'});
      if(portal==='member'&&user.role==='admin')return json(res,403,{error:'管理员请从管理员入口登录（地址后面加 /admin）'});
      resetAdminLoginFailures(req,email);user.lastLoginAt=Date.now();
      try{const result=await issueAppSession(res,user);await recordSecurityEvent('login_success',req,user.id);return json(res,200,result)}catch(error){return json(res,error.status||429,{error:error.message})}
    }
    // ---- 管理员忘记密码：恢复密钥 / 手机确认（只对管理员账号有效）----
    if(pathname.startsWith('/api/auth/recover/')){
      const route=pathname.slice('/api/auth/recover/'.length),ip=clientIp(req);
      const adminByEmail=email=>Object.values(db.users).find(item=>item.email===email&&item.passwordHash&&item.role==='admin'&&!item.disabled);
      const ipAllowed=()=>{const policy=currentAdminPolicy();return !(policy.adminAllowedIps.length&&!policy.adminAllowedIps.includes(ip))};
      if(route==='key'&&req.method==='POST'){
        const body=await readBody(req),email=String(body.email||'').trim().toLowerCase(),key=normalizeRecoveryKey(body.key),newPassword=String(body.newPassword||''),limitKey=ip+'|'+email;
        if(recoverLimiter.blocked(limitKey)||recoverLimiter.blocked(ip+'|*'))return json(res,429,{error:'尝试次数太多，请 15 分钟后再试'});
        const user=adminByEmail(email),ok=Boolean(user&&key&&user.recovery?.hash&&await verifyPassword(key,user.recovery.hash));
        if(!ok){recoverLimiter.fail(limitKey);recoverLimiter.fail(ip+'|*');await recordSecurityEvent('recover_key_failed',req,null,{accountHash:sha(email).slice(0,10)});return json(res,401,{error:'邮箱或恢复密钥不正确'})}
        const problem=passwordProblem(newPassword);if(problem)return json(res,400,{error:problem});
        if(!ipAllowed())return json(res,403,{error:'当前网络地址不在管理员允许列表内'});
        user.passwordHash=await hashPassword(newPassword);
        const fresh=newRecoveryKey();user.recovery={hash:await hashPassword(fresh.raw),createdAt:Date.now()}; // 用过的恢复密钥立即作废，换一把新的
        for(const [k,v]of Object.entries(db.sessions))if(v.userId===user.id)delete db.sessions[k];
        recoverLimiter.reset(limitKey);user.lastLoginAt=Date.now();
        try{const result=await issueAppSession(res,user);await recordSecurityEvent('recover_key_used',req,user.id);return json(res,200,{...result,newRecoveryKey:fresh.display})}catch(error){return json(res,error.status||429,{error:error.message})}
      }
      if(route==='phone/start'&&req.method==='POST'){
        if(recoverStartLimiter.blocked(ip))return json(res,429,{error:'发起太频繁，请稍后再试'});
        recoverStartLimiter.fail(ip);
        const email=String((await readBody(req)).email||'').trim().toLowerCase(),user=adminByEmail(email),started=phoneStore.start(user?user.id:null,{ip,ua:req.headers['user-agent']});
        if(user)await recordSecurityEvent('recover_phone_started',req,user.id);
        return json(res,201,started);
      }
      if(route==='phone/status'&&req.method==='GET')return json(res,200,phoneStore.status(url.searchParams.get('id')));
      if(route==='phone/finish'&&req.method==='POST'){
        const body=await readBody(req),status=phoneStore.status(body.id).status,newPassword=body.newPassword===undefined||body.newPassword===''?'':String(body.newPassword);
        if(status!=='approved')return json(res,409,{error:status==='denied'?'手机上拒绝了这次请求':'手机还没有批准，或请求已过期，请重新发起'});
        if(newPassword&&passwordProblem(newPassword))return json(res,400,{error:passwordProblem(newPassword)});
        if(!ipAllowed())return json(res,403,{error:'当前网络地址不在管理员允许列表内'});
        const userId=phoneStore.consume(body.id),user=userId&&db.users[userId];
        if(!user||user.disabled||user.role!=='admin')return json(res,409,{error:'请求已失效'});
        if(newPassword){user.passwordHash=await hashPassword(newPassword);for(const [k,v]of Object.entries(db.sessions))if(v.userId===user.id)delete db.sessions[k]}
        user.lastLoginAt=Date.now();
        try{const result=await issueAppSession(res,user);await recordSecurityEvent(newPassword?'recover_phone_password':'recover_phone_login',req,user.id);return json(res,200,result)}catch(error){return json(res,error.status||429,{error:error.message})}
      }
      return json(res,404,{error:'未找到'});
    }
    const session=await getSession(req);
    if(!session)return json(res,401,{error:'请先登录'});
    if(req.method!=='GET'&&!validCsrf(req,session))return json(res,403,{error:'安全校验过期，请刷新页面后重试'});
    if(req.method==='GET'&&pathname==='/api/admin/overview'){
      if(session.user.role!=='admin')return json(res,403,{error:'仅管理员可以查看管理面板'});
      const today=new Date(),days=[];
      for(let offset=6;offset>=0;offset--){const d=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()-offset));const date=d.toISOString().slice(0,10);const items=db.usage.filter(item=>new Date(item.at).toISOString().slice(0,10)===date);days.push({date,calls:items.length,inputTokens:items.reduce((sum,item)=>sum+(item.inputTokens||0),0),outputTokens:items.reduce((sum,item)=>sum+(item.outputTokens||0),0),reportedCalls:items.filter(item=>Number.isFinite(item.totalTokens)).length})}
      const usage=db.usage.filter(item=>item.at>=Date.now()-30*24*60*60*1000);
      return json(res,200,{policy:currentAdminPolicy(),clientIp:clientIp(req),activeAdminSessions:sessionCount(session.user.id),users:Object.values(db.users).filter(user=>user.authType==='cindy').map(user=>({...safeUser(user),activeSessions:sessionCount(user.id)})),usage:{days,calls:usage.length,reportedCalls:usage.filter(item=>Number.isFinite(item.totalTokens)).length,inputTokens:usage.reduce((sum,item)=>sum+(item.inputTokens||0),0),outputTokens:usage.reduce((sum,item)=>sum+(item.outputTokens||0),0),recent:usage.slice(-30).reverse().map(item=>({at:item.at,model:item.model,inputTokens:item.inputTokens,outputTokens:item.outputTokens,totalTokens:item.totalTokens}))},events:db.security.events.slice(-50).reverse().map(item=>({type:item.type,at:item.at,ip:item.ip,userId:item.userId,region:item.region}))});
    }
    if(req.method==='PATCH'&&pathname==='/api/admin/policy'){
      if(session.user.role!=='admin')return json(res,403,{error:'仅管理员可以修改登录限制'});
      const body=await readBody(req),ips=Array.isArray(body.adminAllowedIps)?body.adminAllowedIps.map(value=>String(value).trim()).filter(Boolean):[];
      const maxFailedAttempts=Number(body.maxFailedAttempts),windowMinutes=Number(body.windowMinutes),maxSessions=Number(body.maxSessions);
      if(ips.length>50||ips.some(value=>isIP(value)===0)||!Number.isInteger(maxFailedAttempts)||maxFailedAttempts<3||maxFailedAttempts>20||!Number.isInteger(windowMinutes)||windowMinutes<5||windowMinutes>60||!Number.isInteger(maxSessions)||maxSessions<1||maxSessions>20)return json(res,400,{error:'登录策略参数无效'});
      if(ips.length&&!ips.includes(clientIp(req)))return json(res,400,{error:'允许列表必须包含当前管理员 IP，避免锁定自己'});
      db.security.loginPolicy={adminAllowedIps:[...new Set(ips)],maxFailedAttempts,windowMinutes,maxSessions};loginAttempts.clear();await persist();await recordSecurityEvent('admin_policy_updated',req,session.user.id);
      return json(res,200,{policy:currentAdminPolicy()});
    }
    const userPolicyMatch=pathname.match(/^\/api\/admin\/users\/([0-9a-f-]+)\/enabled$/i);
    if(userPolicyMatch&&req.method==='PATCH'){
      if(session.user.role!=='admin')return json(res,403,{error:'仅管理员可以管理账号'});
      const body=await readBody(req),user=db.users[userPolicyMatch[1]];if(!user||user.authType!=='cindy')return json(res,404,{error:'Cindy 账号不存在'});
      if(typeof body.enabled!=='boolean')return json(res,400,{error:'enabled 必须是布尔值'});
      user.disabled=!body.enabled;if(user.disabled){user.cindyCredentials=null;for(const [key,value]of Object.entries(db.sessions))if(value.userId===user.id)delete db.sessions[key]}
      await persist();await recordSecurityEvent(user.disabled?'cindy_user_disabled':'cindy_user_enabled',req,session.user.id,{targetUserId:user.id});return json(res,200,{user:safeUser(user)});
    }
    const isAdmin=session.user.role==='admin',adminOnly=()=>json(res,403,{error:'仅主账号可以执行此操作'});
    // ---- 账号安全（管理员）：恢复密钥管理 + 手机批准“忘记密码”请求 ----
    if(pathname==='/api/security/recovery'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      return json(res,200,{hasKey:Boolean(session.user.recovery?.hash),createdAt:session.user.recovery?.createdAt||null,pending:phoneStore.pendingFor(session.user.id),minPassword:RECOVERY.minPasswordLength,localPassword:Boolean(session.user.passwordHash)});
    }
    if(pathname==='/api/security/recovery-key'&&(req.method==='POST'||req.method==='DELETE')){
      if(!isAdmin)return adminOnly();
      const body=await readBody(req),limitKey='pw|'+session.user.id;
      if(!session.user.passwordHash)return json(res,400,{error:'此账号使用 Cindy 登录，没有本地密码'});
      if(recoverLimiter.blocked(limitKey))return json(res,429,{error:'密码输错次数太多，请 15 分钟后再试'});
      if(!(await verifyPassword(String(body.password||''),session.user.passwordHash))){recoverLimiter.fail(limitKey);return json(res,400,{error:'当前密码不正确'})}
      recoverLimiter.reset(limitKey);
      if(req.method==='DELETE'){delete session.user.recovery;await persist();await recordSecurityEvent('recovery_key_deleted',req,session.user.id);return json(res,200,{ok:true})}
      const fresh=newRecoveryKey();session.user.recovery={hash:await hashPassword(fresh.raw),createdAt:Date.now()};
      await persist();await recordSecurityEvent('recovery_key_created',req,session.user.id);
      return json(res,200,{key:fresh.display,createdAt:session.user.recovery.createdAt});
    }
    if(pathname==='/api/security/phone-approve'&&req.method==='POST'){
      if(!isAdmin)return adminOnly();
      const body=await readBody(req),approve=body.approve!==false,decided=phoneStore.decide(session.user.id,body.code,approve);
      if(!decided)return json(res,404,{error:'没有找到这个验证码对应的请求（可能已过期，或不是这个账号发起的）'});
      await recordSecurityEvent(approve?'recover_phone_approved':'recover_phone_denied',req,session.user.id,{from:decided.ip});
      return json(res,200,{ok:true,status:decided.status,ip:decided.ip,ua:decided.ua});
    }
    // AI 服务商接入（管理员）与可用模型列表（所有登录用户）
    if(pathname==='/api/models'&&req.method==='GET'&&(refreshCindyModelsInBackground(session.user)||true))return json(res,200,{models:modelCatalog(session.user),defaultModel:defaultModelRef(session.user)});
    if(pathname==='/api/admin/providers'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      return json(res,200,{providers:Object.values(db.providers).sort((a,b)=>a.createdAt-b.createdAt).map(safeProvider),builtin:modelConfigured?{baseUrl:modelBase,models:envModels}:null,templates:providerTemplates,defaultModel:db.settings.defaultModel||'',effectiveDefault:defaultModelRef()});
    }
    if(pathname==='/api/admin/providers'&&req.method==='POST'){
      if(!isAdmin)return adminOnly();
      if(Object.keys(db.providers).length>=30)return json(res,400,{error:'服务商数量已达上限'});
      const provider=buildProvider(await readBody(req),null);
      db.providers[provider.id]=provider;await persist();await recordSecurityEvent('provider_created',req,session.user.id,{slug:provider.slug});
      return json(res,201,{provider:safeProvider(provider)});
    }
    if(pathname==='/api/admin/providers/probe'&&req.method==='POST'){
      if(!isAdmin)return adminOnly();
      const body=await readBody(req),existing=body.id?db.providers[String(body.id)]:null;
      if(body.id&&!existing)return json(res,404,{error:'服务商不存在'});
      let baseUrl;try{baseUrl=normalizeBaseUrl(body.baseUrl||existing?.baseUrl)}catch(error){return json(res,400,{error:error.message})}
      return json(res,200,await probeProvider({baseUrl,apiKey:String(body.apiKey||'').trim()||existing?.apiKey||'',model:String(body.model||'').trim()||undefined}));
    }
    const providerMatch=pathname.match(/^\/api\/admin\/providers\/([0-9a-f-]+)$/i);
    if(providerMatch&&(req.method==='PATCH'||req.method==='DELETE')){
      if(!isAdmin)return adminOnly();
      const provider=db.providers[providerMatch[1]];
      if(!provider)return json(res,404,{error:'服务商不存在'});
      if(req.method==='DELETE'){
        delete db.providers[provider.id];
        if(String(db.settings.defaultModel||'').startsWith(provider.slug+'/'))db.settings.defaultModel='';
        await persist();await recordSecurityEvent('provider_deleted',req,session.user.id,{slug:provider.slug});return json(res,200,{ok:true});
      }
      Object.assign(provider,buildProvider(await readBody(req),provider));
      if(db.settings.defaultModel&&!resolveModel(db.settings.defaultModel))db.settings.defaultModel='';
      await persist();await recordSecurityEvent('provider_updated',req,session.user.id,{slug:provider.slug});
      return json(res,200,{provider:safeProvider(provider)});
    }
    if(pathname==='/api/admin/settings'&&req.method==='PUT'){
      if(!isAdmin)return adminOnly();
      const body=await readBody(req),wanted=String(body.defaultModel||'');
      if(wanted&&!resolveModel(wanted))return json(res,400,{error:'默认模型不可用，请先接入并启用对应服务商'});
      db.settings.defaultModel=wanted;await persist();return json(res,200,{defaultModel:wanted,effectiveDefault:defaultModelRef()});
    }
    // 团队成员（仅主账号）
    if(pathname==='/api/admin/members'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      return json(res,200,{members:Object.values(db.users).filter(user=>user.passwordHash).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)).map(safeMember)});
    }
    if(pathname==='/api/admin/members'&&req.method==='POST'){
      if(!isAdmin)return adminOnly();
      if(appMode()==='personal')return personalOnly(res);
      const body=await readBody(req),email=String(body.email||'').trim().toLowerCase(),password=String(body.password||''),limits=readLimits(body);
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return json(res,400,{error:'邮箱格式无效'});
      if(password.length<12||password.length>200)return json(res,400,{error:'成员初始密码至少 12 个字符'});
      if(Object.values(db.users).some(user=>user.email===email))return json(res,409,{error:'该邮箱已存在'});
      const user={id:randomUUID(),email,displayName:String(body.displayName||'').trim().slice(0,60)||email,passwordHash:await hashPassword(password),role:"member",authType:"local",...limits,createdAt:Date.now(),createdBy:session.user.id};
      db.users[user.id]=user;await persist();await recordSecurityEvent('member_created',req,session.user.id,{targetUserId:user.id});
      return json(res,201,{member:safeMember(user)});
    }
    if(pathname==='/api/admin/invites'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      return json(res,200,{invites:Object.values(db.settings.invites||{}).sort((a,b)=>b.createdAt-a.createdAt).map(safeInvite)});
    }
    if(pathname==='/api/admin/invites'&&req.method==='POST'){
      if(!isAdmin)return adminOnly();
      if(appMode()==='personal')return personalOnly(res);
      const body=await readBody(req),limits=readLimits(body);
      const email=String(body.email||'').trim().toLowerCase();
      if(email&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254))return json(res,400,{error:'邮箱格式无效'});
      const days=Number(body.expiresInDays??7),maxUses=Number(body.maxUses??1);
      if(!Number.isInteger(days)||days<1||days>90)return json(res,400,{error:'有效期必须是 1–90 天'});
      if(!Number.isInteger(maxUses)||maxUses<1||maxUses>100)return json(res,400,{error:'可用次数必须是 1–100'});
      const invites=db.settings.invites||={};
      if(Object.values(invites).filter(item=>inviteState(item)==='active').length>=200)return json(res,400,{error:'有效邀请已达上限（200），请先撤销一些'});
      const invite={id:randomUUID(),token:randomBytes(24).toString('base64url'),note:String(body.note||'').trim().slice(0,80),email,limits,maxUses,uses:0,expiresAt:Date.now()+days*86400000,createdAt:Date.now(),createdBy:session.user.id};
      invites[invite.id]=invite;await persist();await recordSecurityEvent('invite_created',req,session.user.id,{inviteId:invite.id});
      return json(res,201,{invite:safeInvite(invite)});
    }
    const inviteAdmin=pathname.match(/^\/api\/admin\/invites\/([0-9a-f-]+)$/i);
    if(inviteAdmin&&req.method==='DELETE'){
      if(!isAdmin)return adminOnly();
      const invite=(db.settings.invites||{})[inviteAdmin[1]];if(!invite)return json(res,404,{error:'邀请不存在'});
      delete db.settings.invites[invite.id];await persist();await recordSecurityEvent('invite_deleted',req,session.user.id,{inviteId:invite.id});
      return json(res,200,{ok:true});
    }
    const memberMatch=pathname.match(/^\/api\/admin\/members\/([0-9a-f-]+)$/i);
    if(memberMatch&&(req.method==='PATCH'||req.method==='DELETE')){
      if(!isAdmin)return adminOnly();
      const user=db.users[memberMatch[1]];
      if(!user||!user.passwordHash||user.role==='admin')return json(res,404,{error:'成员不存在'});
      if(req.method==='DELETE'){removeUserData(user.id);delete db.users[user.id];await persist();await recordSecurityEvent('member_deleted',req,session.user.id,{targetUserId:user.id});return json(res,200,{ok:true})}
      const body=await readBody(req);
      if(body.disabled!==undefined){if(typeof body.disabled!=='boolean')return json(res,400,{error:'disabled 必须是布尔值'});user.disabled=body.disabled}
      if(body.displayName!==undefined)user.displayName=String(body.displayName).trim().slice(0,60)||user.email;
      Object.assign(user,readLimits(body));
      if(body.password!==undefined){const password=String(body.password);if(password.length<12||password.length>200)return json(res,400,{error:'密码至少 12 个字符'});user.passwordHash=await hashPassword(password)}
      if(user.disabled||body.password!==undefined)for(const [key,value]of Object.entries(db.sessions))if(value.userId===user.id)delete db.sessions[key];
      await persist();await recordSecurityEvent('member_updated',req,session.user.id,{targetUserId:user.id});
      return json(res,200,{member:safeMember(user)});
    }
    // 用量统计
    const usageRow=(user,key)=>({id:user.id,email:user.email,displayName:user.displayName||user.email,role:user.role,disabled:Boolean(user.disabled),...quotaView(user),todayCalls:dailyCalls(user.id),...monthStat(user.id,key)});
    if(pathname==='/api/usage/me'&&req.method==='GET'){
      const user=session.user,history=Object.entries(db.stats[user.id]?.months||{}).sort().slice(-6).map(([month,value])=>({month,calls:value.calls,totalTokens:value.totalTokens}));
      return json(res,200,{month:monthKey(),usage:usageRow(user,monthKey()),history,blocked:quotaError(user),alerts:quotaAlerts(user),warnPercent});
    }
    if(pathname==='/api/admin/usage'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      const key=url.searchParams.get('month')||monthKey();
      if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(key))return json(res,400,{error:'month 格式应为 YYYY-MM'});
      const rows=Object.values(db.users).filter(user=>user.passwordHash).map(user=>usageRow(user,key)).sort((a,b)=>b.totalTokens-a.totalTokens||b.calls-a.calls);
      const months=[...new Set(Object.values(db.stats).flatMap(item=>Object.keys(item.months)).concat(monthKey()))].sort().reverse();
      return json(res,200,{month:key,months,rows,totals:{calls:rows.reduce((s,r)=>s+r.calls,0),totalTokens:rows.reduce((s,r)=>s+r.totalTokens,0),unreportedCalls:rows.reduce((s,r)=>s+r.unreportedCalls,0)}});
    }
    // 智能体引擎（Claude Code / Codex / Pi）：主管理员配置；成员只看到被放行且已安装的
    if(pathname==='/api/engines'&&req.method==='GET'){
      const health=await runnerHealth();
      return json(res,200,{runner:runnerEnabled,ok:Boolean(health?.ok),engines:availableEngines(session.user,health).map(engine=>{const config=engineConfig(engine);return {engine,label:ENGINE_LABELS[engine],maxMode:config.maxMode==='edit'?'edit':'readonly',family:ENGINE_HINTS[engine].family,defaultModel:config.model||'',models:[...new Set([config.model,...(config.models||[])].filter(Boolean))]}})});
    }
    if(pathname==='/api/admin/engines'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      const health=await runnerHealth(true);
      return json(res,200,{runner:runnerEnabled,runnerError:runnerEnabled&&!health?.ok?(health?.error||'运行器不可用'):null,engines:ENGINES.map(engine=>safeEngine(engine,health))});
    }
    if(pathname==='/api/admin/mcp'){
      if(!isAdmin)return adminOnly();
      if(req.method==='GET')return json(res,200,{servers:maskMcpServers(db.settings.mcp)});
      if(req.method==='PUT'){
        const body=await readBody(req,256*1024);let servers;
        try{servers=cleanMcpServers(body.servers,db.settings.mcp||[])}catch(error){return json(res,error.status||400,{error:error.message})}
        db.settings.mcp=servers;await persist();await recordSecurityEvent('mcp_updated',req,session.user.id,{count:servers.length});
        return json(res,200,{servers:maskMcpServers(servers)});
      }
    }
    // ---- MCP 市场：内置目录 + 官方注册表搜索；只有管理员能装，安装按服务器端的条目生成配置（页面不能自己塞命令）----
    if((pathname==='/api/admin/mcp/market'&&req.method==='GET')||(pathname==='/api/admin/mcp/market/install'&&req.method==='POST')){
      if(!isAdmin)return adminOnly();
      if(req.method==='GET'){
        const q=String(url.searchParams.get('q')||'').trim().slice(0,80),wantRegistry=url.searchParams.get('registry')==='1';
        const health=await runnerHealth().catch(()=>null),tools=health?.tools||null;
        let registry=[],registryError='';
        if(wantRegistry){
          try{
            const key=q.toLowerCase(),hit=mcpRegistryCache.get(key);
            registry=hit&&Date.now()-hit.at<600000?hit.items:await searchRegistry(q,{base:process.env.MCP_REGISTRY_URL||REGISTRY_BASE});
            mcpRegistryCache.set(key,{at:Date.now(),items:registry});if(mcpRegistryCache.size>50)mcpRegistryCache.delete(mcpRegistryCache.keys().next().value);
            for(const item of registry)mcpMarketItems.set(item.id,item);
            while(mcpMarketItems.size>600)mcpMarketItems.delete(mcpMarketItems.keys().next().value);
          }catch(error){registryError='无法访问官方 MCP 注册表（服务器需要能连上 registry.modelcontextprotocol.io）：'+(error.cause?.code||error.message)}
        }
        return json(res,200,{builtin:MCP_BUILTIN.filter(item=>mcpMatches(item,q)).map(item=>mcpPublicItem(item,tools)),registry:registry.map(item=>mcpPublicItem(item,tools)),registryError,runner:{enabled:runnerEnabled,ok:Boolean(health?.ok),tools},existing:(db.settings.mcp||[]).map(server=>server.name)});
      }
      const body=await readBody(req,64*1024),item=MCP_BUILTIN.find(entry=>entry.id===body.id)||mcpMarketItems.get(String(body.id||''));
      if(!item)return json(res,404,{error:'这个条目不存在，或者搜索结果已过期，请重新搜索'});
      if(!item.supported)return json(res,400,{error:item.reason||'这个服务暂不支持'});
      let built;try{built=buildMcpServer(item,body.values&&typeof body.values==='object'?body.values:{})}catch(error){return json(res,error.status||400,{error:error.message})}
      const current=db.settings.mcp||[],name=mcpSlug(body.name||item.name);
      if(current.some(server=>server.name===name))return json(res,409,{error:'已经有名为 '+name+' 的 MCP 服务了，换个名字再添加'});
      let servers;
      // 内置目录的条目直接启用；注册表里的第三方服务添加后先不启用，管理员到“MCP 服务”页确认后再勾选启用
      try{servers=cleanMcpServers([...current,{name,command:built.command,args:built.args,env:built.env,engines:MCP_ENGINES,enabled:item.source==='builtin'}],current)}catch(error){return json(res,error.status||400,{error:error.message})}
      db.settings.mcp=servers;await persist();await recordSecurityEvent('mcp_market_install',req,session.user.id,{id:item.id,name});
      return json(res,201,{server:maskMcpServers(servers).find(server=>server.name===name),enabled:item.source==='builtin'});
    }
    const engineMatch=pathname.match(/^\/api\/admin\/engines\/(claude|codex|pi)$/);
    if(engineMatch&&req.method==='PUT'){
      if(!isAdmin)return adminOnly();
      const engine=engineMatch[1],body=await readBody(req),current=engineConfig(engine);
      let baseUrl=current.baseUrl||'';
      if(body.baseUrl!==undefined){const wanted=String(body.baseUrl).trim();try{baseUrl=wanted?normalizeBaseUrl(wanted):''}catch(error){return json(res,400,{error:error.message})}}
      const typedKey=body.apiKey===undefined?'':String(body.apiKey).trim();
      const provider=body.provider===undefined?current.provider||'':String(body.provider).trim().toLowerCase();
      if(provider&&!/^[a-z0-9-]{1,40}$/.test(provider))return json(res,400,{error:'provider 只能用小写字母、数字和连字符'});
      const model=body.model===undefined?current.model||'':String(body.model).trim().slice(0,200);
      const models=body.models===undefined?(current.models||[]):cleanModels(body.models).filter(item=>/^[A-Za-z0-9._:\/-]{1,120}$/.test(item)).slice(0,50);
      db.settings.engines||={};
      db.settings.engines[engine]={enabled:typeof body.enabled==='boolean'?body.enabled:Boolean(current.enabled),membersAllowed:typeof body.membersAllowed==='boolean'?body.membersAllowed:Boolean(current.membersAllowed),maxMode:body.maxMode==='edit'?'edit':body.maxMode==='readonly'?'readonly':(current.maxMode||'readonly'),apiKey:typedKey||current.apiKey||'',baseUrl,provider,model,models};
      await persist();await recordSecurityEvent('engine_updated',req,session.user.id,{engine});
      return json(res,200,{engine:safeEngine(engine,await runnerHealth())});
    }

    // 工作区：一组成员共享的项目目录（文件在运行器里）+ 多智能体协作记录
    if(pathname==='/api/workspaces'&&req.method==='GET')return json(res,200,{runner:runnerEnabled,workspaces:Object.values(db.workspaces).filter(item=>workspaceFor(item.id,session.user)).sort((a,b)=>b.createdAt-a.createdAt).map(item=>safeWorkspace(item,session.user))});
    if(pathname==='/api/workspaces'&&req.method==='POST'){
      if(Object.values(db.workspaces).filter(item=>item.ownerId===session.user.id).length>=20)return json(res,400,{error:'工作区数量已达上限（20）'});
      const name=String((await readBody(req)).name||'').trim().slice(0,60);
      if(!name)return json(res,400,{error:'请填写工作区名称'});
      const workspace={id:randomUUID(),ownerId:session.user.id,name,memberIds:[],createdAt:Date.now()};
      db.workspaces[workspace.id]=workspace;addAudit(db,{userId:session.user.id,action:'workspace.create',target:name,ip:clientIp(req)});await persist();return json(res,201,{workspace:safeWorkspace(workspace,session.user)});
    }
    const workspaceMatch=pathname.match(/^\/api\/workspaces\/([0-9a-f-]+)$/i);
    if(workspaceMatch&&(req.method==='PATCH'||req.method==='DELETE')){
      const workspace=workspaceFor(workspaceMatch[1],session.user);
      if(!workspace)return json(res,404,{error:'工作区不存在'});
      if(!canManageWorkspace(workspace,session.user))return json(res,403,{error:'只有创建者或主账号可以管理工作区'});
      if(req.method==='DELETE'){
        for(const [key,run]of Object.entries(db.runs))if(run.workspaceId===workspace.id)delete db.runs[key];
        delete db.workspaces[workspace.id];addAudit(db,{userId:session.user.id,action:'workspace.delete',target:workspace.name,detail:'工作区文件备份保留在服务器 .versions 目录',ip:clientIp(req)});await persist();
        if(runnerEnabled)runnerFetch('/workspace?workspace='+workspace.id,{method:'DELETE',signal:AbortSignal.timeout(10000)}).catch(()=>{});
        return json(res,200,{ok:true});
      }
      const body=await readBody(req);
      if(body.name!==undefined){const name=String(body.name).trim().slice(0,60);if(!name)return json(res,400,{error:'名称不能为空'});workspace.name=name}
      if(body.members!==undefined){
        const emails=[...new Set((Array.isArray(body.members)?body.members:[]).map(item=>String(item).trim().toLowerCase()).filter(Boolean))];
        if(emails.length>20)return json(res,400,{error:'成员最多 20 人'});
        const ids=[];
        for(const email of emails){const user=Object.values(db.users).find(item=>item.email===email&&!item.disabled);if(!user)return json(res,400,{error:'找不到成员账号：'+email});if(user.id!==workspace.ownerId)ids.push(user.id)}
        workspace.memberIds=ids;
      }
      await persist();return json(res,200,{workspace:safeWorkspace(workspace,session.user)});
    }
    // 工作区文件搜索（文件名 + 可选的文件内容），结果里有匹配的行号与片段，高亮由前端做
    const searchMatch=req.method==='GET'&&pathname.match(/^\/api\/workspaces\/([0-9a-f-]+)\/search$/i);
    if(searchMatch){
      const workspace=workspaceFor(searchMatch[1],session.user);
      if(!workspace)return json(res,404,{error:'工作区不存在'});
      if(!runnerEnabled)return json(res,503,{error:'还没有安装智能体运行器，工作区文件暂不可用'});
      const q=String(url.searchParams.get('q')||'').trim();
      if(!q||q.length>100)return json(res,400,{error:'搜索词需要 1–100 个字符'});
      try{const upstream=await runnerFetch('/search?workspace='+workspace.id+'&q='+encodeURIComponent(q)+'&content='+(url.searchParams.get('content')==='1'?'1':'0'),{signal:AbortSignal.timeout(30000)});return json(res,upstream.status,await upstream.json().catch(()=>({error:'运行器响应无效'})))}
      catch(error){return json(res,error.status||502,{error:error.status?error.message:'无法连接运行器'})}
    }
    const filesMatch=pathname.match(/^\/api\/workspaces\/([0-9a-f-]+)\/files$/i);
    if(filesMatch){
      const workspace=workspaceFor(filesMatch[1],session.user);
      if(!workspace)return json(res,404,{error:'工作区不存在'});
      if(!runnerEnabled)return json(res,503,{error:'还没有安装智能体运行器，工作区文件暂不可用'});
      const rel=url.searchParams.get('path')||'',query='?workspace='+workspace.id+'&path='+encodeURIComponent(rel);
      try{
        if(req.method==='GET'){const upstream=await runnerFetch('/files'+query,{signal:AbortSignal.timeout(15000)});return json(res,upstream.status,await upstream.json().catch(()=>({error:'运行器响应无效'})))}
        if(req.method==='PUT'){
          const content=String((await readBody(req,1100*1024)).content??'');
          if(!rel)return json(res,400,{error:'请填写文件路径'});
          addAudit(db,{userId:session.user.id,action:'file.write',target:rel,detail:'工作区 '+workspace.name+' · '+content.length+' 字符',ip:clientIp(req)});
          const upstream=await runnerFetch('/files'+query,{method:'PUT',body:content,signal:AbortSignal.timeout(15000)});
          return json(res,upstream.status,await upstream.json().catch(()=>({})));
        }
        if(req.method==='DELETE'){
          if(!canManageWorkspace(workspace,session.user))return json(res,403,{error:'只有创建者或主账号可以删除文件'});
          addAudit(db,{userId:session.user.id,action:'file.delete',target:rel,detail:'工作区 '+workspace.name+'（删除前已备份）',ip:clientIp(req)});await persist();
          const upstream=await runnerFetch('/files'+query,{method:'DELETE',signal:AbortSignal.timeout(15000)});
          return json(res,upstream.status,await upstream.json().catch(()=>({})));
        }
      }catch(error){return json(res,error.status||502,{error:error.status?error.message:'无法连接运行器'})}
    }
    const transfer=pathname.match(/^\/api\/workspaces\/([0-9a-f-]+)\/(upload|download)$/i);
    if(transfer){
      const workspace=workspaceFor(transfer[1],session.user),action=transfer[2].toLowerCase();
      if(!workspace)return json(res,404,{error:'工作区不存在'});
      if(!runnerEnabled)return json(res,503,{error:'还没有安装智能体运行器，工作区文件暂不可用'});
      const rel=url.searchParams.get('path')||'';
      if(!rel)return json(res,400,{error:'请填写文件路径'});
      const query='?workspace='+workspace.id+'&path='+encodeURIComponent(rel);
      try{
        if(action==='upload'&&req.method==='PUT'){
          const data=await readRaw(req,uploadLimit);
          const upstream=await runnerFetch('/files'+query,{method:'PUT',body:data,signal:AbortSignal.timeout(120000)});
          const result=await upstream.json().catch(()=>({}));
          if(!upstream.ok)return json(res,upstream.status,{error:result.error||'上传失败'});
          addAudit(db,{userId:session.user.id,action:'file.upload',target:rel,detail:'工作区 '+workspace.name+' · '+data.length+' 字节（覆盖前已备份）',ip:clientIp(req)});
          await persist();return json(res,200,{ok:true,size:data.length});
        }
        if(action==='download'&&req.method==='GET'){
          const upstream=await runnerFetch('/raw'+query,{signal:AbortSignal.timeout(120000)});
          if(!upstream.ok){const data=await upstream.json().catch(()=>({}));return json(res,upstream.status,{error:data.error||'下载失败'})}
          addAudit(db,{userId:session.user.id,action:'file.download',target:rel,detail:'工作区 '+workspace.name,ip:clientIp(req)});
          const headers={'Content-Type':'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(rel.split('/').pop()||'file'),'X-Content-Type-Options':'nosniff','Content-Security-Policy':'sandbox','Cache-Control':'no-store'};
          const length=upstream.headers.get('content-length');if(length)headers['Content-Length']=length;
          res.writeHead(200,headers);Readable.fromWeb(upstream.body).pipe(res);return;
        }
      }catch(error){return json(res,error.status||502,{error:error.status?error.message:'无法连接运行器'})}
    }
    // ---- AI 指引对话：使用向导 / 任务引导（对话由前端保存，服务器不留存） ----
    if(pathname==='/api/guide/chat'&&req.method==='POST'){
      const body=await readBody(req,700*1024),mode=body.mode==='task'?'task':'help',messages=cleanGuideMessages(body.messages,{maxMessages:14,maxChars:40000});
      if(!messages.length||messages.at(-1).role!=='user')return json(res,400,{error:'请先输入你的问题'});
      ensureModelReady(session.user);
      const today=new Date().toISOString().slice(0,10),slot=guideDay.get(session.user.id);
      const used=slot&&slot.day===today?slot.count:0,limit=Math.max(1,Number(process.env.GUIDE_DAILY_LIMIT)||200);
      if(used>=limit)return json(res,429,{error:'今天的指引对话次数已用完（'+limit+' 次），请明天再试'});
      if(guideBusy.has(session.user.id))return json(res,429,{error:'上一条还在回复中，请稍等'});
      guideBusy.add(session.user.id);
      try{
        const ref=pickModel(String(body.model||''),session.user)||defaultModelRef(session.user);
        const result=await askModel(messages,ref,guidePrompt(mode,guideState(session.user)));
        guideDay.set(session.user.id,{day:today,count:used+1});
        recordUsage(session.user.id,result.usage,ref,'guide');await persist();
        return json(res,200,parseGuideReply(result.reply));
      }finally{guideBusy.delete(session.user.id)}
    }
    // 侧边栏同步（便签 / 待办 / 片段）：PUT 和服务器上的合并后返回合并结果，不是覆盖
    if(pathname==='/api/side'&&(req.method==='GET'||req.method==='PUT')){
      const user=session.user,current=user.sideData||{notes:[],todos:[],snippets:[],sessions:[],del:{},u:0};
      if(req.method==='GET')return json(res,200,{data:current});
      const body=await readBody(req,1024*1024),merged=mergeSideData(current,cleanSideData(body.data));
      user.sideData=merged;await persist();return json(res,200,{data:merged});
    }
    // 侧边栏的 AI 帮手：把一段文字（便签或最近的对话）整理成待办候选项，由用户确认后才加入；每人每分钟最多 6 次，计入用量
    if(pathname==='/api/side/ai'&&req.method==='POST'){
      const body=await readBody(req,64*1024),user=session.user;
      const text=String(body.text??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,' ').slice(0,6000).trim();
      if(text.length<4)return json(res,400,{error:'内容太短，整理不出待办'});
      const wait=hitWindowLimit(sideAiHits,user.id,6,60*1000);
      if(wait)return json(res,429,{error:'整理太频繁，请 '+wait+' 秒后再试'});
      ensureModelReady(user);
      const ref=defaultModelRef(user),today=new Date().toISOString().slice(0,10);
      const result=await askModel([{role:'user',content:'今天是 '+today+'。内容如下：\n'+text}],ref,'你是任务整理助手。从用户给的内容（便签或对话片段）里，提取需要用户去做的具体事项。只输出一个 JSON 数组，不要其他文字：[{"t":"事项（≤ 40 字，以动词开头）","pri":0 到 2 的整数（2=紧急重要）,"due":"YYYY-MM-DD 或空字符串（只有内容里明确提到日期时才填，相对日期按今天推算）"}]。最多 10 条；没有任何待办就输出 []。不要编造内容里没有的事。');
      recordUsage(user.id,result.usage,ref,'side');await persist();
      let parsed=[];try{parsed=JSON.parse((String(result.reply||'').match(/\[[\s\S]*\]/)||['[]'])[0])}catch{}
      const items=(Array.isArray(parsed)?parsed:[]).slice(0,10).map(item=>({t:String(item?.t??'').replace(/\s+/g,' ').trim().slice(0,80),pri:Math.max(0,Math.min(2,Math.round(Number(item?.pri)||0))),due:/^\d{4}-\d{2}-\d{2}$/.test(item?.due)?item.due:''})).filter(item=>item.t);
      return json(res,200,{items});
    }
    // 桌宠的情绪记忆（读取 / 合并写入）：PUT 不是覆盖，而是和服务器上的合并，所以多台设备同时写不会互相覆盖
    if(pathname==='/api/pet/memory'&&(req.method==='GET'||req.method==='PUT')){
      const user=session.user,current=user.petMemory||{affinity:0,events:[],at:0,clearedAt:0,lastSeen:0};
      if(req.method==='GET')return json(res,200,{memory:current});
      const body=await readBody(req,24*1024),merged=mergePetMemory(current,cleanPetMemory(body.memory));
      user.petMemory=merged;await persist();return json(res,200,{memory:merged});
    }
    // 桌宠 AI 台词（可选，前端默认关闭）：按情绪让当前模型现编一句很短的话；每人每分钟最多 3 次，计入用量
    if(pathname==='/api/pet/line'&&req.method==='POST'){
      const body=await readBody(req,4*1024),emotion=String(body.emotion||'').slice(0,20);
      const EMOTIONS={angry:'生气',sad:'难过',laugh:'开心大笑',happy:'开心',shy:'害羞',surprised:'惊讶'};
      if(!EMOTIONS[emotion])return json(res,400,{error:'未知情绪'});
      const wait=hitWindowLimit(petLineHits,session.user.id,3,60*1000);
      if(wait)return json(res,429,{error:'桌宠说话太频繁，请 '+wait+' 秒后再试'});
      ensureModelReady(session.user);
      const hint=String(body.hint||'').replace(/[\u0000-\u001f]/g,' ').slice(0,80);
      const ref=defaultModelRef(session.user);
      const result=await askModel([{role:'user',content:'现在的情绪：'+EMOTIONS[emotion]+(hint?'。刚发生的事：'+hint:'')+'。请说一句话。'}],ref,'你是桌宠“梦色”，一个有点俏皮的二次元少女，肩上趴着一只小狐狸。只输出她此刻会说的一句话：不超过 24 个汉字，口语化，可以带一个颜文字或 emoji，不要引号、不要解释、不要换行。');
      recordUsage(session.user.id,result.usage,ref,'pet');await persist();
      const line=String(result.reply||'').replace(/\s+/g,' ').trim().slice(0,60);
      return json(res,200,{line});
    }
    // 桌宠看表情图：用户发了一张图（表情包 / 贴纸 / 梗图），让能看图的模型判断它传达的情绪。只分析自己的、不超过 3 MB 的图；每人每分钟最多 6 次，计入用量
    if(pathname==='/api/pet/sticker'&&req.method==='POST'){
      const body=await readBody(req,4*1024),ids=(Array.isArray(body.ids)?body.ids:[]).map(String).slice(0,2),user=session.user;
      const records=ids.map(id=>db.attachments[id]).filter(record=>record&&record.userId===user.id&&record.bytes<=3*1048576);
      if(!records.length)return json(res,404,{error:'没有可分析的图片（只分析属于你、不超过 3 MB 的图片）'});
      const wait=hitWindowLimit(petStickerHits,user.id,6,60*1000);
      if(wait)return json(res,429,{error:'看图太频繁，请 '+wait+' 秒后再试'});
      const config=visionConfig();
      const ref=[defaultModelRef(user),...modelCatalog(user).map(item=>item.ref)].find(candidate=>{const target=candidate&&resolveModel(candidate,user);return target&&isVisionModel(target.model,config.visionModels)});
      const serviceReady=config.enabled&&config.baseUrl&&config.dialect==='openai';
      if(!ref&&!serviceReady)return json(res,200,{kind:'unsupported',reason:'没有能看图的模型'});
      const record=records[0],buffer=await readFile(path.join(attachDir(record.userId),record.file));
      const system='你是图片情绪分析器。判断用户发来的这张图：kind=sticker（表情包、贴纸、梗图、动漫表情、颜文字图）、photo（照片）、screenshot（截图、文档、代码）、other。如果是表情包，判断它传达的情绪给桌宠助手带来的影响（比如大哭、捂脸、白眼、比心、笑哭）。只输出一个 JSON，不要其他文字：{"kind":"sticker"|"photo"|"screenshot"|"other","valence":-1到 1 的数,"arousal":0 到 1 的数,"about":"pet"|"self"|"none","emotion":"angry"|"sad"|"laugh"|"shy"|"surprised"|"happy"|"none","caption":"不超过 12 字的画面描述"}。about：pet=在夸或批评助手，self=在表达自己的状态，none=中性。';
      let text;
      if(ref&&config.mode!=='service'){
        const result=await askModel([{role:'user',content:imageParts('请分析这张图。',[{url:dataUrl(record.mime,buffer)}])}],ref,system);
        text=result.reply;recordUsage(user.id,result.usage,ref,'pet');
      }else{
        const result=await callVision({...config,prompt:system+'\n请分析这张图。'},buffer,record.mime);
        text=result.text;if(result.usage)recordUsage(user.id,result.usage,'vision/'+(config.model||config.dialect),'pet');
      }
      await persist();
      let parsed={};try{parsed=JSON.parse((String(text||'').match(/\{[\s\S]*\}/)||['{}'])[0])}catch{}
      const KINDS=new Set(['sticker','photo','screenshot','other']),EMOTION_SET=new Set(['angry','sad','laugh','shy','surprised','happy','none']),ABOUT_SET=new Set(['pet','self','none']);
      const num=(value,lo,hi)=>Number.isFinite(Number(value))?Math.max(lo,Math.min(hi,Number(value))):0;
      return json(res,200,{kind:KINDS.has(parsed.kind)?parsed.kind:'other',valence:num(parsed.valence,-1,1),arousal:num(parsed.arousal,0,1),about:ABOUT_SET.has(parsed.about)?parsed.about:'none',emotion:EMOTION_SET.has(parsed.emotion)?parsed.emotion:'none',caption:String(parsed.caption||'').replace(/\s+/g,' ').trim().slice(0,24)});
    }
    // 桌宠 AI 情绪理解（可选，前端默认关闭）：把最近几句对话交给模型，结合上下文判断最后一句用户消息的情绪影响（反话、玩笑、emoji、[表情包]）；每人每分钟最多 4 次，计入用量
    if(pathname==='/api/pet/sense'&&req.method==='POST'){
      const body=await readBody(req,16*1024),list=Array.isArray(body.messages)?body.messages.slice(-8):[];
      const lines=list.map(item=>(item?.role==='user'?'用户：':'助手：')+String(item?.text||'').replace(/[\u0000-\u001f]/g,' ').slice(0,200)).filter(line=>line.length>3);
      if(!lines.length||!lines.at(-1).startsWith('用户：'))return json(res,400,{error:'需要最近的聊天片段，且最后一条是用户消息'});
      const wait=hitWindowLimit(petSenseHits,session.user.id,4,60*1000);
      if(wait)return json(res,429,{error:'情绪理解太频繁，请 '+wait+' 秒后再试'});
      ensureModelReady(session.user);
      const ref=defaultModelRef(session.user);
      const result=await askModel([{role:'user',content:lines.join('\n')}],ref,'你是情绪分析器。下面是一段聊天，请判断“最后一条用户消息”给桌宠助手带来的情绪影响。要结合上下文（用户是在批评助手的回答、表达自己的低落、开玩笑、夸奖，还是只是中性提问，反话也要识别），也要理解 emoji、表情包文字（如[捂脸]）和颜文字。只输出一个 JSON，不要其他文字：{"valence":-1到 1 的数,"arousal":0 到 1 的数,"about":"pet"|"self"|"none","emotion":"angry"|"sad"|"laugh"|"shy"|"surprised"|"happy"|"none"}。about：pet=针对助手本身（夸或批评），self=用户在说自己的状态，none=中性或第三方。');
      recordUsage(session.user.id,result.usage,ref,'pet');await persist();
      let parsed={};try{parsed=JSON.parse((String(result.reply||'').match(/\{[\s\S]*\}/)||['{}'])[0])}catch{}
      const EMOTION_SET=new Set(['angry','sad','laugh','shy','surprised','happy','none']),ABOUT_SET=new Set(['pet','self','none']);
      const num=(value,lo,hi)=>Number.isFinite(Number(value))?Math.max(lo,Math.min(hi,Number(value))):0;
      return json(res,200,{valence:num(parsed.valence,-1,1),arousal:num(parsed.arousal,0,1),about:ABOUT_SET.has(parsed.about)?parsed.about:'none',emotion:EMOTION_SET.has(parsed.emotion)?parsed.emotion:'none'});
    }
    if(pathname==='/api/guide/save'&&req.method==='POST'){
      if(!runnerEnabled)return json(res,503,{error:'还没有安装智能体运行器，工作区文件暂不可用'});
      const body=await readBody(req,3*1024*1024),list=Array.isArray(body.files)?body.files:[];
      if(!list.length||list.length>12)return json(res,400,{error:'没有可保存的文件（一次最多 12 个）'});
      const files=[];
      for(const item of list){
        const rel=safeEntryName(String(item?.path||'')),content=typeof item?.content==='string'?item.content:null;
        if(!rel||content===null||Buffer.byteLength(content)>200*1024)return json(res,400,{error:'文件路径或内容不合法：'+String(item?.path||'').slice(0,80)});
        files.push({path:rel,content});
      }
      let workspace;
      if(body.workspaceId){workspace=workspaceFor(String(body.workspaceId),session.user);if(!workspace)return json(res,404,{error:'工作区不存在'})}
      else{
        if(Object.values(db.workspaces).filter(item=>item.ownerId===session.user.id).length>=20)return json(res,400,{error:'工作区数量已达上限（20）'});
        const name=String(body.newWorkspaceName||'AI 引导项目').trim().slice(0,60)||'AI 引导项目';
        workspace={id:randomUUID(),ownerId:session.user.id,name,memberIds:[],createdAt:Date.now()};db.workspaces[workspace.id]=workspace;
      }
      for(const file of files){
        const upstream=await runnerFetch('/files?workspace='+workspace.id+'&path='+encodeURIComponent(file.path),{method:'PUT',body:file.content,signal:AbortSignal.timeout(30000)});
        if(!upstream.ok){const data=await upstream.json().catch(()=>({}));return json(res,upstream.status,{error:(data.error||'保存失败')+'：'+file.path})}
      }
      addAudit(db,{userId:session.user.id,action:'guide.save',target:workspace.name,detail:files.length+' 个文件（同名旧文件已备份）',ip:clientIp(req)});await persist();
      return json(res,200,{workspaceId:workspace.id,name:workspace.name,saved:files.length,hasIndex:files.some(file=>file.path==='index.html')});
    }
    // ---- 项目导出 / 导入 / 在线预览链接 ----
    const projectMatch=pathname.match(/^\/api\/workspaces\/([0-9a-f-]+)\/(export|import|preview-link|preview-revoke)$/i);
    if(projectMatch){
      const workspace=workspaceFor(projectMatch[1],session.user),action=projectMatch[2].toLowerCase();
      if(!workspace)return json(res,404,{error:'工作区不存在'});
      if(!runnerEnabled)return json(res,503,{error:'还没有安装智能体运行器，工作区文件暂不可用'});
      const wq='workspace='+workspace.id;
      if(action==='export'&&req.method==='GET'){
        const local=url.searchParams.get('local')==='1',tree=await runnerJson('/tree?'+wq);
        const files=tree.files.filter(file=>!/(^|\/)(node_modules|\.git)\//.test(file.path));
        const maxBytes=Math.max(10,Number(process.env.EXPORT_MAX_MB)||PROJECT_LIMITS.maxExportBytes/1048576)*1048576;
        if(files.length>PROJECT_LIMITS.maxFiles)return json(res,413,{error:'文件太多（'+files.length+' 个，上限 '+PROJECT_LIMITS.maxFiles+'），请分批导出或先清理'});
        if(files.reduce((sum,file)=>sum+file.size,0)>maxBytes)return json(res,413,{error:'项目超过 '+Math.floor(maxBytes/1048576)+' MB，无法一次打包'});
        const entries=[];let next=0;
        const pump=async()=>{while(next<files.length){const file=files[next++];const upstream=await runnerFetch('/raw?'+wq+'&path='+encodeURIComponent(file.path),{signal:AbortSignal.timeout(120000)});if(!upstream.ok)throw Object.assign(new Error('读取文件失败：'+file.path),{status:502});entries.push({name:PROJECT_DIR+'/'+file.path,data:Buffer.from(await upstream.arrayBuffer()),mtime:file.mtime})}};
        await Promise.all([pump(),pump(),pump(),pump()]);
        entries.sort((a,b)=>a.name<b.name?-1:1);
        entries.unshift({name:MANIFEST_NAME,data:Buffer.from(manifestFor(workspace.name,entries.length,{local}),'utf8')});
        if(local)entries.push(...localKit(workspace.name));
        const zip=createZip(entries),base=workspace.name.replace(/[\\/:*?"<>|\s]+/g,'-').slice(0,60)||'project',stamp=new Date().toISOString().slice(0,10).replace(/-/g,'');
        addAudit(db,{userId:session.user.id,action:'project.export',target:workspace.name,detail:(entries.length-1)+' 个文件'+(local?'（含本地使用包）':''),ip:clientIp(req)});await persist();
        res.writeHead(200,{'Content-Type':'application/zip','Content-Length':zip.length,'Content-Disposition':'attachment; filename="project.zip"; filename*=UTF-8\'\''+encodeURIComponent(base+(local?'-本地版-':'-')+stamp+'.zip'),'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
        return res.end(zip);
      }
      if(action==='import'&&(req.method==='PUT'||req.method==='POST')){
        const data=await readRaw(req,uploadLimit);
        let parsed;try{parsed=readZip(data,{maxFiles:PROJECT_LIMITS.maxFiles,maxEntryBytes:uploadLimit,maxTotalBytes:300*1048576})}catch(error){return json(res,400,{error:error.message})}
        const plan=planImport(parsed.entries);
        if(!plan.files.length)return json(res,400,{error:'压缩包里没有可导入的文件'});
        const overwrite=url.searchParams.get('overwrite')!=='0',existing=new Set((await runnerJson('/tree?'+wq)).files.map(file=>file.path));
        let written=0,replaced=0,kept=0;const failed=[];
        for(const file of plan.files){
          const exists=existing.has(file.name);
          if(exists&&!overwrite){kept++;continue}
          const upstream=await runnerFetch('/files?'+wq+'&path='+encodeURIComponent(file.name),{method:'PUT',body:file.data,signal:AbortSignal.timeout(120000)});
          if(upstream.ok){written++;if(exists)replaced++}else failed.push(file.name);
        }
        addAudit(db,{userId:session.user.id,action:'project.import',target:workspace.name,detail:'写入 '+written+'（覆盖 '+replaced+'，覆盖前已备份），保留 '+kept+'，失败 '+failed.length,ip:clientIp(req)});await persist();
        return json(res,200,{ok:true,written,replaced,kept,ignored:plan.ignored+parsed.skipped.length,failed:failed.slice(0,20),mode:plan.mode,skipped:parsed.skipped.slice(0,20)});
      }
      if(action==='preview-link'&&req.method==='POST'){
        const body=await readBody(req).catch(()=>({})),rel=String(body.path||'').replace(/^\/+/,'');
        if(rel&&!safeEntryName(rel))return json(res,400,{error:'文件路径不合法'});
        const expiresAt=Date.now()+PROJECT_LIMITS.previewTtlMs,token=signPreview(storeKey,workspace.id,workspace.previewEpoch||0,expiresAt);
        return json(res,200,{url:'/preview/'+token+'/'+(rel?rel.split('/').map(encodeURIComponent).join('/'):''),expiresAt});
      }
      if(action==='preview-revoke'&&req.method==='POST'){
        if(!canManageWorkspace(workspace,session.user))return json(res,403,{error:'只有创建者或主账号可以撤销预览链接'});
        workspace.previewEpoch=(workspace.previewEpoch||0)+1;addAudit(db,{userId:session.user.id,action:'project.preview.revoke',target:workspace.name,ip:clientIp(req)});await persist();
        return json(res,200,{ok:true});
      }
    }
    const fileMgmt=pathname.match(/^\/api\/workspaces\/([0-9a-f-]+)\/(tree|history|versions|restore|expiry(?:\/approve)?)$/i);
    if(fileMgmt){
      const workspace=workspaceFor(fileMgmt[1],session.user),action=fileMgmt[2].toLowerCase();
      if(!workspace)return json(res,404,{error:'工作区不存在'});
      if(!runnerEnabled)return json(res,503,{error:'还没有安装智能体运行器，工作区文件暂不可用'});
      const rel=url.searchParams.get('path')||'',manage=canManageWorkspace(workspace,session.user),wq='workspace='+workspace.id;
      try{
        if(action==='tree'&&req.method==='GET'){const tree=await runnerJson('/tree?'+wq);return json(res,200,{files:tree.files,truncated:tree.truncated,total:tree.files.reduce((sum,file)=>sum+file.size,0)})}
        if(action==='history'&&req.method==='GET')return json(res,200,await runnerJson('/history?'+wq));
        if(action==='versions'&&req.method==='GET'){if(!rel)return json(res,400,{error:'请填写文件路径'});return json(res,200,await runnerJson('/versions?'+wq+'&path='+encodeURIComponent(rel)+(url.searchParams.get('id')?'&id='+encodeURIComponent(url.searchParams.get('id')):'')))}
        if(action==='restore'&&req.method==='POST'){
          const body=await readBody(req),target=String(body.path||''),id=String(body.id||'');
          if(!target||!id)return json(res,400,{error:'请选择要还原的文件和版本'});
          await runnerJson('/restore?'+wq+'&path='+encodeURIComponent(target)+'&id='+encodeURIComponent(id),{method:'POST'});
          logCleanup(workspace,{by:session.user.email,auto:false,deleted:0,skipped:0,restored:target});
          addAudit(db,{userId:session.user.id,action:'file.restore',target,detail:'工作区 '+workspace.name+' · 版本 '+id,ip:clientIp(req)});await persist();
          return json(res,200,{ok:true});
        }
        if(action==='expiry'&&req.method==='GET'){
          const info=await expiredFiles(workspace);
          return json(res,200,{policy:info.policy,candidates:info.files,truncated:info.truncated,total:info.total,fileCount:info.count,log:(workspace.cleanupLog||[]).slice(0,20),canManage:manage});
        }
        if(action==='expiry'&&req.method==='PUT'){
          if(!manage)return json(res,403,{error:'只有创建者或主账号可以设置清理规则'});
          const body=await readBody(req),days=Math.floor(Number(body.days)||0);
          if(days<0||days>3650||(days>0&&days<7))return json(res,400,{error:'过期天数需为 0（关闭）或 7–3650 天'});
          const protect=(Array.isArray(body.protect)?body.protect:String(body.protect||'').split(/[,，\n]+/)).map(item=>String(item).trim().replace(/^\/+/,'')).filter(Boolean).slice(0,30);
          const current=workspace.retention||{},wantAuto=Boolean(body.autoDelete)&&days>0;
          // 开启自动删除必须由人明确确认；确认人和时间会记录下来
          if(wantAuto&&!current.autoDelete&&body.confirm!==true)return json(res,400,{error:'开启自动删除需要确认：开启后系统每天会自动清理过期文件（删除前都会备份，可在“版本历史”里还原）'});
          workspace.retention={days,protect,autoDelete:wantAuto,autoEnabledBy:wantAuto?(current.autoDelete?current.autoEnabledBy:session.user.email):null,autoEnabledAt:wantAuto?(current.autoDelete?current.autoEnabledAt:Date.now()):null};
          addAudit(db,{userId:session.user.id,action:'expiry.policy',target:workspace.name,detail:JSON.stringify({days,autoDelete:wantAuto,protect}),ip:clientIp(req)});
          await persist();return json(res,200,{policy:retentionOf(workspace)});
        }
        if(action==='expiry/approve'&&req.method==='POST'){
          if(!manage)return json(res,403,{error:'只有创建者或主账号可以确认删除'});
          const body=await readBody(req);
          if(body.confirm!==true)return json(res,400,{error:'需要人工确认'});
          const wanted=new Map((Array.isArray(body.items)?body.items:[]).map(item=>[String(item.path),Number(item.mtime)]));
          if(!wanted.size)return json(res,400,{error:'没有选择文件'});
          if(wanted.size>500)return json(res,400,{error:'一次最多确认 500 个文件'});
          // 以服务器此刻的过期清单为准，只处理“仍然过期且没被改过”的文件，防止构造请求删掉未过期文件
          const expired=await expiredFiles(workspace),items=expired.files.filter(file=>wanted.get(file.path)===file.mtime).map(file=>({path:file.path,mtime:file.mtime}));
          const notExpired=[...wanted.keys()].filter(path=>!items.some(item=>item.path===path));
          if(!items.length)return json(res,200,{deleted:[],skipped:notExpired.map(path=>({path,reason:'不再满足过期条件'}))});
          const result=await deleteExpired(workspace,items,session.user.email,false);
          for(const path of notExpired)result.skipped.push({path,reason:'不再满足过期条件'});
          return json(res,200,result);
        }
      }catch(error){return json(res,error.status||502,{error:error.status?error.message:'无法连接运行器'})}
    }
    const runsMatch=pathname.match(/^\/api\/workspaces\/([0-9a-f-]+)\/runs(?:\/([0-9a-f-]+))?$/i);
    if(runsMatch){
      const workspace=workspaceFor(runsMatch[1],session.user);
      if(!workspace)return json(res,404,{error:'工作区不存在'});
      if(req.method==='GET'&&!runsMatch[2])return json(res,200,{runs:Object.values(db.runs).filter(run=>run.workspaceId===workspace.id).sort((a,b)=>b.createdAt-a.createdAt).map(runSummary)});
      if(req.method==='GET'){const run=db.runs[runsMatch[2]];return run&&run.workspaceId===workspace.id?json(res,200,{run:{...runSummary(run),steps:run.steps,final:run.final,rounds:run.rounds,error:run.error||null}}):json(res,404,{error:'记录不存在'})}
      if(req.method==='POST'&&!runsMatch[2]){
        if((activeRuns.get(session.user.id)||0)>=2)return json(res,429,{error:'你已经有 2 个协作任务在运行，请等待完成或先停止'});
        const body=await readBody(req,256*1024),task=String(body.task||'').trim(),mode=String(body.mode||'pipeline'),rounds=Number(body.rounds||2),maxSteps=Number(body.maxSteps||8);
        if(!task||task.length>20000)return json(res,400,{error:'任务不能为空，且不能超过 20000 个字符'});
        const health=await runnerHealth();let participants;
        try{
          if(!Array.isArray(body.participants))throw fail(400,'请添加参与者');
          participants=body.participants.slice(0,LIMITS.participants+1).map(item=>resolveParticipant(item,session.user,health));
          validatePlan({mode,participants,rounds});
        }catch(error){return json(res,error.status||400,{error:error.message})}
        if(participants.some(item=>item.kind==='engine')&&!health?.ok)return json(res,503,{error:'智能体运行器不可用：'+(health?.error||'未安装或未启动')});
        const over=quotaError(session.user);if(over)return json(res,429,{error:over});

        const run={id:randomUUID(),workspaceId:workspace.id,userId:session.user.id,task,mode,rounds,status:'running',createdAt:Date.now(),participants:participants.map(item=>({label:item.label,kind:item.kind,engine:item.engine||null,model:item.model||null,mode:item.mode||null})),steps:[],final:''};
        db.runs[run.id]=run;
        const mine=Object.values(db.runs).filter(item=>item.workspaceId===workspace.id).sort((a,b)=>b.createdAt-a.createdAt);
        for(const old of mine.slice(30))delete db.runs[old.id];
        await persist();activeRuns.set(session.user.id,(activeRuns.get(session.user.id)||0)+1);
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
        const send=(event,data)=>{if(!res.writableEnded&&!res.destroyed)res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n')};
        const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort()});
        send('run',{id:run.id});
        const call=async({participant,prompt,onDelta,signal})=>{
          const limit=quotaError(session.user);if(limit)throw fail(429,limit);
          if(participant.kind==='engine'){
            const out=await runEngine({engine:participant.engine,prompt,workspaceId:workspace.id,userId:session.user.id,mode:participant.mode,model:participant.model,gateway:participant.gateway,system:participant.role?'你的职责：'+participant.role:'',signal,onDelta});
            recordUsage(session.user.id,out.usage,'engine:'+participant.engine,'workspace');await persist();return out;
          }
          const result=await streamModel([{role:'user',content:prompt}],onDelta,signal,participant.model,participant.system);
          recordUsage(session.user.id,result.usage,participant.model,'workspace');await persist();
          return {text:result.reply,usage:result.usage};
        };
        try{
          const result=await runCollaboration({task,mode,participants,rounds,maxSteps,call,signal:abort.signal,emit:event=>{const{type,...data}=event;send(type,data)}});
          run.status=result.status;run.final=result.final;run.steps=result.steps;
        }catch(error){
          run.status='failed';run.error=error.message;run.steps=error.steps||run.steps;run.final=error.partial||'';
          if((error.status||500)>=500)console.error('协作任务失败：',error.message);
          send('error',{error:error.message});
        }finally{
          run.endedAt=Date.now();activeRuns.set(session.user.id,Math.max(0,(activeRuns.get(session.user.id)||1)-1));
          try{await persist()}catch{}
          send('finished',{id:run.id,status:run.status});res.end();
        }
        return;
      }
    }
    // 已绑定的 Cindy 账号
    if(pathname==='/api/cindy/accounts'&&req.method==='GET'){
      refreshCindyModelsInBackground(session.user);
      return json(res,200,{accounts:userCindyAccounts(session.user).map(account=>({...safeCindyAccount(account),...cindySummary(account)}))});
    }
    // 查询 Cindy 账号的余额、额度池和订阅（只读；接口与官方客户端相同，均在 model-access 服务上，用该账号的访问令牌）
    const cindyBillingMatch=pathname.match(/^\/api\/cindy\/accounts\/([0-9a-f-]+)\/billing$/i);
    if(cindyBillingMatch&&req.method==='GET'){
      const account=userCindyAccounts(session.user).find(item=>item.id===cindyBillingMatch[1]);
      if(!account)return json(res,404,{error:'绑定记录不存在'});
      try{await ensureFreshAccessToken(account)}catch(error){return json(res,error.status||401,{error:error.message})}
      const base=modelAccessBase(account.region),headers={Authorization:'Bearer '+account.credentials.accessToken,Accept:'application/json'};
      const scrub=value=>Array.isArray(value)?value.slice(0,50).map(scrub):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!/token|secret|api.?key|password|authorization/i.test(key)).map(([key,item])=>[key,scrub(item)])):value;
      const get=async path=>{
        try{
          const response=await fetch(base+path,{headers,signal:AbortSignal.timeout(15000),redirect:'error'});
          const data=await response.json().catch(()=>null);
          if(response.ok)return {ok:true,data:scrub(data)};
          const info=data&&typeof data.error==='object'&&data.error?data.error:data||{};
          const reason={401:'授权失效，请解绑后重新绑定',403:'没有权限',404:'账号尚未开通',501:'这个账号类型不支持该查询'}[response.status]||'服务暂不可用';
          return {ok:false,status:response.status,code:String(info.code||''),message:reason};
        }catch(error){return {ok:false,status:0,message:'无法连接官方服务：'+(error.cause?.code||error.message)}}
      };
      const [balance,creditUsage]=await Promise.all([get('/api/model-access/balance'),get('/api/model-access/credit-usage')]);
      // 订阅的购买、变更都在官方网站完成，这里只给链接
      const site=(account.region==='cn'?process.env.CINDY_WEBSITE_URL_CN||'https://cindy.com.cn':process.env.CINDY_WEBSITE_URL_GLOBAL||'https://cindy.app').replace(/\/+$/,'');
      return json(res,200,{balance,creditUsage,links:{subscription:site+'/#pricing',website:site}});
    }
    const cindySyncMatch=pathname.match(/^\/api\/cindy\/accounts\/([0-9a-f-]+)\/(sync|test)$/i);
    if(cindySyncMatch&&req.method==='POST'){
      const account=userCindyAccounts(session.user).find(item=>item.id===cindySyncMatch[1]);
      if(!account)return json(res,404,{error:'绑定记录不存在'});
      let renewal=null;
      if(cindySyncMatch[2]==='test'){try{await ensureFreshAccessToken(account,{force:true});renewal={name:'令牌续期（用刷新令牌换新的访问令牌）',ok:true,detail:'成功，新令牌约 1 小时有效'}}catch(error){renewal={name:'令牌续期（用刷新令牌换新的访问令牌）',ok:false,detail:error.message}}}
      const entry=await syncCindyAccount(account);await persist();
      if(cindySyncMatch[2]==='sync')return json(res,200,{ok:!entry.error,...cindySummary(account)});
      // 逐步测试：每一步的结果都如实返回，便于定位是令牌、目录、网关路径还是模型的问题
      const steps=[...(renewal?[renewal]:[]),{name:'读取模型目录与网关凭据',ok:!entry.error,detail:entry.error||('发现 '+entry.models.length+' 个对话模型')}];
      if(entry.base){
        steps.push({name:'探测网关路径',ok:!entry.guessed,detail:(entry.guessed?'没有找到可用的 /models，先按 ':'使用 ')+entry.base.replace(/^(https?:\/\/[^/]+).*$/,'$1/…')+'；'+(entry.tried||[]).map(item=>item.replace(entry.apiKey||'§','***')).join('；')});
        const body=await readBody(req).catch(()=>({})),model=String(body.model||'')||entry.models[0]?.id;
        if(model&&entry.models.some(item=>item.id===model)){const ping=await pingChat(entry.base,entry.apiKey,model);steps.push({name:'对话测试（1 token）：'+model,ok:ping.ok,detail:ping.detail})}
      }
      return json(res,200,{ok:steps.every(step=>step.ok),steps});
    }
    const cindyShareMatch=pathname.match(/^\/api\/cindy\/accounts\/([0-9a-f-]+)$/i);
    if(cindyShareMatch&&req.method==='PATCH'){
      const account=userCindyAccounts(session.user).find(item=>item.id===cindyShareMatch[1]);
      if(!account)return json(res,404,{error:'绑定记录不存在'});
      const body=await readBody(req);
      if(typeof body.shared!=='boolean')return json(res,400,{error:'shared 必须是布尔值'});
      if(body.shared&&!isAdmin)return json(res,403,{error:'只有主账号可以把 Cindy 账号共享给团队成员'});
      account.shared=body.shared;await persist();await recordSecurityEvent(body.shared?'cindy_account_shared':'cindy_account_unshared',req,session.user.id);
      return json(res,200,{account:safeCindyAccount(account)});
    }
    const cindyAccountMatch=pathname.match(/^\/api\/cindy\/accounts\/([0-9a-f-]+)$/i);
    if(cindyAccountMatch&&req.method==='DELETE'){
      const accounts=session.user.cindyAccounts||[],index=accounts.findIndex(item=>item.id===cindyAccountMatch[1]);
      if(index<0)return json(res,404,{error:'绑定记录不存在'});
      cindyCache.delete(accounts[index].id);accounts.splice(index,1);await persist();await recordSecurityEvent('cindy_account_unbound',req,session.user.id);
      return json(res,200,{ok:true});
    }
    // 壁纸：文件放在 DATA_DIR/wallpapers（图片或 mp4）；每人可选一张并调暗度，主账号可上传/删除/设为全员默认
    if(pathname==='/api/wallpapers'&&req.method==='GET'){
      const items=await listWallpapers();
      const pref=session.user.prefs?.wallpaper||{};
      return json(res,200,{items,defaultWallpaper:db.settings.defaultWallpaper||'',pref:{wallpaper:pref.wallpaper??null,dim:Number.isFinite(pref.dim)?pref.dim:35}});
    }
    if(pathname==='/api/wallpapers/pref'&&req.method==='PUT'){
      const body=await readBody(req),wallpaper=String(body.wallpaper??''),dim=Number(body.dim);
      if(wallpaper&&!wallpaper.startsWith('preset:')&&!(await listWallpapers()).some(item=>item.name===wallpaper))return json(res,400,{error:'壁纸不存在'});
      if(wallpaper.startsWith('preset:')&&!/^preset:[a-z0-9-]{1,30}$/.test(wallpaper))return json(res,400,{error:'预设无效'});
      if(!Number.isFinite(dim)||dim<0||dim>80)return json(res,400,{error:'暗度需在 0–80 之间'});
      session.user.prefs={...(session.user.prefs||{}),wallpaper:{wallpaper,dim:Math.round(dim)}};
      await persist();return json(res,200,{ok:true});
    }
    const wallpaperFile=pathname.match(/^\/api\/wallpapers\/file\/([A-Za-z0-9._-]{1,80})$/);
    if(wallpaperFile&&req.method==='GET'){
      const kind=wallpaperKind(wallpaperFile[1]);
      if(!kind)return json(res,404,{error:'未找到'});
      try{
        const data=await readFile(path.join(wallpapersDir,wallpaperFile[1]));
        res.writeHead(200,{'Content-Type':kind.type,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff','Content-Length':data.length});
        return res.end(data);
      }catch{return json(res,404,{error:'未找到'})}
    }
    const wallpaperAdmin=pathname.match(/^\/api\/admin\/wallpapers\/([A-Za-z0-9._-]{1,80})$/);
    if(wallpaperAdmin&&(req.method==='PUT'||req.method==='DELETE')){
      if(!isAdmin)return adminOnly();
      const name=wallpaperAdmin[1],kind=wallpaperKind(name);
      if(!kind)return json(res,400,{error:'文件名只能是字母数字._- ，扩展名为 webp / png / jpg / mp4'});
      if(req.method==='DELETE'){
        await rm(path.join(wallpapersDir,name),{force:true});
        if(db.settings.defaultWallpaper===name)db.settings.defaultWallpaper='';
        await persist();return json(res,200,{ok:true});
      }
      const data=await readRaw(req,kind.video?30*1024*1024:8*1024*1024);
      if(!kind.magic(data))return json(res,400,{error:'文件内容和扩展名不匹配（不是有效的 '+kind.label+'）'});
      await mkdir(wallpapersDir,{recursive:true});
      await writeFile(path.join(wallpapersDir,name),data);
      return json(res,200,{ok:true,size:data.length});
    }
    if(pathname==='/api/admin/wallpapers-default'&&req.method==='PUT'){
      if(!isAdmin)return adminOnly();
      const name=String((await readBody(req)).name||'');
      if(name&&!name.startsWith('preset:')&&!(await listWallpapers()).some(item=>item.name===name))return json(res,400,{error:'壁纸不存在'});
      db.settings.defaultWallpaper=name;await persist();return json(res,200,{ok:true});
    }
    // 技能工坊：可复用的“能力说明”（SKILL.md 格式），绑定到智能体后自动加入它的系统提示词
    if(pathname==='/api/skills'&&req.method==='GET')return json(res,200,{skills:Object.values(db.skills).filter(skill=>usableSkill(skill.id,session.user)).sort((a,b)=>a.createdAt-b.createdAt).map(skill=>skillSummary(skill,session.user))});
    if(pathname==='/api/skills'&&req.method==='POST'){
      if(Object.values(db.skills).filter(skill=>skill.ownerId===session.user.id).length>=100)return json(res,400,{error:'技能数量已达上限（100）'});
      const skill={id:randomUUID(),ownerId:session.user.id,createdAt:Date.now(),...parseSkillBody(await readBody(req,64*1024),session.user)};
      db.skills[skill.id]=skill;await persist();return json(res,201,{skill:skillSummary(skill,session.user)});
    }
    if(pathname==='/api/skills/import-zip'&&req.method==='POST'){
      const body=await readBody(req,3*1024*1024);
      let buffer;try{buffer=Buffer.from(String(body.data||''),'base64')}catch{buffer=Buffer.alloc(0)}
      if(!buffer.length)return json(res,400,{error:'没有收到文件内容'});
      const isSkill=name=>/(^|\/)skill\.md$/i.test(name)&&!/(^|\/)(node_modules|__MACOSX)\//.test(name);
      const {entries,ignored}=readZipEntries(buffer,isSkill);
      if(!entries.length)return json(res,400,{error:'压缩包里没有找到 SKILL.md'});
      const result=await importSkills(entries.map(entry=>({name:entry.name,text:entry.text,fallbackTitle:entry.name.split('/').slice(-2,-1)[0]||''})),session.user);
      return json(res,result.created.length?201:400,{...result,ignoredFiles:ignored,note:'压缩包里的脚本和其它文件不会被执行或保存，只导入 SKILL.md 的文字内容。',...(result.created.length?{}:{error:'没有成功导入任何技能：'+(result.skipped[0]?.reason||'')})});
    }
    if(pathname==='/api/skills/import'&&req.method==='POST'){
      const parsed=parseSkillMarkdown((await readBody(req,64*1024)).markdown);
      if(!parsed.title)return json(res,400,{error:'没有找到技能名称：请在 SKILL.md 前言里写 name:，或用 # 一级标题'});
      const skill={id:randomUUID(),ownerId:session.user.id,createdAt:Date.now(),...parseSkillBody(parsed,session.user)};
      db.skills[skill.id]=skill;await persist();return json(res,201,{skill:skillSummary(skill,session.user)});
    }
    const skillMatch=pathname.match(/^\/api\/skills\/([0-9a-f-]+)(\/export)?$/i);
    if(skillMatch){
      const skill=visibleSkill(skillMatch[1],session.user);
      if(!skill)return json(res,404,{error:'技能不存在'});
      if(skillMatch[2]&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="SKILL.md"','Cache-Control':'no-store'});return res.end(exportSkillMarkdown(skill))}
      if(req.method==='PATCH'||req.method==='DELETE'){
        if(skill.ownerId!==session.user.id&&!isAdmin)return json(res,403,{error:'只有创建者或主账号可以修改'});
        if(req.method==='DELETE'){delete db.skills[skill.id];for(const agent of Object.values(db.agents))agent.skillIds=(agent.skillIds||[]).filter(id=>id!==skill.id);await persist();return json(res,200,{ok:true})}
        Object.assign(skill,parseSkillBody(await readBody(req,64*1024),session.user,skill));await persist();return json(res,200,{skill:skillSummary(skill,session.user)});
      }
    }
    if(pathname==='/api/market'&&req.method==='GET'){
      await refreshMarketSources(false);
      const own=marketOwn(session.user),catalog=marketCatalog().map(entry=>marketView(entry,session.user,own));
      return json(res,200,{skills:catalog.filter(item=>item.type==='skill'),bots:catalog.filter(item=>item.type==='bot'),mine:marketMine(session.user),sources:marketSources().filter(source=>source.enabled).map(source=>({id:source.id,name:source.name,kind:source.kind,searchable:typeof marketKit.adapterFor(source.kind)?.search==='function'}))});
    }
    if(pathname==='/api/market/search'&&req.method==='GET'){
      const wait=hitWindowLimit(codeAttempts,'mkq:'+session.user.id,20,60*1000);
      if(wait)return json(res,429,{error:'搜索太频繁，请稍后再试'});
      const q=String(url.searchParams.get('q')||'').trim().slice(0,60),source=marketSources().find(item=>item.id===url.searchParams.get('source')&&item.enabled),adapter=source&&marketKit.adapterFor(source.kind);
      if(typeof adapter?.search!=='function')return json(res,404,{error:'来源不存在、未启用或不支持搜索'});
      if(q.length<2)return json(res,400,{error:'请至少输入 2 个字'});
      let items;try{items=await adapter.search(source,q,marketKit.ctx)}catch(error){return json(res,502,{error:'搜索失败：'+error.message})}
      const own=marketOwn(session.user);
      return json(res,200,{items:items.map(item=>marketView({...item,sourceName:source.name},session.user,own))});
    }
    if(pathname==='/api/market/preview'&&req.method==='GET'){
      const key=String(url.searchParams.get('key')||''),entry=marketCatalog().find(item=>item.key===key);
      if(entry&&!entry.lazy)return json(res,200,{preview:marketPreview(entry,20000)});
      const cached=marketPreviewCache.get(key);
      if(cached&&Date.now()-cached.at<MARKET_TTL)return json(res,200,{preview:cached.text});
      let resolved;try{resolved=await resolveExternal(key)}catch(error){return json(res,error.status||502,{error:error.message})}
      const text=String(resolved.content||resolved.prompt||'').slice(0,20000);marketPreviewCache.set(key,{at:Date.now(),text});
      if(marketPreviewCache.size>200)marketPreviewCache.delete(marketPreviewCache.keys().next().value);
      return json(res,200,{preview:text});
    }
    if(pathname==='/api/market/install'&&req.method==='POST'){
      const body=await readBody(req);let entry=marketCatalog().find(item=>item.key===String(body.key||'')&&item.type===body.type);
      if(entry?.lazy||(!entry&&String(body.key||'').startsWith('ext:'))){entry=await resolveExternal(String(body.key));if(entry.type!==body.type)entry=null}
      if(!entry)return json(res,404,{error:'市场里没有这个条目（可能已被下架）'});
      if(entry.type==='skill'){
        const result=installMarketSkill(entry,session.user);
        if(!result.created)return json(res,409,{error:'你已经安装过这个技能'});
        await persist();await recordSecurityEvent('market_install',req,session.user.id,{key:entry.key,type:'skill'});return json(res,201,{skill:skillSummary(result.skill,session.user)});
      }
      const result=installMarketBot(entry,session.user);await persist();await recordSecurityEvent('market_install',req,session.user.id,{key:entry.key,type:'bot'});
      return json(res,201,{agent:safeAgent(result.agent,session.user),bot:botSummary(result.bot),token:result.token});
    }
    if(pathname==='/api/market/publish'&&req.method==='POST'){
      const body=await readBody(req),type=body.type==='bot'?'bot':'skill',items=marketItems();
      if(Object.values(items).filter(item=>item.ownerId===session.user.id).length>=20)return json(res,400,{error:'你的投稿已达上限（20），请先撤回一些'});
      const sourceId=String(body.id||''),duplicate=Object.values(items).find(item=>item.ownerId===session.user.id&&item.type===type&&item.sourceId===sourceId&&item.status!=='rejected');
      if(duplicate)return json(res,409,{error:duplicate.status==='published'?'这个条目已经在市场里了':'这个条目正在审核中'});
      let record;
      if(type==='skill'){
        const skill=db.skills[sourceId];
        if(!skill||(skill.ownerId!==session.user.id&&!isAdmin))return json(res,404,{error:'技能不存在'});
        record={title:skill.title,description:skill.description,content:skill.content};
      }else{
        const bot=db.bots[sourceId];
        if(!bot||bot.ownerId!==session.user.id)return json(res,404,{error:'机器人不存在'});
        const agent=bot.agentId?db.agents[bot.agentId]:null;
        if(!agent||!String(agent.systemPrompt||'').trim())return json(res,400,{error:'这个机器人没有绑定带提示词的智能体，没有可分享的内容'});
        record={title:bot.name,description:agent.description||'',prompt:agent.systemPrompt,skills:(agent.skillIds||[]).map(id=>db.skills[id]).filter(Boolean).slice(0,8).map(skill=>({title:skill.title,description:skill.description,content:skill.content}))};
      }
      const title=String(body.title||record.title).trim().slice(0,60),description=String(body.description??record.description).trim().slice(0,200);
      if(!title)return json(res,400,{error:'请填写标题'});
      const item={id:randomUUID(),type,ownerId:session.user.id,sourceId,status:isAdmin?'published':'pending',title,description,tags:marketTags(body.tags),createdAt:Date.now(),reviewedAt:isAdmin?Date.now():null,...record,title,description};
      items[item.id]=item;await persist();await recordSecurityEvent('market_submitted',req,session.user.id,{itemId:item.id,type});
      return json(res,201,{item:marketMine(session.user).find(entry=>entry.id===item.id),published:item.status==='published'});
    }
    const marketItem=pathname.match(/^\/api\/market\/items\/([0-9a-f-]+)$/i);
    if(marketItem&&req.method==='DELETE'){
      const item=marketItems()[marketItem[1]];
      if(!item||(item.ownerId!==session.user.id&&!isAdmin))return json(res,404,{error:'投稿不存在'});
      delete marketItems()[item.id];await persist();return json(res,200,{ok:true});
    }
    if(pathname==='/api/admin/skills'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      const users=Object.values(db.users).filter(user=>user.passwordHash||user.authType==='cindy'),usage=new Map();
      for(const agent of Object.values(db.agents))for(const id of agent.skillIds||[])usage.set(id,(usage.get(id)||0)+1);
      const skills=Object.values(db.skills).sort((a,b)=>b.createdAt-a.createdAt).map(skill=>{const owner=db.users[skill.ownerId];return {id:skill.id,title:skill.title,description:skill.description,ownerId:skill.ownerId,ownerEmail:owner?.email||'（已删除用户）',ownerName:owner?.displayName||owner?.email||'（已删除用户）',shared:Boolean(skill.shared),origin:skill.origin||(skill.marketKey?{kind:skill.marketKey.startsWith('builtin:')?'builtin':skill.marketKey.startsWith('ext:')?'external':'community',name:''}:{kind:'own',name:''}),marketKey:skill.marketKey||'',createdAt:skill.createdAt,length:String(skill.content||'').length,usedByAgents:usage.get(skill.id)||0,preview:String(skill.content||'').slice(0,800)}});
      const templates=Object.values(db.agents).filter(agent=>agent.marketKey).map(agent=>({agentId:agent.id,ownerId:agent.ownerId,ownerEmail:db.users[agent.ownerId]?.email||'（已删除用户）',title:agent.name,marketKey:agent.marketKey,createdAt:agent.createdAt}));
      return json(res,200,{users:users.map(user=>({id:user.id,email:user.email,displayName:user.displayName||user.email,role:user.role,skillCount:skills.filter(skill=>skill.ownerId===user.id).length,installedCount:skills.filter(skill=>skill.ownerId===user.id&&skill.marketKey).length})),skills,templates});
    }
    const adminSkill=pathname.match(/^\/api\/admin\/skills\/([0-9a-f-]+)$/i);
    if(adminSkill&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      const skill=db.skills[adminSkill[1]];if(!skill)return json(res,404,{error:'技能不存在'});
      return json(res,200,{id:skill.id,title:skill.title,description:skill.description,ownerEmail:db.users[skill.ownerId]?.email||'（已删除用户）',content:skill.content});
    }
    if(pathname==='/api/admin/market/presets'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      return json(res,200,{presets:[...marketKit.presets.values()].map(({id,label,kind,free,searchable,fields})=>({id,label,kind,free,searchable,fields}))});
    }
    if(pathname==='/api/admin/market/suggested'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      return json(res,200,{suggested:marketKit.suggested.map(item=>({...item,added:marketSources().some(source=>marketKit.optionOf(source)===item.option&&(!item.repo||String(source.repo||'').toLowerCase()===item.repo.toLowerCase()))}))});
    }
    if(pathname==='/api/admin/market/sources'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      await refreshMarketSources(false);
      return json(res,200,{sources:marketSources().map(sourceView)});
    }
    if(pathname==='/api/admin/market/sources'&&req.method==='POST'){
      if(!isAdmin)return adminOnly();
      const body=await readBody(req),list=marketSources();
      if(list.length>=20)return json(res,400,{error:'外部来源最多 20 个'});
      const preset=marketKit.presetFor(body);
      if(!preset)return json(res,400,{error:'不支持的来源类型'});
      const checked=await marketKit.adapterFor(preset.kind).validate(body,{preset,sources:list,ctx:marketKit.ctx});
      const source={id:randomUUID(),kind:preset.kind,option:preset.id,name:String(body.name||'').trim().slice(0,40)||checked.name||preset.label,enabled:true,createdAt:Date.now(),...checked.fields};
      list.push(source);await persist();await recordSecurityEvent('market_source_added',req,session.user.id,{sourceId:source.id,kind:source.kind});
      await Promise.race([refreshSource(source,true).catch(()=>{}),new Promise(resolve=>setTimeout(resolve,6000))]);
      return json(res,201,{source:sourceView(source)});
    }
    const sourceMatch=pathname.match(/^\/api\/admin\/market\/sources\/([0-9a-f-]+)(\/refresh)?$/i);
    if(sourceMatch){
      if(!isAdmin)return adminOnly();
      const list=marketSources(),source=list.find(item=>item.id===sourceMatch[1]);
      if(!source)return json(res,404,{error:'来源不存在'});
      if(sourceMatch[2]&&req.method==='POST'){await refreshSource(source,true);return json(res,200,{source:sourceView(source)})}
      if(req.method==='PATCH'){const body=await readBody(req);if(typeof body.enabled==='boolean')source.enabled=body.enabled;await persist();if(source.enabled)await refreshSource(source,false);return json(res,200,{source:sourceView(source)})}
      if(req.method==='DELETE'){db.settings.marketSources=list.filter(item=>item.id!==source.id);marketCache.delete(source.id);await persist();return json(res,200,{ok:true})}
    }
    if(pathname==='/api/admin/market'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      const all=Object.values(marketItems()).sort((a,b)=>b.createdAt-a.createdAt).map(marketAdminView);
      return json(res,200,{pending:all.filter(item=>item.status==='pending'),published:all.filter(item=>item.status==='published'),rejected:all.filter(item=>item.status==='rejected')});
    }
    const marketReview=pathname.match(/^\/api\/admin\/market\/([0-9a-f-]+)$/i);
    if(marketReview&&req.method==='PATCH'){
      if(!isAdmin)return adminOnly();
      const item=marketItems()[marketReview[1]],body=await readBody(req);
      if(!item)return json(res,404,{error:'投稿不存在'});
      if(body.action==='approve')item.status='published';
      else if(body.action==='reject'||body.action==='unpublish')item.status='rejected';
      else return json(res,400,{error:'action 必须是 approve / reject / unpublish'});
      item.note=String(body.note||'').trim().slice(0,200);item.reviewedAt=Date.now();
      await persist();await recordSecurityEvent('market_'+body.action,req,session.user.id,{itemId:item.id});
      return json(res,200,{item:marketAdminView(item)});
    }
    // 机器人：给每个机器人一个固定的 Webhook 地址 + 令牌，外部程序（IM 机器人、自动化脚本）POST 文本就能得到智能体的回复
    if(pathname==='/api/bots'&&req.method==='GET')return json(res,200,{bots:Object.values(db.bots).filter(bot=>bot.ownerId===session.user.id).sort((a,b)=>a.createdAt-b.createdAt).map(botSummary)});
    if(pathname==='/api/bots'&&req.method==='POST'){
      if(Object.values(db.bots).filter(bot=>bot.ownerId===session.user.id).length>=10)return json(res,400,{error:'每个账号最多 10 个机器人'});
      const body=await readBody(req),name=String(body.name||'').trim().slice(0,40),agentId=String(body.agentId||'');
      if(!name)return json(res,400,{error:'请填写机器人名称'});
      if(agentId&&!visibleAgent(agentId,session.user))return json(res,400,{error:'所选智能体不存在或不可用'});
      const token=newBotToken(),bot={id:randomUUID(),ownerId:session.user.id,name,agentId:agentId||null,tokenHash:sha(token),tokenPrefix:token.slice(0,8),createdAt:Date.now()};
      db.bots[bot.id]=bot;await persist();return json(res,201,{bot:botSummary(bot),token});
    }
    const apiMemMatch=pathname.match(/^\/api\/api-memory(?:\/([0-9a-f-]+))?$/i);
    if(apiMemMatch){
      const prefix='api:'+session.user.id+':';
      const items=()=>Object.values(db.memories).filter(item=>item.ownerId===session.user.id&&String(item.userId).startsWith(prefix));
      const sessionOf=item=>String(item.userId).slice(prefix.length);
      if(req.method==='GET'&&!apiMemMatch[1])return json(res,200,{enabled:readPrefs(session.user).enabled,memories:items().sort((a,b)=>b.updatedAt-a.updatedAt).map(item=>({...safeMemory(item),session:sessionOf(item)}))});
      if(req.method==='DELETE'){
        const only=url.searchParams.get('session');
        let removed=0;
        for(const item of items()){if(apiMemMatch[1]?item.id===apiMemMatch[1]:(!only||sessionOf(item)===only)){delete db.memories[item.id];removed++}}
        if(apiMemMatch[1]&&!removed)return json(res,404,{error:'记忆不存在'});
        addAudit(db,{userId:session.user.id,action:'api.memory_delete',target:only||apiMemMatch[1]||'全部',detail:'删除 '+removed+' 条',ip:clientIp(req)});
        await persist();return json(res,200,{ok:true,removed});
      }
    }
    const botMemMatch=pathname.match(/^\/api\/bots\/([0-9a-f-]+)\/memories(?:\/([0-9a-f-]+))?$/i);
    if(botMemMatch){
      const bot=db.bots[botMemMatch[1]];
      if(!bot||bot.ownerId!==session.user.id)return json(res,404,{error:'机器人不存在'});
      const sessionOf=item=>String(item.userId).slice(('bot:'+bot.id+':').length);
      if(req.method==='GET'&&!botMemMatch[2])return json(res,200,{enabled:bot.memory!==false,memories:botMemoryItems(bot).sort((a,b)=>b.updatedAt-a.updatedAt).map(item=>({...safeMemory(item),session:sessionOf(item)}))});
      if(req.method==='DELETE'){
        const only=url.searchParams.get('session');
        let removed=0;
        for(const item of botMemoryItems(bot)){if(botMemMatch[2]?item.id===botMemMatch[2]:(!only||sessionOf(item)===only)){delete db.memories[item.id];removed++}}
        if(botMemMatch[2]&&!removed)return json(res,404,{error:'记忆不存在'});
        addAudit(db,{userId:session.user.id,action:'bot.memory_delete',target:bot.name,detail:'删除 '+removed+' 条'+(only?'（会话 '+only+'）':''),ip:clientIp(req)});
        await persist();return json(res,200,{ok:true,removed});
      }
    }
    const botMatch=pathname.match(/^\/api\/bots\/([0-9a-f-]+)(\/rotate)?$/i);
    if(botMatch){
      const bot=db.bots[botMatch[1]];
      if(!bot||bot.ownerId!==session.user.id)return json(res,404,{error:'机器人不存在'});
      if(botMatch[2]&&req.method==='POST'){const token=newBotToken();bot.tokenHash=sha(token);bot.tokenPrefix=token.slice(0,8);await persist();return json(res,200,{bot:botSummary(bot),token})}
      if(req.method==='DELETE'){for(const item of botMemoryItems(bot))delete db.memories[item.id];delete db.bots[bot.id];for(const [key,item]of Object.entries(db.conversations))if(item.botId===bot.id)delete db.conversations[key];await persist();return json(res,200,{ok:true})}
      if(req.method==='PATCH'){
        const body=await readBody(req);
        if(body.name!==undefined){const name=String(body.name).trim().slice(0,40);if(!name)return json(res,400,{error:'名称不能为空'});bot.name=name}
        if(body.agentId!==undefined){const agentId=String(body.agentId||'');if(agentId&&!visibleAgent(agentId,session.user))return json(res,400,{error:'所选智能体不存在或不可用'});bot.agentId=agentId||null}
        if(typeof body.memory==='boolean')bot.memory=body.memory;
        await persist();return json(res,200,{bot:botSummary(bot)});
      }
    }
    // 语音识别：成员读取开关与可选语言；上传录音识别；管理员配置与测试
    if(pathname==='/api/asr/config'&&req.method==='GET'){
      const config=asrConfig();
      return json(res,200,{enabled:Boolean(config.enabled&&asrProviderTarget(config)),languages:ASR_LANGS.map(({id,label,group})=>({id,label,group})),defaultLang:config.defaultLang||'auto',maxSeconds:config.maxSeconds||60});
    }
    if(pathname==='/api/asr'&&req.method==='POST'){
      const config=asrConfig(),target=config.enabled?asrProviderTarget(config):null;
      if(!target)return json(res,404,{error:'语音识别还没有开启，请联系管理员'});
      const mime=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
      if(!AUDIO_TYPES.has(mime))return json(res,415,{error:'不支持的音频格式'});
      const wait=hitWindowLimit(asrHits,session.user.id,30,60*1000);
      if(wait)return json(res,429,{error:'识别太频繁，请 '+wait+' 秒后再试'});
      if((asrBusy.get(session.user.id)||0)>=2)return json(res,429,{error:'上一段还在识别，请稍等'});
      const langId=String(new URL(req.url,'http://x').searchParams.get('lang')||config.defaultLang||'auto');
      if(!ASR_LANGS.some(item=>item.id===langId))return json(res,400,{error:'不支持的语言'});
      asrBusy.set(session.user.id,(asrBusy.get(session.user.id)||0)+1);
      try{
        const audio=await readRaw(req,MAX_AUDIO_BYTES);
        if(audio.length<200)return json(res,400,{error:'没有录到声音'});
        const text=await asrTranscribe({...target,kind:config.kind,model:config.model,langId,audio,mime,hotwords:config.hotwords||''});
        return json(res,200,{text,lang:langId});
      }catch(error){return json(res,error.status||502,{error:error.message})}
      finally{const n=(asrBusy.get(session.user.id)||1)-1;if(n>0)asrBusy.set(session.user.id,n);else asrBusy.delete(session.user.id)}
    }
    if(pathname==='/api/admin/asr'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      return json(res,200,{config:publicAsrConfig(asrConfig()),presets:ASR_PRESETS,kinds:asrKinds(),languages:ASR_LANGS.map(({id,label,group})=>({id,label,group})),providers:[...(modelConfigured?[{id:'builtin',name:'内置服务（环境变量配置）'}]:[]),...Object.values(db.providers).sort((a,b)=>a.createdAt-b.createdAt).map(item=>({id:item.id,name:item.name,baseUrl:item.baseUrl}))]});
    }
    if(pathname==='/api/admin/asr'&&req.method==='PUT'){
      if(!isAdmin)return adminOnly();
      try{
        const body=await readBody(req);
        db.settings.asr=normalizeAsrConfig(body,asrConfig(),id=>id==='builtin'?Boolean(modelConfigured):Boolean(db.providers[id]));
        await persist();await recordSecurityEvent('asr_updated',req,session.user.id,{enabled:db.settings.asr.enabled});
        return json(res,200,{config:publicAsrConfig(db.settings.asr)});
      }catch(error){return json(res,error.status||400,{error:error.message})}
    }
    if(pathname==='/api/admin/asr/test'&&req.method==='POST'){
      if(!isAdmin)return adminOnly();
      const body=await readBody(req);let config;
      try{config=normalizeAsrConfig({...body,enabled:false},asrConfig(),id=>id==='builtin'?Boolean(modelConfigured):Boolean(db.providers[id]))}catch(error){return json(res,400,{error:error.message})}
      const target=asrProviderTarget(config);
      if(!target||!config.model)return json(res,400,{error:'请先选好服务商并填写模型名'});
      const started=Date.now();
      try{const text=await asrTranscribe({...target,kind:config.kind,model:config.model,langId:'auto',audio:silenceWav(),mime:'audio/wav',timeoutMs:30000});return json(res,200,{ok:true,ms:Date.now()-started,detail:'连接成功，服务可以接收录音（测试用的是一段静音，识别结果为空是正常的）',text})}
      catch(error){return json(res,200,{ok:false,ms:Date.now()-started,detail:error.message})}
    }
    if(pathname==='/api/admin/site'&&req.method==='PUT'){
      if(!isAdmin)return adminOnly();
      const body=await readBody(req),name=String(body.name??'').trim().slice(0,30),notice=String(body.notice??'').trim().slice(0,200);
      if(body.mode==='personal'||body.mode==='team')db.settings.mode=body.mode;
      db.settings.site={name,notice};await persist();await recordSecurityEvent('site_updated',req,session.user.id,{mode:appMode()});
      return json(res,200,{name,notice,mode:appMode()});
    }
    // 个人 API 令牌
    if(pathname==='/api/tokens'&&req.method==='GET'){
      return json(res,200,{tokens:Object.values(db.tokens).filter(item=>item.userId===session.user.id).sort((a,b)=>b.createdAt-a.createdAt).map(({id,name,prefix,createdAt,lastUsedAt})=>({id,name,prefix,createdAt,lastUsedAt:lastUsedAt||null}))});
    }
    if(pathname==='/api/tokens'&&req.method==='POST'){
      const body=await readBody(req),name=String(body.name||'').trim().slice(0,60);
      if(!name)return json(res,400,{error:'请为令牌填写名称'});
      if(Object.values(db.tokens).filter(item=>item.userId===session.user.id).length>=10)return json(res,400,{error:'每个账号最多 10 个令牌，请先删除不用的'});
      const token='ymr_'+randomBytes(24).toString('base64url'),record={id:randomUUID(),userId:session.user.id,name,prefix:token.slice(0,10),createdAt:Date.now()};
      db.tokens[sha(token)]=record;await persist();
      return json(res,201,{token,record:{id:record.id,name,prefix:record.prefix,createdAt:record.createdAt,lastUsedAt:null}});
    }
    const tokenMatch=pathname.match(/^\/api\/tokens\/([0-9a-f-]+)$/i);
    if(tokenMatch&&req.method==='DELETE'){
      const key=Object.keys(db.tokens).find(k=>db.tokens[k].id===tokenMatch[1]&&db.tokens[k].userId===session.user.id);
      if(!key)return json(res,404,{error:'令牌不存在'});
      delete db.tokens[key];await persist();return json(res,200,{ok:true});
    }
    // 智能体
    if(pathname==='/api/agents'&&req.method==='GET')return json(res,200,{agents:visibleAgents(session.user).map(agent=>safeAgent(agent,session.user)),models:modelCatalog(session.user).map(item=>item.ref),defaultModel:defaultModelRef(session.user)});
    if(pathname==='/api/agents'&&req.method==='POST'){
      if(Object.values(db.agents).filter(agent=>agent.ownerId===session.user.id).length>=50)return json(res,400,{error:'智能体数量已达上限'});
      const body=await readBody(req),agent={id:randomUUID(),ownerId:session.user.id,createdAt:Date.now(),...parseAgent(body,session.user)};
      db.agents[agent.id]=agent;await persist();return json(res,201,{agent:safeAgent(agent,session.user)});
    }
    const agentMatch=pathname.match(/^\/api\/agents\/([0-9a-f-]+)$/i);
    if(agentMatch&&(req.method==='PATCH'||req.method==='DELETE')){
      const agent=db.agents[agentMatch[1]];
      if(!agent||(agent.ownerId!==session.user.id&&!isAdmin))return json(res,404,{error:'智能体不存在'});
      if(req.method==='DELETE'){delete db.agents[agent.id];await persist();return json(res,200,{ok:true})}
      Object.assign(agent,parseAgent(await readBody(req),session.user,agent));await persist();return json(res,200,{agent:safeAgent(agent,session.user)});
    }
    if(req.method==='POST'&&pathname==='/api/auth/logout'){
      delete db.sessions[session.tokenHash];await persist();setCookie(res,'',0);return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&pathname==='/api/auth/change-password'){
      if(!session.user.passwordHash)return json(res,400,{error:'此账号使用 Cindy 登录，没有本地密码'});
      const body=await readBody(req),oldPassword=String(body.currentPassword||''),newPassword=String(body.newPassword||'');
      if(!(await verifyPassword(oldPassword,session.user.passwordHash)))return json(res,400,{error:'当前密码不正确'});
      if(newPassword.length<16)return json(res,400,{error:'新密码至少需要 16 个字符'});
      session.user.passwordHash=await hashPassword(newPassword);
      for(const [key,value]of Object.entries(db.sessions))if(value.userId===session.user.id&&key!==session.tokenHash)delete db.sessions[key];
      await persist();return json(res,200,{ok:true});
    }
    // ---- 审计日志与按账号统计：成员只能看自己的，主账号可看全部并导出 ----
    if(pathname==='/api/audit'&&req.method==='GET'){
      const q=Object.fromEntries(url.searchParams);
      const filters={userId:isAdmin?(q.user||undefined):session.user.id,action:q.action||undefined,category:q.category||undefined,q:q.q||undefined,ok:q.ok||undefined,from:Number(q.from)||undefined,to:Number(q.to)||undefined,before:Number(q.before)||undefined,limit:q.limit};
      if(isAdmin&&q.email){const target=Object.values(db.users).find(user=>user.email===String(q.email).toLowerCase());filters.userId=target?target.id:'none'}
      return json(res,200,{entries:queryAudit(db,filters),categories:CATEGORY,isAdmin,stored:db.audit.length});
    }
    if(pathname==='/api/dashboard'&&req.method==='GET'){
      let target=isAdmin?null:session.user.id;
      const wanted=String(url.searchParams.get('email')||'').toLowerCase();
      if(isAdmin&&wanted){const found=Object.values(db.users).find(user=>user.email===wanted);target=found?found.id:'none'}
      return json(res,200,{...dashboardData(db,{days:Number(url.searchParams.get('days'))||30,userId:target}),isAdmin,categories:CATEGORY,mode:appMode(),stored:db.audit.length});
    }
    if(pathname==='/api/audit/summary'&&req.method==='GET'){
      const days=Math.min(90,Math.max(1,Number(url.searchParams.get('days'))||30)),result=summarize(db,{days,userId:isAdmin?null:session.user.id});
      for(const row of result.users){const month=monthStat(row.userId);row.monthCalls=month.calls;row.monthTokens=month.totalTokens}
      return json(res,200,{...result,categories:CATEGORY,days,isAdmin});
    }
    if(pathname==='/api/admin/audit.csv'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      const q=Object.fromEntries(url.searchParams),filters={action:q.action||undefined,category:q.category||undefined,q:q.q||undefined,limit:500};
      if(q.email){const target=Object.values(db.users).find(user=>user.email===String(q.email).toLowerCase());filters.userId=target?target.id:'none'}
      addAudit(db,{userId:session.user.id,action:'audit.export',target:'csv',ip:clientIp(req)});
      res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="yumeiro-audit.csv"','Cache-Control':'no-store'});
      return res.end(toCsv(queryAudit(db,filters)));
    }
    // ---- 服务器体检（仅主账号，只读）----
    if(pathname==='/api/admin/doctor'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      const snapshot=await collectDoctor(req,session.user,url.searchParams.get('deep')==='1'),checks=buildChecks(snapshot);
      const result={at:Date.now(),summary:summarizeChecks(checks),checks};result.report=reportText(result,db.settings.site?.name||'Yumeiro');return json(res,200,result);
    }
    // ---- 环境检测与防封守卫（仅主账号）----
    if(pathname==='/api/admin/env'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      const fresh=url.searchParams.get('fresh')==='1',guard=guardConfig();
      // 首次打开不让页面干等探测（最长约 8 秒）：先返回空结果，探测在后台进行，页面稍后轮询
      let result=fresh?await refreshEnv(true):envState.result;
      if(!result&&!fresh){refreshEnv(true).catch(()=>{})}
      return json(res,200,{result,guard:{...guard,proxyUrl:maskProxy(guard.proxyUrl),hasProxy:Boolean(guard.proxyUrl)},defaultRestricted:DEFAULT_RESTRICTED,usage:guardUsage()});
    }
    if(pathname==='/api/admin/env/guard'&&req.method==='PUT'){
      if(!isAdmin)return adminOnly();
      const body=await readBody(req),current=guardConfig();
      let proxyUrl=current.proxyUrl;
      if(body.clearProxy===true)proxyUrl='';
      else if(body.proxyUrl){if(!validProxyUrl(body.proxyUrl))return json(res,400,{error:'出口代理地址必须是 http:// 或 https:// 开头的完整地址'});proxyUrl=String(body.proxyUrl).trim()}
      db.settings.guard=normalizeGuard({...current,...(body.enabled!==undefined?{enabled:Boolean(body.enabled)}:{}),...(body.restricted!==undefined?{restricted:body.restricted}:{}),...(body.hourlyLimit!==undefined?{hourlyLimit:body.hourlyLimit}:{}),...(body.maxConcurrent!==undefined?{maxConcurrent:body.maxConcurrent}:{}),proxyUrl});
      addAudit(db,{userId:session.user.id,action:'settings.guard',target:'env',detail:JSON.stringify({...db.settings.guard,proxyUrl:db.settings.guard.proxyUrl?'（已配置）':''}),ip:clientIp(req)});
      envState.at=0;envState.result=null;await persist();
      const guard=guardConfig();return json(res,200,{guard:{...guard,proxyUrl:maskProxy(guard.proxyUrl),hasProxy:Boolean(guard.proxyUrl)}});
    }
    // ---- 历史记录树（给“历史动画”用）----
    // ---- 语音朗读 ----
    if(pathname==='/api/tts/config'&&req.method==='GET'){const c=ttsConfig();return json(res,200,{enabled:c.enabled&&Boolean(ttsTarget(c)),voices:c.voices,defaultVoice:c.defaultVoice,speed:c.speed,format:c.format,maxChars:c.maxChars,dailyChars:c.dailyChars,usedToday:ttsDayChars(session.user)})}
    if(pathname==='/api/tts'&&req.method==='POST'){
      try{return sendAudio(res,await speakForUser(session.user,await readBody(req,64*1024)))}
      catch(error){return json(res,error.status||502,{error:error.message||'朗读失败'})}
    }
    if(pathname==='/api/admin/tts'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      return json(res,200,{config:publicTtsConfig(ttsConfig()),providers:[...(modelConfigured?[{id:'builtin',name:'内置服务（环境变量配置）'}]:[]),...Object.values(db.providers).sort((a,b)=>a.createdAt-b.createdAt).map(item=>({id:item.id,name:item.name+'　'+item.baseUrl}))]});
    }
    if(pathname==='/api/admin/tts'&&req.method==='PUT'){
      if(!isAdmin)return adminOnly();
      try{
        const body=await readBody(req);
        db.settings.tts=normalizeTtsConfig(body,ttsConfig(),id=>id==='builtin'?Boolean(modelConfigured):Boolean(db.providers[id]));
        addAudit(db,{userId:session.user.id,action:'settings.tts',target:'语音朗读',detail:JSON.stringify({enabled:db.settings.tts.enabled,provider:db.settings.tts.provider,model:db.settings.tts.model}),ip:clientIp(req)});
        ttsCache.clear();ttsCacheBytes=0;
        await persist();return json(res,200,{config:publicTtsConfig(db.settings.tts)});
      }catch(error){return json(res,error.status||400,{error:error.message})}
    }
    if(pathname==='/api/admin/tts/test'&&req.method==='POST'){
      if(!isAdmin)return adminOnly();
      try{
        const body=await readBody(req),config=normalizeTtsConfig({...body,enabled:true},ttsConfig(),id=>id==='builtin'?Boolean(modelConfigured):Boolean(db.providers[id])),target=ttsTarget(config);
        if(!target)throw ttsError('服务商还没配置好',400);
        const started=Date.now(),audio=await requestSpeech(config,target,{text:'你好，这是一次语音合成测试。',voice:config.defaultVoice,speed:1,format:config.format});
        return json(res,200,{ok:true,ms:Date.now()-started,mime:audio.mime,bytes:audio.buffer.length});
      }catch(error){return json(res,200,{ok:false,error:error.message})}
    }
    // ---- 图片理解：上传 / 查看附件，识图服务配置 ----
    if(pathname==='/api/vision/config'&&req.method==='GET'){const c=visionConfig();return json(res,200,{serviceEnabled:Boolean(c.enabled&&c.baseUrl),maxImages:c.maxImages,maxMb:c.maxMb,maxFiles:DOC_LIMITS.maxFiles,maxDocKb:c.maxMb*1024})}
    if(pathname==='/api/attachments'&&(req.method==='PUT'||req.method==='POST')){
      const c=visionConfig(),data=await readRaw(req,c.maxMb*1048576),kind=sniffImage(data);
      const rawName=String(url.searchParams.get('name')||'').replace(/[\u0000-\u001f]/g,'').slice(0,80);
      let doc=null;
      if(!kind){try{doc=await parseDocument(rawName,data,{maxBytes:c.maxMb*1048576})}catch(error){if(error.userFacing)return json(res,400,{error:error.message});throw error}}
      if(!kind&&!doc)return json(res,400,{error:'只支持图片（PNG、JPEG、WebP、GIF）和这些文件：PDF、Word（docx）、Excel（xlsx）、PowerPoint（pptx）、OpenDocument（odt/ods/odp）、EPUB、RTF，以及 txt、md、csv、json、代码等文本文件（不超过 '+c.maxMb+' MB）'});
      const uid=session.user.id,mine=Object.values(db.attachments).filter(item=>item.userId===uid);
      for(const old of mine)if(!old.ref&&Date.now()-old.createdAt>86400000){delete db.attachments[old.id];rm(path.join(attachDir(uid),old.file),{force:true}).catch(()=>{})}
      if(Object.values(db.attachments).filter(item=>item.userId===uid).length>=VISION_LIMITS.perUserKeep)return json(res,400,{error:'图片附件已达上限（'+VISION_LIMITS.perUserKeep+' 张），请删除一些旧对话后再上传'});
      const id=randomUUID(),file=id+'.'+(kind?kind.ext:'txt'),name=rawName||(kind?'图片':'文件');
      await mkdir(attachDir(uid),{recursive:true,mode:0o700});await writeFile(path.join(attachDir(uid),file),kind?data:Buffer.from(doc.text,'utf8'),{mode:0o600});
      db.attachments[id]={id,userId:uid,file,mime:kind?kind.mime:'text/plain; charset=utf-8',bytes:data.length,name,createdAt:Date.now(),ref:false,...(doc?{kind:'doc',format:doc.format}:{})};await persist();
      return json(res,201,{attachment:safeAttachment(db.attachments[id])});
    }
    const attMatch=pathname.match(/^\/api\/attachments\/([0-9a-f-]+)$/i);
    if(attMatch&&(req.method==='GET'||req.method==='DELETE')){
      const record=db.attachments[attMatch[1]];
      if(!record||record.userId!==session.user.id)return json(res,404,{error:'图片不存在'});
      if(req.method==='DELETE'){delete db.attachments[record.id];await rm(path.join(attachDir(record.userId),record.file),{force:true}).catch(()=>{});await persist();return json(res,200,{ok:true})}
      const data=await readFile(path.join(attachDir(record.userId),record.file)).catch(()=>null);
      if(!data)return json(res,404,{error:'图片文件已丢失'});
      res.writeHead(200,{'Content-Type':record.mime,'Content-Length':data.length,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Cache-Control':'private, max-age=3600'});
      return res.end(data);
    }
    if(pathname==='/api/admin/vision'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      return json(res,200,{config:publicVisionConfig(visionConfig()),dialects:VISION_DIALECTS,defaultModels:DEFAULT_VISION_MODELS,defaultPrompt:DEFAULT_PROMPT});
    }
    if(pathname==='/api/admin/vision'&&req.method==='PUT'){
      if(!isAdmin)return adminOnly();
      try{
        db.settings.vision=normalizeVisionConfig(await readBody(req),visionConfig());
        addAudit(db,{userId:session.user.id,action:'settings.vision',target:'图片理解',detail:JSON.stringify({enabled:db.settings.vision.enabled,mode:db.settings.vision.mode,dialect:db.settings.vision.dialect,model:db.settings.vision.model}),ip:clientIp(req)});
        await persist();return json(res,200,{config:publicVisionConfig(db.settings.vision)});
      }catch(error){return json(res,error.status||400,{error:error.message})}
    }
    if(pathname==='/api/admin/vision/test'&&req.method==='POST'){
      if(!isAdmin)return adminOnly();
      try{
        const config=normalizeVisionConfig({...(await readBody(req)),enabled:true},visionConfig()),started=Date.now(),result=await callVision(config,testPng(),'image/png');
        return json(res,200,{ok:true,ms:Date.now()-started,sample:result.text.slice(0,200)});
      }catch(error){return json(res,200,{ok:false,error:error.message})}
    }
    // ---- 远程控制：我的设备（配对 / 画面 / 输入）----
    if(pathname==='/api/remote/pair'&&req.method==='POST'){
      const body=await readBody(req).catch(()=>({})),mine=Object.values(db.remoteDevices).filter(item=>item.ownerId===session.user.id);
      if(mine.length>=REMOTE_LIMITS.maxDevices)return json(res,400,{error:'设备数量已达上限（'+REMOTE_LIMITS.maxDevices+'），请先删除不用的设备'});
      for(const [key,value]of remotePairs)if(value.expires<Date.now())remotePairs.delete(key);
      if([...remotePairs.values()].filter(item=>item.ownerId===session.user.id).length>=5)return json(res,429,{error:'未使用的配对码太多，请等它们过期（10 分钟）后再生成'});
      const code=newPairCode(),control=body.control!==false;
      remotePairs.set(code,{ownerId:session.user.id,name:cleanDeviceName(body.name),control,expires:Date.now()+REMOTE_LIMITS.pairTtlMs});
      addAudit(db,{userId:session.user.id,action:'remote.pair.create',target:cleanDeviceName(body.name)||'新设备',detail:control?'允许控制':'仅查看',ip:clientIp(req)});await persist();
      return json(res,201,{code,control,expiresAt:Date.now()+REMOTE_LIMITS.pairTtlMs});
    }
    if(pathname==='/api/remote/devices'&&req.method==='GET')return json(res,200,{devices:Object.values(db.remoteDevices).filter(item=>item.ownerId===session.user.id).sort((a,b)=>a.pairedAt-b.pairedAt).map(safeRemoteDevice)});
    const remoteMatch=pathname.match(/^\/api\/remote\/devices\/([0-9a-f-]+)(?:\/(frame|input|stop))?$/i);
    if(remoteMatch){
      const device=db.remoteDevices[remoteMatch[1]],action=(remoteMatch[2]||'').toLowerCase();
      if(!device||device.ownerId!==session.user.id)return json(res,404,{error:'设备不存在'});
      const rt=remoteRt(device.id);
      if(!action&&req.method==='DELETE'){
        delete db.remoteDevices[device.id];remoteDrop(device.id);
        addAudit(db,{userId:session.user.id,action:'remote.device.delete',target:device.name,ip:clientIp(req)});await persist();return json(res,200,{ok:true});
      }
      if(!action&&req.method==='PATCH'){
        const body=await readBody(req);
        if(body.name!==undefined){const name=cleanDeviceName(body.name);if(!name)return json(res,400,{error:'名称不能为空'});device.name=name}
        if(body.allowControl!==undefined){
          device.allowControl=Boolean(body.allowControl);if(!device.allowControl)rt.queue.length=0;
          addAudit(db,{userId:session.user.id,action:'remote.control.toggle',target:device.name,detail:device.allowControl?'开启控制':'改为仅查看',ip:clientIp(req)});
        }
        await persist();return json(res,200,{device:safeRemoteDevice(device)});
      }
      if(action==='stop'&&req.method==='POST'){rt.viewerAt=0;rt.queue.length=0;remoteWake(rt);remoteFlushFrameWaiters(rt,device,true);return json(res,200,{ok:true})}
      if(action==='frame'&&req.method==='GET'){
        const since=Number(url.searchParams.get('since')||0)||0,wasWatching=remoteWatching(rt);
        rt.viewerAt=Date.now();
        if(!wasWatching){
          remoteWake(rt);
          if(Date.now()-(rt.viewAuditAt||0)>5*60*1000){rt.viewAuditAt=Date.now();addAudit(db,{userId:session.user.id,action:'remote.view',target:device.name,ip:clientIp(req)});await persist()}
        }
        if(!remoteOnline(device))return remoteNoFrame(res,device,rt);
        if(rt.frame&&rt.seq>since)return remoteSendFrame(res,device,rt);
        const waiter={res,since,device,timer:setTimeout(()=>{rt.frameWaiters.delete(waiter);remoteNoFrame(res,device,rt)},15000)};
        rt.frameWaiters.add(waiter);res.on('close',()=>{clearTimeout(waiter.timer);rt.frameWaiters.delete(waiter)});
        return;
      }
      if(action==='input'&&req.method==='POST'){
        if(!device.allowControl)return json(res,403,{error:'这台设备设置为“仅查看”，请先在设备列表里开启控制'});
        if(!rt.caps.control)return json(res,403,{error:'被控端是以“仅查看”方式启动的（或这台电脑不支持控制），请用 --allow-control 重新启动被控端'});
        if(!remoteOnline(device))return json(res,409,{error:'设备已离线'});
        if(!remoteWatching(rt))return json(res,409,{error:'请先打开画面再操作'});
        const events=cleanInputEvents((await readBody(req,64*1024)).events),now=Date.now();
        if(now-rt.rate.at>=1000){rt.rate={at:now,n:0}}
        rt.rate.n+=events.length;if(rt.rate.n>REMOTE_LIMITS.eventsPerSecond)return json(res,429,{error:'操作太快了，请稍等'});
        rt.queue.push(...events);
        if(rt.queue.length>REMOTE_LIMITS.queueMax)rt.queue.splice(0,rt.queue.length-REMOTE_LIMITS.queueMax);
        const counts=countEvents(events);for(const key of Object.keys(counts))rt.stats[key]=(rt.stats[key]||0)+counts[key];
        if(now-rt.statsAt>60000){rt.statsAt=now;addAudit(db,{userId:session.user.id,action:'remote.control',target:device.name,detail:JSON.stringify(rt.stats),ip:clientIp(req)});rt.stats={events:0,keys:0,textChars:0,clicks:0};await persist()}
        remoteWake(rt);return json(res,200,{ok:true,queued:events.length});
      }
    }
    // ---- 绘画 ----
    if(pathname==='/api/images/config'&&req.method==='GET'){const c=imageConfig();return json(res,200,{enabled:c.enabled&&Boolean(imageTarget(c)),model:c.model||c.dialect,sizes:c.sizes,defaultSize:c.defaultSize,maxPerRequest:c.maxPerRequest,dailyLimit:c.dailyLimit,usedToday:imageDayCount(session.user),allowCustomSize:c.allowCustomSize,minSide:c.minSide,maxSide:c.maxSide,sizeStep:c.sizeStep,maxPixels:c.maxPixels})}
    if(pathname==='/api/images'&&req.method==='POST'){
      try{const body=await readBody(req,64*1024),{saved}=await generateForUser(session.user,body,'web');return json(res,201,{images:saved.map(safeImage),usedToday:imageDayCount(session.user)})}
      catch(error){return json(res,error.status||502,{error:error.message||'绘画失败'})}
    }
    if(pathname==='/api/images'&&req.method==='GET')return json(res,200,{images:Object.values(db.images).filter(item=>item.userId===session.user.id).sort((a,b)=>b.createdAt-a.createdAt).slice(0,Math.min(200,Number(url.searchParams.get('limit'))||60)).map(safeImage)});
    if(pathname==='/api/images/enhance'&&req.method==='POST'){
      const body=await readBody(req),prompt=String(body.prompt||'').trim().slice(0,500);
      if(!prompt)return json(res,400,{error:'请先写一点想画的内容'});
      try{
        ensureModelReady(session.user);
        const result=await askModel([{role:'user',content:'把下面的绘画需求扩写成一段适合文生图模型的详细描述（主体、场景、构图、光线、风格、色彩），保持原意，不要加入原文没有的人名或品牌，不超过 200 字，只输出描述本身：\n'+prompt}],defaultModelRef(session.user),'');
        recordUsage(session.user.id,result.usage,defaultModelRef(session.user),'image-prompt');await persist();
        return json(res,200,{prompt:result.reply.trim().slice(0,1000)});
      }catch(error){return json(res,error.status||502,{error:error.message||'优化失败'})}
    }
    const imageMatch=pathname.match(/^\/api\/images\/([0-9a-f-]{36})(\/file)?$/i);
    if(imageMatch){
      const record=db.images[imageMatch[1]];
      if(!record||record.userId!==session.user.id)return json(res,404,{error:'图片不存在'});
      if(req.method==='GET'&&imageMatch[2]){
        const data=await readFile(path.join(imageDir(record.userId),record.file)).catch(()=>null);
        if(!data)return json(res,404,{error:'图片文件已丢失'});
        res.writeHead(200,{'Content-Type':record.mime,'Content-Length':data.length,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Cache-Control':'private, max-age=3600'});
        return res.end(data);
      }
      if(req.method==='DELETE'&&!imageMatch[2]){
        delete db.images[record.id];await rm(path.join(imageDir(record.userId),record.file),{force:true}).catch(()=>{});
        addAudit(db,{userId:session.user.id,action:'image.delete',target:record.prompt.slice(0,80),ip:clientIp(req)});
        await persist();return json(res,200,{ok:true});
      }
    }
    if(pathname==='/api/admin/images'&&req.method==='GET'){
      if(!isAdmin)return adminOnly();
      return json(res,200,{config:publicImageConfig(imageConfig()),dialects:IMAGE_DIALECTS,batchModes:BATCH_MODES,providers:[...(modelConfigured?[{id:'builtin',name:'内置服务（环境变量配置）'}]:[]),...Object.values(db.providers).sort((a,b)=>a.createdAt-b.createdAt).map(item=>({id:item.id,name:item.name+'　'+item.baseUrl}))]});
    }
    if(pathname==='/api/admin/images'&&req.method==='PUT'){
      if(!isAdmin)return adminOnly();
      try{
        const body=await readBody(req);
        db.settings.image=normalizeImageConfig(body,imageConfig(),id=>id==='builtin'?Boolean(modelConfigured):Boolean(db.providers[id]));
        addAudit(db,{userId:session.user.id,action:'settings.image',target:'绘画',detail:JSON.stringify({enabled:db.settings.image.enabled,provider:db.settings.image.provider,model:db.settings.image.model}),ip:clientIp(req)});
        await persist();return json(res,200,{config:publicImageConfig(db.settings.image)});
      }catch(error){return json(res,error.status||400,{error:error.message})}
    }
    if(pathname==='/api/admin/images/test'&&req.method==='POST'){
      if(!isAdmin)return adminOnly();
      try{
        const body=await readBody(req),config=normalizeImageConfig({...body,enabled:true},imageConfig(),id=>id==='builtin'?Boolean(modelConfigured):Boolean(db.providers[id]));
        const started=Date.now(),images=await callImageApi(config,{prompt:'a small red circle on a plain white background',size:config.sizes[0],n:1,negative:''});
        return json(res,200,{ok:true,ms:Date.now()-started,mime:images[0].mime,bytes:images[0].buffer.length});
      }catch(error){return json(res,200,{ok:false,error:error.message})}
    }
    if(pathname==='/api/history/tree'&&req.method==='GET'){
      const conversations=Object.values(db.conversations).filter(item=>item.userId===session.user.id&&!item.botId).sort((a,b)=>a.createdAt-b.createdAt).slice(-300).map(item=>({id:item.id,title:item.title,createdAt:item.createdAt,updatedAt:item.updatedAt,count:item.messages.length,model:item.model||null,agent:item.agentId?db.agents[item.agentId]?.name||null:null,hasSummary:Boolean(item.summary),preview:String(item.messages.find(m=>m.role==='user')?.content||'').slice(0,80)}));
      return json(res,200,{conversations,memories:userMemories(db,session.user.id).length,workspaces:Object.values(db.workspaces).filter(item=>workspaceFor(item.id,session.user)).length});
    }
    if(pathname==='/api/memories'&&req.method==='GET')return json(res,200,{memories:userMemories(db,session.user.id).sort((a,b)=>(b.pinned-a.pinned)||b.updatedAt-a.updatedAt).map(safeMemory),prefs:readPrefs(session.user),limit:MEMORY_LIMITS.perUser});
    if(pathname==='/api/memories'&&req.method==='POST'){
      const body=await readBody(req),text=cleanText(body.text);
      if(text.length<4)return json(res,400,{error:'记忆内容太短'});
      if(looksSecret(text))return json(res,400,{error:'看起来包含密码或密钥，不会保存'});
      const memory=upsertMemory(db,session.user.id,{text,kind:body.kind,pinned:!!body.pinned,source:'manual'});
      if(!memory)return json(res,400,{error:'记忆已满，请先删除一些'});
      await persist();return json(res,201,{memory:safeMemory(memory)});
    }
    if(pathname==='/api/memories'&&req.method==='DELETE'){for(const memory of userMemories(db,session.user.id))delete db.memories[memory.id];await persist();return json(res,200,{ok:true})}
    if(pathname==='/api/memory/prefs'&&req.method==='PUT'){
      const body=await readBody(req),prefs=readPrefs(session.user);
      for(const key of Object.keys(prefs))if(typeof body[key]==='boolean')prefs[key]=body[key];
      session.user.memoryPrefs=prefs;await persist();return json(res,200,{prefs});
    }
    const memoryMatch=pathname.match(/^\/api\/memories\/([0-9a-f-]+)$/i);
    if(memoryMatch){
      const memory=db.memories[memoryMatch[1]];
      if(!memory||memory.userId!==session.user.id)return json(res,404,{error:'记忆不存在'});
      if(req.method==='DELETE'){delete db.memories[memory.id];await persist();return json(res,200,{ok:true})}
      if(req.method==='PATCH'){
        const body=await readBody(req);
        if(body.text!==undefined){const text=cleanText(body.text);if(text.length<4)return json(res,400,{error:'记忆内容太短'});if(looksSecret(text))return json(res,400,{error:'看起来包含密码或密钥，不会保存'});memory.text=text}
        if(typeof body.pinned==='boolean')memory.pinned=body.pinned;
        if(body.kind==='profile'||body.kind==='note')memory.kind=body.kind;
        memory.updatedAt=Date.now();await persist();return json(res,200,{memory:safeMemory(memory)});
      }
    }
    if(req.method==='POST'&&pathname==='/api/translate'){
      const body=await readBody(req,64*1024),text=String(body.text||'').trim().slice(0,8000);
      if(!text)return json(res,400,{error:'没有要翻译的内容'});
      {const wait=hitWindowLimit(codeAttempts,'tr:'+session.user.id,30,60*1000);if(wait)return json(res,429,{error:'翻译太频繁，请稍后再试'})}
      try{ensureModelReady(session.user)}catch(error){return json(res,error.status||503,{error:error.message})}
      {const over=quotaError(session.user);if(over)return json(res,429,{error:over})}
      const ref=defaultModelRef(session.user);
      try{
        const result=await askModel([{role:'user',content:text}],ref,TRANSLATE_PROMPT);
        recordUsage(session.user.id,result.usage,ref,'translate');await persist();
        return json(res,200,{text:result.reply});
      }catch(error){return json(res,error.status||502,{error:error.message||'翻译失败'})}
    }
    if(req.method==='GET'&&pathname==='/api/conversations'){
      const items=Object.values(db.conversations).filter(item=>item.userId===session.user.id&&!item.botId).sort((a,b)=>b.updatedAt-a.updatedAt).map(safeConversation);
      return json(res,200,{conversations:items});
    }
    if(req.method==='POST'&&pathname==='/api/conversations'){
      const body=await readBody(req),agentId=String(body.agent_id||''),modelRef=String(body.model||'');
      if(agentId&&!visibleAgent(agentId,session.user))return json(res,400,{error:'所选智能体不存在或不可用'});
      if(modelRef&&!resolveModel(modelRef,session.user))return json(res,400,{error:'所选模型不可用'});
      const id=randomUUID(),now=Date.now(),item={id,userId:session.user.id,title:'新对话',createdAt:now,updatedAt:now,messages:[],...(agentId?{agentId}:{}),...(modelRef?{model:modelRef}:{})};
      db.conversations[id]=item;await persist();return json(res,201,{conversation:safeConversation(item)});
    }
    const match=pathname.match(/^\/api\/conversations\/([0-9a-f-]+)$/i);
    if(match&&req.method==='GET'){
      const item=ownedConversation(match[1],session.user.id);
      if(!item)return json(res,404,{error:'对话不存在'});
      return json(res,200,{conversation:safeConversation(item),messages:item.messages});
    }
    if(match&&req.method==='DELETE'){
      const item=ownedConversation(match[1],session.user.id);
      if(!item)return json(res,404,{error:'对话不存在'});
      for(const m of item.messages)for(const image of [...(m.images||[]),...(m.files||[])]){const record=db.attachments[image.id];if(record){delete db.attachments[image.id];rm(path.join(attachDir(record.userId),record.file),{force:true}).catch(()=>{})}}
      delete db.conversations[item.id];await persist();return json(res,200,{ok:true});
    }
    if(match&&req.method==='PATCH'){
      const item=ownedConversation(match[1],session.user.id);
      if(!item)return json(res,404,{error:'对话不存在'});
      const body=await readBody(req),title=String(body.title??'').replace(/\s+/g,' ').trim().slice(0,80);
      const changesModel=body.model!==undefined,changesAgent=body.agent_id!==undefined;
      if(!title&&!changesModel&&!changesAgent)return json(res,400,{error:'标题不能为空'});
      // 对话中途换模型/智能体：历史、摘要、记忆都保留在服务端，下一条消息起由新模型接着聊
      if(changesModel){const ref=String(body.model||'');if(ref&&!resolveModel(ref,session.user))return json(res,400,{error:'所选模型不可用'});if(ref)item.model=ref;else delete item.model}
      if(changesAgent){const agentId=String(body.agent_id||'');if(agentId&&!visibleAgent(agentId,session.user))return json(res,400,{error:'所选智能体不存在或不可用'});if(agentId)item.agentId=agentId;else delete item.agentId}
      if(title)item.title=title;await persist();return json(res,200,{conversation:safeConversation(item)});
    }
    if(req.method==='POST'&&(pathname==='/api/chat'||pathname==='/api/chat/stream')){
      const streaming=pathname==='/api/chat/stream';
      const body=await readBody(req),attIds=Array.isArray(body.attachments)?[...new Set(body.attachments.map(String))].slice(0,visionConfig().maxImages+DOC_LIMITS.maxFiles):[],id=String(body.conversation_id||'');
      let message=String(body.message||'').trim();
      if(!message&&attIds.length)message=attIds.every(x=>db.attachments[x]?.kind==='doc')?'请阅读我上传的文件，并总结其中的要点。':'请看这张图片，描述并分析其中的内容。';
      if(!message||message.length>12000)return json(res,400,{error:'消息不能为空，且不能超过 12000 个字符'});
      const item=ownedConversation(id,session.user.id);
      if(!item)return json(res,404,{error:'对话不存在，请新建对话后重试'});
      if(busyConversations.has(item.id))return json(res,409,{error:'这段对话正在生成回复，请稍候或先停止'});
      try{ensureModelReady(session.user)}catch(error){return json(res,error.status||503,{error:error.message,conversation_id:item.id})}
      {const over=quotaError(session.user);if(over)return json(res,429,{error:over,conversation_id:item.id})}
      const agent=item.agentId?visibleAgent(item.agentId,session.user):null,useModel=pickModel(agent?.model,session.user)||pickModel(item.model,session.user)||defaultModelRef(session.user),useSystem=agent?agentPrompt(agent):systemPrompt;
      const atts=attIds.map(x=>db.attachments[x]).filter(record=>record&&record.userId===session.user.id);
      if(atts.length!==attIds.length)return json(res,400,{error:'附件已失效，请重新上传',conversation_id:item.id});
      const imageAtts=atts.filter(record=>record.kind!=='doc'),docAtts=atts.filter(record=>record.kind==='doc');
      if(imageAtts.length>visionConfig().maxImages)return json(res,400,{error:'一条消息最多带 '+visionConfig().maxImages+' 张图片',conversation_id:item.id});
      if(docAtts.length>DOC_LIMITS.maxFiles)return json(res,400,{error:'一条消息最多带 '+DOC_LIMITS.maxFiles+' 个文件',conversation_id:item.id});
      if(imageAtts.length&&visionRoute(visionConfig(),resolveModel(useModel,session.user)?.model||useModel)==='none')return json(res,400,{error:NO_ROUTE_MESSAGE,conversation_id:item.id});
      busyConversations.add(item.id);
      let memoryUsed=0;
      try{
        if(!item.messages.length)item.title=(atts.length&&message.startsWith('请看这张图片')?'图片分析':atts.length&&message.startsWith('请阅读我上传的文件')?'文件分析':message).replace(/\s+/g,' ').slice(0,48);
        item.messages.push({role:'user',content:message,createdAt:Date.now(),...(imageAtts.length?{images:imageAtts.map(record=>({id:record.id,mime:record.mime,name:record.name}))}:{}),...(docAtts.length?{files:docAtts.map(record=>({id:record.id,name:record.name,bytes:record.bytes}))}:{})});for(const record of atts)record.ref=true;item.updatedAt=Date.now();await persist();
        const history=await chatHistory(item,session.user,useModel);
        const remembered=readPrefs(session.user).enabled?explicitRemember(message):null;
        if(remembered)upsertMemory(db,session.user.id,{text:remembered,kind:'note',pinned:true,source:'manual',conversationId:item.id});
        const memory=memoryContext(session.user,item,message);memoryUsed=memory.used;
        const system=[useSystem,memory.block].filter(Boolean).join('\n\n');
        if(!streaming){
          const result=await askModel(history,useModel,system),reply=result.reply;
          item.messages.push({role:'assistant',content:reply,createdAt:Date.now()});item.updatedAt=Date.now();recordUsage(session.user.id,result.usage,useModel);await persist();
          memoryAfterTurn(session.user,item,message,reply,useModel);
          return json(res,200,{reply,usage:result.usage,memory_used:memoryUsed,conversation_id:item.id,conversation:safeConversation(item),alerts:quotaAlerts(session.user)});
        }
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff',Connection:'keep-alive'});
        const send=(event,data)=>{if(!res.writableEnded&&!res.destroyed)res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n')};
        const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort()});
        send('start',{conversation_id:item.id,memory_used:memoryUsed});
        try{
          const result=await streamModel(history,delta=>send('delta',{text:delta}),abort.signal,useModel,system);
          if(result.reply.trim()){item.messages.push({role:'assistant',content:result.reply,createdAt:Date.now(),...(result.aborted?{partial:true}:{})});item.updatedAt=Date.now()}
          recordUsage(session.user.id,result.usage,useModel);await persist();
          if(!result.aborted)memoryAfterTurn(session.user,item,message,result.reply,useModel);
          send('done',{usage:result.usage,aborted:result.aborted,memory_used:memoryUsed,conversation:safeConversation(item),alerts:quotaAlerts(session.user)});
        }catch(error){
          console.error('模型流式请求失败：',error.message);
          send('error',{error:error.message||'模型服务请求失败'});
        }
        return res.end();
      }catch(error){
        console.error('模型请求失败：',error.message);
        if(res.headersSent){res.end();return}
        return json(res,error.status||502,{error:error.message||'模型服务请求失败',conversation_id:item.id});
      }finally{busyConversations.delete(item.id)}
    }
    return json(res,404,{error:'未找到'});
  }catch(error){
    if((error.status||500)>=500)console.error('请求处理失败：',error);
    if(!res.headersSent)json(res,error.status||500,{error:error.message||'服务器内部错误'});else res.destroy();
  }
});
server.requestTimeout=15*60*1000;
server.on('upgrade',async(req,socket,head)=>{
  try{
    const url=new URL(req.url,'http://'+(req.headers.host||'localhost'));
    if(!url.pathname.startsWith(DESKTOP_PREFIX)||!await desktopAllowed(req)){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return socket.destroy()}
    desktopUpgrade(req,socket,head,url.pathname,url.search);
  }catch{socket.destroy()}
});
const envEvery=Number(process.env.ENV_CHECK_INTERVAL_MS);
if(envEvery!==0){const every=envEvery||5*60*1000;setInterval(()=>refreshEnv(true).catch(()=>{}),every).unref();setTimeout(()=>refreshEnv(true).catch(()=>{}),20000).unref()}
const cleanupEvery=Number(process.env.WORKSPACE_CLEANUP_INTERVAL_MS)||6*3600*1000;
setInterval(()=>autoCleanup().catch(()=>{}),cleanupEvery).unref();
setTimeout(()=>autoCleanup().catch(()=>{}),Math.min(60000,cleanupEvery)).unref();
server.listen(port,process.env.HOST||'0.0.0.0',()=>console.log('Yumeiro web listening on :'+port));
async function shutdown(signal){
  console.log('收到 '+signal+'，正在安全退出…');
  server.close();server.closeIdleConnections?.();
  await Promise.race([storage.close(),new Promise(resolve=>setTimeout(resolve,8000))]).catch(error=>console.error("关闭存储失败：",error.message));
  process.exit(0);
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>shutdown(signal));
