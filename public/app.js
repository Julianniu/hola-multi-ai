// Hola 界面脚本（原来写在 index.html 里）：对话、侧栏、预览、队友、设置、技能库、个人主页
const $ = (s) => document.querySelector(s);
const BUILTIN_COLORS = { claude: '#FF5A4E', codex: '#22D39A', gemini: '#3D7BFF' };
const colorOf = (id) => (S.members.find(m=>m.id===id)||{}).color || BUILTIN_COLORS[id] || '#8C8FB8';
const enabledMembers = () => S.members.filter(m=>m.enabled);
const S = { convs: [], members: [], settings: {}, profile: {}, skills: [], projects: [], cur: null, conv: null, pending: [] };
const nodes = new Map();
const store = { get(k){ try{return localStorage.getItem(k)}catch(_){return null} }, set(k,v){ try{localStorage.setItem(k,v)}catch(_){} } };

// ---------- helpers
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function member(id){return S.members.find(m=>m.id===id)||{id,name:id}}
function nameOf(id){return id==='boss'?(S.profile.name||t('你')):id==='system'?t('系统'):member(id).name}
function fmtTime(ts){return new Date(ts).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}
// ---------- 用量（tokens）
function fmtTok(n){ n=+n||0; return n<1000 ? String(n) : n<1e6 ? (n/1000).toFixed(n<1e4?1:0).replace(/\.0$/,'')+'k' : (n/1e6).toFixed(1).replace(/\.0$/,'')+'M' }
const EN_UI=()=>window.HOLA_LANG==='en';
function usageTip(u){
  const loc=x=>(+x||0).toLocaleString();
  return EN_UI()
    ? `Input ${loc(u.input)} tokens${u.cached?`, of which ${loc(u.cached)} are cached (re-read context, cheaper)`:''}\nOutput ${loc(u.output)} tokens\nOn a subscription this counts toward your plan's quota and isn't billed separately; on an API it's billed at the provider's price.`
    : `输入 ${loc(u.input)} tokens${u.cached?`，其中 ${loc(u.cached)} 是缓存（重复读取的上下文，更省）`:''}\n输出 ${loc(u.output)} tokens\n用订阅时计入订阅额度，不另外收费；用 API 时按服务商的价格计费。`;
}
// 每条回复：用的模型 + 用量
function usageLine(m){
  const parts=[];
  if(m.model) parts.push(esc(m.model) + (m.effort ? ` (${esc(EN_UI()?m.effort:(EFFORT_LABEL[m.effort]||m.effort))})` : ''));
  if(m.usage) parts.push(`<span title="${esc(usageTip(m.usage))}">${EN_UI()?'in':'输入'} ${fmtTok(m.usage.input)} · ${EN_UI()?'out':'输出'} ${fmtTok(m.usage.output)}</span>`);
  return parts.length ? `<span class="usage" data-raw> · ${parts.join(' · ')}</span>` : '';
}
// 本对话里每位队友的用量合计（含整理记忆、整理技能）
function convUsageHTML(){
  const tot={};
  for(const x of (S.conv&&S.conv.messages)||[]) if(x.usage){ const t=tot[x.from]||(tot[x.from]={input:0,cached:0,output:0}); t.input+=x.usage.input||0; t.cached+=x.usage.cached||0; t.output+=x.usage.output||0 }
  const ids=Object.keys(tot); if(!ids.length) return '';
  return `<div class="usage-sum"><b>本对话用量</b>${ids.map(id=>`<div data-raw title="${esc(usageTip(tot[id]))}"><span>${esc(nameOf(id))}</span><span>${EN_UI()?'in':'输入'} ${fmtTok(tot[id].input)} · ${EN_UI()?'out':'输出'} ${fmtTok(tot[id].output)}</span></div>`).join('')}<small>用订阅时计入订阅额度，不另外收费。</small></div>`;
}
function dur(ms){const s=Math.max(0,Math.round(ms/1000));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
function size(n){return n>1e6?(n/1e6).toFixed(1)+' MB':n>1e3?Math.round(n/1e3)+' KB':n+' B'}
function fileUrl(p,dl){return `/files/${S.cur}/${p.split('/').map(encodeURIComponent).join('/')}${dl?'?download':''}`}
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove('show'),2200)}
async function api(p, body){
  const r = await fetch('/api/'+p,{method:'POST',headers:{'Content-Type':'application/json','X-Hola':'1'},body:JSON.stringify(body||{})});
  let j=null; try{ j=await r.json() }catch(_){}
  if(!r.ok&&!(j&&j.error)) throw new Error('请求失败 '+r.status);
  return j||{};
}
function rel(ts){
  const d=Date.now()-ts, m=6e4;
  if(d<m) return '刚刚'; if(d<60*m) return Math.floor(d/m)+' 分钟前';
  const a=new Date(ts), b=new Date(); if(a.toDateString()===b.toDateString()) return fmtTime(ts);
  return (a.getMonth()+1)+'月'+a.getDate()+'日';
}

// ---------- markdown
function mentionRe(){
  const names=enabledMembers().map(m=>m.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).sort((a,b)=>b.length-a.length);
  return new RegExp('@('+[...names,'全员','所有人','大家'].join('|')+')','gi');
}
function inline(s){
  return s.replace(/`([^`\n]+)`/g,(_,c)=>'\u0001'+btoa(unescape(encodeURIComponent(c)))+'\u0001')
    .replace(/\*\*([^*\n]+)\*\*/g,'<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g,'$1<i>$2</i>')
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g,(m,t,u)=>linkHTML(t,u))
    .replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g,'$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(mentionRe(),(m,n)=>{const mm=enabledMembers().find(x=>x.name.toLowerCase()===n.toLowerCase());return `<span class="mention" ${mm?`style="--mc:${mm.color}"`:''}>@${n}</span>`})
    .replace(/\u0001([^\u0001]+)\u0001/g,(_,b)=>'<code>'+decodeURIComponent(escape(atob(b)))+'</code>');
}
// 链接目标：网址照常打开；指向本对话文件夹的路径（绝对路径、file:///、相对路径都行）变成文件链接
function convRel(u){
  u=u.replace(/&amp;/g,'&').replace(/^file:\/+/i,'');
  try{ u=decodeURI(u) }catch(_){}
  u=u.replace(/\\/g,'/');
  if(/^[A-Za-z]:\//.test(u)||u.startsWith('/')){ const k=u.indexOf('/'+S.cur+'/'); if(k<0) return null; u=u.slice(k+S.cur.length+2) }
  u=u.replace(/^\.\//,'');
  if(u.split('/').includes('..')) return null;
  return u; // 空字符串 = 对话文件夹本身
}
function linkHTML(t,u){
  u=u.trim().replace(/^&lt;/,'').replace(/&gt;$/,'').trim();
  if(/^https?:/i.test(u)) return `<a href="${u}" target="_blank" rel="noopener">${t}</a>`;
  const rel=S.cur?convRel(u):null;
  return rel===null ? t : `<a href="#" class="flink" data-file="${esc(rel)}" title="${esc(rel)}">${t}</a>`;
}
function md(src){
  const blocks=[]; let s=String(src||'');
  s=s.replace(/```[^\n]*\n?([\s\S]*?)```/g,(_,c)=>{blocks.push('<pre><code>'+esc(c.replace(/\n$/,''))+'</code></pre>');return '\n\u0000'+(blocks.length-1)+'\u0000\n'});
  const lines=esc(s).split('\n'); const out=[]; let i=0;
  const isRow=l=>/^\s*\|.*\|\s*$/.test(l);
  while(i<lines.length){
    let l=lines[i];
    const blk=l.match(/^\u0000(\d+)\u0000$/); if(blk){out.push(blocks[+blk[1]]);i++;continue}
    if(/^\s*$/.test(l)){i++;continue}
    const h=l.match(/^(#{1,6})\s+(.*)/); if(h){const n=Math.min(5,h[1].length+2);out.push(`<h${n}>${inline(h[2])}</h${n}>`);i++;continue}
    if(/^\s*(-{3,}|\*{3,})\s*$/.test(l)){out.push('<hr>');i++;continue}
    if(isRow(l)&&i+1<lines.length&&/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i+1])&&lines[i+1].includes('-')){
      const cells=r=>r.trim().replace(/^\||\|$/g,'').split('|').map(c=>inline(c.trim()));
      let t='<table><thead><tr>'+cells(l).map(c=>`<th>${c}</th>`).join('')+'</tr></thead><tbody>'; i+=2;
      while(i<lines.length&&isRow(lines[i])){t+='<tr>'+cells(lines[i]).map(c=>`<td>${c}</td>`).join('')+'</tr>';i++}
      out.push(t+'</tbody></table>');continue;
    }
    if(/^\s*&gt;\s?/.test(l)){const q=[];while(i<lines.length&&/^\s*&gt;\s?/.test(lines[i])){q.push(lines[i].replace(/^\s*&gt;\s?/,''));i++}out.push('<blockquote>'+inline(q.join('<br>'))+'</blockquote>');continue}
    const li=l.match(/^\s*([-*•]|\d+[.、)])\s+/);
    if(li){
      const ordered=/\d/.test(li[1]); const items=[];
      while(i<lines.length){const m=lines[i].match(/^\s*([-*•]|\d+[.、)])\s+(.*)/); if(!m) break; items.push(inline(m[2])); i++;
        while(i<lines.length&&/^\s{2,}\S/.test(lines[i])&&!/^\s*([-*•]|\d+[.、)])\s+/.test(lines[i])){items[items.length-1]+='<br>'+inline(lines[i].trim());i++}}
      out.push(`<${ordered?'ol':'ul'}>`+items.map(x=>`<li>${x}</li>`).join('')+`</${ordered?'ol':'ul'}>`);continue;
    }
    const p=[];
    while(i<lines.length&&!/^\s*$/.test(lines[i])&&!/^(#{1,6})\s|^\u0000\d+\u0000$|^\s*([-*•]|\d+[.、)])\s+|^\s*&gt;/.test(lines[i])&&!(isRow(lines[i])&&p.length===0)){p.push(lines[i]);i++}
    if(p.length) out.push('<p>'+inline(p.join('\n')).replace(/\n/g,'<br>')+'</p>'); else {out.push('<p>'+inline(l)+'</p>');i++}
  }
  return out.join('');
}

// ---------- sidebar
function convRow(c, inProj){
  const lamp=c.running?`<span class="lamp run" style="background:${(c.working||[])[0]?colorOf(c.working[0]):'#fff'}"></span>`:'<span class="lamp"></span>';
  const done=c.status==='done';
  const ck=inProj?`<button class="ck" data-status title="${done?'标为进行中':'标为完成'}" aria-label="${done?'标为进行中':'标为完成'}">${done?'<svg class="i"><use href="#i-check"/></svg>':''}</button>`:'';
  return `<div class="conv${c.id===S.cur?' on':''}${inProj&&done?' done':''}" data-id="${c.id}" role="button" tabindex="0" draggable="true">${inProj?ck:lamp}<span class="t" data-raw>${esc(c.title)}</span>${inProj&&c.running?lamp:''}<button class="x" data-menu title="更多" aria-label="更多"><svg class="i" style="width:15px;height:15px"><use href="#i-dots"/></svg></button></div>`;
}
function renderConvs(){
  const el=$('#convs'); const P=S.projects||[];
  const byP=new Map(P.map(p=>[p.id,[]])); const loose=[];
  for(const c of S.convs){ if(c.project&&byP.has(c.project)) byP.get(c.project).push(c); else loose.push(c) }
  let h=`<div class="sechead"><span>项目</span><button data-newproj title="新建项目" aria-label="新建项目"><svg class="i"><use href="#i-plus"/></svg></button></div>`;
  if(!P.length) h+=`<div class="phint">新建一个项目，把相关的对话归进去，每个对话就是一个任务，进度一目了然。</div>`;
  for(const p of P){
    const list=byP.get(p.id).sort((x,y)=>(x.status==='done')-(y.status==='done'));
    const done=list.filter(c=>c.status==='done').length;
    const col=store.get('hola.pc.'+p.id)==='1';
    h+=`<div class="proj${col?' col':''}" data-pid="${p.id}"><button class="ph" data-ptoggle><svg class="i"><use href="#i-chev"/></svg><span class="pn" data-raw>${esc(p.name)}</span><small>${done}/${list.length}</small></button><button class="pa" data-pnew title="在这个项目里新建任务" aria-label="在这个项目里新建任务"><svg class="i"><use href="#i-plus"/></svg></button><button class="pa" data-pedit title="编辑项目" aria-label="编辑项目"><svg class="i"><use href="#i-dots"/></svg></button></div>`;
    if(!col) h+=`<div class="ptasks">${list.map(c=>convRow(c,true)).join('')||'<div class="pempty">还没有任务，点 + 新建，或把对话拖进来</div>'}</div>`;
  }
  const today=new Date().toDateString(); let lastGroup='';
  h+=`<div class="sechead" data-dropnone><span>对话</span></div>`;
  if(!loose.length) h+=`<div class="phint">${S.convs.length?'所有对话都归进了项目':'还没有对话'}</div>`;
  h+=loose.map(c=>{ const g=new Date(c.updated).toDateString()===today?'今天':'更早'; const head=g!==lastGroup?`<h6>${g}</h6>`:''; lastGroup=g; return head+convRow(c,false) }).join('');
  el.innerHTML=h;
  el.querySelectorAll('.conv').forEach(d=>{
    d.onclick=e=>{ if(e.target.closest('[data-menu],[data-status]')||e.target.tagName==='INPUT')return; openConv(d.dataset.id); $('#side').classList.remove('show'); };
    d.onkeydown=e=>{ if(e.key==='Enter'&&e.target===d) openConv(d.dataset.id) };
    d.ondblclick=()=>renameInline(d);
    d.ondragstart=e=>{ e.dataTransfer.setData('text/hola-conv',d.dataset.id); e.dataTransfer.effectAllowed='move'; d.classList.add('dragging') };
    d.ondragend=()=>d.classList.remove('dragging');
  });
  el.querySelectorAll('[data-status]').forEach(b=>b.onclick=e=>{ e.stopPropagation(); const c=S.convs.find(x=>x.id===b.closest('.conv').dataset.id); api('conv/status',{conv:c.id,status:c.status==='done'?'doing':'done'}) });
  el.querySelectorAll('[data-menu]').forEach(b=>b.onclick=e=>{ e.stopPropagation(); convMenu(b, S.convs.find(x=>x.id===b.closest('.conv').dataset.id)) });
  el.querySelector('[data-newproj]').onclick=()=>openProject(null);
  el.querySelectorAll('.proj').forEach(row=>{
    const pid=row.dataset.pid, p=P.find(x=>x.id===pid);
    row.querySelector('[data-ptoggle]').onclick=()=>{ store.set('hola.pc.'+pid, row.classList.contains('col')?'':'1'); renderConvs() };
    row.querySelector('[data-pnew]').onclick=async()=>{ store.set('hola.pc.'+pid,''); const {id}=await api('conv/new',{project:pid}); await openConv(id); $('#side').classList.remove('show'); input.focus() };
    row.querySelector('[data-pedit]').onclick=()=>openProject(p);
  });
  el.querySelectorAll('.proj,[data-dropnone]').forEach(z=>{
    z.ondragover=e=>{ if([...e.dataTransfer.types].includes('text/hola-conv')){ e.preventDefault(); z.classList.add('drop') } };
    z.ondragleave=()=>z.classList.remove('drop');
    z.ondrop=e=>{ e.preventDefault(); z.classList.remove('drop'); const id=e.dataTransfer.getData('text/hola-conv'); if(id) api('conv/project',{conv:id,project:z.dataset.pid||null}) };
  });
  renderCrumb();
}
function renderCrumb(){
  const c=S.convs.find(x=>x.id===S.cur); const p=c&&c.project&&(S.projects||[]).find(x=>x.id===c.project);
  const b=$('#crumb'); b.hidden=!p; if(p){ b.textContent=p.name+' /'; b.onclick=()=>openProject(p) }
}
function closeMenu(){ $('#cmenu').classList.remove('show') }
document.addEventListener('click',e=>{ if(!e.target.closest('#cmenu')) closeMenu() });
window.addEventListener('blur',closeMenu);
function convMenu(btn, c){
  const m=$('#cmenu'); const P=S.projects||[];
  m.innerHTML=`<small>移到项目</small>${P.map(p=>`<button data-mv="${p.id}" class="${c.project===p.id?'on':''}"><span class="pnm" data-raw>${esc(p.name)}</span></button>`).join('')}<button data-mv="" class="${c.project?'':'on'}">不放进项目</button><button data-mvnew>新建项目并移入…</button><hr>
    <button data-st>${c.status==='done'?'标为进行中':'标为完成'}</button><button data-rn>重命名</button><hr><button data-dl class="danger">删除对话</button>`;
  const r=btn.getBoundingClientRect(); m.classList.add('show');
  const mh=m.offsetHeight, mw=m.offsetWidth;
  m.style.left=Math.min(r.left, innerWidth-mw-8)+'px'; m.style.top=(r.bottom+4+mh>innerHeight? Math.max(8,r.top-mh-4) : r.bottom+4)+'px';
  m.querySelectorAll('[data-mv]').forEach(b=>b.onclick=()=>{ closeMenu(); api('conv/project',{conv:c.id,project:b.dataset.mv||null}) });
  m.querySelector('[data-mvnew]').onclick=()=>{ closeMenu(); openProject(null, c.id) };
  m.querySelector('[data-st]').onclick=()=>{ closeMenu(); api('conv/status',{conv:c.id,status:c.status==='done'?'doing':'done'}) };
  m.querySelector('[data-rn]').onclick=()=>{ closeMenu(); const d=$('#convs').querySelector(`.conv[data-id="${c.id}"]`); if(d) renameInline(d) };
  m.querySelector('[data-dl]').onclick=async()=>{ closeMenu();
    if(!confirm(`彻底删除「${c.title}」？\n\n聊天记录、对话记忆、附件和队友做出来的文件都会一起永久删除，无法恢复。`))return;
    await api('conv/delete',{conv:c.id}); if(S.cur===c.id){S.cur=null;S.conv=null;store.set('hola.cur','');renderConv()} };
}
let editingProj=null, projMoveConv=null;
function openProject(p, moveConv){
  editingProj=p||null; projMoveConv=moveConv||null;
  $('#pTitle').textContent=p?'编辑项目':'新建项目';
  $('#pName').value=p?p.name:''; $('#pBrief').value=p?p.brief||'':'';
  $('#pDelete').hidden=!p; $('#pRes').textContent='';
  $('#projDlg').showModal(); $('#pName').focus();
}
$('#pCancel').onclick=()=>$('#projDlg').close();
$('#pSave').onclick=async()=>{
  const name=$('#pName').value.trim(); if(!name){ $('#pRes').textContent=t('请填写项目名称'); $('#pRes').className='testres bad'; return }
  const r=await api('projects/save',{project:{id:editingProj&&editingProj.id,name,brief:$('#pBrief').value}});
  if(r.error){ $('#pRes').textContent=r.error; $('#pRes').className='testres bad'; return }
  if(projMoveConv) await api('conv/project',{conv:projMoveConv,project:r.id});
  $('#projDlg').close(); toast(editingProj?'项目已保存':'项目已创建');
};
$('#pDelete').onclick=async()=>{
  if(!editingProj) return;
  if(!confirm(`删除项目「${editingProj.name}」？\n\n项目里的对话不会被删除，会移到"对话"里。`)) return;
  await api('projects/delete',{id:editingProj.id}); $('#projDlg').close(); toast('已删除');
};
function renameInline(d){
  const c=S.convs.find(x=>x.id===d.dataset.id); const t=d.querySelector('.t');
  const inp=document.createElement('input'); inp.value=c.title; t.replaceWith(inp); inp.focus(); inp.select();
  const done=async ok=>{ if(ok&&inp.value.trim()&&inp.value.trim()!==c.title) await api('conv/rename',{conv:c.id,title:inp.value.trim()}); else renderConvs(); };
  inp.onkeydown=e=>{ if(e.key==='Enter')done(true); if(e.key==='Escape')done(false) };
  inp.onblur=()=>done(true);
}

// ---------- lights / members
function renderLights(){
  const cs = S.conv && S.convs.find(c=>c.id===S.cur);
  const working = (cs && cs.working) || [];
  const act=activeFor(cs), list=enabledMembers(), n=list.length;
  const r=n<=1?0:n===2?5:n===3?6.2:7.5, rad=n<=3?8.5:n<=5?7:6;
  $('#lightsSvg').innerHTML=list.map((m,i)=>{
    const a=-Math.PI/2+(2*Math.PI*i)/Math.max(n,1), x=20+r*Math.cos(a), y=16+r*Math.sin(a);
    const cls=!m.online?'off':working.includes(m.id)?'work':working.length||!act.includes(m.id)?'dim':'';
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad}" fill="${m.color}" style="color:${m.color}" class="${cls}"/>`;
  }).join('');
  const on=list.filter(m=>m.online).length;
  const PH={initial:'各自思考中',discuss:'内部讨论中',conclusion:'整理结论中',decided:'按你的拍板分工中',memory:'整理记忆中',skill:'整理技能中'};
  $('#whoText').textContent = working.length ? (PH[cs.phase] || (working.length>1?`${working.length} 位在干活`:`${member(working[0]).name} 在干活`))
    : list.some(m=>m.problem==='检查中…') ? '检查中' : `${on}/${n} 在线`;
  $('#memberPop').innerHTML = list.map(m=>`<div class="mem-row"><span class="dot" style="background:${m.color};box-shadow:0 0 8px ${m.color}"></span><div><b>${esc(m.name)}</b>${m.type==='api'?' · API':m.access==='full'?' · 完全权限':m.readOnly?' · 只读':''}<p>${esc(m.strengths)}</p><p class="${m.online?'':'bad'}">${m.online?'在线 '+esc(m.version||''):esc(m.problem||'不在线')}${m.model&&m.model!==m.version?` · <span data-raw>${esc(m.model)}</span>`:''}</p></div></div>`).join('') +
    convUsageHTML() +
    `<div style="padding:6px 8px 4px;display:flex;gap:6px"><span class="btn" id="popRecheck" role="button">重新检查</span><span class="btn" id="popTeam" role="button">管理队友</span></div>`;
  const pt=$('#popTeam'); if(pt) pt.onclick=e=>{e.stopPropagation();$('#memberPop').classList.remove('show');openTeam()};
  const rc=$('#popRecheck'); if(rc) rc.onclick=e=>{e.stopPropagation();api('recheck');toast('正在重新检查队友')};
  renderUnder();
}
$('#lights').onclick=e=>{ if(e.target.closest('.pop'))return; $('#memberPop').classList.toggle('show') };
document.addEventListener('click',e=>{ if(!e.target.closest('#lights')) $('#memberPop').classList.remove('show'); if(!e.target.closest('.composer')) hideMpop(); });

function activeFor(c){ const all=enabledMembers().map(m=>m.id); return c&&Array.isArray(c.active)? all.filter(id=>c.active.includes(id)) : all }
function renderUnder(){
  const cs = S.conv && S.convs.find(c=>c.id===S.cur), act=activeFor(cs);
  const hint = '发送：主脑回答 · 开会讨论：大脑们讨论出团队结论 · @ 某人：按 @ 的顺序来';
  $('#under').innerHTML = `<span class="lbl">参与</span>` + enabledMembers().map(m=>{
    const on=act.includes(m.id);
    return `<button class="part${on?'':' off'}${m.online?'':' down'}" style="--mc:${m.color}" data-part="${m.id}" title="${on?'点一下：这次不让 Ta 参与':'点一下：让 Ta 参与'}${m.online?'':'（不在线）'}"><i></i><span>${esc(m.name)}</span>${m.role==='helper'?'<em>帮手</em>':''}</button>`;
  }).join('') + `<span class="hint">${hint}</span>`;
  $('#under').querySelectorAll('[data-part]').forEach(b=>b.onclick=async()=>{
    const id=await ensureConv(); const c=S.convs.find(x=>x.id===id); let a=activeFor(c);
    a = a.includes(b.dataset.part) ? a.filter(x=>x!==b.dataset.part) : [...a,b.dataset.part];
    if(c) c.active=a; renderUnder(); renderLights();
    await api('conv/active',{conv:id,active:a});
  });
}

// ---------- conversation view
async function openConv(id){
  setView('chat');
  // 待发送的附件是传到上一个对话里的：换对话时清掉，免得带到别的对话里找不到文件
  if(id!==S.cur && S.pending.length){ S.pending=[]; renderTray(); updateSend() }
  S.cur=id; store.set('hola.cur',id||''); nodes.clear(); S.conv=null; renderConvs();
  if(!id){renderConv();return}
  const r=await fetch('/api/conv/'+id); if(!r.ok){S.cur=null;renderConv();return}
  S.conv=await r.json(); renderConv();
  if($('#drawer').classList.contains('show')) $('#memText').value=S.conv.memory||'';
}
function renderConvAfter(){ renderUnder() }
function renderConv(){
  const feed=$('#feed'); feed.innerHTML=''; nodes.clear();
  $('#title').textContent = S.conv ? S.conv.title : 'Hola';
  if(!S.conv||!S.conv.messages.length){ renderEmpty(); } else { S.conv.messages.forEach(m=>putMsg(m)); scrollDown(); }
  renderLights(); renderRun(); updateSend(); renderUnder();
}
function renderEmpty(){
  const tries=['新品耳机首发，定价 399 还是 499 更合适？说说理由',
    '@Gemini 先查最近耳机类小红书爆款笔记的风格，@Claude 再据此写 5 篇文案，@Codex 最后整理成 Excel 表',
    '我发了一张竞品海报，大家分别从文案、视觉、卖点三个角度点评一下',
    '@Codex 做一个网页小工具：输入活动预算和达人报价，自动算出投放组合'];
  $('#feed').innerHTML=`<div class="empty"><img class="glow" src="/logo.svg" alt="">
    <h2>${S.profile.callMe?esc(S.profile.callMe)+'，':''}今天让大家一起做什么？</h2>
    <p>直接发送，由主脑回答，最快。值得多想想的问题，点「开会讨论」：几位大脑各自独立作答，再讨论、互相挑战，形成共识后给你一个团队结论。想指定谁做、按什么顺序做，就用 @。图片和文件可以直接拖进来或粘贴。</p>
    <div class="team">${enabledMembers().map(m=>`<div><b><i style="background:${m.color};box-shadow:0 0 8px ${m.color}"></i>${esc(m.name)}</b><span>${esc(m.strengths)}</span></div>`).join('')}</div>
    <div class="tries">${tries.map(t=>`<button>${esc(t)}</button>`).join('')}</div></div>`;
  $('#feed').querySelectorAll('.tries button').forEach(b=>b.onclick=()=>{input.value=b.textContent;autoGrow();updateSend();input.focus()});
}
const scroller=$('#scroll');
function nearBottom(){return scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<160}
function scrollDown(){scroller.scrollTop=scroller.scrollHeight}

const KIND={think:'思考',tool:'动作',result:'结果',log:'日志',error:'出错',say:'说'};
// 平时不给老板看后台过程，用工地黑话包装一下；设置里打开"显示后台过程"才显示原始步骤
const showProc=()=>!!S.settings.showProcess;
const FUN={
  zh:{think:['琢磨中','抓耳挠腮中','盯着天花板想事中','灵光一闪中'],read:['翻资料中','埋头看文件中','戴上老花镜中'],web:['上网冲浪中','出门打听消息中'],
      write:['搬砖中','码字中','砌墙中'],build:['打螺丝中','抡锤子中','拧扳手中','焊接中'],stuck:['被卡住了，换个姿势再来','撞墙了，揉揉头继续'],
      reply:['组织语言中','打草稿中'],idle:['摸鱼中（其实在等结果）','去厕所了，马上回来','泡杯茶先','伸个懒腰']},
  en:{think:['Pondering','Scratching head','Staring at the ceiling','Lightbulb moment'],read:['Digging through files','Reading the fine print','Putting on reading glasses'],web:['Surfing the web','Asking around'],
      write:['Hauling bricks','Typing away','Laying bricks'],build:['Tightening screws','Swinging the hammer','Turning the wrench','Welding'],stuck:['Hit a snag, trying another way','Bumped into a wall, carrying on'],
      reply:['Finding the words','Drafting'],idle:['Slacking off (actually waiting)','Bathroom break, back soon','Making a cup of tea','Stretching']}
};
function stepCat(it){
  if(it.k==='think') return 'think';
  if(it.k==='error') return 'stuck';
  const x=it.t||'';
  if(/^(读取|查找文件|搜索内容)/.test(x)) return 'read';
  if(/^(联网搜索|打开网页|浏览网页)/.test(x)) return 'web';
  if(/^(写入|修改|记入)/.test(x)) return 'write';
  return 'build';
}
function funLabel(m){
  const L=FUN[window.HOLA_LANG==='en'?'en':'zh'];
  const steps=(m.process||[]).filter(x=>x.k==='think'||x.k==='tool'||x.k==='error');
  const lastTs=Math.max(m.startedAt||0,...(m.process||[]).map(x=>x.ts||0));
  const idle=Date.now()-(lastTs||Date.now());
  let cat = !steps.length ? (m.text ? 'reply' : 'think') : idle>45000 ? (m.text ? 'reply' : 'idle') : stepCat(steps[steps.length-1]);
  const pool=L[cat]; const i = cat==='idle' ? Math.floor(idle/20000) : steps.length;
  return pool[i%pool.length];
}
function friendlyErr(text){
  return String(text||'').replace(/\n\n(错误信息：|Error:)\n[\s\S]*?(?=\n\n(常见原因|Common causes)|$)/,'');
}
function stepHTML(it){return `<div class="step ${it.k}"><span class="k">${KIND[it.k]||''}</span><span data-raw>${esc(it.t)}</span></div>`}
function filesHTML(list, boss){
  if(!list||!list.length) return '';
  const dl = f => `<a href="${fileUrl(f.path,true)}" title="下载" aria-label="下载 ${esc(f.name)}"><svg class="i" style="width:15px;height:15px"><use href="#i-down"/></svg></a>`;
  return `<div class="files">${list.map(f=>f.image
    ? `<div class="thumb"><a href="${fileUrl(f.path)}" data-img="${fileUrl(f.path)}" data-rel="${esc(f.path)}"><img src="${fileUrl(f.path)}" alt="${esc(f.name)}" loading="lazy"></a><a class="dl" href="${fileUrl(f.path,true)}" title="下载" aria-label="下载 ${esc(f.name)}"><svg class="i" style="width:15px;height:15px"><use href="#i-down"/></svg></a></div>`
    : f.video
    ? `<div class="media"><video controls preload="metadata" src="${fileUrl(f.path)}"></video><div class="cap"><span title="${esc(f.path)}">${esc(f.name)} · ${size(f.size||0)}</span>${dl(f)}<button data-reveal="${esc(f.path)}" title="在文件夹中显示"><svg class="i" style="width:15px;height:15px"><use href="#i-folder"/></svg></button></div></div>`
    : f.audio
    ? `<div class="audiobox"><audio controls preload="metadata" src="${fileUrl(f.path)}"></audio><div class="cap"><span title="${esc(f.path)}">${esc(f.name)} · ${size(f.size||0)}</span>${dl(f)}<button data-reveal="${esc(f.path)}" title="在文件夹中显示"><svg class="i" style="width:15px;height:15px"><use href="#i-folder"/></svg></button></div></div>`
    : `<div class="chip"><svg class="i" style="width:16px;height:16px;color:var(--ink3)"><use href="#i-file"/></svg><span class="n" data-raw title="${esc(f.path)}">${esc(f.name)}</span><small>${size(f.size||0)}</small>${f.preview?`<button class="pv" data-preview="${esc(f.path)}">预览</button>`:''}<a href="${fileUrl(f.path)}" target="_blank" title="打开"><svg class="i" style="width:15px;height:15px"><use href="#i-open"/></svg></a>${dl(f)}<button data-reveal="${esc(f.path)}" title="在文件夹中显示"><svg class="i" style="width:15px;height:15px"><use href="#i-folder"/></svg></button></div>`).join('')}</div>`;
}
// 讨论没谈拢时，结论下面列出方案让老板拍板
function decideHTML(m){
  if(!m.awaitDecision) return '';
  const open=!m.decided, opts=m.options||[];
  const head = open ? `<div class="decide-h">请你拍板</div>` : m.decided==='other' ? '' : `<div class="decide-h done">${m.decided==='custom'?'你已拍板，队友按你的话执行':'你已拍板，队友按这个方案执行'}</div>`;
  const list = opts.map(o=>`<button class="opt${m.decided===o.key?' on':''}" ${open?`data-decide="${m.id}" data-key="${esc(o.key)}"`:'disabled'}><b>${esc(o.key)}</b><span data-raw>${esc(o.text)}</span></button>`).join('');
  const hint = open ? `<small>${opts.length?'点一个方案，或者直接在下面输入框里说你的决定（不用 @）。':'直接在下面输入框里说你的决定（不用 @）。'}</small>` : '';
  return `<div class="decide${open?' open':''}">${head}${list}${hint}</div>`;
}
function msgHTML(m){
  const running=m.status==='running';
  if(m.from==='system'&&!m.divider) return `<div class="sys">${esc(m.text)}</div>`;
  if(m.reason==='memory'){
    if(running) return `<div class="memline"><svg class="i"><use href="#i-brain"/></svg><span class="beam" style="color:${colorOf(m.from)}"></span>${esc(nameOf(m.from))} 正在整理对话记忆…</div>`;
    return `<div class="memline${m.status==='error'?' err':''}" style="--mc:${colorOf(m.from)}"><svg class="i"><use href="#i-brain"/></svg><span>${m.memoryChanged?'<b>对话记忆已更新</b>'+(window.HOLA_LANG==='en'?': ':'：'):''}<span data-raw>${esc(m.text)}</span></span>${m.memoryChanged?'<span class="link" data-openmem>查看</span>':''}</div>`;
  }
  if(m.reason==='describe'){
    if(running) return `<div class="memline"><svg class="i"><use href="#i-image"/></svg><span class="beam" style="color:${colorOf(m.from)}"></span>${esc(nameOf(m.from))} 正在帮看不到图片的队友看图…</div>`;
    if(m.status!=='done') return `<div class="memline err"><svg class="i"><use href="#i-image"/></svg><span data-raw>${esc(m.text)}</span></div>`;
    return `<div class="memline" style="--mc:${colorOf(m.from)}"><svg class="i"><use href="#i-image"/></svg><span><b>图片说明已写好</b>${window.HOLA_LANG==='en'?': ':'：'}<span data-raw>${esc(m.text)}</span>${window.HOLA_LANG==='en'?` (by ${esc(nameOf(m.from))}, for teammates who can't see images)`:`（${esc(nameOf(m.from))} 看图后写的，给看不到图片的队友）`}</span></div>`;
  }
  if(m.reason==='skill'){
    if(running) return `<div class="memline"><svg class="i"><use href="#i-book"/></svg><span class="beam" style="color:${colorOf(m.from)}"></span>${esc(nameOf(m.from))} 正在把这次的做法整理成技能…</div>`;
    if(m.status!=='done') return `<div class="memline err"><svg class="i"><use href="#i-book"/></svg><span data-raw>${esc(m.text)}</span></div>`;
    return `<div class="memline" style="--mc:${colorOf(m.from)}"><svg class="i"><use href="#i-book"/></svg><span><b>${m.skillUpdated?'技能已更新':'已存为技能'}</b>${window.HOLA_LANG==='en'?': ':'：'}<b data-raw>${esc(m.skillName||'')}</b>${m.text?` · <span data-raw>${esc(m.text)}</span>`:''}</span><span class="link" data-openskill="${esc(m.skillId||'')}">查看</span></div>`;
  }
  if(m.from==='system'&&m.divider) return `<div class="divider"><span><i></i>${esc(m.text)}</span></div>`;
  const tag = m.from==='boss' ? '' : ({main:'主脑',review:'验收',mention:'被你点名',handoff:`${esc(nameOf(m.by))} 交给 Ta`,initial:'独立作答',discuss:`讨论 · 第 ${m.round} 轮`,conclusion:'',decided:'按你的拍板执行',all:'依次发言'})[m.reason]||'';
  const reviewTag = m.reason==='review'&&m.status==='done'&&m.review ? `<span class="review ${m.review}">${({pass:'✓ 验收通过',fixed:'✓ 改好后通过',redo:'退回重做'})[m.review]}</span>` : '';
  const stance = m.reason==='discuss'&&m.status==='done'&&m.stance ? `<span class="stance ${m.stance}">${m.stance==='agree'?'同意':'有异议'}</span>` : '';
  const concl = m.reason==='conclusion';
  const conclHead = concl&&!running ? `<div class="concl-head"><img src="/logo.svg" alt="">团队结论<small>${m.consensus?'大家达成共识':m.awaitDecision?(m.decided?'老板已拍板':'仍有分歧，等你拍板'):'仍有分歧，已写明'}</small>${m.status==='done'?`<button class="save-skill" data-saveskill="${m.id}" title="把这次的做法沉淀到技能库，下次同类任务直接用"><svg class="i"><use href="#i-book"/></svg>存为技能</button>`:''}</div>` : '';
  let body;
  const WK={main:'思考中',review:'验收中',handoff:'接手中',initial:'独立思考中',discuss:'读队友的观点，思考中',conclusion:'整理团队结论',decided:'按你的拍板分工'};
  const sp=showProc(), anySteps=(m.process||[]).some(x=>x.k!=='say');
  const wlabel = !sp&&anySteps ? `<span class="lbl" data-raw data-fun="${m.id}">${esc(funLabel(m))}</span>` : `<span class="lbl">${WK[m.reason]||'正在做'}</span>`;
  if(running&&!m.text) body=`<div class="working"><span class="beam"></span>${wlabel} · <span class="timer" data-start="${m.startedAt}">${dur(Date.now()-m.startedAt)}</span></div>`;
  else body=conclHead+`<div class="md" data-raw>${md(m.status==='error'&&!sp?friendlyErr(m.text):m.text)}</div>`+decideHTML(m)
    // 主脑的回答下面：老板觉得需要，再请大家开会
    +(m.reason==='main'&&m.status==='done'&&!m.escalated?`<button class="escalate" data-escalate="${m.id}" title="其他大脑先各自独立作答，再和主脑一起讨论出团队结论">让大家讨论一下</button>`:'');
  const last=m.process.length?m.process[m.process.length-1]:null;
  const latest = !running ? '' : sp ? (last?`<div class="latest" data-raw>${esc(t(KIND[last.k]||''))}　${esc(last.t.split('\n')[0])}</div>`:'') : (m.text?`<div class="latest" data-raw data-fun="${m.id}">${esc(funLabel(m))}</div>`:'');
  const steps=m.process.filter(it=>it.k!=='say');
  const proc=!sp ? (!running&&m.endedAt&&m.startedAt&&m.from!=='boss'?`<div class="took">${window.HOLA_LANG==='en'?'Worked for ':'忙活了 '}${dur(m.endedAt-m.startedAt)}${usageLine(m)}</div>`:'') : steps.length?`<details class="proc"><summary><svg class="i"><use href="#i-chev"/></svg>过程 ${steps.length} 步${m.endedAt&&m.startedAt?' · 用时 '+dur(m.endedAt-m.startedAt):''}${usageLine(m)}</summary><div class="steps">${steps.map(stepHTML).join('')}</div></details>`:'';
  const state=m.status==='stopped'?' · 已叫停':m.status==='error'?' · 出错':'';
  const files = m.from==='boss' ? filesHTML(m.attachments,true) : '';
  const out = m.from!=='boss' && m.files && m.files.length ? `<div class="filebar">产出 ${m.files.length} 个文件</div>${filesHTML(m.files)}` : '';
  const showBubble = m.text || running || m.from!=='boss';
  const memb = m.from!=='boss';
  const bossPic = !memb && S.profile.avatar ? ` pic" style="background-image:url('${S.profile.avatar}')` : '';
  return `<div class="row ${memb?'mem':'boss'}${concl?' concl':''}"${memb?` style="--mc:${colorOf(m.from)}"`:''}><span class="av ${memb?'mem':'boss'}${bossPic}"></span><div class="col">
    <div class="meta"><span class="who">${esc(nameOf(m.from))}</span>${tag?`<span>${tag}</span>`:''}${stance}${reviewTag}${(m.skills||[]).map(k=>`<span class="skilltag" data-openskill="${esc(k.id)}" title="用了技能库里的这个技能"><svg class="i"><use href="#i-book"/></svg><span data-raw>${esc(k.name)}</span></span>`).join('')}<span>${fmtTime(m.ts)}${state}</span></div>
    ${files}${showBubble?`<div class="bubble${m.status==='error'?' err':''}">${body}${latest}</div>`:''}${out}${proc}</div></div>`;
}
function putMsg(m, stick){
  if(!S.conv) return;
  const keep=stick||nearBottom();
  if($('#feed .empty')) $('#feed').innerHTML='';
  const i=S.conv.messages.findIndex(x=>x.id===m.id); if(i>=0) S.conv.messages[i]=m; else S.conv.messages.push(m);
  const w=document.createElement('div'); w.innerHTML=msgHTML(m); const el=w.firstElementChild;
  const old=nodes.get(m.id);
  if(old){ const od=old.querySelector('details.proc'), nd=el.querySelector('details.proc'); if(od&&nd){nd.open=od.open; nd.querySelector('.steps').scrollTop=od.querySelector('.steps').scrollTop} old.replaceWith(el) }
  else $('#feed').appendChild(el);
  nodes.set(m.id,el); bindFiles(el);
  if(keep) scrollDown();
}
function addStep(id,item){
  if(!S.conv) return; const m=S.conv.messages.find(x=>x.id===id); if(!m) return;
  m.process.push(item); const el=nodes.get(id); if(!el||item.k==='say') return;
  if(!showProc()){
    if(!el.querySelector('[data-fun]')) { putMsg(m); return }
    el.querySelectorAll('[data-fun]').forEach(x=>x.textContent=funLabel(m)); return;
  }
  const keep=nearBottom(); let det=el.querySelector('details.proc');
  if(!det){putMsg(m);return}
  const n=m.process.filter(x=>x.k!=='say').length;
  det.querySelector('summary').innerHTML=`<svg class="i"><use href="#i-chev"/></svg>过程 ${n} 步`;
  const st=det.querySelector('.steps'); const atEnd=st.scrollHeight-st.scrollTop-st.clientHeight<40;
  st.insertAdjacentHTML('beforeend',stepHTML(item)); if(atEnd) st.scrollTop=st.scrollHeight;
  let lt=el.querySelector('.latest'); if(!lt){lt=document.createElement('div');lt.className='latest';el.querySelector('.bubble')?.appendChild(lt)}
  lt.setAttribute('data-raw','');
  lt.textContent=t(KIND[item.k]||'')+'　'+item.t.split('\n')[0];
  if(keep) scrollDown();
}
function bindFiles(el){
  el.querySelectorAll('[data-openskill]').forEach(b=>b.onclick=()=>{ const k=S.skills.find(x=>x.id===b.dataset.openskill); if(k) openSkill(k); else toast('这个技能已经不在技能库里了') });
  el.querySelectorAll('[data-saveskill]').forEach(b=>b.onclick=()=>distillSkill(b.dataset.saveskill));
  el.querySelectorAll('[data-escalate]').forEach(b=>b.onclick=async()=>{ b.disabled=true; const j=await api('discuss',{conv:S.cur,msg:b.dataset.escalate}); if(j.error){ toast(j.error); b.disabled=false } });
  el.querySelectorAll('[data-decide]').forEach(b=>b.onclick=async()=>{
    el.querySelectorAll('[data-decide]').forEach(x=>x.disabled=true);
    const j=await api('decide',{conv:S.cur,msg:b.dataset.decide,option:b.dataset.key}).catch(e=>({error:e.message}));
    if(j.error){ toast(j.error); el.querySelectorAll('[data-decide]').forEach(x=>x.disabled=false); }
  });
  el.querySelectorAll('[data-openmem]').forEach(b=>b.onclick=()=>{ if(!$('#drawer').classList.contains('show')) $('#memBtn').click() });
  el.querySelectorAll('[data-img]').forEach(a=>a.onclick=e=>{e.preventDefault(); if(a.dataset.rel&&!matchMedia('(max-width:760px)').matches) return openPreview(a.dataset.rel); const lb=$('#lightbox');lb.querySelector('img').src=a.dataset.img;lb.classList.add('show')});
  el.querySelectorAll('a.flink').forEach(a=>a.onclick=e=>{e.preventDefault();openFileLink(a.dataset.file)});
  el.querySelectorAll('[data-reveal]').forEach(b=>b.onclick=()=>api('open',{conv:S.cur,file:b.dataset.reveal}));
  el.querySelectorAll('[data-preview]').forEach(b=>b.onclick=()=>openPreview(b.dataset.preview));
}
$('#lightbox').onclick=()=>$('#lightbox').classList.remove('show');
// ---------- 版本标识：官方版 / 开发版 / 非官方修改版（服务端启动时核对签名和文件指纹）
function renderBuild(b){
  const tag=$('#buildTag'); if(!b) return;
  const en=EN_UI(), st=b.status;
  // 平时不在侧栏显示版本号（在设置窗口底部）；只有被改过、不是官方版时才在侧栏提醒
  const warn = st==='modified'||st==='unofficial';
  tag.hidden=!warn; tag.classList.toggle('warn', warn);
  tag.textContent = st==='official' ? 'v'+b.version : st==='dev' ? (en?'Dev':'开发版') : (en?'Unofficial':'非官方版');
  const files=(b.changed||[]).slice(0,8).join(en?', ':'、');
  const msg = st==='official' ? (en?`Official release v${b.version} (${b.date}). Signature verified.`:`官方正式版 v${b.version}（${b.date}），签名校验通过。`)
    : st==='dev' ? (en?"Development copy on the author's computer: free to modify, not checked against the official release.":'作者本机的开发版：可以随意修改，不做官方校验。')
    : (en?`This copy of Hola is not the official release${files?' (changed files: '+files+')':''}. Someone may have modified it. To get the official version, download it again from github.com/Julianniu/hola-multi-ai.`
         :`这份 Hola 不是官方发布的版本${files?'（被改动的文件：'+files+'）':''}，可能被人改过。想用官方版，请到 github.com/Julianniu/hola-multi-ai 重新下载。`);
  tag.title=msg; tag.onclick=()=>alert(msg);
  const label = st==='official' ? (en?'Official release':'官方版') : st==='dev' ? (en?'Development copy':'开发版') : (en?'Not the official release':'非官方版');
  $('#sVersion').textContent = (b.version ? (en?'Version ':'版本 ')+b.version+' · ' : '') + label;
  $('#sVersion').title = msg;
}
// ---------- 图片库 / 文件库：自己上传的 + 所有对话里的附件和队友做的文件
const LIB={kind:null, items:[], filter:'all', q:''};
function setView(v){
  document.body.classList.toggle('view-lib', v!=='chat');
  LIB.kind = v==='chat' ? null : v;
  $('#openImages').classList.toggle('on', v==='images'); $('#openFiles').classList.toggle('on', v==='files');
  if(v!=='chat'){ $('#title').textContent = v==='images'?'图片库':'文件库'; $('#crumb').hidden=true }
}
async function openLib(kind){
  setView(kind); $('#side').classList.remove('show');
  $('#libHint').textContent = kind==='images'
    ? '你上传的图片，和所有对话里的图片（你发的、队友做的）都在这里。点"发到对话"，就放进当前对话的输入框，能看图的队友都看得到。'
    : '你上传的文件，和所有对话里的文件（你发的、队友做的）都在这里。点"发到对话"，就放进当前对话的输入框，Word、Excel、PPT 会自动转成文字版给队友读。';
  await libReload();
}
let libT=null;
function libReload(){ clearTimeout(libT); return new Promise(r=>{ libT=setTimeout(async()=>{ try{ const j=await (await fetch('/api/library')).json(); LIB.items=j.items||[]; LIB.pinBudget=j.pinBudget||12000 }catch(_){ LIB.items=[] } renderLib(); r() }, 120) }) }
// 来源说明（里面有对话标题，所以整段不交给翻译，直接按界面语言写）
function libSource(it){
  const en=EN_UI();
  if(it.from==='upload') return en?'Uploaded by me':'我上传的';
  const who = it.from==='boss' ? (en?'sent by you':'你发的') : (en?`made by ${nameOf(it.from)}`:`${nameOf(it.from)} 做的`);
  return en ? `"${it.conv.title}" · ${who}` : `「${it.conv.title}」· ${who}`;
}
function renderLib(){
  if(!LIB.kind) return;
  const q=LIB.q.trim().toLowerCase();
  const list=LIB.items.filter(it=>(LIB.kind==='images')===!!it.image)
    .filter(it=>LIB.filter==='all'||(LIB.filter==='upload')===(it.from==='upload'))
    .filter(it=>!q||it.name.toLowerCase().includes(q)||(it.conv&&it.conv.title.toLowerCase().includes(q)));
  const box=$('#libItems');
  box.className='libitems '+(LIB.kind==='images'?'grid':'list');
  // 常驻资料：每次干活所有队友都会看到，所以提醒一下字数
  const pins=LIB.items.filter(it=>it.pinned), total=pins.reduce((n,it)=>n+(it.chars||0),0), en=EN_UI(), fmt=n=>n.toLocaleString();
  $('#libPins').hidden = LIB.kind!=='files' || !pins.length;
  $('#libPins').classList.toggle('over', total>LIB.pinBudget);
  $('#libPins').textContent = en
    ? `Pinned: ${pins.length} file(s), ${fmt(total)} characters. Every teammate reads them in every chat.${total>LIB.pinBudget?` Over the ${fmt(LIB.pinBudget)}-character limit: each file will be cut short.`:''}`
    : `常驻资料 ${pins.length} 份，共 ${fmt(total)} 字：所有对话的队友每次都会看到。${total>LIB.pinBudget?`超过了 ${fmt(LIB.pinBudget)} 字的上限，每份会被截短。`:''}`;
  if(!list.length){ box.innerHTML=`<div class="libempty">${LIB.items.length?'没有符合条件的文件':'这里还是空的。点右上角"上传"，或者把文件拖进来。'}</div>`; return }
  const acts=it=>`<div class="libacts"><button class="libsend" data-lsend="${esc(it.id)}">发到对话</button>${it.pinnable?`<button data-lpin="${esc(it.id)}" title="所有对话的队友每次都会参考这份资料">${it.pinned?'取消常驻':'设为常驻'}</button>`:''}${(it.preview||it.image)?`<button data-lpv="${esc(it.id)}">预览</button>`:''}<a href="${it.url}?download" title="下载">下载</a>${it.conv?`<button data-lconv="${esc(it.conv.id)}">打开对话</button>`:`<button data-ldel="${esc(it.id)}">删除</button>`}</div>`;
  box.innerHTML = list.map(it=> LIB.kind==='images'
    ? `<div class="libcard"><button class="ph" data-lpv="${esc(it.id)}" aria-label="预览"><img src="${it.url}" alt="" loading="lazy"></button><div class="mt"><b data-raw>${esc(it.name)}</b><small data-raw>${esc(libSource(it))}</small></div>${acts(it)}</div>`
    : `<div class="librow"><svg class="i"><use href="#i-file"/></svg><div class="nm"><b data-raw>${esc(it.name)}</b><small data-raw>${esc(size(it.size))} · ${esc(libSource(it))}${it.pinned?` · <span class="pin">${EN_UI()?`pinned, ${(it.chars||0).toLocaleString()} chars`:`常驻 · ${(it.chars||0).toLocaleString()} 字`}</span>`:''}</small></div>${acts(it)}</div>`).join('');
  const find=id=>LIB.items.find(x=>x.id===id);
  box.querySelectorAll('[data-lpv]').forEach(b=>b.onclick=()=>{ const it=find(b.dataset.lpv); if(it) openPreviewUrl(it.name, it.image?it.url:it.previewUrl, it.url, it.image) });
  box.querySelectorAll('[data-lconv]').forEach(b=>b.onclick=()=>openConv(b.dataset.lconv));
  box.querySelectorAll('[data-ldel]').forEach(b=>b.onclick=async()=>{ const it=find(b.dataset.ldel); if(!it||!confirm(`删除「${it.name}」？会从资料库文件夹里永久删除。`)) return; const r=await api('library/delete',{id:it.id}); if(r.error) toast(r.error); else libReload() });
  box.querySelectorAll('[data-lsend]').forEach(b=>b.onclick=()=>libSend(find(b.dataset.lsend)));
  box.querySelectorAll('[data-lpin]').forEach(b=>b.onclick=async()=>{ const it=find(b.dataset.lpin); if(!it) return; const r=await api('library/pin',{id:it.id,on:!it.pinned}); if(r.error) toast(r.error); else { toast(it.pinned?'已取消常驻':'已设为常驻：队友每次都会参考'); libReload() } });
}
// 发到对话：复制进当前对话（没有就新建一个），放进输入框上方，写上要做什么再发
async function libSend(it){
  if(!it) return;
  const id = S.cur || (await api('conv/new')).id;
  const info = await api('library/attach',{conv:id, id:it.id});
  if(!info||info.error){ toast(info&&info.error||'发送失败'); return }
  if(id!==S.cur) await openConv(id); else setView('chat');
  S.pending.push({name:info.name, done:true, path:info.path, preview: it.image?it.url:''});
  renderTray(); updateSend(); input.focus();
  toast('已放进输入框，写上要做什么再发送');
}
async function libUploadFiles(files){
  for(const f of files){
    const r=await fetch(`/api/library/upload?name=${encodeURIComponent(f.name||'file')}`,{method:'POST',headers:{'X-Hola':'1','Content-Type':'application/octet-stream'},body:f}).then(r=>r.json()).catch(()=>({error:1}));
    if(r.error) toast('上传失败：'+(f.name||''));
  }
  libReload();
}
$('#openImages').onclick=()=>openLib('images');
$('#openFiles').onclick=()=>openLib('files');
$('#libUpload').onclick=()=>$('#libFile').click();
$('#libFile').onchange=e=>{ libUploadFiles([...e.target.files]); e.target.value='' };
$('#libFilter').querySelectorAll('button').forEach(b=>b.onclick=()=>{ LIB.filter=b.dataset.f; $('#libFilter').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b)); renderLib() });
$('#libSearch').oninput=e=>{ LIB.q=e.target.value; renderLib() };

// ---------- 右侧分屏预览（和聊天并排，中间的分隔线可以拖动）
const IMG_RE=/\.(png|jpe?g|gif|webp|bmp|svg)$/i, PREVIEW_RE=/\.(docx|xlsx|pptx|pdf|csv|tsv|md|txt|json)$/i;
function openPreview(p){
  const img=IMG_RE.test(p);
  openPreviewUrl(p.split('/').pop(), img?fileUrl(p):`/preview/${S.cur}/${p.split('/').map(encodeURIComponent).join('/')}`, fileUrl(p), img, p);
}
// name：显示的名字；viewUrl：预览栏里显示什么；rawUrl：原文件（下载用）；img：是不是图片
function openPreviewUrl(name, viewUrl, rawUrl, img, title){
  setWebMode(false);
  $('#spName').textContent=name; $('#spName').title=title||name;
  $('#spDown').href=rawUrl+(rawUrl.includes('?')?'&':'?')+'download'; $('#spOpen').href=viewUrl;
  $('#spImg').hidden=!img; $('#spFrame').hidden=img;
  if(img){ $('#spImg').querySelector('img').src=viewUrl; $('#spFrame').src='about:blank' } else $('#spFrame').src=viewUrl;
  $('#split').hidden=false; $('#splitGrip').hidden=false;
}
function closePreview(){ setWebMode(false); $('#split').hidden=true; $('#splitGrip').hidden=true; $('#spFrame').src='about:blank'; $('#spImg').querySelector('img').removeAttribute('src') }
$('#spClose').onclick=closePreview;

// ---------- 内置浏览器（只在桌面版里有）：开在右侧分屏里，你和队友都能用
// 真正的网页由桌面版外壳摆在 #spWeb 的位置上，盖在页面上面；所以有弹窗、看大图时要先把它收起来
const BR=window.holaDesktop&&window.holaDesktop.browser||null;
let webOn=false, webHasPage=false, webAsks=0;
function setWebMode(on){ webOn=on; $('#split').classList.toggle('web',on); syncWeb() }
function syncWeb(){
  if(!BR) return;
  const covered=!!document.querySelector('dialog[open]')||$('#lightbox').classList.contains('show');
  const r=webOn&&webHasPage&&!$('#split').hidden&&!covered?$('#spWeb').getBoundingClientRect():null;
  BR.setBounds(r&&r.width>0&&r.height>0?{x:r.left,y:r.top,width:r.width,height:r.height}:null);
}
function openBrowser(){
  if(!BR) return;
  $('#split').hidden=false; $('#splitGrip').hidden=false;
  $('#spFrame').src='about:blank'; $('#spImg').querySelector('img').removeAttribute('src');
  setWebMode(true);
  if(!webHasPage) $('#bUrl').focus();
}
function webState(s){
  if(!s) return;
  webHasPage=!!s.url&&s.url!=='about:blank';
  if(document.activeElement!==$('#bUrl')) $('#bUrl').value=webHasPage?s.url:'';
  $('#bBack').disabled=!s.canBack; $('#bFwd').disabled=!s.canForward;
  $('#spBar').classList.toggle('loading',!!s.loading);
  if(s.error==='blocked') toast('内置浏览器不打开本机地址和本地文件');
  else if(s.error) toast('打不开这个网页');
  if(s.reveal&&!webOn) openBrowser(); else syncWeb();
}
// 谁正在用浏览器、谁在等你点头
function renderBrowser(){
  const b=S.browser||{};
  const d=b.driver;
  $('#bDriver').hidden=!d;
  if(d) $('#bDriver').textContent=window.HOLA_LANG==='en'?`${d.name} is using it`:`${d.name} 正在用`;
  const asks=b.asks||[];
  if(asks.length>webAsks&&!document.hasFocus()&&window.holaDesktop&&window.holaDesktop.attention) window.holaDesktop.attention();
  webAsks=asks.length;
  $('#bAsks').innerHTML=asks.map(a=>`<div class="bask" data-id="${esc(a.id)}"><div class="bq"><b data-raw>${esc(a.name)}</b> <span>想在内置浏览器里操作</span></div><div class="bd" data-raw>${esc(a.detail)}</div>${a.convTitle?`<div class="bc"><span>来自对话</span> <span data-raw>${esc(a.convTitle)}</span></div>`:''}<div class="bb"><button class="btn pri" data-bans="once">允许</button><button class="btn" data-bans="conv">这个对话都允许</button><button class="btn" data-bans="no">不允许</button></div></div>`).join('');
  $('#bAsks').querySelectorAll('[data-bans]').forEach(btn=>btn.onclick=()=>{ btn.closest('.bask').classList.add('done'); api('browser/answer',{id:btn.closest('.bask').dataset.id,answer:btn.dataset.bans}) });
  // 队友要点网页了：把浏览器打开，让你看到它要点的是哪个网页
  if(asks.length&&!webOn) openBrowser();
}
// 1.2 起直接发送由主脑回答：第一次打开时提示一下新用法
if(!store.get('hola.notice12')) $('#v12Notice').hidden=false;
$('#v12Ok').onclick=()=>{ $('#v12Notice').hidden=true; store.set('hola.notice12','1') };
if(BR){
  $('#browserBtn').hidden=false; $('#sBrowserField').hidden=false;
  $('#browserBtn').onclick=()=>webOn&&!$('#split').hidden?closePreview():openBrowser();
  $('#bClose').onclick=closePreview;
  $('#bBack').onclick=()=>BR.back().then(webState);
  $('#bFwd').onclick=()=>BR.forward().then(webState);
  $('#bReload').onclick=()=>BR.reload().then(webState);
  $('#bUrl').onkeydown=e=>{ if(e.key==='Enter'&&e.target.value.trim()){ e.preventDefault(); BR.open(e.target.value.trim()).then(webState); e.target.blur() } };
  $('#bUrl').onfocus=e=>e.target.select();
  BR.onState(webState);
  BR.state().then(webState);
  new ResizeObserver(syncWeb).observe($('#spWeb'));
  addEventListener('resize',syncWeb);
  new MutationObserver(syncWeb).observe($('#lightbox'),{attributes:true,attributeFilter:['class']});
}
// AI 回复里的文件链接：能预览的在右边打开，文件夹在资源管理器里打开，其他的直接下载
function openFileLink(rel){
  if(/\/$/.test(rel)||!/\.[A-Za-z0-9]{1,8}$/.test(rel)) return api('open',{conv:S.cur,file:rel.replace(/\/$/,'')});
  if(PREVIEW_RE.test(rel)||IMG_RE.test(rel)) return openPreview(rel);
  location.href=fileUrl(rel,true);
}
setInterval(()=>{
  document.querySelectorAll('.timer').forEach(t=>t.textContent=dur(Date.now()-Number(t.dataset.start)));
  if(S.conv) document.querySelectorAll('[data-fun]').forEach(x=>{ const m=S.conv.messages.find(y=>y.id===x.dataset.fun); if(m){ const v=funLabel(m); if(x.textContent!==v) x.textContent=v } });
},1000);

function renderRun(){
  const c=S.convs.find(x=>x.id===S.cur);
  $('#stopBtn').classList.toggle('show',!!(c&&c.running));
  renderLights();
}

// ---------- composer
const input=$('#input');
function autoGrow(){input.style.height='auto';input.style.height=Math.min(input.scrollHeight,220)+'px'}
function updateSend(){ $('#sendBtn').disabled = $('#meetBtn').disabled = !(input.value.trim()||S.pending.some(p=>p.done)) || S.pending.some(p=>!p.done) }
input.addEventListener('input',()=>{autoGrow();updateSend();checkMention()});
input.addEventListener('keydown',e=>{
  if($('#mpop').classList.contains('show')&&['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(e.key)){mpopKey(e);return}
  if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send()}
});
async function ensureConv(){ if(S.cur&&S.conv) return S.cur; const {id}=await api('conv/new'); await openConv(id); return id }
async function send(mode){
  const text=input.value.trim(); const atts=S.pending.filter(p=>p.done).map(p=>({path:p.path}));
  if(!text&&!atts.length) return; if(S.pending.some(p=>!p.done)){toast('附件还在上传');return}
  const id=await ensureConv();
  input.value=''; S.pending=[]; renderTray(); autoGrow(); updateSend();
  try{ await api('send',{conv:id,text,attachments:atts,...(mode==='discuss'?{mode}:{})}) }catch(e){ toast('发送失败：Hola 后台可能没在运行') }
}
$('#sendBtn').onclick=()=>send();
$('#meetBtn').onclick=()=>send('discuss');
$('#stopBtn').onclick=()=>S.cur&&api('stop',{conv:S.cur});

// mentions popup
let mIdx=0, mStart=-1;
function mentionOptions(q){
  const all=[...enabledMembers().map(m=>({v:m.name,id:m.id,d:m.online?'':'不在线'})),{v:'全员',id:'all',d:'开会讨论'}];
  return all.filter(o=>o.v.toLowerCase().startsWith(q.toLowerCase()));
}
function checkMention(){
  const pos=input.selectionStart, before=input.value.slice(0,pos), m=before.match(/@([A-Za-z一-龥]*)$/);
  if(!m){hideMpop();return}
  mStart=pos-m[0].length; const opts=mentionOptions(m[1]); if(!opts.length){hideMpop();return}
  mIdx=Math.min(mIdx,opts.length-1);
  const p=$('#mpop'); p.innerHTML=opts.map((o,i)=>`<button class="${i===mIdx?'sel':''}" data-v="${esc(o.v)}"><i style="background:${o.id==='all'?'conic-gradient(#FF5A4E,#22D39A,#3D7BFF,#FF5A4E)':colorOf(o.id)}"></i>${esc(o.v)}<small>${esc(o.d)}</small></button>`).join('');
  p.classList.add('show'); p.querySelectorAll('button').forEach(b=>b.onmousedown=e=>{e.preventDefault();pickMention(b.dataset.v)});
}
function hideMpop(){$('#mpop').classList.remove('show');mIdx=0}
function mpopKey(e){
  const bs=[...$('#mpop').querySelectorAll('button')];
  if(e.key==='Escape'){hideMpop();return}
  e.preventDefault();
  if(e.key==='ArrowDown'){mIdx=(mIdx+1)%bs.length;checkMention()}
  else if(e.key==='ArrowUp'){mIdx=(mIdx-1+bs.length)%bs.length;checkMention()}
  else pickMention(bs[mIdx].dataset.v);
}
function pickMention(v){
  const pos=input.selectionStart; input.value=input.value.slice(0,mStart)+'@'+v+' '+input.value.slice(pos);
  const np=mStart+v.length+2; input.setSelectionRange(np,np); hideMpop(); input.focus(); updateSend();
}
function insertMention(v){
  const pos=input.selectionStart??input.value.length; const pre=input.value.slice(0,pos); const sp=pre&&!/\s$/.test(pre)?' ':'';
  input.value=pre+sp+'@'+v+' '+input.value.slice(pos); const np=(pre+sp+'@'+v+' ').length; input.focus(); input.setSelectionRange(np,np); autoGrow(); updateSend();
}

// attachments
function renderTray(){
  $('#tray').innerHTML=S.pending.map((p,i)=>`<div class="item${p.done?'':' up'}">${p.preview?`<img src="${p.preview}" alt="">`:'<svg class="i" style="color:var(--ink3)"><use href="#i-file"/></svg>'}<span class="n" data-raw>${esc(p.name)}</span><button class="rm" data-rm="${i}" aria-label="移除"><svg class="i" style="width:14px;height:14px"><use href="#i-x"/></svg></button></div>`).join('');
  $('#tray').querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{S.pending.splice(+b.dataset.rm,1);renderTray();updateSend()});
}
async function addFiles(files){
  if(!files.length) return;
  const id=await ensureConv();
  for(const f of files){
    const name=f.name&&f.name!=='image.png'?f.name:`粘贴图片-${new Date().toTimeString().slice(0,8).replace(/:/g,'')}.png`;
    const p={name,done:false,preview:f.type.startsWith('image/')?URL.createObjectURL(f):''}; S.pending.push(p); renderTray(); updateSend();
    try{
      const r=await fetch(`/api/upload?conv=${id}&name=${encodeURIComponent(name)}`,{method:'POST',headers:{'X-Hola':'1','Content-Type':'application/octet-stream'},body:f});
      const info=await r.json(); if(!r.ok||info.error) throw new Error(info.error);
      Object.assign(p,{done:true,path:info.path,name:info.name});
    }catch(e){ S.pending.splice(S.pending.indexOf(p),1); toast('上传失败：'+name) }
    renderTray(); updateSend();
  }
}
$('#attachBtn').onclick=()=>$('#fileInput').click();
$('#fileInput').onchange=e=>{addFiles([...e.target.files]);e.target.value=''};
input.addEventListener('paste',e=>{const fs=[...(e.clipboardData?.files||[])]; if(fs.length){e.preventDefault();addFiles(fs)}});
let dragN=0; const main=$('#main');
main.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){dragN++;$('#drop').classList.add('show')}});
main.addEventListener('dragleave',()=>{if(--dragN<=0){dragN=0;$('#drop').classList.remove('show')}});
main.addEventListener('dragover',e=>e.preventDefault());
main.addEventListener('drop',e=>{e.preventDefault();dragN=0;$('#drop').classList.remove('show');(LIB.kind?libUploadFiles:addFiles)([...e.dataTransfer.files])});

// header buttons
$('#newConv').onclick=async()=>{setView('chat');const {id}=await api('conv/new');await openConv(id);input.focus();$('#side').classList.remove('show')};
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='n'){e.preventDefault();$('#newConv').click()} if(e.key==='Escape'){if(!document.querySelector('dialog[open]')&&!$('#split').hidden&&!$('#lightbox').classList.contains('show')&&!$('#drawer').classList.contains('show'))closePreview();$('#lightbox').classList.remove('show');$('#drawer').classList.remove('show');$('#memBtn').classList.remove('on')}});
$('#dirBtn').onclick=()=>LIB.kind?api('open',{library:true}):api('open',{conv:S.cur||undefined});
// ---------- 布局：侧栏可拖宽 / 收起，聊天区三档宽度，分屏预览可拖宽（都记在本机浏览器里）
const isNarrow=()=>matchMedia('(max-width:760px)').matches;
$('#menuBtn').onclick=()=>{ if(isNarrow()) return $('#side').classList.toggle('show'); store.set('hola.sideOff', document.body.classList.toggle('side-off')?'1':'') };
if(store.get('hola.sideOff')==='1') document.body.classList.add('side-off');
const WIDTHS=['normal','wide','full'], WIDTH_LABEL={normal:'标准宽度',wide:'加宽',full:'铺满'};
function applyWidth(w){ if(!WIDTHS.includes(w)) w='normal'; document.body.dataset.width=w; $('#widthLabel').textContent=WIDTH_LABEL[w]; store.set('hola.width',w) }
$('#widthBtn').onclick=()=>applyWidth(WIDTHS[(WIDTHS.indexOf(document.body.dataset.width)+1)%WIDTHS.length]);
applyWidth(store.get('hola.width'));
function dragGrip(grip,onMove,onEnd){
  grip.addEventListener('pointerdown',e=>{
    e.preventDefault(); grip.setPointerCapture(e.pointerId); grip.classList.add('drag'); document.body.classList.add('dragging');
    const mv=ev=>onMove(ev.clientX);
    const up=()=>{ grip.removeEventListener('pointermove',mv); grip.removeEventListener('pointerup',up); grip.removeEventListener('pointercancel',up); grip.classList.remove('drag'); document.body.classList.remove('dragging'); onEnd() };
    grip.addEventListener('pointermove',mv); grip.addEventListener('pointerup',up); grip.addEventListener('pointercancel',up);
  });
}
const rootStyle=document.documentElement.style;
let sideW=+store.get('hola.sideW')||0, splitW=+store.get('hola.splitW')||0;
const setSideW=px=>{ sideW=Math.round(Math.max(200,Math.min(440,px))); rootStyle.setProperty('--side-w',sideW+'px') };
// 预览栏最宽到聊天区还剩 380px 为止
const setSplitW=px=>{ const side=document.body.classList.contains('side-off')?0:$('#side').offsetWidth; splitW=Math.round(Math.max(300,Math.min(innerWidth-side-380,px))); $('#split').style.width=splitW+'px' };
if(sideW) setSideW(sideW);
if(splitW) setSplitW(splitW);
dragGrip($('#sideGrip'),x=>setSideW(x),()=>store.set('hola.sideW',sideW));
dragGrip($('#splitGrip'),x=>setSplitW(innerWidth-x),()=>store.set('hola.splitW',splitW));
$('#sideGrip').ondblclick=()=>{ rootStyle.removeProperty('--side-w'); sideW=0; store.set('hola.sideW','') };
$('#splitGrip').ondblclick=()=>{ $('#split').style.width=''; splitW=0; store.set('hola.splitW','') };
$('#memBtn').onclick=async()=>{
  const d=$('#drawer'); const show=!d.classList.contains('show');
  if(show&&!S.cur){toast('先开始一个对话');return}
  d.classList.toggle('show',show); $('#memBtn').classList.toggle('on',show);
  if(show){const r=await fetch('/api/conv/'+S.cur);const c=await r.json();$('#memText').value=c.memory||'';$('#memSaved').textContent=''}
};
$('#memClose').onclick=()=>{$('#drawer').classList.remove('show');$('#memBtn').classList.remove('on')};
$('#memReload').onclick=async()=>{const r=await fetch('/api/conv/'+S.cur);$('#memText').value=(await r.json()).memory||'';$('#memSaved').textContent='已读取最新内容'};
$('#memSave').onclick=async()=>{await api('memory',{conv:S.cur,text:$('#memText').value});$('#memSaved').textContent='已保存'};

// theme
function applyTheme(t){ if(t) document.documentElement.dataset.theme=t; else delete document.documentElement.dataset.theme }
applyTheme(store.get('hola.theme'));
$('#toggleTheme').onclick=()=>{
  const dark=document.documentElement.dataset.theme==='dark'||(!document.documentElement.dataset.theme&&matchMedia('(prefers-color-scheme: dark)').matches);
  const t=dark?'light':'dark'; applyTheme(t); store.set('hola.theme',t); syncTitleBar();
};

// ---------- 桌面版：自己画的标题栏（拖动区域、给窗口按钮留位置、按钮颜色跟着深浅色走）
const DESKTOP = window.holaDesktop || null;
if (DESKTOP) document.body.classList.add('desktop', 'os-' + DESKTOP.platform);
function syncTitleBar(){
  if(!DESKTOP||!DESKTOP.setTitleBarColors) return;
  const hex=(c)=>'#'+(c.match(/\d+/g)||[]).slice(0,3).map(n=>(+n).toString(16).padStart(2,'0')).join('');
  DESKTOP.setTitleBarColors(hex(getComputedStyle($('header')).backgroundColor), hex(getComputedStyle($('header .hbtn')).color));
}
syncTitleBar();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTitleBar);
// 弹窗打开时整页都不当作拖动区域（不然点到标题栏那一条会变成拖窗口）
new MutationObserver(()=>{ document.body.classList.toggle('no-drag', !!document.querySelector('dialog[open]')); if(typeof syncWeb==='function') syncWeb() }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });

// settings
$('#openSettings').onclick=()=>{
  const s=S.settings;
  $('#sConcl').innerHTML=S.members.filter(m=>m.enabled).map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join('');
  $('#sConcl').value=s.conclusionBy||'claude'; $('#sPolicy').value=s.policy||'auto';
  $('#sRounds').value=s.maxDiscussRounds??3;
  $('#sLang').value=window.HOLA_LANG;
  $('#sMem').checked=s.autoMemory!==false; $('#sProc').checked=!!s.showProcess; $('#sBrowserAsk').checked=s.browserAsk!==false;
  $('#sHops').value=s.maxAutoTurns??10;
  $('#settings').showModal();
};
$('#sCancel').onclick=()=>$('#settings').close();
$('#sSave').onclick=async()=>{
  await api('settings',{maxDiscussRounds:+$('#sRounds').value,conclusionBy:$('#sConcl').value,policy:$('#sPolicy').value,autoMemory:$('#sMem').checked,showProcess:$('#sProc').checked,browserAsk:$('#sBrowserAsk').checked,maxAutoTurns:+$('#sHops').value}); const lang=$('#sLang').value; $('#settings').close(); toast('设置已保存');
  if(lang!==window.HOLA_LANG){ await api('settings',{uiLang:lang}); window.setHolaLang(lang); setTimeout(()=>location.reload(),300); }
};
$('#recheck').onclick=()=>{api('recheck');toast('正在重新检查队友')};
$('#quitApp').onclick=async()=>{ if(!confirm('退出 Hola？正在进行的工作会被叫停。下次双击桌面图标即可重新打开。'))return; await api('quit'); document.body.innerHTML='<div style="margin:auto;text-align:center;color:#888;font-size:15px">Hola 已退出，可以关掉这个窗口了。</div>' };

// ---------- team manager
// ---------------- 技能库
let editingSkill=null;
function openSkills(){ renderSkills(); if(!$('#skillsDlg').open) $('#skillsDlg').showModal() }
function renderSkills(){
  const list=S.skills||[];
  $('#skillList').innerHTML = list.length ? list.map(k=>{
    const src = k.source==='conversation' ? `<span>从对话整理</span>${k.fromConv?`<span data-raw>${window.HOLA_LANG==='en'?': ':'：'}${esc(k.fromConv)}</span>`:''}` : `<span>${k.source==='import'?'导入':'手写'}</span>`;
    const meta = [src, `<span>${k.uses?`用过 ${k.uses} 次`:'还没用过'}</span>`, k.files.length?`<span>附带 ${k.files.length} 个文件</span>`:''].filter(Boolean);
    return `<div class="skill-row${k.enabled?'':' off'}"><span class="ic"><svg class="i"><use href="#i-book"/></svg></span>
      <div class="info"><b data-raw>${esc(k.name)}</b><p data-raw>${esc(k.description||'')}</p><small>${meta.join(' · ')}</small></div>
      <div class="acts"><button class="btn" data-kedit="${esc(k.id)}">编辑</button><button class="btn" data-ktoggle="${esc(k.id)}">${k.enabled?'停用':'启用'}</button></div></div>`;
  }).join('') : `<div class="skills-empty">技能库还是空的。<br>在团队结论旁点"存为技能"，或者点下面的"从当前对话整理"，让队友把这次的做法沉淀下来；也可以自己新建，或导入现成的 SKILL.md。</div>`;
  $('#skillList').querySelectorAll('[data-kedit]').forEach(b=>b.onclick=()=>openSkill(list.find(k=>k.id===b.dataset.kedit)));
  $('#skillList').querySelectorAll('[data-ktoggle]').forEach(b=>b.onclick=async()=>{ const k=list.find(x=>x.id===b.dataset.ktoggle); await api('skills/toggle',{id:k.id,enabled:!k.enabled}) });
  $('#skillFromConv').disabled = !S.cur;
}
function openSkill(k){
  editingSkill=k||null;
  $('#kTitle').textContent = k ? '编辑技能' : '新建技能';
  $('#kName').value = k ? k.name : ''; $('#kDesc').value = k ? k.description : ''; $('#kBody').value = k ? k.body : '';
  $('#kEnabled').checked = k ? k.enabled : true;
  $('#kFiles').textContent = k && k.files.length ? '同一文件夹里的其他文件：'+k.files.join('、') : '';
  $('#kDelete').hidden = !k; $('#kRes').textContent=''; $('#kRes').className='testres';
  $('#skillDlg').showModal();
}
async function distillSkill(fromMsg){
  if(!S.cur) return toast('先开始一个对话');
  const r = await api('skills/distill',{conv:S.cur,msg:fromMsg||null});
  if(r&&!r.error) toast('队友正在把这次的做法整理成技能');
}
$('#skillsBtn').onclick=openSkills;
$('#skillsClose').onclick=()=>$('#skillsDlg').close();
$('#skillNew').onclick=()=>openSkill(null);
$('#skillFromConv').onclick=()=>{ $('#skillsDlg').close(); distillSkill(null) };
$('#skillOpenDir').onclick=()=>api('skills/open',{});
$('#skillImport').onclick=()=>$('#skillFile').click();
$('#skillFile').onchange=async()=>{
  const f=$('#skillFile').files[0]; $('#skillFile').value=''; if(!f) return;
  try{
    const r=await fetch('/api/skills/import?name='+encodeURIComponent(f.name),{method:'POST',headers:{'X-Hola':'1','Content-Type':'application/octet-stream'},body:f});
    const j=await r.json(); if(!r.ok||j.error) throw new Error(j.error||'导入失败');
    toast('已导入技能');
  }catch(e){ toast('导入失败：'+e.message) }
};
$('#kCancel').onclick=()=>$('#skillDlg').close();
$('#kSave').onclick=async()=>{
  const skill={id:editingSkill&&editingSkill.id, name:$('#kName').value.trim(), description:$('#kDesc').value.trim(), body:$('#kBody').value, enabled:$('#kEnabled').checked};
  if(!skill.name) { $('#kRes').textContent=t('请填写技能名称'); $('#kRes').className='testres bad'; return }
  const r=await fetch('/api/skills/save',{method:'POST',headers:{'Content-Type':'application/json','X-Hola':'1'},body:JSON.stringify({skill})});
  const j=await r.json(); if(!r.ok||j.error){ $('#kRes').textContent=j.error||t('保存失败'); $('#kRes').className='testres bad'; return }
  $('#skillDlg').close(); toast('技能已保存');
};
$('#kDelete').onclick=async()=>{
  if(!editingSkill) return;
  if(!confirm(`删除技能「${editingSkill.name}」？`)) return;
  await api('skills/delete',{id:editingSkill.id}); $('#skillDlg').close(); toast('已删除');
};

const PRESETS = [
  { k:'deepseek-pro', label:'DeepSeek（V4 Pro，更强）', base:'https://api.deepseek.com', model:'deepseek-v4-pro', name:'DeepSeek', strengths:'中文写作、逻辑推理、数学和代码', strengthsEn:'Writing, logical reasoning, math and code' },
  { k:'deepseek-flash', label:'DeepSeek（Flash，更快更便宜）', base:'https://api.deepseek.com', model:'deepseek-flash', name:'DeepSeek', strengths:'中文写作、快速回答、日常推理', strengthsEn:'Writing, quick answers, everyday reasoning' },
  { k:'qwen', label:'通义千问（阿里云百炼）', base:'https://dashscope.aliyuncs.com/compatible-mode/v1', model:'qwen-plus', name:'千问', nameEn:'Qwen', strengths:'中文写作、电商与营销文案', strengthsEn:'Writing, e-commerce and marketing copy' },
  { k:'kimi', label:'Kimi（月之暗面）', base:'https://api.moonshot.cn/v1', model:'', name:'Kimi', strengths:'长文阅读、中文写作', strengthsEn:'Long-document reading, writing' },
  { k:'glm', label:'智谱 GLM', base:'https://open.bigmodel.cn/api/paas/v4', model:'', name:'GLM', strengths:'中文写作、通用问答', strengthsEn:'Writing, general Q&A' },
  { k:'openrouter', label:'OpenRouter（一个 Key 用很多模型）', base:'https://openrouter.ai/api/v1', model:'', name:'', strengths:'' },
  { k:'ollama', label:'本地 Ollama（不用 Key）', base:'http://localhost:11434/v1', model:'', name:'', strengths:'' },
  { k:'custom', label:'其他（自己填）', base:'', model:'', name:'', strengths:'' },
];
const SWATCHES = ['#A26BFA','#F5A524','#FF6FB5','#2EC4D6','#8BC34A','#FF8A3D','#7C8CFF','#E2C044','#FF5A4E','#22D39A','#3D7BFF'];
let editing = null, mType = 'api', mColor = SWATCHES[0];

function openTeam(){ renderTeam(); if(!$('#teamDlg').open) $('#teamDlg').showModal() }
function renderTeam(){
  $('#teamList').innerHTML = S.members.map(m=>{
    const kind = (m.builtin ? '内置' : m.type==='api' ? 'API' : '命令行') + (m.via==='relay' ? '</span><span class="tag">中转站' : '') + (m.access==='full' ? '</span><span class="tag">完全权限' : '') + (m.type==='api' && m.edit && (m.edit.hands===false || m.edit.toolsOk===false) ? '</span><span class="tag">只动脑' : '');
    const sub = (!m.enabled ? '已停用' : m.online ? `在线 · ${esc(m.version||'')}` : esc(m.problem||'不在线')) + (m.model && m.model!==m.version ? ` · <span data-raw>${esc(m.model)}</span>` : '');
    return `<div class="team-row${m.enabled?'':' disabled'}"><span class="dot" style="background:${m.color};box-shadow:0 0 8px ${m.color}"></span>
      <div class="info"><b>${esc(m.name)}</b><span class="tag">${kind}</span><small>${esc(m.strengths)}</small><small class="${m.enabled&&!m.online?'bad':''}">${sub}</small></div>
      <div class="acts"><button class="btn" data-tedit="${m.id}">编辑</button><button class="btn" data-ttoggle="${m.id}">${m.enabled?'停用':'启用'}</button></div></div>`;
  }).join('');
  $('#teamList').querySelectorAll('[data-tedit]').forEach(b=>b.onclick=()=>openMember(S.members.find(m=>m.id===b.dataset.tedit)));
  $('#teamList').querySelectorAll('[data-ttoggle]').forEach(b=>b.onclick=async()=>{
    const m=S.members.find(x=>x.id===b.dataset.ttoggle);
    await saveMemberRaw({ id:m.id, name:m.name, enabled:!m.enabled });
  });
}
async function saveMemberRaw(member){
  const r = await fetch('/api/members/save',{method:'POST',headers:{'Content-Type':'application/json','X-Hola':'1'},body:JSON.stringify({member})});
  const j = await r.json(); if(!r.ok||j.error) throw new Error(j.error||'保存失败'); return j;
}
function setType(t){
  mType=t; $('#mType').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
  $('#apiFields').hidden = t!=='api'; $('#cliFields').hidden = t!=='cli';
}
function renderSwatches(){
  $('#mColors').innerHTML = SWATCHES.map(c=>`<button type="button" style="background:${c}" data-c="${c}" class="${c===mColor?'on':''}" aria-label="颜色 ${c}"></button>`).join('');
  $('#mColors').querySelectorAll('button').forEach(b=>b.onclick=()=>{mColor=b.dataset.c;renderSwatches()});
}
function openMember(m){
  editing = m || null;
  const builtin = !!(m && m.builtin);
  $('#mTitle').textContent = m ? `编辑 ${m.name}` : '添加队友';
  $('#mSub').textContent = builtin ? '内置队友只能改颜色、擅长什么、权限，以及是否启用。' : '填好以后点"保存并测试"，会发一句话试试能不能连上。';
  $('#mFull').checked = !!(m && m.access==='full');
  $('#mPreset').innerHTML = PRESETS.map(p=>`<option value="${p.k}">${esc(p.label)}</option>`).join('');
  const used = new Set(S.members.map(x=>x.color));
  mColor = m ? m.color : (SWATCHES.find(c=>!used.has(c)) || SWATCHES[0]);
  renderSwatches();
  $('#mName').value = m ? m.name : ''; $('#mName').disabled = builtin;
  $('#mStrengths').value = m ? m.strengths : ''; $('#mRole').value = m && m.role==='helper' ? 'helper' : 'brain';
  $('#mEnabled').checked = m ? m.enabled : true;
  setType(m ? m.type : 'api');
  $('#mType').querySelectorAll('button').forEach(b=>b.disabled=builtin);
  $('#mType').hidden = builtin; $('#apiFields').hidden = builtin || mType!=='api'; $('#cliFields').hidden = builtin || mType!=='cli';
  // 内置的 Claude / Codex / Gemini：接入方式（订阅登录 / 中转站）
  editVia = m && m.via ? m.via : null;
  $('#viaField').hidden = !editVia;
  $('#presetField').hidden = builtin;
  const e = (m && m.via === 'relay' ? m.edit : m && m.relay) || (m && m.edit) || {};
  $('#mBase').value = e.baseUrl || ''; $('#mModel').value = e.model || ''; $('#mTemp').value = e.temperature ?? ''; $('#mVision').checked = !!e.vision; $('#mHands').checked = e.hands !== false; $('#mApiEffort').value = e.effort || ''; $('#mModelPick').hidden = true;
  $('#mKey').value = ''; $('#mKey').placeholder = e.keyHint ? `已保存（${e.keyHint}），留空表示不改` : 'sk-...';
  $('#mCmd').value = e.cmd || ''; $('#mArgs').value = e.argsText || ''; $('#mParser').value = e.parser || 'plain';
  $('#mReadOnly').checked = !!e.readOnly; $('#mVer').checked = e.versionCheck !== false;
  $('#mPresetNote').textContent = '选一个会自动填好地址和推荐的模型名；模型名以服务商文档为准。';
  $('#mPreset').value = m ? (PRESETS.find(p=>p.base && p.base===e.baseUrl)||{k:'custom'}).k : 'deepseek-pro';
  if(!m) applyPreset();
  $('#mDelete').hidden = !m || builtin;
  if(editVia) setVia(editVia);
  $('#mRes').textContent=''; $('#mRes').className='testres';
  showAccess();
  if(m && m.modelPick) loadModels(m);
  $('#memberDlg').showModal();
}
let editVia = null;
function setVia(v){
  editVia=v; $('#mVia').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.v===v));
  $('#apiFields').hidden = v!=='relay';
  // "完全权限"跟着接入方式走：中转站 = API 队友能不能运行命令；订阅 = 命令行的权限
  if(editing) $('#mFull').checked = v==='relay' ? !!(editing.via==='relay' ? editing.access==='full' : (editing.relay||{}).full) : (editing.via==='relay' ? editing.cliAccess==='full' : editing.access==='full');
  showAccess();
  if(v==='sub' && editing && editing.modelPick) loadModels(editing);
}
$('#mVia').querySelectorAll('button').forEach(b=>b.onclick=()=>setVia(b.dataset.v));
// 读出这把 Key 能用的模型，内置队友把自家的模型排在前面
$('#mLoadModels').onclick=async()=>{
  const res=$('#mRes'); res.className='testres'; res.textContent='正在读取可用模型…';
  const r=await api('members/remote-models',{ id: editing&&editing.id, baseUrl:$('#mBase').value.trim(), apiKey:$('#mKey').value.trim() });
  if(!r||r.error){ res.className='testres bad'; res.textContent=(r&&r.error)||'读取失败'; return }
  if(r.base && r.base!==$('#mBase').value.trim()) $('#mBase').value=r.base;
  const fam={claude:/claude/i,codex:/gpt|codex|^o\d/i,gemini:/gemini/i}[editing&&editing.builtin?editing.id:''];
  const mine=fam?r.models.filter(x=>fam.test(x)):r.models, other=fam?r.models.filter(x=>!fam.test(x)):[];
  const opt=x=>`<option value="${esc(x)}">${esc(x)}</option>`;
  $('#mModelPick').innerHTML='<option value="">— 从列表里选一个 —</option>'+mine.map(opt).join('')+(other.length?`<optgroup label="其他模型">${other.map(opt).join('')}</optgroup>`:'');
  $('#mModelPick').hidden=false; $('#mModelPick').value=r.models.includes($('#mModel').value.trim())?$('#mModel').value.trim():'';
  res.className='testres ok'; res.textContent=`读到 ${r.models.length} 个可用模型，在下面的列表里选一个`;
};
$('#mModelPick').onchange=e=>{ if(e.target.value) $('#mModel').value=e.target.value };
// 认得的三种命令行（Claude / Codex / Antigravity）才能一键切换权限
const ACCESS_PARSERS = ['claude-stream','codex-json','agy-json'];
const accessShown = ()=> editing && editing.builtin ? !!editing.access : mType==='api' || (mType==='cli' && ACCESS_PARSERS.includes($('#mParser').value));
function showAccess(){ $('#accessField').hidden = !accessShown(); $('#modelField').hidden = !(editing && editing.id && accessShown() && (editing.builtin ? editVia!=='relay' : mType!=='api') && editing.modelPick) }
// 模型下拉：列表从各家工具实时读取；"默认"表示用工具自己的设置
async function loadModels(m){
  const sel=$('#mModelSel'), note=$('#mModelNote');
  sel.innerHTML='<option value="">读取中…</option>'; note.textContent=''; $('#mModelCustom').hidden=true;
  let j={}; try{ j=await api('models',{id:m.id}) }catch(_){}
  if(editing!==m) return;
  const list=j.choices||[], cur=j.current||'';
  const opt=(v,l)=>`<option value="${esc(v)}">${esc(l)}</option>`;
  const def = j.defaultHint ? `默认（${j.defaultHint}）` : '默认（用它自己的设置）';
  const main=list.filter(x=>!x.other), other=list.filter(x=>x.other);
  sel.innerHTML = opt('',def) + main.map(x=>opt(x.id,x.label)).join('') +
    (other.length?`<optgroup label="其他家的模型（会失去多家模型互相讨论的意义）">${other.map(x=>opt(x.id,x.label)).join('')}</optgroup>`:'') +
    opt('__custom','手动填写…');
  if(cur && !list.some(x=>x.id===cur)){ sel.value='__custom'; $('#mModelCustom').value=cur; $('#mModelCustom').hidden=false } else { sel.value=cur; $('#mModelCustom').value='' }
  note.textContent = list.length ? '列表来自它自己的命令行工具。选了订阅里没有的模型会出错，改回"默认"就好。' : '没读到模型列表，可以选"手动填写"。';
  modelInfo=j; renderEfforts(j.effort||'');
}
// 思考深度的档位：Codex 跟着所选模型变，其他两家固定
let modelInfo={};
const EFFORT_LABEL={low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'极限'};
function renderEfforts(keep){
  const ef=modelInfo.efforts||{}, m=$('#mModelSel').value;
  const levels = ef[m==='__custom'?'':m] || ef[''] || [];
  const hint = modelInfo.effortHint ? `默认（${EFFORT_LABEL[modelInfo.effortHint]||modelInfo.effortHint}）` : '默认（用它自己的设置）';
  $('#mEffortSel').innerHTML = `<option value="">${esc(hint)}</option>` + levels.map(l=>`<option value="${l}">${EFFORT_LABEL[l]||l}</option>`).join('');
  $('#mEffortSel').value = levels.includes(keep) ? keep : '';
}
$('#mModelSel').onchange=()=>{ $('#mModelCustom').hidden = $('#mModelSel').value!=='__custom'; renderEfforts($('#mEffortSel').value) };
const pickedModel=()=> $('#mModelSel').value==='__custom' ? $('#mModelCustom').value.trim() : $('#mModelSel').value;
$('#mParser').addEventListener('change', showAccess);
$('#mFull').onchange = ()=>{
  if($('#mFull').checked && !confirm('打开完全权限？\n\n这位队友将能运行任何命令、修改或删除你电脑上任何地方的文件，而且不会先问你。请只给你信任的 AI 打开，重要文件记得备份。')) $('#mFull').checked = false;
};
function applyPreset(){
  const p = PRESETS.find(x=>x.k===$('#mPreset').value); if(!p) return;
  if(p.base) $('#mBase').value = p.base;
  $('#mModel').value = p.model;
  $('#mModel').placeholder = p.model || '填服务商文档里的模型名';
  if(!editing){ if(p.name && !S.members.some(x=>x.name.toLowerCase()===p.name.toLowerCase())) $('#mName').value = (window.HOLA_LANG==='en'&&p.nameEn)||p.name; if(p.strengths) $('#mStrengths').value = (window.HOLA_LANG==='en'&&p.strengthsEn)||p.strengths; }
}
$('#mPreset').onchange = applyPreset;
$('#mType').querySelectorAll('button').forEach(b=>b.onclick=()=>{setType(b.dataset.t);showAccess()});
$('#openTeam').onclick = openTeam;
$('#teamClose').onclick = ()=>$('#teamDlg').close();
$('#teamRecheck').onclick = ()=>{api('recheck');toast('正在重新检查队友')};
$('#addMember').onclick = ()=>openMember(null);
$('#mCancel').onclick = ()=>$('#memberDlg').close();
$('#mDelete').onclick = async()=>{
  if(!editing||!confirm(`删除队友「${editing.name}」？之前的聊天记录不受影响。`)) return;
  await api('members/delete',{id:editing.id}); $('#memberDlg').close(); toast('已删除');
};
$('#mSave').onclick = async()=>{
  const res=$('#mRes'); res.className='testres'; res.textContent='保存中…';
  const builtin = !!(editing && editing.builtin);
  const member = { id: editing ? editing.id : undefined, name: builtin ? editing.name : $('#mName').value.trim(), color: mColor,
    strengths: $('#mStrengths').value.trim(), enabled: $('#mEnabled').checked, role: $('#mRole').value };
  if(accessShown()) member.access = $('#mFull').checked ? 'full' : 'safe';
  const modelsLoaded = !!$('#mModelSel').querySelector('option[value="__custom"]');
  if(!$('#modelField').hidden && modelsLoaded){ member.cliModel = pickedModel(); member.cliEffort = $('#mEffortSel').value; }
  const apiPart = ()=>({ baseUrl:$('#mBase').value.trim(), model:$('#mModel').value.trim(), apiKey:$('#mKey').value.trim(), temperature:$('#mTemp').value.trim(), vision:$('#mVision').checked, hands:$('#mHands').checked, apiEffort:$('#mApiEffort').value });
  if(builtin && editVia){
    member.via = editVia;
    if(editVia==='relay'){
      Object.assign(member, apiPart());
      if(!member.baseUrl || !member.model){ res.className='testres bad'; res.textContent='请填写中转站的接口地址和模型名（可以点"读取可用模型"）'; return }
    }
  }
  if(!builtin){
    member.type = mType;
    if(mType==='api') Object.assign(member, apiPart());
    else Object.assign(member,{ cmd:$('#mCmd').value.trim(), argsText:$('#mArgs').value, parser:$('#mParser').value, readOnly:$('#mReadOnly').checked, versionCheck:$('#mVer').checked });
    if(!member.name){ res.className='testres bad'; res.textContent='请填写名字'; return }
    if(mType==='api' && (!member.baseUrl || !member.model)){ res.className='testres bad'; res.textContent='请填写接口地址和模型名'; return }
    if(mType==='cli' && !member.cmd){ res.className='testres bad'; res.textContent='请填写命令'; return }
  }
  let saved;
  try{ saved = await saveMemberRaw(member) }catch(e){ res.className='testres bad'; res.textContent=e.message; return }
  editing = { ...(editing||{}), id: saved.id, name: member.name, builtin };
  if(!member.enabled){ res.className='testres ok'; res.textContent='已保存（已停用）'; return }
  res.textContent='已保存，正在测试连接…';
  try{
    const t = await api('members/test',{id:saved.id});
    res.className = 'testres ' + (t.ok?'ok':'bad'); res.title = t.ok ? t.text : t.error;
    res.textContent = t.ok ? `连上了：${t.text}` + (t.hands===true?' · 能动手':t.hands===false?' · 这个模型不支持工具调用，只能动脑':'') : `没连上：${t.error}`;
    if(t.ok) setTimeout(()=>{ if($('#memberDlg').open) $('#memberDlg').close() }, 1200);
  }catch(e){ res.className='testres bad'; res.textContent='测试失败：'+e.message }
};

// ---------- profile
function initials(){ const n=(S.profile.name||'').trim(); return n? esc([...n][0].toUpperCase()) : '我' }
function paintAva(el){ if(S.profile.avatar){ el.style.backgroundImage=`url('${S.profile.avatar}')`; el.innerHTML='' } else { el.style.backgroundImage=''; el.innerHTML=initials() } }
function renderMe(){
  paintAva($('#meAva'));
  $('#meName').textContent = S.profile.name || t('你');
  const sub=[S.profile.title,S.profile.org].filter(Boolean).join(' · ');
  $('#meSub').textContent = sub; $('#meSub').hidden = !sub;
}
let pfDraft = {};
function openProfile(){
  const p=S.profile; pfDraft={...p};
  $('#pfName').value=p.name||''; $('#pfCall').value=p.callMe||''; $('#pfTitle').value=p.title||''; $('#pfOrg').value=p.org||'';
  $('#pfIndustry').value=p.industry||''; $('#pfBio').value=p.bio||''; $('#pfExtra').value=p.extra||'';
  document.querySelectorAll('#profileDlg [data-pref]').forEach(seg=>{
    const k=seg.dataset.pref;
    seg.querySelectorAll('button').forEach(b=>{
      b.classList.toggle('on',pfDraft[k]===b.dataset.v);
      b.onclick=()=>{ pfDraft[k]= pfDraft[k]===b.dataset.v ? '' : b.dataset.v; seg.querySelectorAll('button').forEach(x=>x.classList.toggle('on',pfDraft[k]===x.dataset.v)) };
    });
  });
  paintAva($('#pfAva')); $('#pfRemove').hidden=!p.avatar; $('#pfRes').textContent='';
  $('#profileDlg').showModal();
}
$('#openProfile').onclick=openProfile;
$('#pfCancel').onclick=()=>$('#profileDlg').close();
$('#pfPick').onclick=()=>$('#pfFile').click();
$('#pfFile').onchange=async e=>{
  const f=e.target.files[0]; e.target.value=''; if(!f) return;
  const res=$('#pfRes'); res.className='testres'; res.textContent='处理中…';
  try{
    const img=await new Promise((ok,bad)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=bad;i.src=URL.createObjectURL(f)});
    const side=Math.min(img.naturalWidth,img.naturalHeight), cv=document.createElement('canvas'); cv.width=cv.height=256;
    cv.getContext('2d').drawImage(img,(img.naturalWidth-side)/2,(img.naturalHeight-side)/2,side,side,0,0,256,256);
    const blob=await new Promise(ok=>cv.toBlob(ok,'image/png'));
    const r=await fetch('/api/profile/avatar',{method:'POST',headers:{'X-Hola':'1','Content-Type':'image/png'},body:blob});
    const j=await r.json(); if(!r.ok) throw new Error(); S.profile=j.profile; paintAva($('#pfAva')); $('#pfRemove').hidden=false; renderMe();
    res.className='testres ok'; res.textContent='头像已更新';
  }catch(_){ res.className='testres bad'; res.textContent='这张图片读不了，换一张 PNG 或 JPG 试试' }
};
$('#pfRemove').onclick=async()=>{ const j=await api('profile',{profile:{},removeAvatar:true}); S.profile=j.profile; paintAva($('#pfAva')); $('#pfRemove').hidden=true; renderMe(); };
$('#pfSave').onclick=async()=>{
  const prof={...pfDraft, name:$('#pfName').value, callMe:$('#pfCall').value, title:$('#pfTitle').value, org:$('#pfOrg').value,
    industry:$('#pfIndustry').value, bio:$('#pfBio').value, extra:$('#pfExtra').value};
  ['detail','tone','format','language','debate'].forEach(k=>{ if(prof[k]==null) prof[k]='' });
  delete prof.avatar;
  try{ const j=await api('profile',{profile:prof}); S.profile=j.profile; renderMe(); $('#profileDlg').close(); toast('个人主页已保存，队友下次干活就会按这个来'); if(S.conv) renderConv(); else renderEmpty(); }
  catch(_){ $('#pfRes').className='testres bad'; $('#pfRes').textContent='保存失败' }
};

// ---------- live events
function connect(){
  const es=new EventSource('/api/events');
  es.onopen=()=>$('#conn').style.display='none';
  es.onerror=()=>$('#conn').style.display='block';
  es.onmessage=e=>{
    const ev=JSON.parse(e.data);
    if(ev.type==='init'){
      S.convs=ev.convs; S.members=ev.members; S.settings=ev.settings; S.profile=ev.profile||{}; S.skills=ev.skills||[]; S.projects=ev.projects||[]; renderMe(); renderBuild(ev.build); S.browser=ev.browser||null; renderBrowser(); document.body.dataset.ready='1';
      if(!S.settings.uiLang){ api('settings',{uiLang:window.HOLA_LANG}); S.settings.uiLang=window.HOLA_LANG; }
      else if(S.settings.uiLang!==window.HOLA_LANG){ window.setHolaLang(S.settings.uiLang); location.reload(); return; }
      const want=S.cur||store.get('hola.cur'); renderConvs();
      openConv(S.convs.some(c=>c.id===want)?want:(S.convs[0]?.id||null));
    }
    else if(ev.type==='convs'){ S.convs=ev.convs; renderConvs(); if(S.conv){const c=S.convs.find(x=>x.id===S.cur); if(c){S.conv.title=c.title;$('#title').textContent=c.title}} renderRun() }
    else if(ev.type==='state'){ const i=S.convs.findIndex(c=>c.id===ev.conv.id); if(i>=0) S.convs[i]=ev.conv; renderConvs(); if(ev.conv.id===S.cur){ renderRun(); renderUnder() } }
    else if(ev.type==='msg'){ if(ev.conv===S.cur) putMsg(ev.msg, ev.msg.from==='boss'); if(LIB.kind&&(ev.msg.files||ev.msg.attachments)) libReload() }
    else if(ev.type==='library'){ if(LIB.kind) libReload() }
    else if(ev.type==='browser'){ S.browser=ev.browser; renderBrowser() }
    else if(ev.type==='proc'){ if(ev.conv===S.cur) addStep(ev.id,ev.item) }
    else if(ev.type==='projects'){ S.projects=ev.projects||[]; renderConvs() }
    else if(ev.type==='skills'){ S.skills=ev.skills||[]; if($('#skillsDlg').open) renderSkills() }
    else if(ev.type==='profile'){ S.profile=ev.profile; renderMe(); if(S.conv) renderConv() }
    else if(ev.type==='memory'){ if(ev.conv===S.cur&&$('#drawer').classList.contains('show')&&document.activeElement!==$('#memText')){$('#memText').value=ev.memory;$('#memSaved').textContent='队友刚更新了记忆'} }
    else if(ev.type==='members'){ S.members=ev.members; renderLights(); if($('#feed .empty')) renderEmpty(); if($('#teamDlg').open) renderTeam() }
    else if(ev.type==='settings'){ const pv=!!S.settings.showProcess; S.settings=ev.settings; S.members=ev.members; renderLights(); if(pv!==!!S.settings.showProcess&&S.conv) renderConv() }
  };
}
renderUnder(); connect();
