const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const state = { projects: [], dashboard: null, currentProject: null };
const labels = {
  active:'进行中',paused:'暂停',done:'完成',archived:'归档',low:'低',medium:'中',high:'高',urgent:'紧急',
  planned:'计划',in_progress:'进行中',blocked:'阻塞',skipped:'跳过',open:'待处理',waiting:'等待',resolved:'已解决',closed:'关闭',critical:'严重'
};

boot();

async function boot(){
  bindEvents();
  const me = await api('/api/auth/me', { quiet401:true });
  if(me?.authenticated){ showApp(); await refreshAll(); }
  else showLogin();
}

function bindEvents(){
  $('#loginForm').addEventListener('submit', login);
  $('#logoutBtn').addEventListener('click', logout);
  $('#refreshBtn').addEventListener('click', refreshAll);
  $('#newProjectBtn').addEventListener('click', () => openProjectDialog());
  $('#projectSearch').addEventListener('input', renderProjectList);
  $('#projectForm').addEventListener('submit', saveProject);
  $('#milestoneForm').addEventListener('submit', saveMilestone);
  $('#issueForm').addEventListener('submit', saveIssue);
  $$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
}

async function login(e){
  e.preventDefault(); $('#loginError').textContent='';
  try{
    await api('/api/auth/login',{method:'POST',body:{password:$('#passwordInput').value}});
    $('#passwordInput').value=''; showApp(); await refreshAll();
  }catch(err){ $('#loginError').textContent=err.message; }
}
async function logout(){ await api('/api/auth/logout',{method:'POST'}); state.currentProject=null; showLogin(); }
function showLogin(){ $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden'); setTimeout(()=>$('#passwordInput').focus(),0); }
function showApp(){ $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden'); }

async function refreshAll(){
  try{
    const [p,d] = await Promise.all([api('/api/v1/projects'),api('/api/v1/dashboard')]);
    state.projects=p; state.dashboard=d; renderProjectList();
    if(state.currentProject){
      const still=state.projects.find(x=>x.id===state.currentProject.id);
      if(still) await openProject(still.id); else showDashboard();
    } else showDashboard();
  }catch(err){ toast(err.message,true); }
}

function renderProjectList(){
  const q=$('#projectSearch').value.trim().toLowerCase();
  const list=state.projects.filter(p=>!q || [p.name,p.next_action,p.notes].some(v=>(v||'').toLowerCase().includes(q)));
  $('#projectCount').textContent=`${list.length}`;
  $('#projectList').innerHTML=list.length?list.map(p=>`
    <div class="project-nav ${state.currentProject?.id===p.id?'active':''}" data-project="${esc(p.id)}">
      <div class="project-nav-top"><span>${esc(p.name)}</span><span class="badge ${p.priority}">${label(p.priority)}</span></div>
      <div class="project-nav-meta"><span class="badge ${p.status}">${label(p.status)}</span><span>${Number(p.open_issue_count||0)} 问题</span>${p.due_date?`<span>${esc(p.due_date)}</span>`:''}</div>
    </div>`).join(''):'<div class="empty">暂无项目</div>';
  $$('[data-project]').forEach(el=>el.addEventListener('click',()=>openProject(el.dataset.project)));
}

function showDashboard(){ state.currentProject=null; renderProjectList(); $('#projectView').classList.add('hidden'); $('#dashboardView').classList.remove('hidden'); renderDashboard(); }
function renderDashboard(){
  const d=state.dashboard||{}; const pc=d.project_counts||{}, mc=d.milestone_counts||{}, ic=d.issue_counts||{};
  const openIssues=(ic.open||0)+(ic.in_progress||0)+(ic.waiting||0);
  const openMilestones=(mc.planned||0)+(mc.in_progress||0)+(mc.blocked||0);
  $('#dashboardView').innerHTML=`
    <div class="page-head"><div><h1>今天推进什么</h1><p>${esc(d.today||'')} · 只看项目、节点、问题和下一步动作。</p></div></div>
    <div class="stats">
      <div class="stat"><div class="muted">进行中项目</div><div class="n">${pc.active||0}</div></div>
      <div class="stat"><div class="muted">未完成节点</div><div class="n">${openMilestones}</div></div>
      <div class="stat"><div class="muted">未解决问题</div><div class="n">${openIssues}</div></div>
      <div class="stat"><div class="muted">逾期节点</div><div class="n">${d.overdue_milestones?.length||0}</div></div>
    </div>
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><h2>活跃项目</h2></div><div class="list">${cardsActive(d.active_projects||[])}</div></div>
      <div class="panel"><div class="panel-head"><h2>优先问题</h2></div><div class="list">${cardsIssues(d.priority_issues||[])}</div></div>
      <div class="panel"><div class="panel-head"><h2>逾期节点</h2></div><div class="list">${cardsMilestones(d.overdue_milestones||[],true)}</div></div>
      <div class="panel"><div class="panel-head"><h2>API</h2></div><div class="row-card"><div class="row-title">第三方 / 大模型接口</div><div class="row-meta"><span>Bearer API Key</span><span>/api/v1/*</span></div><div style="margin-top:10px"><a href="/openapi.json" target="_blank">查看 OpenAPI JSON</a></div></div></div>
    </div>`;
  $$('[data-open-project]').forEach(el=>el.addEventListener('click',()=>openProject(el.dataset.openProject)));
}
function cardsActive(items){ return items.length?items.map(p=>`<div class="row-card clickable" data-open-project="${esc(p.id)}"><div class="row-top"><div><div class="row-title">${esc(p.name)}</div><div class="row-meta"><span class="badge ${p.priority}">${label(p.priority)}</span><span>${p.open_milestones||0} 节点</span><span>${p.open_issues||0} 问题</span></div></div></div>${p.next_action?`<div class="row-meta">下一步：${esc(p.next_action)}</div>`:''}</div>`).join(''):'<div class="empty">没有进行中的项目</div>'; }
function cardsIssues(items){ return items.length?items.map(i=>`<div class="row-card clickable" data-open-project="${esc(i.project_id)}"><div class="row-top"><div><div class="row-title">${esc(i.title)}</div><div class="row-meta"><span>${esc(i.project_name||'')}</span><span class="badge ${i.severity}">${label(i.severity)}</span><span class="badge ${i.status}">${label(i.status)}</span></div></div></div>${i.next_action?`<div class="row-meta">下一步：${esc(i.next_action)}</div>`:''}</div>`).join(''):'<div class="empty">没有未解决问题</div>'; }
function cardsMilestones(items, overdue=false){ return items.length?items.map(m=>`<div class="row-card clickable" data-open-project="${esc(m.project_id)}"><div class="row-title">${esc(m.title)}</div><div class="row-meta"><span>${esc(m.project_name||'')}</span><span class="badge ${m.status}">${label(m.status)}</span>${m.due_date?`<span class="${overdue?'overdue':''}">${esc(m.due_date)}</span>`:''}</div></div>`).join(''):'<div class="empty">没有逾期节点</div>'; }

async function openProject(id){
  try{ state.currentProject=await api(`/api/v1/projects/${encodeURIComponent(id)}`); renderProjectList(); $('#dashboardView').classList.add('hidden'); $('#projectView').classList.remove('hidden'); renderProject(); }
  catch(err){ toast(err.message,true); }
}
function renderProject(){
  const p=state.currentProject; const ms=p.milestones||[], issues=p.issues||[];
  $('#projectView').innerHTML=`
    <div class="page-head"><div><button id="backDashboard" class="btn ghost small">← 总览</button><h1 style="margin-top:10px">${esc(p.name)}</h1><div class="row-meta"><span class="badge ${p.status}">${label(p.status)}</span><span class="badge ${p.priority}">${label(p.priority)}</span>${p.due_date?`<span>截止 ${esc(p.due_date)}</span>`:''}</div></div><div class="row-actions"><button id="editProject" class="btn">编辑项目</button><button id="addMilestone" class="btn">+ 节点</button><button id="addIssue" class="btn primary">+ 问题</button></div></div>
    <div class="project-summary">
      <div class="summary-item"><div class="label">下一步动作</div><div class="value next-action">${esc(p.next_action||'—')}</div></div>
      <div class="summary-item"><div class="label">计划节点</div><div class="value">${ms.filter(x=>x.status==='done').length} / ${ms.length} 已完成</div></div>
      <div class="summary-item"><div class="label">未解决问题</div><div class="value">${issues.filter(x=>!['resolved','closed'].includes(x.status)).length}</div></div>
    </div>
    ${p.description?`<div class="panel" style="margin-bottom:16px"><div class="panel-head"><h2>项目说明</h2></div><div class="next-action">${esc(p.description)}</div></div>`:''}
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><h2>计划节点</h2><button id="addMilestone2" class="btn small">+ 新建</button></div><div class="list">${ms.length?ms.map(m=>milestoneCard(m)).join(''):'<div class="empty">还没有计划节点</div>'}</div></div>
      <div class="panel"><div class="panel-head"><h2>问题</h2><button id="addIssue2" class="btn small">+ 新建</button></div><div class="list">${issues.length?issues.map(i=>issueCard(i)).join(''):'<div class="empty">没有问题</div>'}</div></div>
    </div>
    ${p.notes?`<div class="panel" style="margin-top:16px"><div class="panel-head"><h2>备注</h2></div><div class="next-action">${esc(p.notes)}</div></div>`:''}
    <div class="danger-zone"><button id="deleteProject" class="btn danger small">删除项目</button></div>`;
  $('#backDashboard').onclick=showDashboard; $('#editProject').onclick=()=>openProjectDialog(p); $('#addMilestone').onclick=$('#addMilestone2').onclick=()=>openMilestoneDialog(); $('#addIssue').onclick=$('#addIssue2').onclick=()=>openIssueDialog(); $('#deleteProject').onclick=deleteCurrentProject;
  $$('[data-edit-milestone]').forEach(el=>el.onclick=()=>openMilestoneDialog(ms.find(x=>x.id===el.dataset.editMilestone)));
  $$('[data-edit-issue]').forEach(el=>el.onclick=()=>openIssueDialog(issues.find(x=>x.id===el.dataset.editIssue)));
  $$('[data-delete-milestone]').forEach(el=>el.onclick=()=>deleteMilestone(el.dataset.deleteMilestone));
  $$('[data-delete-issue]').forEach(el=>el.onclick=()=>deleteIssue(el.dataset.deleteIssue));
}
function milestoneCard(m){ return `<div class="row-card"><div class="row-top"><div><div class="row-title">${esc(m.title)}</div><div class="row-meta"><span class="badge ${m.status}">${label(m.status)}</span>${m.due_date?`<span>${esc(m.due_date)}</span>`:''}</div></div><div class="row-actions"><button class="btn small" data-edit-milestone="${esc(m.id)}">编辑</button><button class="btn danger small" data-delete-milestone="${esc(m.id)}">删除</button></div></div>${m.notes?`<div class="row-meta">${esc(m.notes)}</div>`:''}</div>`; }
function issueCard(i){ return `<div class="row-card"><div class="row-top"><div><div class="row-title">${esc(i.title)}</div><div class="row-meta"><span class="badge ${i.severity}">${label(i.severity)}</span><span class="badge ${i.status}">${label(i.status)}</span></div></div><div class="row-actions"><button class="btn small" data-edit-issue="${esc(i.id)}">编辑</button><button class="btn danger small" data-delete-issue="${esc(i.id)}">删除</button></div></div>${i.next_action?`<div class="row-meta">下一步：${esc(i.next_action)}</div>`:''}${i.notes?`<div class="row-meta">备注：${esc(i.notes)}</div>`:''}</div>`; }

function openProjectDialog(p=null){ const f=$('#projectForm'); f.reset(); f.elements.id.value=p?.id||''; $('#projectDialogTitle').textContent=p?'编辑项目':'新建项目'; if(p) fill(f,p); $('#projectDialog').showModal(); }
async function saveProject(e){ e.preventDefault(); const f=e.currentTarget, id=f.elements.id.value, body=formData(f,['id']); try{ if(id) await api(`/api/v1/projects/${id}`,{method:'PATCH',body}); else await api('/api/v1/projects',{method:'POST',body}); $('#projectDialog').close(); toast('项目已保存'); await refreshAll(); }catch(err){ toast(err.message,true); } }
function openMilestoneDialog(m=null){ const f=$('#milestoneForm'); f.reset(); f.elements.id.value=m?.id||''; f.elements.project_id.value=state.currentProject.id; $('#milestoneDialogTitle').textContent=m?'编辑计划节点':'新建计划节点'; if(m) fill(f,m); $('#milestoneDialog').showModal(); }
async function saveMilestone(e){ e.preventDefault(); const f=e.currentTarget,id=f.elements.id.value,pid=f.elements.project_id.value,body=formData(f,['id','project_id']); try{ if(id) await api(`/api/v1/milestones/${id}`,{method:'PATCH',body}); else await api(`/api/v1/projects/${pid}/milestones`,{method:'POST',body}); $('#milestoneDialog').close(); toast('节点已保存'); await refreshAll(); }catch(err){ toast(err.message,true); } }
function openIssueDialog(i=null){ const f=$('#issueForm'); f.reset(); f.elements.id.value=i?.id||''; f.elements.project_id.value=state.currentProject.id; $('#issueDialogTitle').textContent=i?'编辑问题':'新建问题'; const sel=f.elements.milestone_id; sel.innerHTML='<option value="">不关联节点</option>'+state.currentProject.milestones.map(m=>`<option value="${esc(m.id)}">${esc(m.title)}</option>`).join(''); if(i) fill(f,i); $('#issueDialog').showModal(); }
async function saveIssue(e){ e.preventDefault(); const f=e.currentTarget,id=f.elements.id.value,pid=f.elements.project_id.value,body=formData(f,['id','project_id']); body.milestone_id=body.milestone_id||null; try{ if(id) await api(`/api/v1/issues/${id}`,{method:'PATCH',body}); else await api(`/api/v1/projects/${pid}/issues`,{method:'POST',body}); $('#issueDialog').close(); toast('问题已保存'); await refreshAll(); }catch(err){ toast(err.message,true); } }
async function deleteCurrentProject(){ const p=state.currentProject; if(!confirm(`确认删除项目「${p.name}」？节点和问题会一起删除。`))return; try{ await api(`/api/v1/projects/${p.id}`,{method:'DELETE'}); state.currentProject=null; toast('项目已删除'); await refreshAll(); }catch(err){ toast(err.message,true); } }
async function deleteMilestone(id){ if(!confirm('确认删除这个计划节点？关联问题会保留，但解除节点关联。'))return; try{ await api(`/api/v1/milestones/${id}`,{method:'DELETE'}); toast('节点已删除'); await refreshAll(); }catch(err){ toast(err.message,true); } }
async function deleteIssue(id){ if(!confirm('确认删除这个问题？'))return; try{ await api(`/api/v1/issues/${id}`,{method:'DELETE'}); toast('问题已删除'); await refreshAll(); }catch(err){ toast(err.message,true); } }

function fill(form,obj){ Object.entries(obj).forEach(([k,v])=>{ if(form.elements[k]) form.elements[k].value=v??''; }); }
function formData(form,exclude=[]){ const o=Object.fromEntries(new FormData(form)); exclude.forEach(k=>delete o[k]); return o; }
function label(v){ return labels[v]||v||'—'; }
function esc(v){ return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
let toastTimer; function toast(msg,error=false){ const el=$('#toast'); el.textContent=msg; el.style.background=error?'#b42318':'#111827'; el.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.add('hidden'),2400); }
async function api(path,{method='GET',body,quiet401=false}={}){ const res=await fetch(path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin'}); let payload=null; try{payload=await res.json()}catch{} if(!res.ok){ if(res.status===401&&quiet401)return {authenticated:false}; if(res.status===401){showLogin();} throw new Error(payload?.error?.message||`HTTP ${res.status}`); } return payload?.data ?? payload; }
