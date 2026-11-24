import express from 'express';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {OAuth2Client} from 'google-auth-library';
import {sample} from './sample.mjs';

const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'8kb'}));
app.use((req,res,next)=>{
  res.set('X-Content-Type-Options','nosniff');
  res.set('Cross-Origin-Opener-Policy','same-origin-allow-popups');
  if(req.path.startsWith('/api/'))res.set('Cache-Control','no-store');
  next();
});
app.use(express.static(fileURLToPath(new URL('./public',import.meta.url))));
const clientId=process.env.GOOGLE_CLIENT_ID;
const geminiKey=process.env.GEMINI_API_KEY;
const model=process.env.GEMINI_MODEL||'gemini-3.1-flash-lite';
const google=new OAuth2Client(clientId);
const work=new Map();
const calls=new Map();
const lifetime=20*60*1000;
const limits={free:12,live:4,global:28};
const schema={
  type:'array',minItems:5,maxItems:5,items:{type:'object',required:['stem','options','answer','explanation','distractors'],
  properties:{stem:{type:'string'},options:{type:'array',minItems:5,maxItems:5,items:{type:'string'}},
  answer:{type:'integer',minimum:0,maximum:4},explanation:{type:'string'},
  distractors:{type:'array',minItems:5,maxItems:5,items:{type:'string'}}}}
};
const prompt='교육용 가상 임상 증례 5개와 각 선택지 5개, 정답 인덱스 0~4, 해설과 보기별 해설을 한국어로 작성해. 정답은 하나이며 정확하고 간결하게. 실제 환자·기출·처방·용량은 사용하지 마.';

async function identity(req){
  const token=req.get('Authorization')?.match(/^Bearer (\S{20,4000})$/)?.[1];
  if(!clientId||!token)return null;
  try{
    const ticket=await google.verifyIdToken({idToken:token,audience:clientId});
    const info=ticket.getPayload();
    return info?.email_verified&&info.sub?info.sub:null;
  }catch{return null;}
}
function rate(key,limit,period){
  const now=Date.now();
  for(const [id,bucket] of calls)if(bucket.until<now)calls.delete(id);
  const bucket=calls.get(key)||{count:0,until:now+period};
  if(bucket.count>=limit||calls.size>=1500)return false;
  bucket.count+=1;
  calls.set(key,bucket);
  return true;
}
function startSet(res,items,owner,source){
  const now=Date.now();
  for(const [id,record] of work)if(record.expiry<now)work.delete(id);
  if(work.size>=500)return res.status(503).json({error:'잠시 후 다시 시도해 주세요.'});
  const id=randomUUID();
  work.set(id,{items,owner,source,expiry:now+lifetime});
  return res.json({id,source,items:items.map(({stem,options})=>({stem,options}))});
}
function valid(items){
  const text=(s,max)=>typeof s==='string'&&s.trim().length>0&&s.length<=max;
  const list=(s,max)=>Array.isArray(s)&&s.length===5&&s.every(v=>text(v,max));
  return Array.isArray(items)&&items.length===5&&new Set(items.map(x=>x?.stem)).size===5&&items.every(x=>
    x&&text(x.stem,1500)&&text(x.explanation,800)&&list(x.options,300)&&new Set(x.options.map(v=>v.trim())).size===5&&
    list(x.distractors,450)&&Number.isInteger(x.answer)&&x.answer>=0&&x.answer<5);
}
app.get('/healthz',(_,res)=>res.json({ready:true,signIn:Boolean(clientId),generation:Boolean(geminiKey)}));
app.get('/api/config',(_,res)=>res.json({clientId:clientId||null,generation:Boolean(geminiKey)}));
app.post('/api/session',async(req,res)=>{
  if(!await identity(req))return res.status(401).json({error:'Google 로그인 확인이 필요합니다.'});
  res.json({signedIn:true});
});
app.post('/api/sample',(req,res)=>{
  if(!rate('sample:'+req.ip,limits.free,60000))return res.status(429).json({error:'잠시 후 다시 시도해 주세요.'});
  startSet(res,sample,null,'sample');
});
app.post('/api/generate',async(req,res)=>{
  const owner=await identity(req);
  if(!owner)return res.status(401).json({error:'Google 계정으로 로그인해 주세요.'});
  if(!geminiKey)return res.status(503).json({error:'AI 모델 연결을 확인 중입니다.'});
  const {keywords}=req.body||{};
  if(!Array.isArray(keywords)||keywords.length<1||keywords.length>5||keywords.some(k=>typeof k!=='string'||!/^[\p{L}\p{N} -]{2,48}$/u.test(k)))
    return res.status(400).json({error:'2~48자의 의학 키워드를 쉼표로 구분해 1~5개 넣어 주세요.'});
  if(!rate('user:'+owner,limits.live,3600000)||!rate('live-all',limits.global,3600000))
    return res.status(429).json({error:'생성 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.'});
  try{
    let response;
    for(const candidate of new Set([model,'gemini-flash-lite-latest'])){
      response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(candidate)+':generateContent',{
        method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':geminiKey},
        signal:AbortSignal.timeout(33000),
        body:JSON.stringify({system_instruction:{parts:[{text:prompt}]},contents:[{role:'user',parts:[{text:'키워드: '+keywords.join(', ')}]}],
          generationConfig:{responseMimeType:'application/json',responseJsonSchema:schema,maxOutputTokens:5000}})
      });
      if(response.status!==503)break;
      console.warn('Gemini temporarily unavailable',candidate);
    }
    if(!response.ok){
      console.warn('Gemini response status',response.status);
      return res.status(response.status===429?429:502).json({error:'AI 모델이 문항 생성을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.'});
    }
    const responseBody=await response.json();
    const items=JSON.parse(responseBody.candidates?.[0]?.content?.parts?.map(part=>part.text||'').join('')||'null');
    if(!valid(items))return res.status(502).json({error:'문항 검증을 통과하지 못했습니다. 다시 생성해 주세요.'});
    startSet(res,items,owner,'gemini');
  }catch{
    res.status(502).json({error:'AI 응답을 받아오지 못했습니다. 잠시 후 다시 시도해 주세요.'});
  }
});
app.post('/api/grade',async(req,res)=>{
  const {id,answers}=req.body||{};
  const record=work.get(id);
  if(!record||record.expiry<Date.now())return res.status(410).json({error:'풀이 시간이 만료되었습니다. 새로운 세트를 열어 주세요.'});
  if(record.owner&&record.owner!==await identity(req))return res.status(401).json({error:'로그인한 계정을 다시 확인해 주세요.'});
  if(!Array.isArray(answers)||answers.length!==5||answers.some(x=>!Number.isInteger(x)||x<0||x>4))
    return res.status(400).json({error:'다섯 문항에 모두 답해 주세요.'});
  if(record.result)return res.json(record.result);
  const results=record.items.map(({answer,explanation,distractors},i)=>({answer,explanation,distractors,selected:answers[i],correct:answer===answers[i]}));
  record.result={score:results.filter(x=>x.correct).length,results};
  res.json(record.result);
});
app.use((error,req,res,next)=>{
  if(res.headersSent)return next(error);
  res.status(400).json({error:'요청 형식을 확인해 주세요.'});
});
app.listen(Number(process.env.PORT||8781),'0.0.0.0');
