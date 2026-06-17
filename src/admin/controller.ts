import { Request, Response } from 'express';
import { getService } from '../controllers/openaiController';
import { getStateDb } from '../services/stateDb';
import { getIdentity } from '../services/identityService';
import { getConfiguredSources, getActiveModels, setCatalogModelActive, syncModelCatalog } from '../services/providerCatalog';
import { deleteModelById, updateModelById } from '../services/stateDb';
import {
  getProviderMapping, getUsageStats, getUsageByDay,
  getSessions, getConversations, getConversationDetail, getModelList,
  getEditorConnections, getEditorConnectionStats, upsertProviderMapping, deleteProviderMapping,
  deleteSession, deleteAllSessions, deleteConversation, deleteAllConversations, clearUsageStats,
  setModelPriority, getModelsWithPriority, getModelUsage,
} from './db';

function escapeHtml(s: string | undefined | null): string {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function layout(title: string, body: string, activePage: string): string {
  const navCategories = [
    {
      category: 'Core',
      items: [
        { id: 'overview', label: 'Dashboard', icon: '📊' },
        { id: 'providers', label: 'Providers', icon: '🔌' },
        { id: 'models', label: 'Models', icon: '🤖' },
        { id: 'test', label: 'API Test', icon: '🧪' },
      ],
    },
    {
      category: 'Development',
      items: [
        { id: 'chat', label: 'Chat', icon: '💬' },
        { id: 'agent', label: 'Agent', icon: '🧠' },
        { id: 'docs', label: 'Docs', icon: '📖' },
      ],
    },
    {
      category: 'Data',
      items: [
        { id: 'mapping', label: 'Routing', icon: '🗺️' },
        { id: 'sessions', label: 'Sessions', icon: '📡' },
        { id: 'conversations', label: 'Conversations', icon: '📝' },
        { id: 'usage', label: 'Usage', icon: '📈' },
      ],
    },
    {
      category: 'System',
      items: [
        { id: 'monitor', label: 'Monitor', icon: '🔴' },
      ],
    },
  ];

  const navHtml = navCategories.map(cat => `
    <div class="nav-category">
      <div class="nav-category-label">${cat.category}</div>
      ${cat.items.map(p => `
        <a href="/admin/dashboard/${p.id}" class="nav-item${p.id === activePage ? ' active' : ''}" data-page="${p.id}">
          <span class="nav-icon">${p.icon}</span>
          <span class="nav-label">${p.label}</span>
        </a>
      `).join('')}
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} - Proxi Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
/* ═══ CSS Variables (shadcn/ui inspired) ═══════════════ */
:root {
  --background: 0 0% 3.9%;
  --foreground: 0 0% 98%;
  --card: 0 0% 5.5%;
  --card-foreground: 0 0% 98%;
  --primary: 0 0% 98%;
  --primary-foreground: 0 0% 9%;
  --secondary: 0 0% 9%;
  --secondary-foreground: 0 0% 98%;
  --muted: 0 0% 9%;
  --muted-foreground: 0 0% 63.9%;
  --accent: 0 0% 14.9%;
  --accent-foreground: 0 0% 98%;
  --destructive: 0 72% 51%;
  --destructive-foreground: 0 0% 98%;
  --border: 0 0% 14.9%;
  --input: 0 0% 14.9%;
  --ring: 0 0% 83.1%;
  --radius: 0.5rem;
  --sidebar-bg: 0 0% 5.5%;
  --sidebar-border: 0 0% 14.9%;
  --sidebar-active: 0 0% 98%;
  --green: 142 76% 36%;
  --yellow: 38 92% 50%;
  --red: 0 84% 60%;
  --blue: 217 91% 60%;
  --purple: 270 76% 58%;
  --orange: 25 95% 53%;
}

/* ═══ Reset & Base ═════════════════════════════════════ */
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:hsl(var(--background));color:hsl(var(--foreground));display:flex;min-height:100vh;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}

/* ═══ Sidebar ══════════════════════════════════════════ */
.sidebar{width:260px;background:hsl(var(--sidebar-bg));border-right:1px solid hsl(var(--sidebar-border));flex-shrink:0;position:fixed;top:0;left:0;bottom:0;overflow-y:auto;z-index:10;display:flex;flex-direction:column}
.sidebar::-webkit-scrollbar{width:4px}
.sidebar::-webkit-scrollbar-thumb{background:hsl(var(--border));border-radius:4px}
.sidebar-header{padding:20px 16px 16px;border-bottom:1px solid hsl(var(--sidebar-border))}
.sidebar-header h1{font-size:1.05rem;font-weight:700;color:hsl(var(--foreground));letter-spacing:-0.02em}
.sidebar-header .sub{font-size:.7rem;color:hsl(var(--muted-foreground));margin-top:3px;text-transform:uppercase;letter-spacing:0.05em}
.sidebar-nav{flex:1;padding:12px 8px;overflow-y:auto}
.nav-category{margin-bottom:16px}
.nav-category-label{padding:4px 12px;font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:hsl(var(--muted-foreground));margin-bottom:4px}
.nav-item{display:flex;align-items:center;gap:10px;padding:8px 12px;color:hsl(var(--muted-foreground));font-size:.85rem;font-weight:500;border-radius:var(--radius);transition:all .15s;margin-bottom:2px}
.nav-item:hover{background:hsl(var(--accent));color:hsl(var(--accent-foreground))}
.nav-item.active{background:hsl(var(--accent));color:hsl(var(--foreground));font-weight:600}
.nav-icon{font-size:1rem;width:20px;text-align:center;flex-shrink:0}
.sidebar-footer{padding:12px 16px;border-top:1px solid hsl(var(--sidebar-border));font-size:.7rem;color:hsl(var(--muted-foreground))}

/* ═══ Main Content ════════════════════════════════════ */
.main{flex:1;margin-left:260px;padding:24px 32px;max-width:calc(100vw - 260px);min-height:100vh}

/* ═══ Page Header ═════════════════════════════════════ */
.page-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;flex-wrap:wrap;gap:12px}
.page-header h2{font-size:1.5rem;font-weight:700;color:hsl(var(--foreground));letter-spacing:-0.02em}
.page-header .subtitle{font-size:.85rem;color:hsl(var(--muted-foreground));margin-top:4px}

/* ═══ Cards ═══════════════════════════════════════════ */
.card{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:calc(var(--radius) + 2px);padding:20px;margin-bottom:16px}
.card h3{font-size:.8rem;font-weight:600;color:hsl(var(--muted-foreground));margin-bottom:14px;text-transform:uppercase;letter-spacing:0.06em}

/* ═══ Stat Grid ═══════════════════════════════════════ */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:24px}
.stat-card{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:calc(var(--radius) + 2px);padding:20px;position:relative;overflow:hidden}
.stat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,hsl(var(--blue)),hsl(var(--purple)))}
.stat-card.green::before{background:linear-gradient(90deg,hsl(var(--green)),hsl(142,76%,46%))}
.stat-card.yellow::before{background:linear-gradient(90deg,hsl(var(--yellow)),hsl(38,92%,60%))}
.stat-card.red::before{background:linear-gradient(90deg,hsl(var(--red)),hsl(0,84%,70%))}
.stat-value{font-size:1.75rem;font-weight:700;color:hsl(var(--foreground));letter-spacing:-0.02em}
.stat-label{font-size:.7rem;color:hsl(var(--muted-foreground));text-transform:uppercase;letter-spacing:0.06em;margin-top:6px;font-weight:500}
.stat-icon{position:absolute;top:16px;right:16px;font-size:1.2rem;opacity:.5}

/* ═══ Tables ══════════════════════════════════════════ */
.table-wrapper{overflow-x:auto;border:1px solid hsl(var(--border));border-radius:calc(var(--radius) + 2px)}
table{width:100%;border-collapse:collapse;font-size:.85rem}
thead{background:hsl(var(--muted))}
th{text-align:left;padding:10px 16px;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:hsl(var(--muted-foreground));white-space:nowrap;border-bottom:1px solid hsl(var(--border))}
td{padding:10px 16px;border-bottom:1px solid hsl(var(--border));vertical-align:middle}
tr:last-child td{border-bottom:none}
tbody tr{transition:background .15s}
tbody tr:hover{background:hsl(var(--accent) / 0.3)}
code{font-family:"SF Mono","Fira Code",monospace;font-size:.8rem;background:hsl(var(--muted));padding:2px 6px;border-radius:4px;color:hsl(142,76%,56%)}

/* ═══ Badges ══════════════════════════════════════════ */
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:9999px;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;line-height:1}
.badge-opencode{background:hsl(var(--purple) / 0.2);color:hsl(270,76%,72%);border:1px solid hsl(var(--purple) / 0.3)}
.badge-groq{background:hsl(var(--green) / 0.2);color:hsl(142,76%,56%);border:1px solid hsl(var(--green) / 0.3)}
.badge-openai{background:hsl(160,84%,39% / 0.2);color:hsl(160,84%,55%);border:1px solid hsl(160,84%,39% / 0.3)}
.badge-gemini{background:hsl(var(--blue) / 0.2);color:hsl(217,91%,70%);border:1px solid hsl(var(--blue) / 0.3)}
.badge-ollama{background:hsl(var(--orange) / 0.2);color:hsl(25,95%,65%);border:1px solid hsl(var(--orange) / 0.3)}
.badge-other{background:hsl(var(--muted));color:hsl(var(--muted-foreground));border:1px solid hsl(var(--border))}
.badge-success{background:hsl(var(--green) / 0.2);color:hsl(142,76%,56%);border:1px solid hsl(var(--green) / 0.3)}
.badge-warning{background:hsl(var(--yellow) / 0.2);color:hsl(38,92%,65%);border:1px solid hsl(var(--yellow) / 0.3)}
.badge-error{background:hsl(var(--red) / 0.2);color:hsl(0,84%,70%);border:1px solid hsl(var(--red) / 0.3)}
.badge-neutral{background:hsl(var(--muted));color:hsl(var(--muted-foreground));border:1px solid hsl(var(--border))}

/* ═══ Progress ════════════════════════════════════════ */
.progress{height:6px;background:hsl(var(--muted));border-radius:9999px;overflow:hidden;margin-top:6px}
.progress-bar{height:100%;border-radius:9999px;transition:width .3s}
.progress-bar.green{background:hsl(var(--green))}
.progress-bar.yellow{background:hsl(var(--yellow))}
.progress-bar.red{background:hsl(var(--red))}
.progress-bar.blue{background:hsl(var(--blue))}

/* ═══ Status Dots ═════════════════════════════════════ */
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;flex-shrink:0}
.status-dot.online{background:hsl(var(--green));box-shadow:0 0 8px hsl(var(--green) / 0.5)}
.status-dot.offline{background:hsl(var(--muted-foreground) / 0.3)}
.status-dot.warning{background:hsl(var(--yellow))}

/* ═══ Buttons ═════════════════════════════════════════ */
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:1px solid hsl(var(--border));border-radius:var(--radius);background:hsl(var(--secondary));color:hsl(var(--secondary-foreground));cursor:pointer;font-size:.8rem;font-weight:500;font-family:inherit;transition:all .15s;line-height:1}
.btn:hover{background:hsl(var(--accent));border-color:hsl(var(--muted-foreground) / 0.3)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-primary{background:hsl(var(--foreground));color:hsl(var(--background));border-color:hsl(var(--foreground))}
.btn-primary:hover{opacity:.9}
.btn-danger{background:hsl(var(--destructive));color:hsl(var(--destructive-foreground));border-color:hsl(var(--destructive))}
.btn-danger:hover{opacity:.9}
.btn-success{background:hsl(var(--green));color:#fff;border-color:hsl(var(--green))}
.btn-success:hover{opacity:.9}
.btn-ghost{background:transparent;border-color:transparent;color:hsl(var(--muted-foreground))}
.btn-ghost:hover{background:hsl(var(--accent));color:hsl(var(--foreground))}
.btn-sm{padding:4px 10px;font-size:.75rem}

/* ═══ Filter Bar ══════════════════════════════════════ */
.filter-bar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
.filter-bar input,.filter-bar select{padding:7px 12px;border:1px solid hsl(var(--border));border-radius:var(--radius);background:hsl(var(--background));color:hsl(var(--foreground));font-size:.85rem;font-family:inherit}
.filter-bar input:focus,.filter-bar select:focus{outline:none;border-color:hsl(var(--ring));box-shadow:0 0 0 2px hsl(var(--ring) / 0.2)}
.filter-bar input::placeholder{color:hsl(var(--muted-foreground) / 0.5)}

/* ═══ Empty State ═════════════════════════════════════ */
.empty-state{text-align:center;padding:48px 20px;color:hsl(var(--muted-foreground))}
.empty-state .icon{font-size:2.5rem;margin-bottom:12px;opacity:.5}
.empty-state p{font-size:.9rem}

/* ═══ Spinner ═════════════════════════════════════════ */
.spinner{display:inline-block;width:20px;height:20px;border:2px solid hsl(var(--border));border-top-color:hsl(var(--foreground));border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* ═══ Toast ═══════════════════════════════════════════ */
.toast{position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:var(--radius);color:#fff;font-size:.85rem;font-weight:500;z-index:100;opacity:0;transition:opacity .3s;box-shadow:0 4px 12px rgba(0,0,0,.3)}
.toast.show{opacity:1}
.toast.success{background:hsl(var(--green))}
.toast.error{background:hsl(var(--destructive))}

/* ═══ Modal ═══════════════════════════════════════════ */
.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);z-index:50;display:none;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal-content{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:calc(var(--radius) + 4px);padding:24px;max-width:700px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 16px 48px rgba(0,0,0,.4)}
.modal-content h3{margin-bottom:16px;color:hsl(var(--foreground));font-size:1.1rem;font-weight:600}
.modal-close{float:right;cursor:pointer;color:hsl(var(--muted-foreground));font-size:1.2rem;background:none;border:none;padding:4px;line-height:1}
.modal-close:hover{color:hsl(var(--foreground))}

/* ═══ Provider Cards ══════════════════════════════════ */
.provider-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-bottom:24px}
.provider-card{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:calc(var(--radius) + 2px);padding:20px;transition:all .2s}
.provider-card:hover{border-color:hsl(var(--ring) / 0.4)}
.provider-card.active{border-color:hsl(var(--green) / 0.5)}
.provider-card .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.provider-card .name{font-size:1rem;font-weight:600;color:hsl(var(--foreground))}
.provider-card .status{font-size:.7rem;padding:3px 10px;border-radius:9999px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em}
.provider-card .status.active{background:hsl(var(--green) / 0.2);color:hsl(142,76%,56%)}
.provider-card .status.disabled{background:hsl(var(--muted));color:hsl(var(--muted-foreground))}
.provider-card .meta{font-size:.8rem;color:hsl(var(--muted-foreground));margin-bottom:10px}
.provider-card .models-list{max-height:140px;overflow-y:auto;font-size:.8rem}
.provider-card .model-item{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid hsl(var(--border))}
.provider-card .model-item:last-child{border-bottom:none}

/* ═══ Chat ════════════════════════════════════════════ */
.chat-container{display:flex;flex-direction:column;height:calc(100vh - 180px);background:hsl(var(--background));border:1px solid hsl(var(--border));border-radius:calc(var(--radius) + 2px);overflow:hidden}
.chat-header{padding:12px 16px;background:hsl(var(--card));border-bottom:1px solid hsl(var(--border));display:flex;justify-content:space-between;align-items:center}
.chat-header select{padding:6px 10px;border:1px solid hsl(var(--border));border-radius:var(--radius);background:hsl(var(--background));color:hsl(var(--foreground));font-size:.85rem;font-family:inherit}
.chat-messages{flex:1;overflow-y:auto;padding:16px}
.chat-message{margin-bottom:16px;display:flex;gap:12px}
.chat-message.user{flex-direction:row-reverse}
.chat-message .avatar{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0;font-weight:600}
.chat-message.user .avatar{background:hsl(var(--blue));color:#fff}
.chat-message.assistant .avatar{background:hsl(var(--green));color:#fff}
.chat-message.system .avatar{background:hsl(var(--muted));color:hsl(var(--muted-foreground))}
.chat-message .bubble{max-width:70%;padding:10px 14px;border-radius:12px;font-size:.9rem;line-height:1.6}
.chat-message.user .bubble{background:hsl(var(--blue));color:#fff;border-bottom-right-radius:4px}
.chat-message.assistant .bubble{background:hsl(var(--card));color:hsl(var(--foreground));border:1px solid hsl(var(--border));border-bottom-left-radius:4px}
.chat-message.system .bubble{background:hsl(var(--muted));color:hsl(var(--muted-foreground));font-style:italic;font-size:.8rem}
.chat-input{padding:12px 16px;background:hsl(var(--card));border-top:1px solid hsl(var(--border));display:flex;gap:8px}
.chat-input textarea{flex:1;padding:8px 12px;border:1px solid hsl(var(--border));border-radius:var(--radius);background:hsl(var(--background));color:hsl(var(--foreground));font-size:.9rem;resize:none;min-height:40px;max-height:120px;font-family:inherit}
.chat-input textarea:focus{outline:none;border-color:hsl(var(--ring));box-shadow:0 0 0 2px hsl(var(--ring) / 0.2)}
.chat-input button{padding:8px 16px;border:none;border-radius:var(--radius);background:hsl(var(--foreground));color:hsl(var(--background));cursor:pointer;font-size:.9rem;font-weight:500;font-family:inherit}
.chat-input button:hover{opacity:.9}
.chat-input button:disabled{background:hsl(var(--muted));color:hsl(var(--muted-foreground));cursor:not-allowed}

/* ═══ Tabs ════════════════════════════════════════════ */
.tabs{display:flex;gap:2px;background:hsl(var(--muted));border-radius:var(--radius);padding:3px;margin-bottom:16px;width:fit-content}
.tab{padding:6px 14px;border-radius:calc(var(--radius) - 2px);font-size:.8rem;font-weight:500;color:hsl(var(--muted-foreground));cursor:pointer;transition:all .15s;background:transparent;border:none;font-family:inherit}
.tab:hover{color:hsl(var(--foreground))}
.tab.active{background:hsl(var(--card));color:hsl(var(--foreground));box-shadow:0 1px 2px rgba(0,0,0,.2)}

/* ═══ Responsive ══════════════════════════════════════ */
@media(max-width:768px){
  .sidebar{width:60px}
  .sidebar .nav-label,.sidebar .nav-category-label,.sidebar-header h1,.sidebar-header .sub,.sidebar-footer{display:none}
  .nav-item{justify-content:center;padding:10px}
  .nav-icon{width:auto}
  .main{margin-left:60px;max-width:calc(100vw - 60px);padding:16px}
  .stat-grid{grid-template-columns:repeat(2,1fr)}
  .provider-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div class="sidebar">
  <div class="sidebar-header">
    <h1>⚡ Proxi</h1>
    <div class="sub">Admin Dashboard</div>
  </div>
  <nav class="sidebar-nav">
    ${navHtml}
  </nav>
  <div class="sidebar-footer">ZombieCoder v2.0</div>
</div>
<div class="main" id="main-content">
  ${body}
</div>
<script>
const page = '${escapeHtml(activePage)}';
function $(s){return document.getElementById(s)}
function $$(s){return document.querySelectorAll(s)}
async function api(url,opts){const r=await fetch(url,opts);if(!r.ok)throw new Error(await r.text());return r.json()}
function esc(s){if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function toast(msg,type='success'){let t=$('toast');if(!t){t=document.createElement('div');t.id='toast';t.className='toast';document.body.appendChild(t)}t.textContent=msg;t.className='toast '+type+' show';setTimeout(()=>t.classList.remove('show'),3000)}
function badgeClass(p){const l=(p||'').toLowerCase();if(l.includes('opencode'))return'badge-opencode';if(l.includes('groq'))return'badge-groq';if(l.includes('openai'))return'badge-openai';if(l.includes('gemini')||l.includes('google'))return'badge-gemini';if(l.includes('ollama'))return'badge-ollama';return'badge-other'}
$$('.nav-item').forEach(a=>{a.addEventListener('click',e=>{e.preventDefault();const p=a.dataset.page;history.pushState(null,'','/admin/dashboard/'+p);loadPage(p)})});
function loadPage(p){$$('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.page===p));const c=$('main-content');c.innerHTML='<div style="text-align:center;padding:80px"><div class="spinner"></div></div>';switch(p){case'overview':loadOverview(c);break;case'providers':loadProviders(c);break;case'models':loadModels(c);break;case'test':loadTest(c);break;case'chat':loadChat(c);break;case'mapping':loadMapping(c);break;case'sessions':loadSessions(c);break;case'conversations':loadConversations(c);break;case'usage':loadUsage(c);break;case'monitor':loadMonitor(c);break;case'agent':loadAgent(c);break;case'docs':loadDocs(c);break;default:c.innerHTML='<div class="empty-state"><div class="icon">404</div><p>Page not found</p></div>'}}

// ═══ OVERVIEW ═══════════════════════════════════════════════
async function loadOverview(el){
  try{
    const[stats,identity]=await Promise.all([api('/api/admin/stats'),api('/api/admin/identity')]);
    el.innerHTML=\`<div class="page-header"><div><h2>Dashboard Overview</h2><div class="subtitle">Real-time system status</div></div><div class="subtitle">\${esc(identity.name||'ZombieCoder')} v\${esc(identity.version||'')}</div></div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-value">\${stats.models_count}</div><div class="stat-label">Models</div></div>
      <div class="stat-card"><div class="stat-value">\${stats.total_requests}</div><div class="stat-label">Requests</div></div>
      <div class="stat-card"><div class="stat-value">\${stats.sessions_active}</div><div class="stat-label">Sessions</div></div>
      <div class="stat-card"><div class="stat-value">\${stats.conversations}</div><div class="stat-label">Conversations</div></div>
      <div class="stat-card"><div class="stat-value">\${stats.providers}</div><div class="stat-label">Providers</div></div>
      <div class="stat-card"><div class="stat-value">\${stats.uptime_formatted}</div><div class="stat-label">Uptime</div></div>
    </div>
    <div class="card"><h3>Models by Provider</h3><div id="provider-chart"></div></div>\`;
    const chart=$('provider-chart');
    const provs=stats.models_by_provider||[];
    chart.innerHTML=provs.length?provs.map(p=>\`<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #21262d"><span class="badge badge-\${esc((p.provider||'').toLowerCase())}">\${esc(p.provider)}</span><div style="flex:1"><div class="progress"><div class="progress-bar blue" style="width:\${Math.min(p.count*10,100)}%"></div></div></div><span style="font-size:.85rem;color:#8b949e">\${p.count} models</span></div>\`).join(''):'<div class="empty-state">No models</div>';
  }catch(e){el.innerHTML='<div class="empty-state">Failed to load: '+esc(e.message)+'</div>'}
}

// ═══ PROVIDERS PAGE ═════════════════════════════════════════
async function loadProviders(el){
  try{
    const data=await api('/api/admin/providers');
    const providers=data.providers||[];
    const costs=data.costs||[];
    const costMap={};costs.forEach(c=>{costMap[c.provider]=c});

    el.innerHTML=\`<div class="page-header"><div><h2>Provider Management</h2><div class="subtitle">\${providers.length} registered providers</div></div>
    <div class="filter-bar">
      <button class="btn btn-primary" onclick="syncAllProviders()">Sync All</button>
      <button class="btn" onclick="addProviderModal()">+ Add Provider</button>
    </div></div>

    <div class="card" style="padding:0">
      <table style="width:100%;font-size:.85rem">
        <thead><tr>
          <th style="padding:10px 12px;border-bottom:2px solid #30363d">Provider</th>
          <th style="padding:10px 12px;border-bottom:2px solid #30363d">Type</th>
          <th style="padding:10px 12px;border-bottom:2px solid #30363d">Priority</th>
          <th style="padding:10px 12px;border-bottom:2px solid #30363d">Health</th>
          <th style="padding:10px 12px;border-bottom:2px solid #30363d">Models</th>
          <th style="padding:10px 12px;border-bottom:2px solid #30363d">Caps</th>
          <th style="padding:10px 12px;border-bottom:2px solid #30363d">Status</th>
          <th style="padding:10px 12px;border-bottom:2px solid #30363d">Actions</th>
        </tr></thead>
        <tbody id="provider-list"></tbody>
      </table>
    </div>

    <div id="provider-detail" style="display:none;margin-top:16px"></div>
    <div class="card"><h3>Cost Summary (30 days)</h3><div id="cost-summary"></div></div>
    <div class="modal-overlay" id="provider-modal"><div class="modal-content"><span class="modal-close" onclick="closeModal('provider-modal')">&times;</span><h3 id="pm-title">Add Provider</h3><div id="pm-body"></div></div></div>\`;

    window._providers=providers;
    window._costMap=costMap;
    renderProviderList(providers,costMap);

    const costEl=$('cost-summary');
    const totalCost=costs.reduce((s,c)=>s+(c.estimated_cost_usd||0),0);
    const totalReqs=costs.reduce((s,c)=>s+(c.total_requests||0),0);
    costEl.innerHTML=costs.length? \`<div class="stat-grid"><div class="stat-card"><div class="stat-value">$\${totalCost.toFixed(4)}</div><div class="stat-label">Total Cost (30d)</div></div><div class="stat-card"><div class="stat-value">\${totalReqs.toLocaleString()}</div><div class="stat-label">Total Requests</div></div></div>
    <table><thead><tr><th>Provider</th><th>Requests</th><th>Prompt Tokens</th><th>Completion Tokens</th><th>Est. Cost</th></tr></thead><tbody>\${costs.map(c=>\`<tr><td><span class="badge badge-\${esc((c.provider||'').toLowerCase())}">\${esc(c.provider)}</span></td><td>\${(c.total_requests||0).toLocaleString()}</td><td>\${(c.total_prompt_tokens||0).toLocaleString()}</td><td>\${(c.total_completion_tokens||0).toLocaleString()}</td><td>$\${(c.estimated_cost_usd||0).toFixed(4)}</td></tr>\`).join('')}</tbody></table>\`:'<div style="color:#8b949e;padding:12px">No usage data yet</div>';
  }catch(e){el.innerHTML='<div class="empty-state">Failed to load: '+esc(e.message)+'</div>'}
}

function renderProviderList(providers,costMap){
  const tbody=$('provider-list');if(!tbody)return;
  tbody.innerHTML=providers.map(p=>{
    const cost=costMap[p.id]||{total_requests:0,estimated_cost_usd:0};
    const caps=p.capabilities||{};
    const capList=[];
    if(caps.streaming)capList.push('Stream');
    if(caps.toolCalling)capList.push('Tools');
    if(caps.vision)capList.push('Vision');
    if(caps.audio)capList.push('Audio');
    const healthColor=p.health_status==='healthy'?'#3fb950':p.health_status==='error'?'#f85149':'#8b949e';
    return \`<tr style="cursor:pointer;border-bottom:1px solid #21262d" onclick="showProviderDetail('\${esc(p.id)}')">
      <td style="padding:10px 12px"><strong style="color:#58a6ff">\${esc(p.name)}</strong><div style="font-size:.75rem;color:#8b949e">\${esc(p.base_url)}</div></td>
      <td style="padding:10px 12px"><code style="font-size:.75rem">\${esc(p.type)}</code></td>
      <td style="padding:10px 12px">\${p.priority}</td>
      <td style="padding:10px 12px"><span style="color:\${healthColor};font-size:.85rem">● \${esc(p.health_status||'unknown')}</span></td>
      <td style="padding:10px 12px">\${p.model_count||0}</td>
      <td style="padding:10px 12px;font-size:.75rem">\${capList.join(', ')||'-'}</td>
      <td style="padding:10px 12px"><span style="padding:2px 8px;border-radius:8px;font-size:.75rem;background:\${p.is_active?'#1a7f37':'#30363d'};color:\${p.is_active?'#fff':'#8b949e'}">\${p.is_active?'Active':'Off'}</span></td>
      <td style="padding:10px 12px" onclick="event.stopPropagation()">
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="testProvider('\${esc(p.id)}')" style="font-size:.75rem;padding:3px 8px">Test</button>
          <button class="btn" onclick="syncProvider('\${esc(p.id)}')" style="font-size:.75rem;padding:3px 8px">Sync</button>
          <button class="btn" onclick="toggleProvider('\${esc(p.id)}',\${!p.is_active})" style="font-size:.75rem;padding:3px 8px">\${p.is_active?'Disable':'Enable'}</button>
          <button class="btn btn-danger" onclick="deleteProvider('\${esc(p.id)}')" style="font-size:.75rem;padding:3px 8px">Del</button>
        </div>
        <div id="test-result-\${esc(p.id)}" style="margin-top:6px;display:none"></div>
      </td>
    </tr>\`;
  }).join('');
}

function showProviderDetail(id){
  const providers=window._providers||[];
  const costMap=window._costMap||{};
  const p=providers.find(x=>x.id===id);
  if(!p)return;
  const cost=costMap[p.id]||{total_requests:0,estimated_cost_usd:0};
  const caps=p.capabilities||{};
  const el=$('provider-detail');if(!el)return;
  el.style.display='block';
  el.innerHTML=\`<div class="card" style="border-left:3px solid #58a6ff">
    <div style="display:flex;justify-content:space-between;align-items:start">
      <div>
        <h3>\${esc(p.name)} <span style="font-size:.85rem;color:#8b949e">(\${esc(p.id)})</span></h3>
        <div style="font-size:.85rem;color:#8b949e;margin-top:4px">\${esc(p.type)} • Priority: \${p.priority}</div>
      </div>
      <button class="btn" onclick="$('provider-detail').style.display='none'" style="font-size:.75rem">✕ Close</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-top:16px">
      <div><div style="color:#8b949e;font-size:.75rem;text-transform:uppercase">Base URL</div><div><code>\${esc(p.base_url)}</code></div></div>
      <div><div style="color:#8b949e;font-size:.75rem;text-transform:uppercase">API Key</div><div>\${p.api_key_env?'<code>'+esc(p.api_key_env)+'</code>':'<span style="color:#f85149">Not set</span>'}</div></div>
      <div><div style="color:#8b949e;font-size:.75rem;text-transform:uppercase">Health</div><div style="color:\${p.health_status==='healthy'?'#3fb950':'#f85149'}">\${esc(p.health_status||'unknown')}</div></div>
      <div><div style="color:#8b949e;font-size:.75rem;text-transform:uppercase">Status</div><div>\${p.is_active?'<span style="color:#3fb950">Active</span>':'<span style="color:#8b949e">Disabled</span>'}</div></div>
    </div>
    <div style="margin-top:16px">
      <div style="color:#8b949e;font-size:.75rem;text-transform:uppercase;margin-bottom:4px">Capabilities</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        \${caps.streaming?'<span style="padding:2px 8px;border-radius:8px;font-size:.75rem;background:#0d2b45;color:#58a6ff">🟢 Streaming</span>':'<span style="padding:2px 8px;border-radius:8px;font-size:.75rem;background:#30363d;color:#8b949e">🔴 Streaming</span>'}
        \${caps.toolCalling?'<span style="padding:2px 8px;border-radius:8px;font-size:.75rem;background:#0d2b45;color:#58a6ff">🟢 Tool Call</span>':'<span style="padding:2px 8px;border-radius:8px;font-size:.75rem;background:#30363d;color:#8b949e">🔴 Tool Call</span>'}
        \${caps.vision?'<span style="padding:2px 8px;border-radius:8px;font-size:.75rem;background:#0d2b45;color:#58a6ff">🟢 Vision</span>':'<span style="padding:2px 8px;border-radius:8px;font-size:.75rem;background:#30363d;color:#8b949e">🔴 Vision</span>'}
        \${caps.audio?'<span style="padding:2px 8px;border-radius:8px;font-size:.75rem;background:#0d2b45;color:#58a6ff">🟢 Audio</span>':'<span style="padding:2px 8px;border-radius:8px;font-size:.75rem;background:#30363d;color:#8b949e">🔴 Audio</span>'}
        \${caps.embeddings?'<span style="padding:2px 8px;border-radius:8px;font-size:.75rem;background:#0d2b45;color:#58a6ff">🟢 Embeddings</span>':'<span style="padding:2px 8px;border-radius:8px;font-size:.75rem;background:#30363d;color:#8b949e">🔴 Embeddings</span>'}
      </div>
    </div>
    <div style="margin-top:16px">
      <div style="color:#8b949e;font-size:.75rem;text-transform:uppercase;margin-bottom:4px">Models (\${(p.models||[]).length})</div>
      <div style="max-height:200px;overflow-y:auto">\${(p.models||[]).map(m=>\`<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #21262d;font-size:.8rem">
        <span><code>\${esc(m.model_id)}</code> <span class="badge badge-\${esc((m.category||'other').toLowerCase())}">\${esc(m.category||'other')}</span></span>
        <span>\${m.is_free?'<span style="color:#3fb950">Free</span>':'<span style="color:#8b949e">Paid</span>'}</span>
      </div>\`).join('')||'<div style="color:#8b949e">No models</div>'}</div>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn btn-primary" onclick="testProvider('\${esc(p.id)}')">Test Connection</button>
      <button class="btn btn-success" onclick="syncProvider('\${esc(p.id)}')">Sync Models</button>
      <button class="btn" onclick="editProvider('\${esc(p.id)}')">Edit</button>
    </div>
    <div id="detail-test-result" style="margin-top:8px"></div>
  </div>\`;
  el.scrollIntoView({behavior:'smooth',block:'start'});
}
async function testProvider(id){
  const resultEl=$('test-result-'+id);
  if(resultEl){resultEl.style.display='block';resultEl.innerHTML='<div class="spinner"></div> Testing...';}
  try{
    const r=await api('/api/admin/providers/'+encodeURIComponent(id)+'/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
    if(resultEl){
      resultEl.innerHTML=r.ok
        ? \`<div style="padding:8px;background:#0d2b45;border-radius:6px;font-size:.8rem;border-left:3px solid #3fb950"><strong style="color:#3fb950">✓ Success</strong> (\${r.duration_ms}ms) Model: \${esc(r.model)}<div style="margin-top:4px;color:#c9d1d9">\${esc(r.response?.slice(0,200))}</div></div>\`
        : \`<div style="padding:8px;background:#3d0d0d;border-radius:6px;font-size:.8rem;border-left:3px solid #f85149"><strong style="color:#f85149">✗ Failed</strong> \${r.status} (\${r.duration_ms}ms) Model: \${esc(r.model)}<div style="margin-top:4px;color:#f85149">\${esc(r.error?.slice(0,300))}</div></div>\`;
    }
    setTimeout(()=>loadPage('providers'),2000);
  }catch(e){if(resultEl)resultEl.innerHTML='<div style="padding:8px;color:#f85149;font-size:.8rem">Error: '+esc(e.message)+'</div>';}
}
async function syncProvider(id){try{toast('Syncing '+id+'...');const r=await api('/api/admin/providers/'+encodeURIComponent(id)+'/sync',{method:'POST'});toast('Fetched '+r.fetched+' models, added '+r.added);loadPage('providers')}catch(e){toast(e.message,'error')}}
async function syncAllProviders(){try{toast('Syncing all providers...');const r=await api('/api/admin/providers/sync-all',{method:'POST'});const summary=(r.providers||[]).map(p=>p.id+':+'+p.added).join(', ');toast('Synced: '+summary);loadPage('providers')}catch(e){toast(e.message,'error')}}
async function toggleProvider(id,active){try{await api('/api/admin/providers/'+encodeURIComponent(id)+'/toggle',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({is_active:active})});toast(active?'Enabled':'Disabled');loadPage('providers')}catch(e){toast(e.message,'error')}}
async function deleteProvider(id){if(!confirm('Delete provider '+id+'? This removes all its models.'))return;try{await api('/api/admin/providers/'+encodeURIComponent(id),{method:'DELETE'});toast('Deleted');loadPage('providers')}catch(e){toast(e.message,'error')}}
function editProvider(id){toast('Edit modal for '+id+' — use Add Provider form')}
function addProviderModal(){
  $('pm-title').textContent='Add Provider';
  $('pm-body').innerHTML=\`<div style="display:grid;gap:12px">
    <div><label style="font-size:.75rem;color:#8b949e">ID</label><input id="np-id" style="width:100%;padding:6px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9" placeholder="my-provider"></div>
    <div><label style="font-size:.75rem;color:#8b949e">Name</label><input id="np-name" style="width:100%;padding:6px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9" placeholder="My Provider"></div>
    <div><label style="font-size:.75rem;color:#8b949e">Type</label><select id="np-type" style="width:100%;padding:6px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9"><option value="openai-compatible">OpenAI Compatible</option><option value="groq">Groq</option><option value="opencode">OpenCode</option><option value="ollama">Ollama</option><option value="anthropic">Anthropic</option></select></div>
    <div><label style="font-size:.75rem;color:#8b949e">Base URL</label><input id="np-url" style="width:100%;padding:6px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9" placeholder="https://api.example.com/v1"></div>
    <div><label style="font-size:.75rem;color:#8b949e">API Key Env Variable</label><input id="np-env" style="width:100%;padding:6px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9" placeholder="MY_API_KEY"></div>
    <div><label style="font-size:.75rem;color:#8b949e">API Key (direct, optional)</label><input id="np-key" type="password" style="width:100%;padding:6px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9" placeholder="sk-..."></div>
    <div><label style="font-size:.75rem;color:#8b949e">Priority (higher = preferred)</label><input id="np-pri" type="number" value="50" style="width:100%;padding:6px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9"></div>
    <button class="btn btn-primary" onclick="saveNewProvider()">Save Provider</button>
  </div>\`;
  $('provider-modal').classList.add('show');
}
async function saveNewProvider(){
  try{
    const data={
      id:$('np-id')?.value.trim(),name:$('np-name')?.value.trim(),
      type:$('np-type')?.value,base_url:$('np-url')?.value.trim(),
      api_key_env:$('np-env')?.value.trim()||null,api_key:$('np-key')?.value.trim()||null,
      priority:Number($('np-pri')?.value||50)
    };
    if(!data.id||!data.name||!data.base_url)throw new Error('ID, Name, URL required');
    await api('/api/admin/providers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    closeModal('provider-modal');toast('Provider added');loadPage('providers');
  }catch(e){toast(e.message,'error')}
}
function closeModal(id){$(id).classList.remove('show')}

// ═══ MODELS PAGE ════════════════════════════════════════════
async function loadModels(el){
  try{
    const data=await api('/api/admin/models');
    const models=data.models||[];

    el.innerHTML=\`<div class="page-header"><div><h2>Model Explorer</h2><div class="subtitle">\${models.length} total models</div></div>
    <div class="filter-bar">
      <button class="btn btn-primary" onclick="syncAllProviders()">Sync All Providers</button>
      <button class="btn" onclick="autoRouteTest()">Auto Route Test</button>
      <input type="text" id="mf" placeholder="Filter..." oninput="filterM()">
      <select id="cf" onchange="filterM()"><option value="">All Categories</option><option value="free">Free Only</option><option value="fast">Fast</option><option value="balanced">Balanced</option><option value="powerful">Powerful</option><option value="vision">Vision</option><option value="audio">Audio</option></select>
      <select id="pf" onchange="filterM()"><option value="">All Providers</option></select>
    </div></div>

    <div class="card"><h3>All Models</h3><div id="ms"></div><div id="ml"></div></div>
    <div class="modal-overlay" id="mu-modal"><div class="modal-content"><span class="modal-close" onclick="closeModal('mu-modal')">&times;</span><h3 id="mu-title">Model Test</h3><div id="mu-body"></div></div></div>
    <div class="modal-overlay" id="art-modal"><div class="modal-content"><span class="modal-close" onclick="closeModal('art-modal')">&times;</span><h3>Auto Route Test</h3><div id="art-body"></div></div></div>\`;
    window._m=models;
    const pf=$('pf');[...new Set(models.map(m=>m.provider).filter(Boolean))].forEach(p=>{const o=document.createElement('option');o.value=p;o.textContent=p;pf.appendChild(o)});
    renderMS(models);renderML(models);
  }catch(e){el.innerHTML='<div class="empty-state">Failed: '+esc(e.message)+'</div>'}
}
function filterM(){
  const q=($('mf')?.value||'').toLowerCase();
  const cat=$('cf')?.value||'';
  const prov=$('pf')?.value||'';
  let l=window._m||[];
  if(prov)l=l.filter(m=>m.provider===prov||m.source_name===prov);
  if(cat==='free')l=l.filter(m=>m.is_free);
  else if(cat)l=l.filter(m=>m.category===cat);
  if(q)l=l.filter(m=>m.id.toLowerCase().includes(q));
  renderMS(l);renderML(l);
}
function renderMS(m){const el=$('ms');if(!el)return;const ap=m.filter(x=>x.is_active!==false&&x.status!=='disabled').length;const free=m.filter(x=>x.is_free).length;el.innerHTML=\`<div class="stat-grid"><div class="stat-card"><div class="stat-value">\${m.length}</div><div class="stat-label">Total</div></div><div class="stat-card"><div class="stat-value">\${ap}</div><div class="stat-label">Active</div></div><div class="stat-card"><div class="stat-value">\${free}</div><div class="stat-label">Free</div></div></div>\`}
function renderML(m){const el=$('ml');if(!el)return;if(!m.length){el.innerHTML='<div class="empty-state">No models match</div>';return}el.innerHTML='<table><thead><tr><th>Provider</th><th>Model ID</th><th>Category</th><th>Context</th><th>Free</th><th>Actions</th></tr></thead><tbody>'+m.slice(0,50).map(x=>\`<tr><td><span class="badge badge-\${esc((x.provider||'').toLowerCase())}">\${esc(x.provider)}</span></td><td><code>\${esc(x.id)}</code></td><td><span class="badge badge-\${esc((x.category||'other').toLowerCase())}">\${esc(x.category||'other')}</span></td><td>\${x.context_window?(x.context_window/1000).toFixed(0)+'k':'-'}</td><td>\${x.is_free?'✓':'-'}</td><td style="display:flex;gap:4px">
        <button class="btn" onclick="testModel('\${esc(x.id)}')" style="font-size:.75rem">Test</button>
        <button class="btn" onclick="setDefaultModel('\${esc(x.id)}')" style="font-size:.75rem">⭐</button>
        <button class="btn" onclick="toggleM('\${esc(x.id)}',\${x.is_active===false})" style="font-size:.75rem">\${x.is_active===false?'Enable':'Disable'}</button>
      </td></tr>\`).join('')+'</tbody></table>'}
async function syncAllProviders(){try{toast('Syncing all providers...');const r=await api('/api/admin/providers/sync-all',{method:'POST'});toast('Synced '+r.providers.length+' providers');loadPage('models')}catch(e){toast(e.message,'error')}}
async function toggleM(id,act){try{await api('/api/admin/models/'+encodeURIComponent(id)+'/active',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({is_active:act})});toast('Updated');loadPage('models')}catch(e){toast(e.message,'error')}}
async function testModel(id){
  $('mu-title').textContent='Test: '+id;
  $('mu-body').innerHTML=\`<div style="display:grid;gap:12px">
    <div><label style="font-size:.75rem;color:#8b949e">Message</label><textarea id="tm-msg" style="width:100%;padding:6px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9;min-height:60px">Hello! Say something brief.</textarea></div>
    <div style="display:flex;gap:8px;align-items:center">
      <label style="font-size:.75rem;color:#8b949e">Max Tokens</label><input id="tm-tokens" type="number" value="200" style="width:80px;padding:4px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9">
      <button class="btn btn-primary" onclick="runModelTest('\${esc(id)}')">Send</button>
    </div>
    <div id="tm-result"></div>
  </div>\`;
  $('mu-modal').classList.add('show');
}
async function runModelTest(id){
  const result=$('tm-result');if(result)result.innerHTML='<div class="spinner"></div> Sending...';
  try{
    const msg=$('tm-msg')?.value||'Hello';
    const tokens=Number($('tm-tokens')?.value||200);
    const r=await fetch('/api/admin/models/'+encodeURIComponent(id)+'/test',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:msg,max_tokens:tokens})
    });
    const data=await r.json();
    result.innerHTML=data.ok
      ? \`<div style="padding:8px;background:#0d2b45;border-radius:6px;font-size:.85rem;border-left:3px solid #3fb950"><strong style="color:#3fb950">✓ \${data.duration_ms}ms</strong> Model: \${esc(data.model)}<div style="margin-top:4px;white-space:pre-wrap">\${esc(data.response)}</div>\${data.usage?'<div style="margin-top:4px;color:#8b949e;font-size:.75rem">Tokens: '+data.usage.total_tokens+'</div>':''}</div>\`
      : \`<div style="padding:8px;background:#3d0d0d;border-radius:6px;font-size:.85rem;border-left:3px solid #f85149"><strong style="color:#f85149">✗ \${data.status}</strong> \${esc(data.error)}</div>\`;
  }catch(e){if(result)result.innerHTML='<div style="color:#f85149">Error: '+esc(e.message)+'</div>';}
}
async function setDefaultModel(id){try{await api('/api/admin/default-model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model_id:id})});toast(id+' set as default')}catch(e){toast(e.message,'error')}}
async function autoRouteTest(){
  $('art-body').innerHTML=\`<div style="display:grid;gap:12px">
    <div><label style="font-size:.75rem;color:#8b949e">Input Message</label><textarea id="art-msg" style="width:100%;padding:6px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9;min-height:60px">Write a Python function to sort a list</textarea></div>
    <button class="btn btn-primary" onclick="runAutoRoute()">Test Routing</button>
    <div id="art-result"></div>
  </div>\`;
  $('art-modal').classList.add('show');
}
async function runAutoRoute(){
  const result=$('art-result');if(result)result.innerHTML='<div class="spinner"></div> Analyzing...';
  try{
    const msg=$('art-msg')?.value||'';
    const r=await api('/api/admin/auto-route',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
    result.innerHTML=\`<div class="stat-grid"><div class="stat-card"><div class="stat-value">\${r.total_models}</div><div class="stat-label">Available</div></div><div class="stat-card"><div class="stat-value">\${r.input_length}</div><div class="stat-label">Input Length</div></div></div>
    <table style="margin-top:8px"><thead><tr><th>#</th><th>Model</th><th>Provider</th><th>Score</th><th>Category</th><th>Free</th><th></th></tr></thead><tbody>\${(r.recommendations||[]).map((rec,i)=>\`<tr style="\${i===0?'background:#0d2b45':''}"><td>\${i+1}\${i===0?' ⭐':''}</td><td><code>\${esc(rec.model_id)}</code></td><td><span class="badge badge-\${esc((rec.provider_id||'').toLowerCase())}">\${esc(rec.provider_id)}</span></td><td>\${rec.score}</td><td><span class="badge badge-\${esc((rec.category||'').toLowerCase())}">\${esc(rec.category)}</span></td><td>\${rec.is_free?'✓':'-'}</td><td><button class="btn btn-primary" onclick="testModel('\${esc(rec.model_id)}')">Test</button></td></tr>\`).join('')}</tbody></table>\`;
  }catch(e){if(result)result.innerHTML='<div style="color:#f85149">Error: '+esc(e.message)+'</div>';}
}

// ═══ CHAT PAGE ══════════════════════════════════════════════
let chatMessages=[];let chatModel='mimo-v2.5-free';let chatStreaming=true;
async function loadChat(el){
  try{
    const data=await api('/api/admin/models');
    const models=(data.models||[]).filter(m=>m.is_active!==false&&m.status!=='disabled');
    el.innerHTML=\`<div class="page-header"><div><h2>Chat</h2><div class="subtitle">Test models with streaming support</div></div></div>
    <div class="chat-container">
      <div class="chat-header">
        <span>Chat with Model</span>
        <div style="display:flex;gap:8px;align-items:center">
          <label style="font-size:.75rem;color:#8b949e"><input type="checkbox" id="chat-stream" \${chatStreaming?'checked':''} onchange="chatStreaming=this.checked"> Stream</label>
          <select id="chat-model" onchange="chatModel=this.value">\${models.map(m=>\`<option value="\${esc(m.id)}" \${m.id===chatModel?'selected':''}>\${esc(m.id)} (\${esc(m.provider||'')})</option>\`).join('')}</select>
        </div>
      </div>
      <div class="chat-messages" id="chat-msgs"></div>
      <div class="chat-input"><textarea id="chat-input" placeholder="Type your message..." rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat()}"></textarea><button onclick="sendChat()" id="chat-send">Send</button></div>
    </div>\`;
    renderChat();
  }catch(e){el.innerHTML='<div class="empty-state">Failed: '+esc(e.message)+'</div>'}
}
function renderChat(){const el=$('chat-msgs');if(!el)return;el.innerHTML=chatMessages.length?chatMessages.map(m=>\`<div class="chat-message \${m.role}"><div class="avatar">\${m.role==='user'?'👤':m.role==='assistant'?'🤖':'ℹ️'}</div><div class="bubble">\${esc(m.content).replace(/\\n/g,'<br>')}</div></div>\`).join(''):'<div class="empty-state"><div class="icon">💬</div><p>Select a model and start chatting</p></div>';el.scrollTop=el.scrollHeight}
async function sendChat(){const input=$('chat-input');const send=$('chat-send');if(!input||!input.value.trim())return;const msg=input.value.trim();input.value='';chatMessages.push({role:'user',content:msg});renderChat();send.disabled=true;send.textContent=chatStreaming?'Streaming...':'Thinking...';try{const model=chatModel||'mimo-v2.5-free';const messages=[...chatMessages.map(m=>({role:m.role,content:m.content})),{role:'user',content:msg}];if(chatStreaming){const r=await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages,max_tokens:2048,stream:true})});if(!r.ok)throw new Error(await r.text());const reader=r.body.getReader();const decoder=new TextDecoder();let reply='';let buffer='';chatMessages.push({role:'assistant',content:''});while(true){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split('\\n');buffer=lines.pop()||'';for(const line of lines){if(!line.startsWith('data: '))continue;const data=line.slice(6).trim();if(data==='[DONE]')continue;try{const j=JSON.parse(data);const delta=j.choices?.[0]?.delta?.content||'';reply+=delta;chatMessages[chatMessages.length-1].content=reply;renderChat()}catch{}}}}else{const r=await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages,max_tokens:2048,stream:false})});if(!r.ok)throw new Error(await r.text());const data=await r.json();const reply=data.choices?.[0]?.message?.content||'No response';chatMessages.push({role:'assistant',content:reply})}}catch(e){chatMessages.push({role:'system',content:'Error: '+e.message})}renderChat();send.disabled=false;send.textContent='Send';input.focus()}

// ═══ MAPPING PAGE ═══════════════════════════════════════════
async function loadMapping(el){
  try{
    const data=await api('/api/admin/mapping');
    el.innerHTML=\`<div class="page-header"><div><h2>Model Routing</h2><div class="subtitle">Provider routing rules</div></div></div>
    <div class="stat-grid"><div class="stat-card"><div class="stat-value">\${data.rules?.length||0}</div><div class="stat-label">Rules</div></div><div class="stat-card"><div class="stat-value">\${data.activeModels?.length||0}</div><div class="stat-label">Active Models</div></div><div class="stat-card"><div class="stat-value">\${data.editorStats?.active||0}</div><div class="stat-label">Editor Links</div></div></div>
    <div class="card"><h3>Add Rule</h3><div class="filter-bar"><input id="rp" placeholder="Pattern"><input id="rprov" placeholder="Provider"><input id="rurl" placeholder="Backend URL"><input id="rpri" type="number" value="0" style="width:100px"><button class="btn btn-primary" onclick="saveRule()">Save</button></div></div>
    <div class="card"><h3>Rules</h3><div id="rt"></div></div>\`;
    const rt=$('rt');rt.innerHTML=data.rules&&data.rules.length?'<table><thead><tr><th>Pattern</th><th>Provider</th><th>URL</th><th>Priority</th><th>Status</th><th>Action</th></tr></thead><tbody>'+data.rules.map(r=>\`<tr><td><code>\${esc(r.model_pattern)}</code></td><td><span class="badge badge-\${esc((r.provider_name||'').toLowerCase())}">\${esc(r.provider_name)}</span></td><td><code>\${esc(r.backend_url||'-')}</code></td><td>\${r.priority}</td><td><span class="status-dot \${r.is_active?'online':'offline'}"></span>\${r.is_active?'Active':'Off'}</td><td><button class="btn btn-danger" onclick="delRule(\${r.id})">Delete</button></td></tr>\`).join('')+'</tbody></table>':'<div class="empty-state">No rules</div>';
  }catch(e){el.innerHTML='<div class="empty-state">Failed: '+esc(e.message)+'</div>'}
}
async function saveRule(){try{const p={model_pattern:$('rp')?.value,provider_name:$('rprov')?.value,backend_url:$('rurl')?.value,priority:Number($('rpri')?.value||0),is_active:true};if(!p.model_pattern||!p.provider_name)throw new Error('Pattern and provider required');await api('/api/admin/mapping',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});toast('Saved');loadPage('mapping')}catch(e){toast(e.message,'error')}}
async function delRule(id){if(!confirm('Delete?'))return;try{await api('/api/admin/mapping/'+id,{method:'DELETE'});toast('Deleted');loadPage('mapping')}catch(e){toast(e.message,'error')}}

// ═══ SESSIONS ═══════════════════════════════════════════════
async function loadSessions(el){
  try{
    const data=await api('/api/admin/sessions');
    el.innerHTML=\`<div class="page-header"><div><h2>Sessions</h2><div class="subtitle">\${data.length} total</div></div>
    <div class="filter-bar"><button class="btn btn-danger" onclick="clearSessions()">Delete All Sessions</button></div></div>
    <div class="card">\${data.length?'<table><thead><tr><th>ID</th><th>Agent</th><th>Model</th><th>Status</th><th>Messages</th><th>Tokens</th><th>Started</th><th>Action</th></tr></thead><tbody>'+data.map(s=>\`<tr><td><code>\${esc(s.session_id?.slice(0,12))}...</code></td><td>\${esc(s.agent_name||'-')}</td><td><code>\${esc(s.model||'-')}</code></td><td><span class="status-dot \${s.status==='active'?'online':'offline'}"></span>\${esc(s.status)}</td><td>\${s.messages_count||0}</td><td>\${(s.tokens_used||0).toLocaleString()}</td><td>\${s.started_at?new Date(s.started_at).toLocaleString():'-'}</td><td><button class="btn btn-danger" onclick="deleteSession('\${esc(s.session_id)}')">Delete</button></td></tr>\`).join('')+'</tbody></table>':'<div class="empty-state">No sessions</div>'}</div>\`;
  }catch(e){el.innerHTML='<div class="empty-state">Failed: '+esc(e.message)+'</div>'}
}
async function deleteSession(id){if(!confirm('Delete session '+id.slice(0,12)+'...?'))return;try{await api('/api/admin/sessions/'+encodeURIComponent(id),{method:'DELETE'});toast('Deleted');loadPage('sessions')}catch(e){toast(e.message,'error')}}
async function clearSessions(){if(!confirm('Delete ALL sessions?'))return;try{const r=await api('/api/admin/sessions/all',{method:'DELETE'});toast('Deleted '+r.deleted+' sessions');loadPage('sessions')}catch(e){toast(e.message,'error')}}

// ═══ CONVERSATIONS ══════════════════════════════════════════
async function loadConversations(el){
  try{
    const data=await api('/api/admin/conversations');
    el.innerHTML=\`<div class="page-header"><div><h2>Conversations</h2><div class="subtitle">\${data.length} total</div></div>
    <div class="filter-bar"><button class="btn btn-danger" onclick="clearConversations()">Delete All</button></div></div>
    <div class="card">\${data.length?'<table><thead><tr><th>ID</th><th>Title</th><th>Messages</th><th>Updated</th><th>Actions</th></tr></thead><tbody>'+data.map(c=>\`<tr><td><code>\${esc(c.conversation_id?.slice(0,12))}...</code></td><td>\${esc(c.title||'Untitled')}</td><td>\${c.message_count||0}</td><td>\${c.updated_at?new Date(c.updated_at).toLocaleString():'-'}</td><td><button class="btn" onclick="viewConvo('\${esc(c.conversation_id)}')">View</button> <button class="btn btn-danger" onclick="deleteConvo('\${esc(c.conversation_id)}')">Delete</button></td></tr>\`).join('')+'</tbody></table>':'<div class="empty-state">No conversations</div>'}</div>
    <div class="modal-overlay" id="cm"><div class="modal-content"><span class="modal-close" onclick="$('cm').classList.remove('show')">&times;</span><h3 id="ct">Conversation</h3><div id="cv"></div></div></div>\`;
    window.viewConvo=async(id)=>{try{const msgs=await api('/api/admin/conversations/'+encodeURIComponent(id));$('ct').textContent='Conversation';$('cv').innerHTML=msgs.length?msgs.map(m=>\`<div style="margin-bottom:12px;padding:10px;background:#0d1117;border-radius:6px;border-left:3px solid \${m.role==='user'?'#58a6ff':m.role==='assistant'?'#3fb950':'#8b949e'}"><div style="font-size:.75rem;color:#8b949e;margin-bottom:4px;text-transform:uppercase">\${esc(m.role)}</div><div style="white-space:pre-wrap;font-size:.85rem;max-height:300px;overflow-y:auto">\${esc(m.content?.slice(0,2000))}</div></div>\`).join(''):'<div class="empty-state">No messages</div>';$('cm').classList.add('show')}catch(e){toast(e.message,'error')}};
    window.deleteConvo=async(id)=>{if(!confirm('Delete this conversation?'))return;try{await api('/api/admin/conversations/'+encodeURIComponent(id),{method:'DELETE'});toast('Deleted');loadPage('conversations')}catch(e){toast(e.message,'error')}};
    window.clearConversations=async()=>{if(!confirm('Delete ALL conversations?'))return;try{const r=await api('/api/admin/conversations/all',{method:'DELETE'});toast('Deleted '+r.deleted+' conversations');loadPage('conversations')}catch(e){toast(e.message,'error')}};
  }catch(e){el.innerHTML='<div class="empty-state">Failed: '+esc(e.message)+'</div>'}
}

// ═══ USAGE ═══════════════════════════════════════════════════
async function loadUsage(el){
  try{
    const data=await api('/api/admin/usage');
    el.innerHTML=\`<div class="page-header"><div><h2>Usage Stats</h2><div class="subtitle">Token consumption</div></div>
    <div class="filter-bar"><button class="btn btn-danger" onclick="clearUsage()">Clear All Usage</button></div></div>
    <div class="stat-grid"><div class="stat-card"><div class="stat-value">\${data.total_requests||0}</div><div class="stat-label">Requests</div></div><div class="stat-card"><div class="stat-value">\${((data.total_prompt_tokens||0)+(data.total_completion_tokens||0)).toLocaleString()}</div><div class="stat-label">Tokens</div></div><div class="stat-card"><div class="stat-value">\${data.models_used||0}</div><div class="stat-label">Models</div></div><div class="stat-card"><div class="stat-value">\${data.avg_duration||'0ms'}</div><div class="stat-label">Avg Duration</div></div></div>
    <div class="card"><h3>Per-Model Usage</h3><div id="ut"></div></div>\`;
    const ut=$('ut');const models=data.models||[];ut.innerHTML=models.length?'<table><thead><tr><th>Model</th><th>Provider</th><th>Requests</th><th>Prompt</th><th>Completion</th></tr></thead><tbody>'+models.map(m=>\`<tr><td><code>\${esc(m.model_id)}</code></td><td><span class="badge badge-\${esc((m.provider||'').toLowerCase())}">\${esc(m.provider||'-')}</span></td><td>\${(m.total_requests||0).toLocaleString()}</td><td>\${(m.total_prompt_tokens||0).toLocaleString()}</td><td>\${(m.total_completion_tokens||0).toLocaleString()}</td></tr>\`).join('')+'</tbody></table>':'<div class="empty-state">No usage data</div>';
  }catch(e){el.innerHTML='<div class="empty-state">Failed: '+esc(e.message)+'</div>'}
}
async function clearUsage(){if(!confirm('Delete ALL usage data?'))return;try{const r=await api('/api/admin/usage',{method:'DELETE'});toast('Cleared '+r.deleted+' entries');loadPage('usage')}catch(e){toast(e.message,'error')}}

// ═══ MONITOR (Real-Time) ════════════════════════════════════
let monitorES=null;
async function loadMonitor(el){
  try{
    el.innerHTML=\`<div class="page-header"><div><h2>Real-Time Monitor</h2><div class="subtitle">Live server metrics via SSE</div></div>
    <div class="filter-bar"><button class="btn btn-primary" id="mon-toggle" onclick="toggleMonitor()">Start</button></div></div>
    <div class="stat-grid" id="mon-stats"><div class="stat-card"><div class="stat-value" id="mon-models">-</div><div class="stat-label">Models</div></div><div class="stat-card"><div class="stat-value" id="mon-uptime">-</div><div class="stat-label">Uptime</div></div><div class="stat-card"><div class="stat-value"><span class="status-dot offline" id="mon-dot"></span><span id="mon-status">Stopped</span></div><div class="stat-label">Status</div></div></div>
    <div class="card"><h3>Live Activity Log</h3><div id="mon-log" style="max-height:400px;overflow-y:auto;font-family:monospace;font-size:.8rem;padding:8px;background:#0d1117;border-radius:6px"></div></div>\`;
  }catch(e){el.innerHTML='<div class="empty-state">Failed: '+esc(e.message)+'</div>'}
}
function toggleMonitor(){
  if(monitorES){monitorES.close();monitorES=null;$('mon-toggle').textContent='Start';$('mon-toggle').className='btn btn-primary';$('mon-status').textContent='Stopped';$('mon-dot').className='status-dot offline';return}
  $('mon-toggle').textContent='Stop';$('mon-toggle').className='btn btn-danger';
  $('mon-dot').className='status-dot online';$('mon-status').textContent='Connected';
  monitorES=new EventSource('/api/admin/monitor');
  monitorES.addEventListener('snapshot',e=>{const d=JSON.parse(e.data);$('mon-models').textContent=d.models_count||0;$('mon-uptime').textContent=formatUptime(d.uptime_ms)});
  monitorES.addEventListener('update',e=>{
    const d=JSON.parse(e.data);$('mon-models').textContent=d.models_count||0;$('mon-uptime').textContent=formatUptime(d.uptime_ms);
    const log=$('mon-log');if(!log)return;
    (d.recent_logs||[]).forEach(l=>{
      const line=document.createElement('div');line.style.cssText='padding:2px 0;border-bottom:1px solid #21262d';
      line.innerHTML=\`<span style="color:#8b949e">\${new Date(l.timestamp).toLocaleTimeString()}</span> <span class="badge badge-\${esc((l.model||'').includes('mimo')?'opencode':'groq')}" style="font-size:.6rem">\${esc((l.model||'').slice(0,20))}</span> \${l.status===200?'<span style="color:#3fb950">200</span>':'<span style="color:#f85149">'+l.status+'</span>'} <span style="color:#8b949e">\${l.duration_ms||0}ms</span>\`;
      log.appendChild(line);if(log.children.length>100)log.removeChild(log.firstChild);
    });
    log.scrollTop=log.scrollHeight;
  });
  monitorES.onerror=()=>{$('mon-status').textContent='Reconnecting...';$('mon-dot').className='status-dot warning'};
}
function formatUptime(ms){if(!ms)return'-';const d=Math.floor(ms/86400000);const h=Math.floor((ms%86400000)/3600000);const m=Math.floor((ms%3600000)/60000);return d>0?d+'d '+h+'h':h>0?h+'h '+m+'m':m+'m'}

// ═══ TEST PAGE ═════════════════════════════════════════════
async function loadTest(el){
  try{
    const [providerData, capsData] = await Promise.all([
      api('/api/admin/providers'),
      api('/api/admin/provider-capabilities')
    ]);
    const providers=(providerData.providers||[]).filter(p=>p.is_active);
    const allModels=(providerData.models||[]).filter(m=>m.is_active);
    const capsByProvider=capsData.providers||[];

    el.innerHTML=\`<div class="page-header"><div><h2>Request Tester</h2><div class="subtitle">Select provider → see capabilities → test with real requests</div></div></div>

    <div class="card"><h3>Provider + Capability Test</h3>
      <div style="display:grid;gap:12px">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
          <div style="flex:1;min-width:200px">
            <label style="font-size:.75rem;color:#8b949e;display:block;margin-bottom:4px">Provider</label>
            <select id="ct-provider" style="width:100%;padding:6px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9" onchange="updateCapDropdown()">
              <option value="">Select Provider...</option>
              \${capsByProvider.map(p=>\`<option value="\${esc(p.id)}">\${esc(p.name)} [\${esc(p.health||'unknown')}]</option>\`).join('')}
            </select>
          </div>
          <div style="flex:1;min-width:200px">
            <label style="font-size:.75rem;color:#8b949e;display:block;margin-bottom:4px">Capability</label>
            <select id="ct-capability" style="width:100%;padding:6px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9">
              <option value="">Select provider first...</option>
            </select>
          </div>
          <div style="flex:1;min-width:200px">
            <label style="font-size:.75rem;color:#8b949e;display:block;margin-bottom:4px">Model</label>
            <select id="ct-model" style="width:100%;padding:6px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9">
              <option value="">Auto</option>
            </select>
          </div>
        </div>
        <div id="ct-caps-info" style="display:none;padding:8px;background:#0d1117;border-radius:6px;font-size:.8rem"></div>
        <textarea id="ct-msg" style="padding:8px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9;min-height:60px" placeholder="Your message...">Hello! Say something brief.</textarea>
        <div style="display:flex;gap:8px;align-items:center">
          <label style="font-size:.75rem;color:#8b949e">Max Tokens</label><input id="ct-tokens" type="number" value="200" style="width:80px;padding:4px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9">
          <label style="font-size:.75rem;color:#8b949e">Temp</label><input id="ct-temp" type="number" value="0.7" step="0.1" min="0" max="2" style="width:60px;padding:4px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9">
          <button class="btn btn-primary" onclick="runCapTest()">Test Selected</button>
          <button class="btn" onclick="runSmartSelectTest()" title="Test all capabilities at once">Smart Select Test</button>
        </div>
      </div>
      <div id="ct-result" style="margin-top:12px"></div>
    </div>

    <div class="card"><h3>Quick Model Test</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
        <select id="qt-model" style="flex:1;min-width:250px;padding:6px;border:1px solid #30363d;border-radius:4px;background:#0d1117;color:#c9d1d9">
          <option value="">Select Model...</option>
          \${allModels.slice(0,30).map(m=>\`<option value="\${esc(m.model_id)}">\${esc(m.model_id)} [\${esc(m.provider_id)}] \${m.is_free?'(Free)':''}</option>\`).join('')}
        </select>
        <button class="btn btn-primary" onclick="runQuickModelTest()">Test</button>
      </div>
      <div id="qt-result" style="margin-top:12px"></div>
    </div>\`;

    // Store data for JS functions
    window._capsByProvider=capsByProvider;
    window._allModels=allModels;
  }catch(e){el.innerHTML='<div class="empty-state">Failed to load: '+esc(e.message)+'</div>'}
}
function updateCapDropdown(){
  const provId=$('ct-provider')?.value;
  const caps=window._capsByProvider||[];
  const prov=caps.find(p=>p.id===provId);
  const capSelect=$('ct-capability');
  const modelSelect=$('ct-model');
  const infoEl=$('ct-caps-info');
  if(!prov){
    capSelect.innerHTML='<option value="">Select provider first...</option>';
    modelSelect.innerHTML='<option value="">Auto</option>';
    if(infoEl)infoEl.style.display='none';
    return;
  }
  // Populate capabilities
  const capOptions=[];
  if(prov.capabilities?.streaming) capOptions.push({val:'streaming',label:'🟢 Streaming'});
  if(prov.capabilities?.tool_calling) capOptions.push({val:'tool_call',label:'🟢 Tool Call'});
  if(prov.capabilities?.vision) capOptions.push({val:'vision',label:'🟢 Vision'});
  if(prov.capabilities?.audio) capOptions.push({val:'audio',label:'🟢 Audio'});
  if(prov.capabilities?.embeddings) capOptions.push({val:'embedding',label:'🟢 Embeddings'});
  capOptions.push({val:'chat',label:'💬 Basic Chat'});
  capSelect.innerHTML=capOptions.map(o=>\`<option value="\${o.val}">\${o.label}</option>\`).join('');
  // Populate models
  const models=(window._allModels||[]).filter(m=>m.provider_id===provId);
  modelSelect.innerHTML='<option value="">Auto</option>'+models.map(m=>\`<option value="\${esc(m.model_id)}">\${esc(m.model_id)} \${m.is_free?'(Free)':''}</option>\`).join('');
  // Show info
  if(infoEl){
    infoEl.style.display='block';
    infoEl.innerHTML=\`<span style="color:#58a6ff;font-weight:600">\${esc(prov.name)}</span> — Health: <span style="color:\${prov.health==='healthy'?'#3fb950':'#f85149'}">\${esc(prov.health||'unknown')}</span> — Tools: \${prov.tools?.join(', ')||'none'} — Models: \${models.length}\`;
  }
}
async function runCapTest(){
  const result=$('ct-result');if(result)result.innerHTML='<div class="spinner"></div> Testing...';
  try{
    const provId=$('ct-provider')?.value;
    const capType=$('ct-capability')?.value||'chat';
    const model=$('ct-model')?.value;
    const msg=$('ct-msg')?.value||'Hello';
    const tokens=Number($('ct-tokens')?.value||200);
    const temp=Number($('ct-temp')?.value||0.7);
    if(!provId){result.innerHTML='<div style="color:#f85149">Select a provider first</div>';return;}

    // Use the tool test endpoint
    const r=await fetch('/api/admin/providers/'+encodeURIComponent(provId)+'/tools/'+encodeURIComponent(capType)+'/test',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:msg,model,max_tokens:tokens,temperature:temp})
    });
    const data=await r.json();
    if(data.ok){
      let extra='';
      if(data.has_tool_calls) extra=\`<div style="margin-top:4px;color:#58a6ff">Tool calls: \${JSON.stringify(data.tool_calls?.map(t=>t.function?.name)).slice(0,200)}</div>\`;
      if(data.note) extra=\`<div style="margin-top:4px;color:#8b949e">\${esc(data.note)}</div>\`;
      result.innerHTML=\`<div style="padding:8px;background:#0d2b45;border-radius:6px;font-size:.85rem;border-left:3px solid #3fb950"><strong style="color:#3fb950">✓ \${capType}</strong> — \${data.duration_ms}ms — Model: \${esc(data.model||model||'auto')}<div style="margin-top:4px">\${esc(data.response||'OK')}</div>\${extra}</div>\`;
    }else{
      result.innerHTML=\`<div style="padding:8px;background:#3d0d0d;border-radius:6px;font-size:.85rem;border-left:3px solid #f85149"><strong style="color:#f85149">✗ Failed</strong> — \${data.duration_ms||0}ms<div style="margin-top:4px;color:#f85149">\${esc(data.error||'Unknown error')}</div></div>\`;
    }
  }catch(e){if(result)result.innerHTML='<div style="color:#f85149">Error: '+esc(e.message)+'</div>';}
}
async function runSmartSelectTest(){
  const result=$('ct-result');if(result)result.innerHTML='<div class="spinner"></div> Smart testing all capabilities...';
  try{
    const provId=$('ct-provider')?.value;
    if(!provId){result.innerHTML='<div style="color:#f85149">Select a provider first</div>';return;}
    const caps=window._capsByProvider||[];
    const prov=caps.find(p=>p.id===provId);
    if(!prov){result.innerHTML='<div style="color:#f85149">Provider not found</div>';return;}

    const testTypes=['chat','streaming','tool_call'].filter(t=>(prov.tools||[]).includes(t)||(t==='chat'));
    const results=[];
    for(const t of testTypes){
      try{
        const r=await fetch('/api/admin/providers/'+encodeURIComponent(provId)+'/tools/'+encodeURIComponent(t)+'/test',{
          method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})
        });
        results.push({type:t,...await r.json()});
      }catch(e){results.push({type:t,ok:false,error:e.message});}
    }
    result.innerHTML=\`<div style="display:grid;gap:8px">\${results.map(r=>\`<div style="padding:8px;background:\${r.ok?'#0d2b45':'#3d0d0d'};border-radius:6px;font-size:.85rem;border-left:3px solid \${r.ok?'#3fb950':'#f85149'}"><strong style="color:\${r.ok?'#3fb950':'#f85149'}">\${r.ok?'✓':'✗'} \${esc(r.type)}</strong> — \${r.duration_ms||0}ms — Model: \${esc(r.model||'-')}<div style="margin-top:2px;color:#c9d1d9">\${esc((r.response||r.error||r.note||'').slice(0,150))}</div></div>\`).join('')}</div>\`;
  }catch(e){if(result)result.innerHTML='<div style="color:#f85149">Error: '+esc(e.message)+'</div>';}
}
async function runQuickModelTest(){
  const result=$('qt-result');if(result)result.innerHTML='<div class="spinner"></div> Testing...';
  try{
    const model=$('qt-model')?.value;
    if(!model){result.innerHTML='<div style="color:#f85149">Select a model</div>';return;}
    const r=await fetch('/api/admin/models/'+encodeURIComponent(model)+'/test',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:'Hello! Say something brief.',max_tokens:100})
    });
    const data=await r.json();
    result.innerHTML=data.ok
      ? \`<div style="padding:8px;background:#0d2b45;border-radius:6px;font-size:.85rem;border-left:3px solid #3fb950"><strong style="color:#3fb950">✓ \${data.duration_ms}ms</strong> — \${esc(data.model)}<div style="margin-top:4px">\${esc(data.response)}</div></div>\`
      : \`<div style="padding:8px;background:#3d0d0d;border-radius:6px;font-size:.85rem;border-left:3px solid #f85149"><strong style="color:#f85149">✗ \${data.status||'Error'}</strong><div style="margin-top:4px;color:#f85149">\${esc(data.error)}</div></div>\`;
  }catch(e){if(result)result.innerHTML='<div style="color:#f85149">Error: '+esc(e.message)+'</div>';}
}

// ═══ DOCS PAGE ═════════════════════════════════════════════
function loadDocs(el){
  el.innerHTML=\`<div class="page-header"><div><h2>Gateway Documentation</h2><div class="subtitle">Official documentation — all gateway logic</div></div></div>

  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
    <button class="btn btn-primary" onclick="showDocSection('architecture')">Architecture</button>
    <button class="btn" onclick="showDocSection('project')">Project Structure</button>
    <button class="btn" onclick="showDocSection('deps')">Dependencies</button>
    <button class="btn" onclick="showDocSection('features')">Features</button>
    <button class="btn" onclick="showDocSection('api')">API Structure</button>
    <button class="btn" onclick="showDocSection('integration')">Integration</button>
  </div>

  <div id="doc-content"></div>\`;

  showDocSection('architecture');
}

function showDocSection(section){
  const el=$('doc-content');if(!el)return;
  const sections={
    architecture:\`<div class="card" style="border-left:3px solid #58a6ff"><h3>Architecture Overview</h3>
    <div style="font-size:.9rem;line-height:1.8;color:#c9d1d9">
    <p><strong>Proxi Bridge</strong> is a local-first AI execution engine that routes requests to multiple LLM providers through a unified OpenAI-compatible API.</p>
    <h4 style="color:#58a6ff;margin-top:16px">Request Flow</h4>
    <pre style="background:#0d1117;padding:12px;border-radius:6px;font-size:.8rem;overflow-x:auto;color:#8b949e">
Client → POST /v1/chat/completions
  ↓
OpenAI Controller (entry point)
  ↓
Provider Gateway (new) ← GroqService (fallback)
  ├── 3-Tier Resolution: DB → Environment → Hardcoded
  ├── Smart Model Selection (budget/quality/health scoring)
  ├── Provider Registry (Factory + TTL Cache)
  ├── Normalizer (Ollama/Anthropic/Gemini → OpenAI format)
  ├── Tool Normalizer (tool call format normalization)
  ├── Retry Logic (configurable attempts, fallback chain)
  └── Response (OpenAI-compatible JSON)
    </pre>
    <h4 style="color:#58a6ff;margin-top:16px">Provider Sources</h4>
    <table style="width:100%;font-size:.85rem"><thead><tr><th>Provider</th><th>Base URL</th><th>Priority</th><th>API Key Env</th></tr></thead><tbody>
      <tr><td>OpenCode</td><td><code>opencode.ai/zen/v1</code></td><td>100</td><td><code>OPENCODE_API_KEY</code></td></tr>
      <tr><td>Groq</td><td><code>api.groq.com/openai/v1</code></td><td>90</td><td><code>GROQ_API_KEY</code></td></tr>
      <tr><td>OpenAI</td><td><code>api.openai.com/v1</code></td><td>80</td><td><code>OPENAI_API_KEY</code></td></tr>
      <tr><td>Gemini</td><td><code>generativelanguage.googleapis.com</code></td><td>70</td><td><code>GEMINI_API_KEY</code></td></tr>
      <tr><td>Anthropic</td><td>Gateway URL</td><td>65</td><td><code>ANTHROPIC_API_KEY</code></td></tr>
      <tr><td>Ollama</td><td><code>localhost:11434</code></td><td>60</td><td>None (local)</td></tr>
    </tbody></table>
    <h4 style="color:#58a6ff;margin-top:16px">Smart Model Selection</h4>
    <p>When <code>model: "auto"</code> is sent, the system selects the best model based on:</p>
    <ul style="margin:8px 0 8px 24px">
      <li><strong>Input length</strong> → short text uses fast models, long text uses balanced</li>
      <li><strong>Tool requirements</strong> → filters to models with tool support</li>
      <li><strong>Budget</strong> → free models preferred, then cheapest</li>
      <li><strong>Health</strong> → healthy providers scored higher</li>
      <li><strong>Category</strong> → fast (+15), balanced (+5), powerful (+10), free (+20)</li>
    </ul>
    <h4 style="color:#58a6ff;margin-top:16px">Database Schema</h4>
    <pre style="background:#0d1117;padding:12px;border-radius:6px;font-size:.8rem;overflow-x:auto;color:#8b949e">
providers        → id, name, type, base_url, api_key, priority, health_status, capabilities
provider_models  → id, provider_id, model_id, context_window, category, is_free, supports_tools
provider_tools   → id, provider_id, tool_name, tool_type, is_available, last_test_status
agent_profiles   → id, name, persona, preferred_provider_id, preferred_model_id, budget_limit
models           → model_id, provider, source_name, base_url, is_active (legacy sync)
usage_stats      → model_id, provider, tokens_prompt, tokens_completion, requests
    </pre>
    </div></div>\`,

    project:\`<div class="card" style="border-left:3px solid #3fb950"><h3>Project Structure</h3>
    <pre style="background:#0d1117;padding:12px;border-radius:6px;font-size:.8rem;overflow-x:auto;color:#8b949e">
proxi_new/
├── src/
│   ├── index.ts                          ← Server entry point (port 9999)
│   ├── providers/
│   │   ├── types.ts                      ← ILLMProvider, ChatCompletionParams, ProviderConfig
│   │   ├── base.provider.ts              ← Abstract base (rate limit, retry, health)
│   │   ├── normalizer.ts                 ← Ollama/Anthropic/Gemini → OpenAI format
│   │   ├── tool-normalizer.ts            ← Tool call format normalization
│   │   ├── provider-registry.ts          ← Singleton factory + TTL cache
│   │   ├── provider-gateway.ts           ← Main routing brain (3-tier, smart select)
│   │   ├── index.ts                      ← Barrel export
│   │   └── implementations/
│   │       ├── opencode.provider.ts      ← OpenCode provider
│   │       ├── groq.provider.ts          ← Groq provider
│   │       ├── openai.provider.ts        ← OpenAI provider
│   │       ├── gemini.provider.ts        ← Gemini provider
│   │       └── anthropic.provider.ts     ← Anthropic provider
│   ├── services/
│   │   ├── stateDb.ts                    ← SQLite DB (providers, models, tools tables)
│   │   ├── providerBootstrap.ts          ← Env-based provider discovery + sync
│   │   ├── providerCatalog.ts            ← Legacy provider source management
│   │   ├── groqService.ts                ← Core chat with retry/fallback (legacy)
│   │   ├── identityService.ts            ← System identity management
│   │   ├── ragService.ts                 ← Disk-based RAG (SSOT.md)
│   │   └── workspaceWatcher.ts           ← File watcher for auto-rescan
│   ├── controllers/
│   │   ├── openaiController.ts           ← /v1/chat/completions (gateway + fallback)
│   │   └── agentController.ts            ← /v1/agent/* endpoints
│   ├── admin/
│   │   ├── controller.ts                 ← Admin dashboard HTML + all API handlers
│   │   └── db.ts                         ← Admin DB functions
│   └── routes/
│       └── index.ts                      ← All route registrations
├── documentation/
│   └── now/
│       └── provider-orchestration.html   ← Bengali documentation
└── package.json
    </pre>
    </div></div>\`,

    deps:\`<div class="card" style="border-left:3px solid #d29922"><h3>Dependencies</h3>
    <table style="width:100%;font-size:.85rem"><thead><tr><th>Package</th><th>Purpose</th><th>Version</th></tr></thead><tbody>
      <tr><td><code>express</code></td><td>HTTP server framework</td><td>4.x</td></tr>
      <tr><td><code>better-sqlite3</code></td><td>SQLite database (local-first)</td><td>11.x</td></tr>
      <tr><td><code>groq-sdk</code></td><td>Groq API client (legacy)</td><td>0.x</td></tr>
      <tr><td><code>ts-node</code></td><td>TypeScript execution</td><td>10.x</td></tr>
      <tr><td><code>typescript</code></td><td>Type system</td><td>5.x</td></tr>
      <tr><td><code>multer</code></td><td>File upload (audio endpoints)</td><td>1.x</td></tr>
      <tr><td><code>uuid</code></td><td>Unique ID generation</td><td>10.x</td></tr>
    </tbody></table>
    <h4 style="color:#d29922;margin-top:16px">Environment Variables</h4>
    <table style="width:100%;font-size:.85rem"><thead><tr><th>Variable</th><th>Purpose</th><th>Required</th></tr></thead><tbody>
      <tr><td><code>OPENCODE_API_KEY</code></td><td>OpenCode provider authentication</td><td>Optional</td></tr>
      <tr><td><code>GROQ_API_KEY</code></td><td>Groq provider authentication</td><td>Optional</td></tr>
      <tr><td><code>OPENAI_API_KEY</code></td><td>OpenAI provider authentication</td><td>Optional</td></tr>
      <tr><td><code>GEMINI_API_KEY</code></td><td>Google Gemini authentication</td><td>Optional</td></tr>
      <tr><td><code>ANTHROPIC_API_KEY</code></td><td>Anthropic provider authentication</td><td>Optional</td></tr>
      <tr><td><code>PORT</code></td><td>Server port (default: 9999)</td><td>Optional</td></tr>
      <tr><td><code>WORKSPACE_DIR</code></td><td>Working directory for RAG</td><td>Optional</td></tr>
    </tbody></table>
    </div></div>\`,

    features:\`<div class="card" style="border-left:3px solid #bc8cff"><h3>Features</h3>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">
      <div style="padding:12px;background:#0d1117;border-radius:6px;border:1px solid #30363d">
        <h4 style="color:#bc8cff">🔌 Multi-Provider Routing</h4>
        <p style="font-size:.85rem;color:#8b949e;margin-top:4px">6 providers (OpenCode, Groq, OpenAI, Gemini, Anthropic, Ollama) with automatic failover and health tracking.</p>
      </div>
      <div style="padding:12px;background:#0d1117;border-radius:6px;border:1px solid #30363d">
        <h4 style="color:#3fb950">🎯 Smart Model Selection</h4>
        <p style="font-size:.85rem;color:#8b949e;margin-top:4px">Auto-route based on budget, quality, health, and input complexity. Supports 98+ models.</p>
      </div>
      <div style="padding:12px;background:#0d1117;border-radius:6px;border:1px solid #30363d">
        <h4 style="color:#58a6ff">🔄 Response Normalization</h4>
        <p style="font-size:.85rem;color:#8b949e;margin-top:4px">Ollama, Anthropic, Gemini responses automatically normalized to OpenAI format.</p>
      </div>
      <div style="padding:12px;background:#0d1117;border-radius:6px;border:1px solid #30363d">
        <h4 style="color:#d29922">🛠 Tool Call Normalization</h4>
        <p style="font-size:.85rem;color:#8b949e;margin-top:4px">Tool call formats from all providers normalized to OpenAI function calling format.</p>
      </div>
      <div style="padding:12px;background:#0d1117;border-radius:6px;border:1px solid #30363d">
        <h4 style="color:#f85149">🔄 Retry & Fallback</h4>
        <p style="font-size:.85rem;color:#8b949e;margin-top:4px">Configurable retry with exponential backoff, automatic fallback to next provider.</p>
      </div>
      <div style="padding:12px;background:#0d1117;border-radius:6px;border:1px solid #30363d">
        <h4 style="color:#56d4dd">📊 Rate Limiting</h4>
        <p style="font-size:.85rem;color:#8b949e;margin-top:4px">Per-model RPM/TPM tracking with pre-emptive routing away from exhausted limits.</p>
      </div>
      <div style="padding:12px;background:#0d1117;border-radius:6px;border:1px solid #30363d">
        <h4 style="color:#7788ff">🤖 Agent Templates</h4>
        <p style="font-size:.85rem;color:#8b949e;margin-top:4px">5 built-in agent profiles (Chat, Code, Document, Debug, CLI) as routing fallback.</p>
      </div>
      <div style="padding:12px;background:#0d1117;border-radius:6px;border:1px solid #30363d">
        <h4 style="color:#3fb950">💾 Local-First Database</h4>
        <p style="font-size:.85rem;color:#8b949e;margin-top:4px">SQLite with WAL mode. All provider/model/tool data stored locally. No external DB required.</p>
      </div>
      <div style="padding:12px;background:#0d1117;border-radius:6px;border:1px solid #30363d">
        <h4 style="color:#ff7b72">🌐 OpenAI-Compatible API</h4>
        <p style="font-size:.85rem;color:#8b949e;margin-top:4px">Drop-in replacement for OpenAI API. Works with any OpenAI-compatible client.</p>
      </div>
    </div>
    </div></div>\`,

    api:\`<div class="card" style="border-left:3px solid #56d4dd"><h3>API Structure</h3>
    <h4 style="color:#56d4dd;margin-top:12px">Core Endpoints (OpenAI-Compatible)</h4>
    <table style="width:100%;font-size:.85rem"><thead><tr><th>Method</th><th>Endpoint</th><th>Description</th></tr></thead><tbody>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/v1/chat/completions</code></td><td>Chat completions (tools, vision, streaming, JSON mode)</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/v1/completions</code></td><td>Text completions (legacy)</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/v1/audio/transcriptions</code></td><td>Speech-to-text (Whisper)</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/v1/audio/translations</code></td><td>Audio translation</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/v1/embeddings</code></td><td>Text embeddings</td></tr>
      <tr><td><span class="badge badge-groq">GET</span></td><td><code>/v1/models</code></td><td>List available models</td></tr>
      <tr><td><span class="badge badge-groq">GET</span></td><td><code>/v1/models/:id</code></td><td>Get model details</td></tr>
    </tbody></table>
    <h4 style="color:#56d4dd;margin-top:16px">Agent Endpoints</h4>
    <table style="width:100%;font-size:.85rem"><thead><tr><th>Method</th><th>Endpoint</th><th>Description</th></tr></thead><tbody>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/v1/agent/chat</code></td><td>Agent chat with RAG + persona + tool calling</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/v1/agent/directory</code></td><td>Set working directory</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/v1/agent/rescan</code></td><td>Rescan project files</td></tr>
      <tr><td><span class="badge badge-groq">GET</span></td><td><code>/v1/agent/ssot</code></td><td>Read SSOT documentation</td></tr>
      <tr><td><span class="badge badge-groq">GET</span></td><td><code>/v1/agent/status</code></td><td>Project status & health</td></tr>
      <tr><td><span class="badge badge-groq">GET</span></td><td><code>/v1/agent/routes</code></td><td>Available model routes</td></tr>
    </tbody></table>
    <h4 style="color:#56d4dd;margin-top:16px">Admin Endpoints</h4>
    <table style="width:100%;font-size:.85rem"><thead><tr><th>Method</th><th>Endpoint</th><th>Description</th></tr></thead><tbody>
      <tr><td><span class="badge badge-groq">GET</span></td><td><code>/api/admin/stats</code></td><td>Dashboard statistics</td></tr>
      <tr><td><span class="badge badge-groq">GET</span></td><td><code>/api/admin/providers</code></td><td>List all providers with models & costs</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/api/admin/providers</code></td><td>Create/update provider</td></tr>
      <tr><td><span class="badge badge-guard">DELETE</span></td><td><code>/api/admin/providers/:id</code></td><td>Delete provider</td></tr>
      <tr><td><span class="badge badge-balanced">PATCH</span></td><td><code>/api/admin/providers/:id/toggle</code></td><td>Enable/disable provider</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/api/admin/providers/:id/test</code></td><td>Test provider connection</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/api/admin/providers/:id/sync</code></td><td>Sync provider models</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/api/admin/providers/sync-all</code></td><td>Sync all providers</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/api/admin/models/:id/test</code></td><td>Test specific model</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/api/admin/providers/:id/tools/:type/test</code></td><td>Test provider capability</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/api/admin/auto-route</code></td><td>Test auto-routing logic</td></tr>
      <tr><td><span class="badge badge-fast">POST</span></td><td><code>/api/admin/default-model</code></td><td>Set default model</td></tr>
      <tr><td><span class="badge badge-groq">GET</span></td><td><code>/api/admin/provider-costs</code></td><td>Cost statistics</td></tr>
      <tr><td><span class="badge badge-groq">GET</span></td><td><code>/api/admin/provider-tools</code></td><td>Registered tools</td></tr>
      <tr><td><span class="badge badge-groq">GET</span></td><td><code>/api/admin/provider-capabilities</code></td><td>Provider capabilities</td></tr>
    </tbody></table>
    </div></div>\`,

    integration:\`<div class="card" style="border-left:3px solid #3fb950"><h3>Integration Guide</h3>
    <div style="font-size:.9rem;line-height:1.8;color:#c9d1d9">
    <h4 style="color:#3fb950;margin-top:12px">How to Connect Your Application</h4>
    <p>The gateway exposes a standard <strong>OpenAI-compatible API</strong> on <code>http://localhost:9999</code>. Any OpenAI SDK or client can connect directly.</p>

    <h4 style="color:#3fb950;margin-top:16px">1. Using OpenAI Python SDK</h4>
    <pre style="background:#0d1117;padding:12px;border-radius:6px;font-size:.8rem;overflow-x:auto;color:#8b949e">
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:9999/v1",
    api_key="not-needed"  # or your GROQ_API_KEY
)

response = client.chat.completions.create(
    model="auto",  # or specific model like "llama-3.1-8b-instant"
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"}
    ],
    tools=[{  # Optional: tool calling
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get weather for a city",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string"}
                }
            }
        }
    }],
    stream=True  # Optional: streaming
)
    </pre>

    <h4 style="color:#3fb950;margin-top:16px">2. Using OpenAI Node.js SDK</h4>
    <pre style="background:#0d1117;padding:12px;border-radius:6px;font-size:.8rem;overflow-x:auto;color:#8b949e">
import OpenAI from 'openai';

const client = new OpenAI({
    baseURL: 'http://localhost:9999/v1',
    apiKey: 'not-needed',
});

const response = await client.chat.completions.create({
    model: 'auto',
    messages: [{ role: 'user', content: 'Hello!' }],
});
    </pre>

    <h4 style="color:#3fb950;margin-top:16px">3. Using curl</h4>
    <pre style="background:#0d1117;padding:12px;border-radius:6px;font-size:.8rem;overflow-x:auto;color:#8b949e">
curl http://localhost:9999/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'
    </pre>

    <h4 style="color:#3fb950;margin-top:16px">4. Adding a Custom Provider</h4>
    <pre style="background:#0d1117;padding:12px;border-radius:6px;font-size:.8rem;overflow-x:auto;color:#8b949e">
# Via Admin API
curl -X POST http://localhost:9999/api/admin/providers \\
  -H "Content-Type: application/json" \\
  -d '{
    "id": "my-provider",
    "name": "My Custom Provider",
    "type": "openai-compatible",
    "base_url": "https://api.myprovider.com/v1",
    "api_key_env": "MY_PROVIDER_KEY",
    "priority": 75
  }'

# Set API key in environment
export MY_PROVIDER_KEY="sk-..."

# Sync models
curl -X POST http://localhost:9999/api/admin/providers/my-provider/sync
    </pre>

    <h4 style="color:#3fb950;margin-top:16px">5. Model Selection</h4>
    <ul style="margin:8px 0 8px 24px">
      <li><code>"model": "auto"</code> — System selects best model based on input/budget/health</li>
      <li><code>"model": "llama-3.1-8b-instant"</code> — Use specific model (routed to Groq)</li>
      <li><code>"model": "gpt-4o"</code> — Use specific model (routed to OpenAI)</li>
      <li><code>"model": "groq/compound"</code> — Use provider-prefixed model</li>
    </ul>

    <h4 style="color:#3fb950;margin-top:16px">6. Streaming</h4>
    <pre style="background:#0d1117;padding:12px;border-radius:6px;font-size:.8rem;overflow-x:auto;color:#8b949e">
curl -N http://localhost:9999/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Tell me a story"}],
    "stream": true
  }'
    </pre>
    </div></div>\`
  };
  el.innerHTML=sections[section]||'<div class="empty-state">Section not found</div>';
}

// ═══ AGENT HEALTH ═══════════════════════════════════════════
async function loadAgent(el){
  try{
    const health=await api('/api/admin/agent-health');
    const statusColor=health.status==='ok'?'#3fb950':'#f85149';
    el.innerHTML=\`<div class="page-header"><div><h2>Agent Health</h2><div class="subtitle">ZombieCoder agent status & diagnostics</div></div>
    <div class="filter-bar"><button class="btn btn-primary" onclick="loadPage('agent')">Refresh</button></div></div>
    <div class="stat-grid">
      <div class="stat-card" style="border-left:3px solid \${statusColor}"><div class="stat-value" style="color:\${statusColor}">\${health.status.toUpperCase()}</div><div class="stat-label">Agent Status</div></div>
      <div class="stat-card"><div class="stat-value">\${health.models_available}</div><div class="stat-label">Models Available</div></div>
      <div class="stat-card"><div class="stat-value">\${health.models_active}</div><div class="stat-label">Active Models</div></div>
      <div class="stat-card"><div class="stat-value">\${health.sessions_active}</div><div class="stat-label">Active Sessions</div></div>
      <div class="stat-card"><div class="stat-value">\${formatUptime(health.uptime_ms)}</div><div class="stat-label">Uptime</div></div>
      <div class="stat-card"><div class="stat-value">\${health.last_activity?new Date(health.last_activity).toLocaleString():'None'}</div><div class="stat-label">Last Activity</div></div>
    </div>
    <div class="card"><h3>Agent Configuration</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;padding:8px 0">
        <div><div style="color:#8b949e;font-size:.75rem;text-transform:uppercase">Name</div><div style="font-size:1.1rem;font-weight:600;color:#58a6ff">\${esc(health.agent)}</div></div>
        <div><div style="color:#8b949e;font-size:.75rem;text-transform:uppercase">Server</div><div style="font-size:1.1rem;font-weight:600;color:\${health.server_running?'#3fb950':'#f85149'}">\${health.server_running?'Running':'Stopped'}</div></div>
        <div><div style="color:#8b949e;font-size:.75rem;text-transform:uppercase">Total Sessions</div><div style="font-size:1.1rem;font-weight:600">\${health.sessions_total}</div></div>
      </div>
    </div>
    <div class="card"><h3>Agent Endpoints</h3>
      <table><thead><tr><th>Method</th><th>Endpoint</th><th>Description</th></tr></thead><tbody>
        <tr><td><span class="badge badge-groq">POST</span></td><td><code>/v1/agent/chat</code></td><td>Agent chat with RAG + tool calling</td></tr>
        <tr><td><span class="badge badge-groq">POST</span></td><td><code>/v1/agent/directory</code></td><td>Set working directory</td></tr>
        <tr><td><span class="badge badge-groq">POST</span></td><td><code>/v1/agent/rescan</code></td><td>Rescan project files</td></tr>
        <tr><td><span class="badge badge-opencode">GET</span></td><td><code>/v1/agent/ssot</code></td><td>Read SSOT documentation</td></tr>
        <tr><td><span class="badge badge-opencode">GET</span></td><td><code>/v1/agent/status</code></td><td>Project status & health</td></tr>
        <tr><td><span class="badge badge-opencode">GET</span></td><td><code>/v1/agent/routes</code></td><td>Available model routes</td></tr>
      </tbody></table>
    </div>\`;
  }catch(e){el.innerHTML='<div class="empty-state">Failed to load agent health: '+esc(e.message)+'</div>'}
}

loadPage(page);
window.addEventListener('popstate',()=>{const p=location.pathname.split('/').pop()||'overview';loadPage(p)});
</script>
</body>
</html>`;
}

// ─── CONTROLLER HANDLERS ──────────────────────────────────

export function handleAdminDashboard(req: Request, res: Response) {
  res.send(layout('Overview', '', 'overview'));
}

export function handleAdminPage(req: Request, res: Response) {
  const page = req.params.page || 'overview';
  const validPages = ['overview', 'providers', 'models', 'test', 'chat', 'mapping', 'sessions', 'conversations', 'usage', 'monitor', 'agent', 'docs'];
  const p = validPages.includes(page) ? page : 'overview';
  res.send(layout(p.charAt(0).toUpperCase() + p.slice(1), '', p));
}

// ─── API HANDLERS ─────────────────────────────────────────

function refreshRuntimeModelsFromDb() {
  const service = getService() as any;
  if (!service) return;
  const dbModels = getActiveModels();
  service.models = dbModels.map((m: any) => ({
    id: m.model_id || m.id,
    object: 'model' as const,
    created: m.created || Math.floor(Date.now() / 1000),
    owned_by: m.owned_by || m.provider || 'unknown',
    context_window: m.context_window || 0,
    max_tokens: m.max_tokens || 0,
    category: m.category || 'other',
    provider: m.provider,
    source_name: m.source_name,
    source_kind: m.source_kind,
    base_url: m.base_url,
    api_key_env: m.api_key_env,
    source_model_id: m.source_model_id,
    status: m.status || 'active',
    is_active: Number(m.is_active || 0) === 1,
    is_free: Number(m.is_free || 0) === 1,
  }));
}

export async function handleAdminStats(req: Request, res: Response) {
  try {
    const service = getService();
    const identity = getIdentity();
    const models = service?.getModels() || [];
    const usage = getUsageStats(14);
    const daily = getUsageByDay(14);
    const sessions = getSessions();
    const conversations = getConversations();

    const modelsByProvider: Record<string, number> = {};
    models.forEach(m => { const p = m.owned_by || 'unknown'; modelsByProvider[p] = (modelsByProvider[p] || 0) + 1; });

    const uptimeMs = service ? Date.now() - service.startedAtMs : 0;
    const uptimeDays = Math.floor(uptimeMs / 86400000);
    const uptimeHours = Math.floor((uptimeMs % 86400000) / 3600000);
    const uptimeMins = Math.floor((uptimeMs % 3600000) / 60000);

    res.json({
      models_count: models.length,
      total_requests: usage.reduce((s: number, r: any) => s + (r.total_requests || 0), 0),
      sessions_active: sessions.filter((s: any) => s.status === 'active').length,
      conversations: conversations.length,
      providers: Object.keys(modelsByProvider).length,
      uptime_formatted: uptimeDays > 0 ? `${uptimeDays}d ${uptimeHours}h` : uptimeHours > 0 ? `${uptimeHours}h ${uptimeMins}m` : `${uptimeMins}m`,
      usage_by_day: daily,
      models_by_provider: Object.entries(modelsByProvider).map(([provider, count]) => ({ provider, count })),
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminModels(req: Request, res: Response) {
  try {
    const db = getStateDb();
    const dbModels = db ? getModelList() : [];
    const service = getService();
    const runtimeModels = service?.getModels() || [];
    const runtimeIds = new Set(runtimeModels.map((m: any) => m.id));

    const enriched = dbModels.map((m: any) => ({
      id: m.model_id,
      owned_by: m.owned_by,
      category: m.category || 'other',
      context_window: m.context_window || 0,
      max_tokens: m.max_tokens || 0,
      provider: m.provider || m.source_name || m.owned_by || 'unknown',
      source_name: m.source_name || m.provider || 'unknown',
      source_kind: m.source_kind || 'openai-compatible',
      base_url: m.base_url || '',
      api_key_env: m.api_key_env || '',
      source_model_id: m.source_model_id || m.model_id,
      status: m.status || (m.is_active ? 'active' : 'disabled'),
      is_active: Number(m.is_active || 0) === 1,
      is_free: Number(m.is_free || 0) === 1,
      sync_status: m.sync_status || 'unknown',
      last_synced_at: m.last_synced_at || null,
      runtime_available: runtimeIds.has(m.model_id),
    }));

    res.json({
      total: enriched.length,
      models: enriched,
      sources: getConfiguredSources().map((s) => ({
        name: s.name, label: s.label, kind: s.kind,
        base_url: s.baseUrl, api_key_env: s.apiKeyEnv || null,
        enabled: s.enabled, priority: s.priority,
      })),
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminModelsSync(req: Request, res: Response) {
  try {
    const purge = req.query.purge !== '0';
    const result = await syncModelCatalog({ purge });
    const service = getService();
    if (service) await service.initialize();
    res.json({ ok: true, total: result.total, sources: result.sources.map((s) => s.name), errors: result.errors });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminModelActive(req: Request, res: Response) {
  try {
    const modelId = req.params.id;
    const isActive = req.body?.is_active !== false && req.body?.is_active !== 'false' && req.body?.is_active !== 0;
    setCatalogModelActive(modelId, isActive);
    refreshRuntimeModelsFromDb();
    res.json({ ok: true, model_id: modelId, is_active: isActive });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminMapping(req: Request, res: Response) {
  try {
    const db = getStateDb();
    const rules = db ? getProviderMapping(db) : [];
    const service = getService();
    const models = service?.getModels() || [];
    const activeModels = db ? getModelList().filter((m: any) => Number(m.is_active || 0) === 1) : [];
    const editorConnections = db ? getEditorConnections(db, 100) : [];
    const editorStats = db ? getEditorConnectionStats(db) : { total: 0, active: 0, editors: [] };
    res.json({ rules, activeModels, editorConnections, editorStats });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminMappingSave(req: Request, res: Response) {
  try {
    const { id, model_pattern, provider_name, backend_url, priority, is_active } = req.body || {};
    if (!model_pattern || !provider_name) return res.status(400).json({ error: 'model_pattern and provider_name required' });
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'state db not initialized' });
    const result = upsertProviderMapping(db, { id: id ? Number(id) : undefined, model_pattern: String(model_pattern), provider_name: String(provider_name), backend_url: backend_url ? String(backend_url) : null, priority: Number(priority ?? 0), is_active: is_active === false ? false : true });
    res.json({ ok: true, result });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminMappingDelete(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'state db not initialized' });
    deleteProviderMapping(db, id);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminModelUpdate(req: Request, res: Response) {
  try {
    const modelId = req.params.id;
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'state db not initialized' });
    const body = req.body || {};
    updateModelById(db, modelId, {
      owned_by: body.owned_by ?? body.provider ?? undefined,
      category: body.category ?? undefined,
      context_window: body.context_window !== undefined ? Number(body.context_window) : undefined,
      max_tokens: body.max_tokens !== undefined ? Number(body.max_tokens) : undefined,
      provider: body.provider ?? undefined,
      source_name: body.source_name ?? undefined,
      source_kind: body.source_kind ?? undefined,
      base_url: body.base_url ?? undefined,
      api_key_env: body.api_key_env ?? undefined,
      source_model_id: body.source_model_id ?? undefined,
      is_active: body.is_active !== undefined ? !(body.is_active === false || body.is_active === 'false' || body.is_active === 0) : undefined,
      status: body.status ?? undefined,
      is_free: body.is_free !== undefined ? !(body.is_free === false || body.is_free === 'false' || body.is_free === 0) : undefined,
      sync_status: body.sync_status ?? undefined,
      sync_error: body.sync_error ?? undefined,
      last_synced_at: body.last_synced_at ?? undefined,
    });
    refreshRuntimeModelsFromDb();
    res.json({ ok: true, model_id: modelId });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminModelDelete(req: Request, res: Response) {
  try {
    const modelId = req.params.id;
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'state db not initialized' });
    deleteModelById(db, modelId);
    refreshRuntimeModelsFromDb();
    res.json({ ok: true, model_id: modelId });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminSessions(req: Request, res: Response) {
  try { res.json(getSessions(100)); } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminConversations(req: Request, res: Response) {
  try { res.json(getConversations(100)); } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminConversationDetail(req: Request, res: Response) {
  try {
    const messages = getConversationDetail(req.params.id);
    if (!messages) return res.status(404).json({ error: 'Not found' });
    res.json(messages);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminUsage(req: Request, res: Response) {
  try {
    const models = getUsageStats(7);
    const daily = getUsageByDay(14);
    const total_requests = models.reduce((s: number, r: any) => s + (r.total_requests || 0), 0);
    const total_prompt_tokens = models.reduce((s: number, r: any) => s + (r.total_prompt_tokens || 0), 0);
    const total_completion_tokens = models.reduce((s: number, r: any) => s + (r.total_completion_tokens || 0), 0);
    const total_duration = models.reduce((s: number, r: any) => s + (r.total_duration_ms || 0), 0);
    const avgDuration = total_requests > 0 ? Math.round(total_duration / total_requests) + 'ms' : '0ms';
    res.json({ total_requests, total_prompt_tokens, total_completion_tokens, models_used: models.length, avg_duration: avgDuration, models, daily });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminIdentity(req: Request, res: Response) {
  try {
    const identity = getIdentity();
    res.json(identity?.system_identity || { name: 'ZombieCoder', version: '2.0.0' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── DELETE / CLEANUP ─────────────────────────────────────
export async function handleAdminDeleteSession(req: Request, res: Response) {
  try {
    const id = req.params.id;
    if (id === 'all') {
      const result = deleteAllSessions();
      return res.json({ ok: true, ...result });
    }
    deleteSession(id);
    res.json({ ok: true, session_id: id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminDeleteConversation(req: Request, res: Response) {
  try {
    const id = req.params.id;
    if (id === 'all') {
      const result = deleteAllConversations();
      return res.json({ ok: true, ...result });
    }
    deleteConversation(id);
    res.json({ ok: true, conversation_id: id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminClearUsage(req: Request, res: Response) {
  try {
    const result = clearUsageStats();
    res.json({ ok: true, ...result });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── MODEL PRIORITY ──────────────────────────────────────
export async function handleAdminModelPriority(req: Request, res: Response) {
  try {
    const modelId = req.params.id;
    const priority = Number(req.body?.priority ?? 0);
    setModelPriority(modelId, Math.max(0, Math.min(10, priority)));
    res.json({ ok: true, model_id: modelId, priority });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminModelUsage(req: Request, res: Response) {
  try {
    const modelId = req.params.id;
    const usage = getModelUsage(modelId);
    res.json(usage || { model_id: modelId, total_requests: 0 });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── REAL-TIME MONITORING ────────────────────────────────
export async function handleAdminMonitorSSE(req: Request, res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial snapshot
  const service = getService();
  const db = getStateDb();
  const models = service?.getModels() || [];
  const sessions = db ? getSessions(10) : [];
  sendEvent('snapshot', {
    models_count: models.length,
    uptime_ms: service ? Date.now() - service.startedAtMs : 0,
    sessions: sessions.slice(0, 5),
  });

  // Send periodic updates
  const interval = setInterval(() => {
    try {
      const svc = getService();
      const logs = svc?.getLogs() || [];
      const recent = logs.slice(-5);
      sendEvent('update', {
        timestamp: new Date().toISOString(),
        models_count: svc?.getModels().length || 0,
        uptime_ms: svc ? Date.now() - svc.startedAtMs : 0,
        recent_logs: recent,
      });
    } catch { /* ignore */ }
  }, 3000);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER ORCHESTRATION ADMIN
// ═══════════════════════════════════════════════════════════════

// ─── List Providers with full details ─────────────────────
export async function handleAdminProvidersList(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.json({ providers: [], models: [], costs: [] });

    const providers = db.prepare(`SELECT * FROM providers ORDER BY priority DESC`).all() as any[];
    const models = db.prepare(`SELECT * FROM provider_models WHERE is_active = 1 ORDER BY provider_id, category, model_id`).all() as any[];

    // Group models by provider
    const modelsByProvider: Record<string, any[]> = {};
    for (const m of models) {
      if (!modelsByProvider[m.provider_id]) modelsByProvider[m.provider_id] = [];
      modelsByProvider[m.provider_id].push(m);
    }

    // Calculate per-provider cost from usage_stats
    const costs = db.prepare(`
      SELECT
        provider,
        SUM(requests) as total_requests,
        SUM(tokens_prompt) as total_prompt_tokens,
        SUM(tokens_completion) as total_completion_tokens,
        ROUND(SUM(tokens_prompt) * 0.00001 + SUM(tokens_completion) * 0.00002, 4) as estimated_cost_usd
      FROM usage_stats
      WHERE timestamp >= datetime('now', '-30 days')
      GROUP BY provider
    `).all() as any[];

    res.json({
      providers: providers.map(p => ({
        ...p,
        capabilities: typeof p.capabilities === 'string' ? JSON.parse(p.capabilities || '{}') : p.capabilities,
        models: modelsByProvider[p.id] || [],
        model_count: (modelsByProvider[p.id] || []).length,
      })),
      models,
      costs,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── Get Single Provider ────────────────────────────────
export async function handleAdminProviderGet(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.json({ provider: null });

    const id = req.params.id;
    const provider = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as any;
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    const models = db.prepare(`SELECT * FROM provider_models WHERE provider_id = ? ORDER BY category, model_id`).all(id) as any[];
    const costs = db.prepare(`
      SELECT SUM(requests) as total_requests, SUM(tokens_prompt) as total_prompt_tokens,
             SUM(tokens_completion) as total_completion_tokens,
             ROUND(SUM(tokens_prompt) * 0.00001 + SUM(tokens_completion) * 0.00002, 4) as estimated_cost_usd
      FROM usage_stats WHERE provider = ? AND timestamp >= datetime('now', '-30 days')
    `).get(id) as any;

    res.json({
      provider: {
        ...provider,
        capabilities: typeof provider.capabilities === 'string' ? JSON.parse(provider.capabilities || '{}') : provider.capabilities,
        models,
        model_count: models.length,
      },
      costs: costs || { total_requests: 0, total_prompt_tokens: 0, total_completion_tokens: 0, estimated_cost_usd: 0 },
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── Save Provider (create/update) ───────────────────────
export async function handleAdminProviderSave(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'state db not initialized' });

    const { id, name, type, base_url, api_key_env, api_key, priority, capabilities, rate_limit_rpm, rate_limit_tpm } = req.body || {};
    if (!id || !name || !base_url) return res.status(400).json({ error: 'id, name, base_url required' });

    // Input validation: sanitize and validate fields
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    const safeName = String(name).replace(/[<>"'`]/g, '').slice(0, 128);
    const safeType = String(type || 'openai-compatible').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
    const safeUrl = String(base_url).slice(0, 2048);
    if (!safeUrl.startsWith('http://') && !safeUrl.startsWith('https://')) {
      return res.status(400).json({ error: 'base_url must be http:// or https://' });
    }
    const safeKeyEnv = api_key_env ? String(api_key_env).replace(/[^A-Z0-9_]/g, '').slice(0, 128) : null;
    const safeApiKey = api_key ? String(api_key).slice(0, 512) : null;
    const safePriority = Math.min(Math.max(Number(priority) || 0, 0), 1000);
    const safeRateRpm = rate_limit_rpm ? Math.min(Math.max(Number(rate_limit_rpm), 1), 100000) : null;
    const safeRateTpm = rate_limit_tpm ? Math.min(Math.max(Number(rate_limit_tpm), 1), 10000000) : null;

    db.prepare(`
      INSERT INTO providers(id, name, type, base_url, api_key_env, api_key, priority, capabilities, rate_limit_rpm, rate_limit_tpm, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, type=excluded.type, base_url=excluded.base_url,
        api_key_env=excluded.api_key_env, api_key=excluded.api_key,
        priority=excluded.priority, capabilities=excluded.capabilities,
        rate_limit_rpm=excluded.rate_limit_rpm, rate_limit_tpm=excluded.rate_limit_tpm,
        updated_at=CURRENT_TIMESTAMP
    `).run(safeId, safeName, safeType, safeUrl, safeKeyEnv, safeApiKey, safePriority, JSON.stringify(capabilities || {}), safeRateRpm, safeRateTpm);

    res.json({ ok: true, id: safeId });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── Delete Provider ─────────────────────────────────────
export async function handleAdminProviderDelete(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'state db not initialized' });
    const id = req.params.id;
    db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM provider_models WHERE provider_id = ?`).run(id);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── Toggle Provider Active/Inactive ─────────────────────
export async function handleAdminProviderToggle(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'state db not initialized' });
    const id = req.params.id;
    const { is_active } = req.body || {};
    db.prepare(`UPDATE providers SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(is_active ? 1 : 0, id);
    res.json({ ok: true, id, is_active });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── Test Provider (actual request, not health check) ────
export async function handleAdminProviderTest(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'state db not initialized' });

    const id = req.params.id;
    const provider = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as any;
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    // Resolve API key
    const apiKey = provider.api_key || (provider.api_key_env ? process.env[provider.api_key_env] : '') || '';
    const baseUrl = provider.base_url.replace(/\/+$/, '');
    const testModel = req.body?.model || '';

    // Find first available chat-capable model for this provider (prefer active, fallback to any)
    let models = db.prepare(`SELECT * FROM provider_models WHERE provider_id = ? AND is_active = 1 AND category IN ('fast','balanced','powerful') ORDER BY is_free DESC, category LIMIT 1`).all(id) as any[];
    if (!models.length) {
      models = db.prepare(`SELECT * FROM provider_models WHERE provider_id = ? AND category IN ('fast','balanced','powerful') ORDER BY is_free DESC, category LIMIT 1`).all(id) as any[];
    }
    if (!models.length) {
      models = db.prepare(`SELECT * FROM provider_models WHERE provider_id = ? ORDER BY category LIMIT 1`).all(id) as any[];
    }
    const model = testModel || models[0]?.model_id;
    if (!model) return res.status(400).json({ error: 'No models available for this provider' });

    // Make actual test request
    const startTime = Date.now();
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say "Hello from ' + id + '" in exactly 5 words.' }],
        max_tokens: 50,
        temperature: 0,
      }),
    });

    const durationMs = Date.now() - startTime;
    const body = await resp.json();

    if (!resp.ok) {
      // Update health status
      db.prepare(`UPDATE providers SET health_status = 'error', last_health_check = CURRENT_TIMESTAMP, error_count = error_count + 1 WHERE id = ?`).run(id);
      return res.json({
        ok: false,
        status: resp.status,
        duration_ms: durationMs,
        model,
        error: body?.error?.message || body?.error || JSON.stringify(body).slice(0, 500),
      });
    }

    // Update health status
    db.prepare(`UPDATE providers SET health_status = 'healthy', last_health_check = CURRENT_TIMESTAMP, error_count = 0 WHERE id = ?`).run(id);

    res.json({
      ok: true,
      status: 200,
      duration_ms: durationMs,
      model,
      response: body?.choices?.[0]?.message?.content || 'No content',
      usage: body?.usage || null,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── Sync Provider Models ────────────────────────────────
export async function handleAdminProviderSync(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'state db not initialized' });

    const id = req.params.id;
    const provider = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as any;
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    const apiKey = provider.api_key || (provider.api_key_env ? process.env[provider.api_key_env] : '') || '';
    const baseUrl = provider.base_url.replace(/\/+$/, '');

    // Try to fetch models from API
    let fetchedModels: any[] = [];
    try {
      const resp = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });
      if (resp.ok) {
        const json = await resp.json();
        fetchedModels = Array.isArray(json?.data) ? json.data : [];
      }
    } catch {
      // Some providers don't have /models endpoint
    }

    // Store fetched models (no duplicates)
    let added = 0;
    let skipped = 0;
    for (const m of fetchedModels) {
      const modelId = String(m.id || '').trim();
      if (!modelId) { skipped++; continue; }

      const existing = db.prepare(`SELECT id FROM provider_models WHERE provider_id = ? AND model_id = ?`).get(id, modelId);
      if (existing) { skipped++; continue; }

      const category = inferCategory(modelId);
      db.prepare(`
        INSERT INTO provider_models(id, provider_id, model_id, context_window, max_output_tokens, category, supports_tools, supports_vision, supports_streaming, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
      `).run(
        `${id}:${modelId}`, id, modelId,
        m.context_window || inferContextWindow(category, modelId),
        m.max_tokens || inferMaxTokens(category, modelId),
        category,
        !modelId.includes('embed') && !modelId.includes('whisper') ? 1 : 0,
        modelId.includes('vision') || modelId.includes('gpt-4o') ? 1 : 0,
        1,
      );
      added++;
    }

    // Update provider health
    db.prepare(`UPDATE providers SET health_status = 'healthy', last_health_check = CURRENT_TIMESTAMP WHERE id = ?`).run(id);

    res.json({ ok: true, fetched: fetchedModels.length, added, skipped, provider: id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── Sync All Providers ──────────────────────────────────
export async function handleAdminProviderSyncAll(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'state db not initialized' });

    const providers = db.prepare(`SELECT * FROM providers WHERE is_active = 1`).all() as any[];
    const results: any[] = [];

    for (const provider of providers) {
      try {
        const apiKey = provider.api_key || (provider.api_key_env ? process.env[provider.api_key_env] : '') || '';
        const baseUrl = provider.base_url.replace(/\/+$/, '');

        let fetchedModels: any[] = [];
        try {
          const resp = await fetch(`${baseUrl}/models`, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
          });
          if (resp.ok) {
            const json = await resp.json();
            fetchedModels = Array.isArray(json?.data) ? json.data : [];
          }
        } catch { /* skip */ }

        let added = 0;
        for (const m of fetchedModels) {
          const modelId = String(m.id || '').trim();
          if (!modelId) continue;
          const existing = db.prepare(`SELECT id FROM provider_models WHERE provider_id = ? AND model_id = ?`).get(provider.id, modelId);
          if (existing) continue;

          const category = inferCategory(modelId);
          db.prepare(`
            INSERT INTO provider_models(id, provider_id, model_id, context_window, max_output_tokens, category, supports_tools, supports_vision, supports_streaming, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
          `).run(`${provider.id}:${modelId}`, provider.id, modelId, m.context_window || 0, m.max_tokens || 0, category, 1, modelId.includes('vision') ? 1 : 0, 1);
          added++;
        }

        results.push({ id: provider.id, fetched: fetchedModels.length, added, ok: true });
      } catch (err: any) {
        results.push({ id: provider.id, error: err.message, ok: false });
      }
    }

    res.json({ ok: true, providers: results });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── Test Model (actual chat request) ────────────────────
export async function handleAdminModelTest(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'state db not initialized' });

    const modelId = req.params.id;
    const { message, max_tokens, temperature, stream } = req.body || {};

    // Find provider for this model
    const modelRow = db.prepare(`SELECT * FROM provider_models WHERE model_id = ? AND is_active = 1 LIMIT 1`).get(modelId) as any;
    if (!modelRow) return res.status(404).json({ error: 'Model not found or inactive' });

    const provider = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(modelRow.provider_id) as any;
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    const apiKey = provider.api_key || (provider.api_key_env ? process.env[provider.api_key_env] : '') || '';
    const baseUrl = provider.base_url.replace(/\/+$/, '');

    // If stream requested, use streaming response
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: message || 'Hello! Say something brief.' }],
          max_tokens: max_tokens || 200,
          temperature: temperature ?? 0.7,
          stream: true,
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        res.write(`data: ${JSON.stringify({ error: errBody.slice(0, 500) })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const reader = resp.body?.getReader();
      if (!reader) { res.end(); return; }

      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              res.write(line + '\n');
            }
          }
        }
        if (buffer.trim()) res.write(buffer + '\n');
      } catch { /* ignore */ }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // Non-streaming test
    const startTime = Date.now();
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: message || 'Hello! Say something brief.' }],
        max_tokens: max_tokens || 200,
        temperature: temperature ?? 0.7,
      }),
    });

    const durationMs = Date.now() - startTime;
    const body = await resp.json();

    if (!resp.ok) {
      return res.json({
        ok: false,
        status: resp.status,
        duration_ms: durationMs,
        error: body?.error?.message || JSON.stringify(body).slice(0, 500),
      });
    }

    res.json({
      ok: true,
      status: 200,
      duration_ms: durationMs,
      model: body?.model || modelId,
      response: body?.choices?.[0]?.message?.content || 'No content',
      usage: body?.usage || null,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── Auto Routing Test ───────────────────────────────────
export async function handleAdminAutoRouteTest(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'state db not initialized' });

    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });

    // Get all active models with their providers
    const models = db.prepare(`
      SELECT pm.*, p.base_url, p.api_key, p.api_key_env, p.health_status
      FROM provider_models pm
      JOIN providers p ON pm.provider_id = p.id
      WHERE pm.is_active = 1 AND p.is_active = 1
    `).all() as any[];

    // Smart selection scoring
    const scored = models.map(m => {
      let score = 50;
      if (m.is_free) score += 20;
      if (m.category === 'fast') score += 15;
      if (m.category === 'balanced') score += 5;
      if (m.health_status === 'healthy') score += 10;
      if (m.supports_tools) score += 5;
      return { ...m, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Return top 5 recommendations
    const recommendations = scored.slice(0, 5).map(s => ({
      provider_id: s.provider_id,
      model_id: s.model_id,
      score: s.score,
      category: s.category,
      is_free: s.is_free,
      health: s.health_status,
    }));

    res.json({
      ok: true,
      input_length: message.length,
      total_models: models.length,
      recommendations,
      selected: recommendations[0] || null,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── Set Default Model ───────────────────────────────────
export async function handleAdminSetDefaultModel(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'state db not initialized' });

    const { model_id } = req.body || {};
    if (!model_id) return res.status(400).json({ error: 'model_id required' });

    // Store in a config table or update model priority
    db.prepare(`
      INSERT INTO model_rate_limits(model_id, priority, updated_at)
      VALUES (?, 10, CURRENT_TIMESTAMP)
      ON CONFLICT(model_id) DO UPDATE SET priority=10, updated_at=CURRENT_TIMESTAMP
    `).run(model_id);

    // Also update the service's active model
    const service = getService();
    if (service) {
      (service as any)._defaultModel = model_id;
    }

    res.json({ ok: true, default_model: model_id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── Get Provider Cost Stats ─────────────────────────────
export async function handleAdminProviderCosts(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.json({ costs: [], total: { requests: 0, tokens: 0, cost: 0 } });

    // Use real pricing from pricing module
    const { calculateCost, getAllPricing } = require('../providers/pricing');

    const rawCosts = db.prepare(`
      SELECT
        provider,
        model_id,
        SUM(requests) as total_requests,
        SUM(tokens_prompt) as total_prompt_tokens,
        SUM(tokens_completion) as total_completion_tokens,
        MAX(timestamp) as last_used
      FROM usage_stats
      WHERE timestamp >= datetime('now', '-30 days')
      GROUP BY provider, model_id
      ORDER BY total_requests DESC
    `).all() as any[];

    // Calculate real costs using pricing data
    let totalCost = 0;
    let totalTokens = 0;
    let totalRequests = 0;

    const costs = rawCosts.map((row: any) => {
      const usage = {
        prompt_tokens: row.total_prompt_tokens,
        completion_tokens: row.total_completion_tokens,
        total_tokens: row.total_prompt_tokens + row.total_completion_tokens,
      };
      const costInfo = calculateCost(row.provider, row.model_id, usage);
      const cost = costInfo ? costInfo.totalCost : (usage.total_tokens * 0.00001);
      totalCost += cost;
      totalTokens += usage.total_tokens;
      totalRequests += row.total_requests;

      return {
        provider: row.provider,
        model_id: row.model_id,
        total_requests: row.total_requests,
        total_prompt_tokens: row.total_prompt_tokens,
        total_completion_tokens: row.total_completion_tokens,
        estimated_cost_usd: cost,
        is_free: costInfo?.isFree || false,
        last_used: row.last_used,
      };
    });

    res.json({
      costs,
      total: { requests: totalRequests, tokens: totalTokens, cost: totalCost },
      pricingModels: getAllPricing().length,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── Provider Tools ──────────────────────────────────────
export async function handleAdminProviderTools(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.json({ tools: [], summary: [] });

    const providerId = req.query.provider_id as string;
    const tools = providerId
      ? db.prepare(`SELECT * FROM provider_tools WHERE provider_id = ? ORDER BY tool_type, tool_name`).all(providerId)
      : db.prepare(`SELECT * FROM provider_tools ORDER BY provider_id, tool_type, tool_name`).all();

    // Group by provider
    const byProvider: Record<string, any[]> = {};
    for (const t of tools as any[]) {
      if (!byProvider[t.provider_id]) byProvider[t.provider_id] = [];
      byProvider[t.provider_id].push(t);
    }

    res.json({ tools, byProvider });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

export async function handleAdminProviderToolTest(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.status(500).json({ error: 'Database not initialized' });

    const { id: provider_id, type: tool_type } = req.params;
    const { message } = req.body || {};

    // Get provider
    const provider = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(provider_id) as any;
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    const apiKey = provider.api_key || (provider.api_key_env ? process.env[provider.api_key_env] : '') || '';
    const baseUrl = provider.base_url.replace(/\/+$/, '');

    // Get a model for this provider (prefer active, fallback to any)
    let model = db.prepare(`SELECT * FROM provider_models WHERE provider_id = ? AND is_active = 1 AND category IN ('fast','balanced','powerful') LIMIT 1`).get(provider_id) as any;
    if (!model) model = db.prepare(`SELECT * FROM provider_models WHERE provider_id = ? AND category IN ('fast','balanced','powerful') LIMIT 1`).get(provider_id) as any;
    if (!model) model = db.prepare(`SELECT * FROM provider_models WHERE provider_id = ? ORDER BY category LIMIT 1`).get(provider_id) as any;
    if (!model) return res.status(400).json({ error: 'No models available for this provider' });

    const startTime = Date.now();

    // Test based on tool type
    switch (tool_type) {
      case 'chat': {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            model: model.model_id,
            messages: [{ role: 'user', content: message || 'Say hello in 3 words.' }],
            max_tokens: 50,
          }),
        });
        const data = await resp.json();
        const duration = Date.now() - startTime;
        if (!resp.ok) return res.json({ ok: false, duration_ms: duration, error: data?.error?.message || 'Failed' });
        return res.json({ ok: true, duration_ms: duration, response: data?.choices?.[0]?.message?.content, model: model.model_id });
      }
      case 'streaming': {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            model: model.model_id,
            messages: [{ role: 'user', content: message || 'Say hello.' }],
            max_tokens: 50,
            stream: true,
          }),
        });
        const duration = Date.now() - startTime;
        if (!resp.ok) return res.json({ ok: false, duration_ms: duration, error: 'Stream failed' });
        return res.json({ ok: true, duration_ms: duration, model: model.model_id, note: 'Stream started successfully' });
      }
      case 'tool_call': {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            model: model.model_id,
            messages: [{ role: 'user', content: message || 'What is the weather in Dhaka?' }],
            tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
            max_tokens: 100,
          }),
        });
        const data = await resp.json();
        const duration = Date.now() - startTime;
        if (!resp.ok) return res.json({ ok: false, duration_ms: duration, error: data?.error?.message || 'Failed' });
        const toolCalls = data?.choices?.[0]?.message?.tool_calls;
        return res.json({ ok: true, duration_ms: duration, has_tool_calls: !!(toolCalls?.length), tool_calls: toolCalls, model: model.model_id });
      }
      default:
        return res.status(400).json({ error: 'Unknown tool_type: ' + tool_type });
    }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── Get Provider Capabilities (for test page dropdown) ──
export async function handleAdminProviderCapabilities(req: Request, res: Response) {
  try {
    const db = getStateDb();
    if (!db) return res.json({ providers: [] });

    const providers = db.prepare(`SELECT * FROM providers WHERE is_active = 1 ORDER BY priority DESC`).all() as any[];

    const result = providers.map(p => {
      let caps: any = {};
      try { caps = typeof p.capabilities === 'string' ? JSON.parse(p.capabilities) : (p.capabilities || {}); } catch {}

      const tools = db.prepare(`SELECT * FROM provider_tools WHERE provider_id = ?`).all(p.id) as any[];
      const toolTypes = [...new Set(tools.map(t => t.tool_type))];

      return {
        id: p.id,
        name: p.name,
        health: p.health_status,
        capabilities: {
          streaming: caps.streaming ?? toolTypes.includes('streaming'),
          tool_calling: caps.toolCalling ?? toolTypes.includes('tool_call'),
          vision: caps.vision ?? toolTypes.includes('vision'),
          audio: caps.audio ?? toolTypes.includes('audio'),
          embeddings: caps.embeddings ?? toolTypes.includes('embedding'),
        },
        tools: toolTypes,
      };
    });

    res.json({ providers: result });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// Helper functions for category inference
function inferCategory(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes('guard') || lower.includes('safeguard')) return 'guard';
  if (lower.includes('whisper') || lower.includes('tts') || lower.includes('audio')) return 'audio';
  if (lower.includes('embed')) return 'embedding';
  if (lower.includes('vision')) return 'vision';
  if (lower.includes('mini') || lower.includes('flash') || lower.includes('haiku') || lower.includes('8b') || lower.includes('1b')) return 'fast';
  if (lower.includes('70b') || lower.includes('120b') || lower.includes('opus') || lower.includes('pro')) return 'powerful';
  return 'balanced';
}

function inferContextWindow(category: string, modelId: string): number {
  if (category === 'audio' || category === 'embedding') return 0;
  if (category === 'guard') return 512;
  if (modelId.toLowerCase().includes('gemini')) return 1048576;
  return 131072;
}

function inferMaxTokens(category: string, modelId: string): number {
  if (category === 'audio' || category === 'embedding') return 0;
  if (category === 'guard') return 512;
  return 8192;
}

// ─── AGENT HEALTH ────────────────────────────────────────
export async function handleAdminAgentHealth(req: Request, res: Response) {
  try {
    const service = getService();
    const db = getStateDb();
    const sessions = db ? getSessions(20) : [];
    const activeSessions = sessions.filter((s: any) => s.status === 'active');
    const models = service?.getModels() || [];
    const activeModels = models.filter((m: any) => m.status !== 'disabled');

    res.json({
      status: 'ok',
      agent: 'ZombieCoder',
      server_running: !!service,
      models_available: models.length,
      models_active: activeModels.length,
      sessions_active: activeSessions.length,
      sessions_total: sessions.length,
      uptime_ms: service ? Date.now() - service.startedAtMs : 0,
      last_activity: sessions.length > 0 ? sessions[0].updated_at : null,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}

// ─── PRICING TABLE ────────────────────────────────────────
export async function handleAdminPricing(req: Request, res: Response) {
  try {
    const { getAllPricing, getProviderPricing } = require('../providers/pricing');
    const providerId = req.query.provider_id as string;

    const pricing = providerId ? getProviderPricing(providerId) : getAllPricing();
    res.json({ pricing, count: pricing.length });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
}
