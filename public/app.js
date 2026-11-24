const $=id=>document.getElementById(id);
const node=(tag,text)=>{
  const element=document.createElement(tag);
  element.textContent=text;
  return element;
};
let token=null;
let quiz=null;
let config=null;

async function api(path,body){
  const headers={'Content-Type':'application/json'};
  if(token)headers.Authorization='Bearer '+token;
  const result=await fetch('/api/'+path,{method:'POST',headers,body:JSON.stringify(body||{})});
  const data=await result.json();
  if(!result.ok)throw new Error(data.error||'다시 시도해 주세요.');
  return data;
}
async function signIn(login){
  token=login.credential;
  try{
    await api('session');
    $('session').textContent='Google 로그인 확인됨';
    $('signout').hidden=false;
    $('signin').hidden=true;
    $('generate-button').disabled=!config.generation;
    $('status').textContent=config.generation?'키워드를 입력해 문제를 만들 수 있습니다.':'생성 서비스 연결을 확인 중입니다.';
  }catch(error){
    token=null;
    $('status').textContent=error.message;
  }
}
$('signout').addEventListener('click',()=>{
  token=null;quiz=null;
  $('session').textContent='교육용 가상 증례';
  $('signout').hidden=true;
  $('signin').hidden=false;
  $('generate-button').disabled=true;
  $('quiz').hidden=true;
  $('status').textContent='로그아웃했습니다.';
});
async function setup(){
  try{
    config=await fetch('/api/config').then(r=>r.json());
    if(!config.clientId){$('signin').textContent='Google 로그인 연결을 확인 중입니다.';return;}
    for(let i=0;i<30&&!window.google?.accounts?.id;i++)await new Promise(r=>setTimeout(r,200));
    if(!window.google?.accounts?.id){$('signin').textContent='로그인 버튼을 불러오지 못했습니다. 새로고침해 주세요.';return;}
    google.accounts.id.initialize({client_id:config.clientId,callback:signIn,auto_select:false,use_fedcm_for_button:true});
    google.accounts.id.renderButton($('signin'),{type:'standard',theme:'outline',text:'signin_with',locale:'ko'});
  }catch{$('signin').textContent='서비스 설정을 불러오지 못했습니다.';}
}

function render(items,source){
  $('quiz').hidden=false;
  $('quiz-title').textContent=source==='gemini'?'Gemini 생성 문제':'샘플 문제 · 신생아 호흡곤란';
  $('score').textContent='';
  $('answers').querySelector('button').disabled=false;
  $('items').replaceChildren(...items.map(({stem,options},i)=>{
    const field=document.createElement('fieldset');
    field.append(node('legend',`${i+1}. ${stem}`));
    for(const [j,option] of options.entries()){
      const label=document.createElement('label');
      const input=document.createElement('input');
      input.type='radio';input.name='q'+i;input.value=j;input.required=true;
      label.append(input,node('span',option));
      field.append(label);
    }
    return field;
  }));
}
async function start(path,body){
  const sampleButton=$('sample'),generateButton=$('generate-button');
  sampleButton.disabled=generateButton.disabled=true;
  $('status').textContent=path==='generate'?'Gemini가 5문항을 만들고 있습니다.':'샘플을 불러옵니다.';
  try{
    quiz=await api(path,body);
    render(quiz.items,quiz.source);
    $('status').textContent='다섯 문항에 답하면 채점할 수 있습니다.';
  }catch(error){$('status').textContent=error.message;}
  finally{
    sampleButton.disabled=false;
    generateButton.disabled=!token||!config?.generation;
  }
}
$('sample').addEventListener('click',()=>start('sample',{}));
$('generate').addEventListener('submit',event=>{
  event.preventDefault();
  start('generate',{keywords:$('topics').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean)});
});
$('answers').addEventListener('submit',async event=>{
  event.preventDefault();
  const submitting=quiz;
  if(!submitting)return;
  const fields=new FormData(event.currentTarget);
  const button=event.currentTarget.querySelector('button');
  button.disabled=true;
  try{
    const result=await api('grade',{id:submitting.id,answers:submitting.items.map((_,i)=>Number(fields.get('q'+i)))});
    if(quiz!==submitting)return;
    const nodes=[...$('items').children];
    result.results.forEach((row,i)=>{
      const labels=[...nodes[i].querySelectorAll('label')];
      labels[row.answer].classList.add('key');
      nodes[i].disabled=true;
      const detail=node('div','');
      detail.className='explanation';
      detail.append(node('strong',row.correct?'정답':'오답'),node('p',row.explanation));
      const list=node('ul','');
      row.distractors.forEach((reason,j)=>list.append(node('li',`${j+1}번. ${reason}`)));
      detail.append(list);
      nodes[i].append(detail);
    });
    $('score').textContent=`점수 ${result.score} / 5`;
  }catch(error){
    $('score').textContent=error.message;
    button.disabled=false;
  }
});
setup();
