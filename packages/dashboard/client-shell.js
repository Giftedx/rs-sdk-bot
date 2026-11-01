/* OSRS game chrome and RuneLite plugin workspace. All game data is observed. */
(() => {
  const app=document.querySelector('.app'),asset=n=>'/client-assets/'+n;
  // The local page is the operator's console. Hosted, the shim (window.FleetShim) says whether the owner signed in;
  // a spectator sees the game and the viewing plugins only.
  window.atlasOperator=()=>!window.FleetShim||!!window.FleetShim.signedIn?.();
  // Owner-only: commands, jobs, banks, host resources, the plan (goals) and the private repository's pull requests.
  const OPERATOR_PLUGINS=['operations','dispatch','raw','jobs','machine','stock','goals','prs'];
  // Only the tabs with observed data and no plugin that shows the same: Fleet holds the stopped accounts (the old
  // Ignore List) and Account overview the account summary (the old Account Management tab).
  const tabs=[['skills','Skills'],['quests','Quest List'],['inventory','Inventory'],['equipment','Worn Equipment'],['friends','Friends List'],['settings','Settings']];
  const realSkill=k=>!/^Stat\d+$/.test(k.name)&&k.name!=='Overall';const reported=(acct,n)=>{const set=acct?.skills?.length?acct.skills:S?.bots?.flatMap(x=>x.skills||[])||[];return !set.length||set.some(k=>k.name===n||(n==='Runecraft'&&/runecraft/i.test(k.name)));};
const skills=['Attack','Hitpoints','Mining','Strength','Agility','Smithing','Defence','Herblore','Fishing','Ranged','Thieving','Cooking','Prayer','Crafting','Firemaking','Magic','Fletching','Woodcutting','Runecraft','Slayer','Farming','Construction','Hunter','Sailing'];
  const skillFile=n=>n.toLowerCase()==='runecraft'?'runecraft':n.toLowerCase();
  const hud=document.createElement('div');hud.className='game-hud';
  hud.innerHTML=`<button class="game-xp" title="XP Tracker" aria-label="XP Tracker">XP</button><div class="game-orbs" aria-label="Player status"></div><div class="xp-drops" aria-hidden="true"></div><div class="xp-globes" aria-label="XP globes"></div><div class="game-overlay" aria-label="Overlay"></div><div class="game-infoboxes" aria-label="Infoboxes"></div><div class="game-tip" hidden></div><div class="game-screen" id="game-loading"><div class="game-screen-box"><h2>Welcome to RuneScape</h2><p>Loading - please wait.</p></div></div><div class="game-screen" id="game-lost" hidden><div class="game-screen-box"><p>Connection lost.</p><p>Please wait - attempting to reestablish.</p></div></div><div class="game-minimap" aria-label="Minimap"><canvas width="146" height="146"></canvas><canvas class="minimap-frame" aria-hidden="true"></canvas><img class="minimap-compass" src="${asset('compass.png')}" alt="" title="Compass"><button class="game-worldmap" data-places title="Places: move the camera" aria-label="Places"><img src="${asset('worldmap-icon.png')}" alt=""></button></div><button class="game-logout" title="Logout menu">⏻</button><section class="game-tabs" aria-label="Game interface"><nav class="tab-row" aria-label="Primary game tabs"></nav><div class="game-panel" id="game-panel"></div><nav class="tab-row" aria-label="Social and settings tabs"></nav></section><button class="chat-toggle" aria-label="Toggle chat">▾ Chat</button><section class="game-chat" aria-label="In-game chat"><div class="game-chat-lines" role="log" aria-live="polite"></div><form class="chat-input"><span id="chat-name">Spectator:</span><input aria-label="Chat message or local command" autocomplete="off" placeholder="*"></form><nav class="chat-channels" aria-label="Chat channels"></nav></section>`;
  app.append(hud);
  const title=document.createElement('div');title.className='client-title';title.innerHTML=`<img src="${asset('runelite.png')}" alt=""><span>RuneLite — Swarm</span><span class="connection">● Live world</span><select aria-label="Observed account" id="client-account"><option value="">Free camera</option></select><button id="client-sidebar" title="Toggle plugin sidebar" aria-label="Toggle plugin sidebar">❯</button>`;app.append(title);
  const plugin=document.createElement('aside');plugin.className='client-plugin';plugin.setAttribute('aria-label','RuneLite plugins');plugin.innerHTML='<div class="client-plugin-title"><span id="client-plugin-name">Fleet</span><select id="client-more" aria-label="More plugins"><option value="">⋮</option><option value="raw">Raw evidence</option></select><button aria-label="Close plugin">×</button></div><div class="client-plugin-body"></div>';app.append(plugin);
  const body=plugin.querySelector('.client-plugin-body'),rail=document.createElement('nav');rail.className='client-rail';rail.setAttribute('aria-label','RuneLite plugin toolbar');
  const oldRail=document.querySelector('.plugin-rail');
  const plugins=[['fleet','Fleet'],['xp','XP Tracker'],['boards','Hiscores'],['world','World'],['ge','Grand Exchange'],['prs','Pull requests'],['jobs','Agents & jobs'],['goals','Project goals'],['account','Account overview'],['stock','Supply ledger'],['activity','Activity'],['machine','Host resources']];
  const fallback='<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM8 9h8m-8 5h8"/></svg>';
  // RuneLite's own sidebar icons (client-assets/rl-*.png, see ATTRIBUTION.txt), one per plugin.
  const RAIL_ICONS=['fleet','xp','hiscore','loot','worlds','ge','prs','jobs','goals','account','boards','activity','world','machine','settings','operations','dispatch','alerts','library','manager'],RAIL_FILE={boards:'hiscore'};
  const railIcon=id=>{const f=RAIL_FILE[id]||id;return RAIL_ICONS.includes(f)?`<img src="${asset('rl-'+f+'.png')}" alt="">`:null;};window.atlasRailIcon=railIcon;
  const icons={xp:railIcon('xp')};
  rail.innerHTML=plugins.filter(([id])=>window.atlasOperator()||!OPERATOR_PLUGINS.includes(id)).map(([id,label])=>`<button data-client-plugin="${id}" aria-label="${label}" title="${label}">${railIcon(id)||oldRail.querySelector(`[data-plugin="${id}"]`)?.innerHTML||fallback}</button>`).join('')+'<span class="rail-gap"></span><button data-client-plugin="settings" aria-label="Client settings" title="Client settings">'+railIcon('settings')+'</button>';app.append(rail);
  const fleet=$('#fleet-panel'),inspect=$('#inspect-panel'),boards=$('.boards'),allocation=$('#allocation-panel'),journal=$('.map-dock'),places=$('.map-place');
  const parked=document.createElement('div');parked.hidden=true;app.append(parked);
  for(const el of [fleet,inspect,boards,allocation,journal])parked.append(el);
  const placesBox=document.createElement('div');placesBox.className='game-places';placesBox.hidden=true;placesBox.innerHTML='<strong>Places</strong><button class="game-control" data-viewer-worldmap hidden>World map: every player</button>';if(places)placesBox.append(places);hud.append(placesBox);
  let selectedTab='inventory',selectedPlugin='fleet',channel='All',context=null,questDetail=null;
  const chat=[],seen=new Set();let lastAccountOptions='';
  const account=()=>S?.bots?.find(b=>b.name===sel);
  const notify=text=>{chat.push({kind:'Game',text,at:Date.now()});if(chat.length>200)chat.shift();renderChat();};
  const stamp=at=>at?`<span class="chat-time">[${new Date(at).toTimeString().slice(0,5)}]</span> `:'';
  const KV=/(^|\s)([A-Za-z][A-Za-z0-9]*)=(\S+)/g;const kvWord=k=>k==='t'?'tick':k.replace(/([a-z0-9])([A-Z])/g,'$1 $2').toLowerCase();const kvValue=v=>/^\d{4,}$/.test(v)?Number(v).toLocaleString():v;
  function pretty(text){const t=String(text??'');const pairs=[...t.matchAll(KV)];if(pairs.length<2)return E(t);const head=t.slice(0,pairs[0].index).trim(),tail=t.slice(pairs[pairs.length-1].index+pairs[pairs.length-1][0].length).trim();const body=pairs.map(p=>E(kvWord(p[2]))+' '+E(kvValue(p[3]))).join(' · ');return `<span title="${E(t)}">${head?E(head)+' ':''}${body}${tail?' '+E(tail):''}</span>`;}
  function renderChat(){const rows=chat.filter(r=>channel==='All'||r.kind===channel);hud.querySelector('.game-chat-lines').innerHTML=rows.map(r=>`<p class="${r.kind==='Public'?'chat-public':r.kind==='Private'?'chat-private':'chat-system'}">${stamp(r.at)}${r.name?'<b>'+E(r.name)+'</b>: ':''}${pretty(r.text)}</p>`).join('')||`<p class="chat-system">${channel==='Public'?'No public chat is overheard here.':channel==='Private'?'No job has stopped since this page opened.':'No fleet events yet.'}</p>`;const log=hud.querySelector('.game-chat-lines');log.scrollTop=log.scrollHeight;}
  // Game: fleet events and finished jobs. Private: stopped jobs and deaths. Public: chat the 3D viewer overhears.
  const channels=['All','Game','Public','Private'];
  hud.querySelector('.chat-channels').innerHTML=channels.map(c=>`<button data-chat="${c}" class="${c==='All'?'active':''}">${c}</button>`).join('');
  const rows=hud.querySelectorAll('.tab-row');tabs.forEach(([id,label],i)=>rows[i<3?0:1].insertAdjacentHTML('beforeend',`<button data-game-tab="${id}" aria-label="${label}" title="${label}" class="${id===selectedTab?'active':''}"><img class="game-tab-icon" src="${asset('tab-'+id+'.png')}" alt=""></button>`));
  function level(name){return account()?.skills?.find(s=>s.name.toLowerCase()===name.toLowerCase()||(name==='Runecraft'&&/runecraft/i.test(s.name)));}
  const qty=n=>n>=10000000?`<span class="qty qty-m">${Math.floor(n/1e6)}M</span>`:n>=100000?`<span class="qty qty-k">${Math.floor(n/1000)}K</span>`:`<span class="qty">${n}</span>`;
  function itemCell(item,i){return `<button class="inventory-cell" data-item="${i}" title="${item?E(item.name)+' × '+E(item.count):'Empty slot'}" aria-label="${item?E(item.name)+' × '+E(item.count):'Empty inventory slot '+(i+1)}">${item?icon(item.name,32)+(item.count>1?qty(item.count):''):''}</button>`;}
  function gamePanel(){
    const b=account(),panel=$('#game-panel');let html='';
    if(selectedTab==='inventory'){html=b?.inventory?'<div class="inventory-grid">'+Array.from({length:28},(_,i)=>itemCell(b.inventory[i],i)).join('')+'</div>':'<h3>Inventory</h3><p class="game-muted">Select an account with a reported inventory.</p>';}
    if(selectedTab==='skills'){html='<div class="skill-grid">'+skills.filter(n=>reported(b,n)).map(n=>{const s=level(n);return `<button class="game-skill" data-skill="${n}" title="${n}${s?(s.xp!=null?' · '+s.xp.toLocaleString()+' XP':' · level '+s.level):' · not reported by this game'}"><img src="${asset('skill-'+skillFile(n)+'.png')}" alt=""><span>${s?s.currentLevel??s.level:'—'}<small>／${s?s.level:'—'}</small></span></button>`;}).join('')+'</div><div class="skill-total">Total level: '+(b?.skills?.filter(realSkill).reduce((n,s)=>n+s.level,0)??'—')+'</div>';}
    if(selectedTab==='equipment'&&b?.equipment?.length&&b.equipment.every(e=>e.slot==null)){html='<h3>Worn Equipment</h3><div class="game-list">'+b.equipment.map(it=>`<span class="equip-row">${icon(it.name,32)}<span>${E(it.name)}</span></span>`).join('')+'</div><p class="game-muted">The '+E(b.side||'other')+' side reports worn items without their slots. Snapshot '+age(b.at)+' old.</p>';}
    else if(selectedTab==='equipment'){const slots=[[0,'Head',77,0],[1,'Cape',27,40],[2,'Neck',77,40],[3,'Weapon',0,95],[4,'Body',77,83],[5,'Shield',151,95],[7,'Legs',77,126],[9,'Hands',27,177],[10,'Feet',77,177],[12,'Ring',127,177],[13,'Ammo',127,40]];html='<div class="equipment-doll">'+slots.map(([id,name,x,y])=>{const it=b?.equipment?.find(e=>e.slot===id);return `<button class="equipment-slot" style="left:${x}px;top:${y}px" data-equipment="${id}" title="${it?E(it.name):name+' · '+(b?.equipment?'empty':'not reported')}">${it?icon(it.name,32):'<small>'+name+'</small>'}</button>`;}).join('')+'</div>'+(b?'<p class="game-muted">'+(b.equipment?'Observed '+age(b.at)+' ago':'Equipment is not reported for this account.')+'</p>':'<p class="game-muted">Select an account in the title bar.</p>');}
    if(selectedTab==='quests'){
      const quests=b?.quests||[];
      const qp=b?.ranks?.find(r=>r.board==='Quest Points')?.level??quests.filter(q=>q.state==='complete'||q.state==='completed').length;html='<h3>Quest List</h3><p style="text-align:center">Quest Points: '+(b?E(qp):'—')+'</p><p class="game-muted" style="text-align:center">'+(b?.questsAt?'Observed '+age(b.questsAt)+' ago':'No quest snapshot')+'</p><div class="game-list">'+quests.map(q=>`<button style="color:${q.state==='complete'||q.state==='completed'?'#00ff00':q.state==='not started'?'#ff3030':'#ffff00'}" data-quest="${E(q.name)}">${E(q.name)}</button>`).join('')+'</div>';
      if(!quests.length)html+='<p class="game-muted">Quest progress has not been reported for this account.</p>';
      if(questDetail){const q=quests.find(q=>q.name===questDetail);html='<h3>'+E(questDetail)+'</h3><p style="text-align:center">'+E(q?.state||'Not reported')+'</p><p class="game-muted">'+(b?.questsAt?'Last observed '+age(b.questsAt)+' ago.':'No quest snapshot.')+'</p><button class="game-control" data-quest-back>Back to quest list</button>';}
    }
    if(selectedTab==='friends'){const bots=S.bots.filter(x=>!x.practice&&!x.reserved).sort((x,y)=>(y.fresh?1:0)-(x.fresh?1:0)||x.name.localeCompare(y.name));
      html='<h3>Friends List</h3><p style="text-align:center">Friends: '+bots.filter(x=>x.fresh).length+' online / '+bots.length+'</p><div class="game-list friends-list">'+bots.map(x=>`<button data-friend="${E(x.name)}" title="${E(safeName(x.name))}${x.goal?' · '+E(x.goal):''}"><span>${E(safeName(x.name))}</span><span class="${x.fresh?'friend-on':'friend-off'}">${x.fresh?E(x.side||'local'):'Offline'}</span></button>`).join('')+'</div><button class="game-control" data-open-plugin="fleet">Fleet plugin</button>';}
    if(selectedTab==='settings')html='<h3>Settings</h3><label>Display mode<select id="game-display"><option value="open">Resizable · plugin sidebar</option><option value="closed" '+(app.classList.contains('client-collapsed')?'selected':'')+'>Resizable · game only</option></select></label><label>Render quality<select id="game-quality"><option value="1">Sharp</option><option value="0.75">Balanced</option><option value="0.5">Light</option></select></label><button class="game-control" data-toggle-chat>Show / hide chatbox</button><button class="game-control" data-places>Places & camera</button><button class="game-control" data-open-plugin="machine">Performance</button>';
    if(selectedTab==='logout'){const owner=window.FleetShim?.signedIn?.();html='<h3>Logout</h3><p style="text-align:center">'+(owner?'Logged in as '+E(owner)+'.':'You are watching as a spectator.')+'</p><p class="game-muted">Account sessions belong to their workers; logging out here never logs a bot out.</p><button class="game-control" data-logout>Click here to logout</button><button class="game-control" data-open-plugin="fleet">View active sessions</button>';}
    panel.innerHTML=html;hud.querySelectorAll('[data-game-tab]').forEach(el=>{el.classList.toggle('active',el.dataset.gameTab===selectedTab);el.setAttribute('aria-pressed',String(el.dataset.gameTab===selectedTab));});
    if(selectedTab==='settings')$('#game-quality').value=String(window.atlasQuality||1);
  }
  // The XP Tracker plugin (RuneLite's): gains since the account's login, XP an hour, level progress, time to level.
  const XP_STORE='atlas-xp-baselines';
  const xpStore=()=>{try{return JSON.parse(localStorage.getItem(XP_STORE)||'{}')||{};}catch{return {};}},saveXpStore=store=>{try{localStorage.setItem(XP_STORE,JSON.stringify(store));}catch{/* private window */}};
  function xpTracker(){
    const b=account(),now=Date.now(),X=window.atlasXp;
    if(!b){const live=S.bots.filter(x=>x.fresh&&!x.practice&&!x.reserved);return '<div class="xp-panel"><div class="xp-box"><div class="xp-head"><span>XP Tracker</span></div><span class="xp-muted">Choose an account in the title bar, or one below.</span></div>'+(live.map(x=>`<button class="xp-box xp-row xp-pick" data-xp-focus="${E(x.name)}"><img src="${asset(trainedSkill(x)?'skill-'+skillFile(trainedSkill(x))+'.png':'rl-xp.png')}" alt=""><span class="xp-name">${E(safeName(x.name))}</span><span class="xp-gain">${x.xpPerHour?nf(Math.round(x.xpPerHour))+' XP/hr':'—'}</span></button>`).join('')||'<div class="xp-box"><span class="xp-muted">No account is playing now.</span></div>')+'</div>';}
    if(b.remote)return `<div class="xp-panel"><div class="xp-box"><div class="xp-head"><span>${E(safeName(b.name))}</span><span>${E(b.side)} side</span></div><span class="xp-muted">The ${E(b.side)} side shares levels, not XP, in its snapshot (${b.snapshotAt?age(b.snapshotAt)+' old':'age unknown'}). The Skills tab and the Hiscore plugin show its levels and ranks.</span></div></div>`;
    const store=xpStore(),base=X.baseline(store,b,now);saveXpStore(store);
    const rows=X.rows(b,base,now,b.goalSkill?{skill:b.goalSkill,xpPerHour:b.xpPerHour}:null),total=X.total(rows),hours=(now-base.at)/3.6e6;
    return `<div class="xp-panel"><div class="xp-box"><div class="xp-head"><span>Overall</span><span>${E(safeName(b.name))}</span></div><div class="xp-stats"><span>XP gained <b>${nf(total)}</b></span><span>XP/hr <b>${nf(Math.round(hours>0.001?total/hours:0))}</b></span><span>Tracked <b>${dur(now-base.at)}</b></span></div><button class="xp-reset" data-xp-reset>Reset</button></div>`+
      (rows.length?rows.map(r=>`<div class="xp-box xp-row"><img src="${asset('skill-'+skillFile(r.skill)+'.png')}" alt="" title="${E(r.skill)}"><div class="xp-main"><div class="xp-head"><span>${E(r.skill)}</span><span class="xp-gain">+${nf(r.gained)} xp</span></div><div class="xp-bar"><i style="width:${Math.round(r.progress*100)}%"></i><span>${r.level} → ${r.next} · ${Math.round(r.progress*100)}%</span></div><div class="xp-meta"><span>${nf(r.rate)} XP/hr</span><span>${r.ttl!=null?'TTL '+dur(r.ttl):nf(r.left)+' xp to level'}</span></div></div></div>`).join(''):'<div class="xp-box"><span class="xp-muted">No XP gained since tracking started.</span></div>')+'</div>';
  }
  // Hiscore plugin (RuneLite's layout): any fleet account's levels per skill with rank and XP on hover.
  let hiscoreName='';
  function hiscorePanel(){
    const name=hiscoreName||sel||'',b=S.bots.find(x=>x.name===name);
    const rank=(board)=>b?.ranks?.find(r=>r.board===board);
    const cell=(skill,label,levelText,title)=>`<div class="hs-cell" title="${E(title)}"><img src="${asset('skill-'+skillFile(skill)+'.png')}" alt="${E(label)}"><span>${levelText}</span></div>`;
    const grid=b?skills.filter(n=>reported(b,n)).map(n=>{const k=b.skills?.find(x=>x.name===n),r=rank(n);return cell(n,n,k?String(k.level):'--',n+(k?'\nLevel: '+k.level+(k.xp!=null?'\nExperience: '+nf(k.xp):''):' is not reported')+(r?'\nRank: '+nf(r.rank)+(r.delta?' ('+(r.delta>0?'+':'')+r.delta+' today)':''):''));}).join(''):'';
    const overall=b?.ranks?.find(r=>r.board==='Overall');const total=b?.skills?.filter(realSkill).reduce((n,k)=>n+k.level,0);
    const extra=(b?.ranks||[]).filter(r=>['Quest Points','Equipment','Bank','Runite'].includes(r.board)).map(r=>`<div class="hs-row"><span>${E(r.board)}</span><span>Rank ${nf(r.rank)}</span><span>${E(r.level)}</span></div>`).join('');
    return `<div class="hs-panel"><div class="hs-search"><input id="hs-name" list="hs-names" placeholder="Search for a player..." value="${E(name)}" aria-label="Player name"><datalist id="hs-names">${S.bots.filter(x=>!x.practice).map(x=>`<option value="${E(x.name)}">`).join('')}</datalist></div>`+
      (b?`<div class="hs-head"><span>${E(safeName(b.name))}</span><span>${overall?'Rank '+nf(overall.rank):''}</span></div><div class="hs-grid">${grid}<div class="hs-cell hs-overall" title="${E('Overall\nTotal level: '+total+(overall?'\nRank: '+nf(overall.rank)+'\nTime: '+overall.time:''))}"><img src="${asset('rl-xp.png')}" alt="Overall"><span>${total??'--'}</span></div></div>${extra?'<div class="hs-extra">'+extra+'</div>':''}<p class="xp-muted">Ranks from the demo hiscores, refreshed every 5 minutes. Hover a skill.</p>`
        :'<p class="xp-muted">Type a fleet account name, or follow one in the title bar.</p>')+'</div>';
  }
  // Hiscores: Fleet shows the scoreboard and the fleet's best rank per board; Account shows one account's ranks.
  let hiscoresMode='fleet';
  function hiscores(){
    for(const el of [boards])parked.append(el);body.replaceChildren();
    const head=document.createElement('div');head.className='op-filter hs-mode';head.innerHTML=[['fleet','Fleet'],['rivals','Rivals'],['account','Account']].map(([m,l])=>`<button data-hs-mode="${m}" class="${hiscoresMode===m?'active':''}">${l}</button>`).join('');body.append(head);
    if(hiscoresMode==='fleet'){boards.hidden=false;const p=document.createElement('div');p.className='progress-head';p.innerHTML=progressPanel();body.append(p,boards);if(S)boardGrid();}
    else if(hiscoresMode==='rivals'){const w=document.createElement('div');w.className='rivals-wrap';w.innerHTML=rivalsPanel();body.append(w);}
    else{const w=document.createElement('div');w.className='hs-wrap';w.innerHTML=hiscorePanel();body.append(w);}
  }
  // Where a tile is, in words: the nearest named place within 64 tiles.
  const placeOf=(x,z)=>{if(x==null)return '';let best=null,bd=64*64;for(const [n,px,pz] of (typeof PLACES!=='undefined'?PLACES:[])){const d=(px-x)**2+(pz-z)**2;if(d<bd){bd=d;best=n;}}return best?'near '+best:x+', '+z;};
  // Board time: the demo hiscores normalise ticks to 400 ms.
  const boardTime=t=>{const s=Math.round(t*0.4);return s>=3600?Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m':Math.floor(s/60)+'m '+s%60+'s';};
  // Rivals (Hiscores): each board's top 10 from the demo hiscores, who is ours, who is online now and where.
  let rivalBoard='Overall';
  function rivalsPanel(){
    const list=S.rivals||[];if(!list.length)return '<div class="xp-box"><span class="xp-muted">The board tops are not loaded yet. The server reads each board every 15 minutes.</span></div>';
    const b=list.find(x=>x.board===rivalBoard)||list[0];rivalBoard=b.board;
    return `<div class="xp-panel"><select id="rival-board" class="rl-search" aria-label="Board">${list.map(x=>`<option ${x.board===b.board?'selected':''}>${E(x.board)}</option>`).join('')}</select>`+
      `<div class="xp-box"><div class="xp-head"><span>${E(b.board)}</span><span class="xp-gain">read ${age(b.at)} ago</span></div><div class="xp-stats"><span>Our best <b>${b.ours?'#'+nf(b.ours.rank)+' '+E(safeName(b.ours.name)):'not ranked'}</b></span><span>Online now <b>${b.rows.filter(r=>r.online&&!r.fleet).length} of ${b.rows.filter(r=>!r.fleet).length}</b></span></div></div>`+
      overtakeBox(b.board)+
      b.rows.map(r=>`<button class="rival-row${r.fleet?' rival-ours':''}" data-lookup="${E(r.name)}" title="${E(r.name)}: level ${r.level}, ${nf(r.ticks)} ticks${r.online?', online '+placeOf(r.x,r.z):''}"><span>#${nf(r.rank)}</span><span>${E(safeName(r.name))}</span><span>${r.level}</span><span>${boardTime(r.ticks)}</span><span class="${r.online?'friend-on':'friend-off'}">${r.online?E(placeOf(r.x,r.z)):'offline'}</span></button>`).join('')+
      '<p class="xp-muted">Click a player to look them up. Gold rows are fleet accounts.</p></div>';
  }
  // Overtake planner: the fleet's best account on the board, and what it needs to pass the next rows of the top 10.
  const hoursText=h=>h==null?null:h<1?Math.max(1,Math.round(h*60))+' min':h<48?h.toFixed(1)+' h':Math.round(h/24)+' days';
  function overtakeBox(board){
    if(!window.atlasOperator())return '';const o=(S.overtake||[]).find(x=>x.board===board);if(!o)return board==='Overall'||board==='Quest Points'?'':'<div class="xp-box"><span class="xp-muted">No fleet account is ranked on this board.</span></div>';
    const line=t=>t.newAccount?`<div class="ot-row"><span>Pass #${t.rank} ${E(t.name)} (99 in ${boardTime(t.seconds/0.4)})</span><span>${o.level>=99?'board time stops at 99':'our board time is already past theirs'}: a new account must reach 99 in under ${boardTime(t.seconds/0.4)}</span></div>`
      :`<div class="ot-row"><span>Pass #${t.rank} ${E(t.name)} (level ${t.level})</span><span>level ${t.goal}${t.deadline!=null?' within '+boardTime(t.deadline/0.4)+' more board time':''}: ${t.xpNeeded==null?'XP not reported':nf(t.xpNeeded)+' XP'}${t.hours!=null?' · about '+hoursText(t.hours)+' at '+nf(Math.round(o.xpPerHour))+' XP/hr':t.xpNeeded!=null?' · not training this skill now':''}</span></div>`;
    return `<div class="xp-box"><div class="xp-head"><span>Overtake · ${E(safeName(o.account))}</span><span class="xp-gain">#${nf(o.rank)} · level ${o.level}</span></div>${o.targets.length?o.targets.map(line).join(''):'<span class="xp-muted">Already #1 on this board.</span>'}</div>`;
  }
  // World plugin: who stands at the spots our bots claim, and a lookup of any player (hiscores and where they are).
  let worldLookup=null,worldLookupName='';
  function worldPanel(){
    const spots=(S.contention||[]).filter(s=>s.x!=null),named=(S.contention||[]).filter(s=>s.x==null),roster=S.roster||[],fleet=new Set(S.bots.map(b=>b.name.toLowerCase()));
    const crowded=spots.filter(s=>s.others.length).length;
    return `<div class="xp-panel"><div class="xp-box"><div class="xp-head"><span>Look up a player</span></div><form id="wp-form"><input id="wp-name" class="rl-search" list="wp-names" maxlength="12" placeholder="Player name..." value="${E(worldLookupName)}" aria-label="Player name"><datalist id="wp-names">${roster.filter(r=>!fleet.has(String(r[0]).toLowerCase())).slice(0,400).map(r=>`<option value="${E(r[0])}">`).join('')}</datalist></form><div id="wp-result">${worldLookup?lookupCard(worldLookup):'<span class="xp-muted">Any player: levels, ranks and where they are now. Right-click a dot on the map to look that player up.</span>'}</div></div>`+
      `<div class="xp-box"><div class="xp-head"><span>Our spots</span><span class="${crowded?'side-late':'xp-gain'}">${crowded} with other players</span></div>${spots.map(s=>`<div class="spot-row"><div class="xp-head"><span>${E(s.kind)} ${E(placeOf(s.x,s.z))}</span><span class="${s.others.length?'side-late':'xp-muted'}">${s.others.length} other${s.others.length===1?'':'s'}</span></div><div class="xp-meta"><span>${E(s.side)} side · ${s.ours.length} of ours</span><span>${s.x}, ${s.z}</span></div>${s.others.length?'<div class="spot-names">'+s.others.slice(0,12).map(n=>`<button data-lookup="${E(n)}">${E(n)}</button>`).join('')+(s.others.length>12?`<span class="xp-muted">+${s.others.length-12} more</span>`:'')+'</div>':''}</div>`).join('')||'<span class="xp-muted">No claimed spot has a tile.</span>'}${named.length?`<p class="xp-muted">Claimed without a tile: ${named.map(s=>E(s.resource)).join(', ')}</p>`:''}</div>`+
      farmsBox()+
      `<div class="xp-box"><div class="xp-head"><span>Online now</span><span class="xp-gain">${nf(roster.length)}</span></div><div class="xp-meta"><span>${roster.filter(r=>fleet.has(String(r[0]).toLowerCase())).length} of them are ours</span><span>world feed, every 6 s</span></div></div>`+
      '<p class="xp-muted">Other players count within 10 tiles of a claimed tile on the ground floor. All of this is public game data.</p></div>';
  }
  // Bot farms: other players online whose names follow one pattern, and how many of them stand at our spots.
  function farmsBox(){
    const farms=S.farms||[];if(!farms.length)return '<div class="xp-box"><div class="xp-head"><span>Bot farms</span></div><span class="xp-muted">No group of three or more patterned names is online.</span></div>';
    return `<div class="xp-box"><div class="xp-head"><span>Bot farms</span><span class="xp-gain">${farms.length} groups · ${nf(farms.reduce((n,g)=>n+g.count,0))} players</span></div>`+farms.slice(0,12).map(g=>{const at=g.atSpots.reduce((n,s)=>n+s.count,0),where=[...new Map(g.tiles.map(([x,z])=>[placeOf(x,z),0])).keys()].slice(0,2).join(', ');
      return `<details class="farm-row"><summary><span>${E(g.label)}</span><span>${g.count} online${g.range?' · numbers '+g.range[0]+'–'+g.range[1]:''}</span><span class="${at?'side-late':'xp-muted'}">${at?at+' at our spots':'not at our spots'}</span></summary><div class="xp-meta"><span>${E(where)}</span></div><div class="spot-names">${g.names.slice(0,24).map(n=>`<button data-lookup="${E(n)}">${E(n)}</button>`).join('')}${g.names.length>24?`<span class="xp-muted">+${g.names.length-24} more</span>`:''}</div></details>`;}).join('')+'<p class="xp-muted">A farm is three or more online players with one name pattern: a numbered series, or random names with the same first two characters and length.</p></div>';
  }
  function lookupCard(l){
    if(l.error)return '<span class="side-late">'+E(l.error)+'</span>';
    const rank=n=>l.rows?.find(r=>r.board===n);
    const grid=l.rows?skills.filter(n=>reported(null,n)).map(n=>{const r=rank(n);return `<div class="hs-cell" title="${E(n+(r?'\nLevel: '+r.level+'\nRank: '+nf(r.rank)+'\nTime: '+r.time:'\nNot ranked'))}"><img src="${asset('skill-'+skillFile(n)+'.png')}" alt="${E(n)}"><span>${r?r.level:'--'}</span></div>`;}).join(''):'';
    const overall=rank('Overall'),qp=rank('Quest Points');
    return `<div class="lookup-card"><div class="xp-head"><span>${E(l.name)}</span><span class="${l.online?'friend-on':'friend-off'}">${l.online?'online '+E(placeOf(l.x,l.z)):l.lastSeen?'last seen '+age(l.lastSeen)+' ago':'not seen online'}</span></div><div class="xp-stats">${l.combat!=null?`<span>Combat <b>${l.combat}</b></span>`:''}${overall?`<span>Overall <b>#${nf(overall.rank)} · ${overall.level}</b></span>`:''}${qp?`<span>QP <b>${qp.level}</b></span>`:''}</div>`+
      (l.rows?(l.rows.length?`<div class="hs-grid">${grid}</div>`:'<p class="xp-muted">Not on the demo hiscores.</p>'):`<p class="xp-muted">${E(l.note||'Hiscores not loaded.')}</p>`)+
      (l.at?`<p class="xp-muted">Hiscores read ${age(l.at)} ago.</p>`:'')+(l.online?`<button class="game-control" data-world-go="${l.x},${l.z}">Show on the map</button>`:'')+'</div>';
  }
  function lookup(name){
    name=String(name||'').trim();if(!/^[A-Za-z0-9_ -]{1,12}$/.test(name))return;worldLookupName=name;worldLookup={name,rows:null,note:'Looking up…'};
    if(selectedPlugin!=='world')showPlugin('world');else{const el=body.querySelector('#wp-result');if(el)el.innerHTML=lookupCard(worldLookup);}
    fetch('/api/player?name='+encodeURIComponent(name)).then(r=>r.json()).then(j=>{if(worldLookupName!==name)return;worldLookup=j;const el=body.querySelector('#wp-result');if(el)el.innerHTML=lookupCard(j);}).catch(e=>{worldLookup={name,error:'Lookup failed: '+(e?.message||e)};const el=body.querySelector('#wp-result');if(el)el.innerHTML=lookupCard(worldLookup);});
  }
  window.atlasLookup=lookup;
  // Infoboxes (RuneLite): the watched account's session and time to target, or one box per playing bot.
  function infoboxes(){
    const el=hud.querySelector('.game-infoboxes'),b=account();
    const box=(img,text,title,name)=>`<button class="infobox" title="${E(title)}" ${name?'data-xp-focus="'+E(name)+'"':''}><img src="${img}" alt=""><span>${E(text)}</span></button>`;
    const short=ms=>ms==null?'':ms<3600e3?Math.floor(ms/6e4)+'m':Math.floor(ms/36e5)+'h'+String(Math.floor(ms%36e5/6e4)).padStart(2,'0');
    if(b){el.innerHTML=(b.uptime?box(asset('rl-activity.png'),short(b.uptime),'Session: '+dur(b.uptime)):'')+(b.goalSkill?box(asset('skill-'+skillFile(b.goalSkill)+'.png'),b.eta||String(b.goalNow??''),b.goalSkill+' '+(b.goalNow??'?')+' → '+b.goalLevel+(b.eta?' in '+b.eta:'')):'')+(b.death?box(asset('skill-hitpoints.png'),'died','Died '+age(b.death.at)+' ago: '+b.death.text):'');return;}
    el.innerHTML=S.bots.filter(x=>x.fresh&&!x.practice&&!x.reserved).slice(0,12).map(x=>{const t=trainedSkill(x);return box(asset(t?'skill-'+skillFile(t)+'.png':'rl-activity.png'),short(x.uptime),safeName(x.name)+(t?' · '+t+(x.goalNow!=null&&t===x.goalSkill?' '+x.goalNow:''):'')+(x.phaseShort?' · '+String(x.phaseShort).slice(0,60):'')+' · '+dur(x.uptime||0),x.name);}).join('');
  }
  // Board progress (the coordinator's scoreboard): what remains, the fleet's best live level per skill, quests and items.
  function progressPanel(){
    const p=S.scoreboard;if(!p?.available)return window.atlasOperator()?'<div class="xp-box"><span class="xp-muted">The coordinator scoreboard is not available.</span></div>':'';
    const old=!p.at||Date.now()-p.at>15*60e3,frac=(a,b)=>a==null||b==null?'—':nf(a)+' / '+nf(b);
    return `<div class="xp-panel progress-panel"><div class="xp-box"><div class="xp-head"><span>Board progress</span><span class="${old?'side-late':'xp-gain'}">${p.at?'updated '+age(p.at)+' ago':'age unknown'}</span></div><div class="xp-stats"><span>Skill levels <b>${nf(p.skillLevels??0)}</b></span><span>99s <b>${p.skills99??'—'}</b></span><span>Quests live <b>${frac(p.quests.live,p.quests.total)}</b></span><span>Items held <b>${frac(p.items.held,p.items.total)}</b></span></div></div>`+
      `<div class="xp-box"><div class="xp-head"><span>Remaining</span><span class="xp-gain">${p.done?'done':p.remaining.length}</span></div><div class="progress-remaining">${p.remaining.map(r=>`<span>${E(r)}</span>`).join('')||'<span class="xp-muted">Nothing remains.</span>'}</div></div></div>`;
  }
  // Grand Exchange plugin (RuneLite's): the route supplies with the live market's buy and sell prices and stock.
  let geQuery='';
  let geAll=false;
  function gePanel(){
    const offered=i=>i.ask!=null||i.bid!=null,owner=window.atlasOperator(),held=new Map();
    if(owner)for(const b of S.bots)if(!b.practice&&!b.reserved&&Array.isArray(b.bank))for(const it of b.bank)held.set(it.name,(held.get(it.name)||0)+(it.count||0));
    const all=(S.economy?.supplies||[]).filter(i=>i.name&&(!geQuery||i.name.toLowerCase().includes(geQuery))),hidden=all.filter(i=>!offered(i)).length;
    const rows=all.filter(i=>geAll||offered(i)).sort((a,b)=>Number(b.ask!=null||b.bid!=null)-Number(a.ask!=null||a.bid!=null)||(b.stock||0)-(a.stock||0)||a.name.localeCompare(b.name));
    const price=v=>v==null?'—':nf(Math.round(v))+' gp';
    return `<div class="ge-panel"><input id="ge-search" class="rl-search" placeholder="Search for an item..." value="${E(geQuery)}" aria-label="Search items"><div class="xp-meta"><span>${all.length-hidden} route supplies with offers</span><span>prices ${S.economy?.pricesAt?age(S.economy.pricesAt)+' old':'unknown'}</span></div>${hidden?`<button class="game-control" data-ge-all>${geAll?'Hide':'Show'} the ${hidden} with no offer</button>`:''}`+
      rows.slice(0,80).map(i=>`<div class="ge-row" title="${E(i.name)}: buy ${price(i.ask)}, sell ${price(i.bid)}, stock ${nf(i.stock||0)}, average ${price(i.vwap)}, shop ${price(i.base)}"><span class="ge-icon">${icon(i.name,32)}</span><div class="ge-main"><div class="ge-name">${E(i.name)}</div><div class="ge-prices"><span>Buy <b>${price(i.ask)}</b></span><span>Sell <b>${price(i.bid)}</b></span><span>Stock <b>${nf(i.stock||0)}</b></span>${owner?`<span>We hold <b>${nf(held.get(i.name)||0)}</b></span>`:''}</div></div></div>`).join('')+(rows.length?'':'<p class="xp-muted">No item matches.</p>')+'</div>';
  }
  // Pull requests plugin: the bot repository's open and lately merged pull requests, by the agent whose branch they are.
  const AGENT_OF=b=>/^claude-cloud\//.test(b)?'Claude cloud':/^cloud\//.test(b)?'Codex cloud':/^claude\//.test(b)?'Claude on the PC':/^codex\//.test(b)?'Codex on the PC':'Other';
  function prsPanel(){
    const rows=S.prs||[];if(!rows.length)return '<div class="xp-panel"><div class="xp-box"><span class="xp-muted">No pull requests are published.</span></div></div>';
    const groups=new Map();for(const r of rows){const k=AGENT_OF(r.branch);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
    const chipFor=r=>r.state==='MERGED'?'<span class="pr-chip merged">merged</span>':r.draft?'<span class="pr-chip draft">draft</span>':'<span class="pr-chip open">open</span>';
    return '<div class="xp-panel">'+[...groups].map(([agent,list])=>`<div class="xp-box"><div class="xp-head"><span>${E(agent)}</span><span class="xp-gain">${list.filter(r=>r.state==='OPEN').length} open</span></div>${list.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,12).map(r=>`<a class="pr-row" href="${E(r.url)}" target="_blank" rel="noopener"><span class="pr-num">#${r.number}</span><span class="pr-title">${E(r.title)}</span>${chipFor(r)}<span class="pr-age">${r.updatedAt?age(Date.parse(r.updatedAt))+' ago':''}</span></a>`).join('')}</div>`).join('')+'</div>';
  }
  function showPlugin(id){if(!window.atlasOperator()&&OPERATOR_PLUGINS.includes(id)){toast('Sign in as owner for the command tools.');id='fleet';}const priorPlugin=selectedPlugin;window.atlasBeforePluginChange?.(priorPlugin,id);selectedPlugin=id;app.classList.remove('client-collapsed');app.classList.add('mobile-plugin');for(const el of [fleet,inspect,boards,allocation,journal])parked.append(el);body.replaceChildren();$('#client-plugin-name').textContent=window.atlasPlugins?.[id]?.label||window.atlasPluginNames?.[id]||plugins.find(p=>p[0]===id)?.[1]||({raw:'Raw evidence'}[id]||'Settings');
    body.dataset.plugin=id;plugin.dataset.plugin=id;if(window.atlasPlugins?.[id]){window.atlasPlugins[id].render(body);}else if(id==='xp')body.innerHTML=xpTracker();else if(id==='ge')body.innerHTML=gePanel();else if(id==='prs')body.innerHTML=prsPanel();else if(id==='fleet')body.append(fleet);else if(id==='boards')hiscores();else if(id==='world')body.innerHTML=worldPanel();else if(id==='activity'){body.append(journal);journal.style.setProperty('display','block','important');journal.style.position='static';journal.style.width='100%';journal.style.height='auto';}else{body.append(inspect);choose(id==='settings'?'machine':id);if(id==='goals'&&window.atlasOperator()){const form=document.createElement('form');form.className='goal-request';form.innerHTML='<input name="text" maxlength="500" placeholder="Tell the agents what you want next..." aria-label="New owner request"><button>Send</button><small>Goes to research/owner-requests.md as the next numbered row.</small>';body.prepend(form);}}
    rail.querySelectorAll('[data-client-plugin]').forEach(b=>b.classList.toggle('on',b.dataset.clientPlugin===id));if(S&&id==='fleet')roster();window.atlasAfterPluginChange?.(priorPlugin,id);
  }
  function openBank(){
    if(!window.atlasOperator()){toast('Sign in as owner to see banks.');return;}
    const b=account();hud.querySelector('.game-bank')?.remove();const modal=document.createElement('section');modal.className='game-bank';modal.setAttribute('aria-label','Bank interface');
    const slots=b?.bank?.length??0;modal.innerHTML='<header><span>The Bank of Gielinor</span><small class="bank-count">'+slots+'</small><button aria-label="Close bank">×</button></header><div class="bank-tabs"><button title="All items">∞</button>'+Array.from({length:8},(_,i)=>'<button title="Bank tab '+(i+1)+'">＋</button>').join('')+'</div><div class="bank-items"></div><footer><span class="bank-group">Rearrange mode: <button data-view-action="Swap" class="on">Swap</button><button data-view-action="Insert">Insert</button></span><span class="bank-group">Withdraw as: <button data-view-action="Withdraw as item" class="on">Item</button><button data-view-action="Withdraw as note">Note</button></span><span class="bank-group">Quantity: '+['1','5','10','X','All'].map((q,i)=>'<button data-view-action="Quantity '+q+'"'+(i===0?' class="on"':'')+'>'+q+'</button>').join('')+'</span><input aria-label="Search bank" placeholder="Search bank…"><span class="bank-age">'+(b?.bankAt?'Observed '+age(b.bankAt)+' ago':'No bank snapshot')+'</span></footer>';
    const draw=()=>{const query=modal.querySelector('input').value.toLowerCase(),items=b?.bank?.filter(i=>i.name.toLowerCase().includes(query));modal.querySelector('.bank-items').innerHTML=items?items.map((it,i)=>'<button class="inventory-cell" title="'+E(it.name)+' × '+it.count+'">'+icon(it.name,32)+(it.count>1?qty(it.count):'')+'</button>').join(''):'<p class="game-muted">No bank inventory has been reported for this account.</p>';};
    modal.querySelector('[aria-label="Close bank"]').onclick=()=>modal.remove();modal.querySelector('input').oninput=draw;modal.querySelector('.bank-tabs').onclick=()=>toast('Only the combined bank inventory is reported.');hud.append(modal);draw();
  }
  // Orbs as RuneLite draws them: a stone ring, a dark well, a liquid fill as high as the value (red HP, cyan Prayer)
  // with a gloss and the skill icon on top, and the number on a plate to the left in RuneLite's red-yellow-green.
  const orbIcons={hp:'skill-hitpoints.png',prayer:'skill-prayer.png'},orbFill={hp:['#e2382c','#b00905'],prayer:['#4a3d78','#27203b']},orbImg={};
  const orbColour=(v,max)=>{if(v==null||!max)return '#ffff00';const f=Math.max(0,Math.min(1,v/max));return `rgb(${Math.round(f<0.5?255:510*(1-f))},${Math.round(f<0.5?510*f:255)},0)`;};
  const hiDpi=(c,w,h)=>{const r=Math.max(1,Math.round(window.devicePixelRatio||1));c.width=w*r;c.height=h*r;c.style.width=w+'px';c.style.height=h+'px';const g=c.getContext('2d');g.scale(r,r);return g;};
  // Size and place as the game's minimap (oldschool.runescape.wiki/images/Minimap.png; ring centre fitted to the ring's
  // edge pixels, outer radius 81): 27 px orbs, HP at (-94.2, -24.5), Prayer at (-95.2, +9), the XP orb at
  // (-117.2, -45.5), the compass dial at (-72.7, -62).
  const ORB=27;
  function drawOrb(c){
    const id=c.dataset.orb,frac=Number(c.dataset.frac)||0,g=hiDpi(c,ORB,ORB),m=ORB/2,R=m-0.5,r=R-3;
    // The game's orb: a dark frame (#5d544a) with a black edge, a dark empty part, and the colour disc as high as the value.
    g.beginPath();g.arc(m,m,R,0,Math.PI*2);g.fillStyle='#5d544a';g.fill();g.lineWidth=1;g.strokeStyle='#000';g.stroke();
    g.beginPath();g.arc(m,m,R-1.5,0,Math.PI*2);g.strokeStyle='#7a6f60';g.stroke();
    g.beginPath();g.arc(m,m,r,0,Math.PI*2);g.fillStyle='#1a1510';g.fill();
    g.save();g.beginPath();g.arc(m,m,r,0,Math.PI*2);g.clip();
    const top=m+r-2*r*frac,disc=g.createRadialGradient(m-3,m-4,1,m,m,r);disc.addColorStop(0,orbFill[id][0]);disc.addColorStop(1,orbFill[id][1]);g.fillStyle=disc;g.fillRect(0,top,ORB,ORB);g.restore();
    g.beginPath();g.arc(m,m,r,0,Math.PI*2);g.strokeStyle='#000';g.stroke();
    // The icon a little brighter with a dark edge, so the heart stands out on the red disc as in the game.
    const draw=img=>{g.save();g.shadowColor='rgba(0,0,0,0.85)';g.shadowOffsetX=1;g.shadowOffsetY=1;g.filter='brightness(1.35)';g.drawImage(img,m-6.5,m-6.5,13,13);g.restore();};
    let img=orbImg[id];if(!img){img=orbImg[id]=new Image();img.src=asset(orbIcons[id]);}
    if(img.complete&&img.naturalWidth)draw(img);else img.addEventListener('load',()=>draw(img),{once:true});
  }
  // The minimap frame: a stone ring round the map and a socket for the compass, drawn once at the screen's scale.
  {
    const c=hud.querySelector('canvas.minimap-frame'),g=hiDpi(c,181,165),cx=98.5,cy=84.5;
    const stone=(x,y,inner,outer)=>{const gr=g.createRadialGradient(x,y,inner,x,y,outer);gr.addColorStop(0,'#1e1a10');gr.addColorStop(0.25,'#322b19');gr.addColorStop(0.8,'#3d3420');gr.addColorStop(1,'#746a5a');g.beginPath();g.arc(x,y,outer,0,Math.PI*2);g.arc(x,y,inner,0,Math.PI*2,true);g.fillStyle=gr;g.fill('evenodd');g.lineWidth=1;g.strokeStyle='#000';g.beginPath();g.arc(x,y,outer,0,Math.PI*2);g.stroke();g.beginPath();g.arc(x,y,inner,0,Math.PI*2);g.stroke();};
    stone(cx,cy,73,80);
    // The compass sits on a light face, as in the game (about #b4a890), large enough that its N and needle both show.
    const face=g.createRadialGradient(23,20,2,25.8,22.5,17);face.addColorStop(0,'#d6ccb3');face.addColorStop(1,'#a39880');g.beginPath();g.arc(25.8,22.5,17,0,Math.PI*2);g.fillStyle=face;g.fill();stone(25.8,22.5,17,21);
  }
  // The minimap: the 2D map art around the observed account at 4 px a tile, every bot a dot, the observed one a
  // white square in the centre. With no account it shows the whole known world.
  // In 3D it turns with the viewer's camera (yaw from the bridge, the viewer's own formula) and centres on the followed
  // account, or on the camera in free camera; the viewer's minimap is hidden (client-viewer.css). In 2D it stays north-up.
  // The bridge sends the camera only when it moves, so the last one holds while the 3D frame is loaded.
  let miniView={cx:0,cz:0,PX:1,angle:0};
  function minimap(){const c=hud.querySelector('.game-minimap canvas');if(!c||!S)return;const g=c.getContext('2d'),W=c.width,H=c.height,m=S.map||{x0:2368,z0:2880,w:560,h:416,scale:2};const b=account(),bp=b?.live||b?.pos;
    const c3=typeof mode!=='undefined'&&mode==='3d'&&window.atlasCam3d&&$('#rsw')?.getAttribute('src')?window.atlasCam3d:null,p=c3&&(!bp||window.atlasFreeCamera)?{x:c3.x,z:c3.z}:bp,angle=c3?(2047-c3.yaw)*Math.PI/1024:0;
    const PX=p?4:Math.min(W/(m.w*m.scale),H/(m.h*m.scale)),cx=p?p.x:m.x0+m.w*m.scale/2,cz=p?p.z:m.z0+m.h*m.scale/2;miniView={cx,cz,PX,angle};
    const compass=hud.querySelector('.minimap-compass');if(compass)compass.style.transform=angle?`rotate(${angle*180/Math.PI}deg)`:'';
    g.clearRect(0,0,W,H);g.save();g.beginPath();g.arc(W/2,H/2,W/2,0,7);g.clip();g.fillStyle='#000';g.fillRect(0,0,W,H);if(angle){g.translate(W/2,H/2);g.rotate(angle);g.translate(-W/2,-H/2);}
    if(typeof MAPI!=='undefined'&&MAPI){const ppt=window.atlasMapPx||1/m.scale,sw=W/PX*ppt,sh=H/PX*ppt,sx=(cx-m.x0+0.5)*ppt-sw/2,sy=(m.z0+m.h*m.scale-cz-0.5)*ppt-sh/2;g.imageSmoothingEnabled=!p||!!window.atlasMapPx;g.drawImage(MAPI,sx,sy,sw,sh,0,0,W,H);}
    if(p&&window.atlasSquare){const half=W/PX/2;for(let mx=Math.floor((cx-half)/64);mx<=Math.floor((cx+half)/64);mx++)for(let mz=Math.floor((cz-half)/64);mz<=Math.floor((cz+half)/64);mz++){const img=window.atlasSquare(mx,mz);if(img)g.drawImage(img,W/2+(mx*64-cx-0.5)*PX,H/2-(mz*64+64-cz-0.5)*PX,64*PX,64*PX);}}
    const fleetNames=new Set(S.bots.map(o=>o.name.toLowerCase())),dot=(x,y,s,col)=>{g.fillStyle='#000';g.fillRect(x-s/2-0.5,y-s/2+0.5,s+1,s+1);g.fillStyle=col;g.fillRect(x-s/2,y-s/2,s,s);};for(const [n,qx,qz] of S.roster||[]){if(fleetNames.has(String(n).toLowerCase()))continue;const x=W/2+(qx-cx)*PX,y=H/2-(qz-cz)*PX;if(x<-4||y<-4||x>W+4||y>H+4)continue;dot(x,y,2,'#fff');}
    for(const o of S.bots){const q=o.live||o.pos;if(!q||q.z>6400||o===b)continue;const x=W/2+(q.x-cx)*PX,y=H/2-(q.z-cz)*PX;if(x<0||y<0||x>W||y>H)continue;const[cl]=st(o);dot(x,y,3,cl==='on'?'#2bff2b':'#3d8a33');}
    if(p){g.fillStyle='#000';g.fillRect(W/2-2.5,H/2-2.5,5,5);g.fillStyle='#fff';g.fillRect(W/2-2,H/2-2,4,4);}g.restore();}
  // A click on the minimap in 2D moves the camera to that tile (free camera); in 3D the view itself moves the camera.
  hud.querySelector('.game-minimap canvas')?.addEventListener('click',e=>{if(typeof mode!=='undefined'&&mode==='3d'){toast('In 3D, drag the view to move the camera.');return;}const r=e.currentTarget.getBoundingClientRect(),W=e.currentTarget.width,H=e.currentTarget.height,mx=(e.clientX-r.left)*W/r.width-W/2,my=(e.clientY-r.top)*H/r.height-H/2;window.atlasCamera.goto(Math.round(miniView.cx+mx/miniView.PX),Math.round(miniView.cz-my/miniView.PX));});
  // XP drops (OSRS): each skill gain since the last observation floats up under the XP orb with its icon.
  let dropsFor=null,dropsXp={};
  function xpDrops(b){
    if(!b||b.name!==dropsFor){dropsFor=b?.name??null;dropsXp=Object.fromEntries((b?.skills||[]).map(k=>[k.name,k.xp]));return;}
    const box=hud.querySelector('.xp-drops');let n=0;
    for(const k of b.skills||[]){const before=dropsXp[k.name];dropsXp[k.name]=k.xp;if(before==null||k.xp<=before||k.name==='Overall')continue;
      xpGlobe(k.name,k.xp);const el=document.createElement('div');el.className='xp-drop';el.style.animationDelay=(n++*260)+'ms';el.innerHTML=`<img src="${asset('skill-'+skillFile(k.name)+'.png')}" alt="">+${nf(k.xp-before)}`;box.append(el);setTimeout(()=>el.remove(),3200+n*260);}
  }
  // The overlay panel (RuneLite): the watched account's goal, phase and pace, or the fleet in free camera.
  function overlay(){
    const b=account(),el=hud.querySelector('.game-overlay');
    const line=(k,v)=>`<div><span>${E(k)}</span><b>${E(v)}</b></div>`;
    if(!b){const fleet=S.bots.filter(x=>!x.practice&&!x.reserved),live=fleet.filter(x=>x.fresh),stuck=fleet.filter(x=>['blocked','failed','died','active-stale'].includes(x.operation)),c=S.coordination?.counts;el.innerHTML='<h4>Fleet</h4>'+line('Playing',live.length+' / '+fleet.length)+line('Stopped',String(stuck.length))+(c?line('AI jobs',(c.running??0)+' working · '+(c.pending??0)+' queued'):'')+(window.atlasOperator()&&S.vault?.coins?line('Vault coins',gp(S.vault.coins)):'')+(S.worldPlayers?line('Online',nf(S.worldPlayers)):'');return;}
    const [,state]=st(b);
    el.innerHTML='<h4>'+E(safeName(b.name))+'</h4>'+line('Status',state)+line('Goal',(b.goalSkill?b.goalSkill+' '+b.goalLevel:'')||String(b.goal||'').slice(0,60))+(b.phaseShort?line('Phase',String(b.phaseShort).slice(0,60)):'')+(b.xpPerHour?line('XP/hr',nf(Math.round(b.xpPerHour))):'')+(b.eta?line('To target',b.eta):'')+(b.uptime?line('Session',dur(b.uptime)):'');
  }
  // Skills tab tooltip (OSRS): XP, next level at, remaining.
  hud.addEventListener('mouseover',e=>{const sk=e.target.closest('[data-skill]');const tip=hud.querySelector('.game-tip');if(!sk){tip.hidden=true;return;}const s=level(sk.dataset.skill),X=window.atlasXp;if(!s||!X){tip.hidden=true;return;}const lvl=Math.min(99,s.level),next=X.xpForLevel(Math.min(99,lvl+1));
    if(s.xp==null){tip.innerHTML=`<div>${E(sk.dataset.skill)} level <b>${s.level}</b></div><div>XP is not reported for this side.</div>`;}else tip.innerHTML=`<div>${E(sk.dataset.skill)} XP: <b>${nf(s.xp)}</b></div>`+(lvl<99?`<div>Next level at: <b>${nf(next)}</b></div><div>Remaining XP: <b>${nf(Math.max(0,next-s.xp))}</b></div>`:'');
    const r=sk.getBoundingClientRect(),h=hud.getBoundingClientRect();tip.style.left=Math.max(0,r.left-h.left-tip.offsetWidth-4)+'px';tip.style.top=(r.top-h.top)+'px';tip.hidden=false;});
  hud.addEventListener('mouseout',e=>{if(e.target.closest('[data-skill]')&&!e.relatedTarget?.closest?.('[data-skill]'))hud.querySelector('.game-tip').hidden=true;});
  let welcomed=false;
  function chatFeed(){
    if(!welcomed){welcomed=true;chat.push({kind:'Game',text:'Welcome to RuneScape.',at:Date.now()});if(!window.atlasOperator())chat.push({kind:'Game',text:'You are watching the Swarm fleet. Sign in as owner (title bar) to command it; ::help lists the chat commands.',at:Date.now()});}
    const rows=[...(S.events||[]).filter(e=>!e.practice).map(e=>({at:e.at,name:e.name,text:e.full||e.text,kind:'Game'})),...(S.results||[]).filter(r=>!r.practice).map(r=>({at:r.at,name:r.name,text:(r.ok?'finished: ':'stopped: ')+String(r.text).slice(0,120),kind:r.ok?'Game':'Private'}))]
      .sort((a,b)=>a.at-b.at).slice(-60);
    let added=0;
    for(const r of rows){const key=r.kind+'|'+r.at+'|'+r.name+'|'+r.text;if(seen.has(key))continue;seen.add(key);if(seen.size>800)seen.delete(seen.values().next().value);chat.push({kind:r.kind,name:safeName(r.name),text:r.text,at:r.at});added++;}
    while(chat.length>200)chat.shift();
    if(added)renderChat();
  }
  // Desktop notifications (RuneLite's notifier): level-ups, deaths and idling, when the owner switched them on.
  const NOTIFY_KEY='atlas-notify';
  const notifyOn=()=>{try{return localStorage.getItem(NOTIFY_KEY)==='1';}catch{return false;}};
  function setNotify(on){try{localStorage.setItem(NOTIFY_KEY,on?'1':'0');}catch{/* private window */}if(on&&'Notification' in window&&Notification.permission==='default')Notification.requestPermission();}
  function desktopNotify(text){if(!notifyOn()||!('Notification' in window)||Notification.permission!=='granted'||document.hasFocus())return;try{new Notification('RuneLite \u2014 Swarm',{body:text,icon:asset('runelite.png'),tag:text.slice(0,40)});}catch{/* blocked */}}
  window.atlasNotify={on:notifyOn,set:setNotify};
  let idleFor=null,idleRun=0,idleTold=false;
  function idleNotifier(b){
    if(!b||b.name!==idleFor){idleFor=b?.name??null;idleRun=0;idleTold=false;return;}
    if(b.fresh&&b.action==='idle'){idleRun++;if(idleRun>=3&&!idleTold){idleTold=true;notify(safeName(b.name)+' is now idle!');desktopNotify(safeName(b.name)+' is now idle!');}}else{idleRun=0;idleTold=false;}
  }
  // Level-ups for every live account, in the game's words, as the chat shows them.
  const levelsSeen=new Map(),xpSeen=new Map(),lastGain=new Map();
  // The skill an account trains now: its latest XP gain, else its goal skill, else a role named after a skill.
  const trainedSkill=b=>lastGain.get(b.name)||b.goalSkill||skills.find(n=>n.toLowerCase()===String(b.role||'').toLowerCase())||null;
  // Deaths in the game's words; the deaths already on record when the page opens are not announced again.
  const deathsSeen=new Set();let deathsPrimed=false;
  function deaths(){for(const b of S.bots){if(b.practice||!b.death)continue;const key=b.name+'|'+b.death.at;if(deathsSeen.has(key))continue;deathsSeen.add(key);if(deathsPrimed){chat.push({kind:'Private',name:safeName(b.name),text:'Oh dear, you are dead!',at:b.death.at});renderChat();desktopNotify(safeName(b.name)+': Oh dear, you are dead!');}}deathsPrimed=true;}
  function levelUps(){
    for(const b of S.bots){if(b.practice||!Array.isArray(b.skills))continue;const prev=levelsSeen.get(b.name);const now={};for(const k of b.skills)now[k.name]=k.level;
      const xpBefore=xpSeen.get(b.name),xpNow={};let best=0;for(const k of b.skills.filter(realSkill)){xpNow[k.name]=k.xp;const d=xpBefore?.[k.name]!=null?k.xp-xpBefore[k.name]:0;if(d>best){best=d;lastGain.set(b.name,k.name);}}xpSeen.set(b.name,xpNow);
      if(prev)for(const [skill,lvl] of Object.entries(now))if(prev[skill]!=null&&lvl>prev[skill]&&skill!=='Overall'){chat.push({kind:'Game',name:safeName(b.name),text:`Congratulations, you've just advanced ${/^[AEIOU]/.test(skill)?'an':'a'} ${skill} level. Your ${skill} level is now ${lvl}.`,at:Date.now()});if(chat.length>200)chat.shift();renderChat();desktopNotify(safeName(b.name)+' advanced a '+skill+' level: '+lvl);}
      levelsSeen.set(b.name,now);}
  }
  // XP globes (RuneLite): a ring of progress to the next level for each skill gained in the last ten seconds.
  const globeTimers=new Map();
  function xpGlobe(skill,xp){
    const X=window.atlasXp,box=hud.querySelector('.xp-globes');if(!X||!box)return;const lvl=X.levelForXp(xp),floor=X.xpForLevel(lvl),ceil=X.xpForLevel(Math.min(99,lvl+1)),p=lvl>=99?1:Math.min(1,(xp-floor)/Math.max(1,ceil-floor));
    let el=box.querySelector(`[data-globe="${skill}"]`);if(!el){el=document.createElement('div');el.className='xp-globe';el.dataset.globe=skill;el.innerHTML=`<img src="${asset('skill-'+skillFile(skill)+'.png')}" alt="">`;box.append(el);}
    el.style.setProperty('--p',Math.round(p*100)+'%');el.title=`${skill}: ${Math.round(p*100)}% to level ${Math.min(99,lvl+1)} (${nf(Math.max(0,ceil-xp))} xp left)`;
    clearTimeout(globeTimers.get(skill));globeTimers.set(skill,setTimeout(()=>{el.remove();globeTimers.delete(skill);},10000));
  }
  function screens(){const loading=hud.querySelector('#game-loading'),lost=hud.querySelector('#game-lost');if(loading&&S)loading.hidden=true;if(lost)lost.hidden=!(S&&(typeof connected!=='undefined'&&!connected||typeof lastReceived!=='undefined'&&Date.now()-lastReceived>10000));}
  setInterval(screens,2000);
  // Map squares (map-squares/<mx>_<mz>.png, 4 px a tile): loaded as the view needs them, drawn when ready.
  const squares=new Map();let squaresMissing=false;
  window.atlasSquare=(mx,mz)=>{
    if(squaresMissing)return null;const key=mx+'_'+mz;let img=squares.get(key);
    if(!img){img=new Image();img.onload=()=>{if(typeof drawMap==='function')drawMap();minimap();};img.onerror=()=>{if(!squares.size||[...squares.values()].every(i=>!i.complete||!i.naturalWidth))squaresMissing=true;};img.src='/map-squares/'+key+'.png';squares.set(key,img);}
    return img.complete&&img.naturalWidth?img:null;
  };
  // The 2D camera, the game's view: it follows the watched account at FOLLOW_PX a tile and flies to a new target;
  // the wheel zooms about the cursor and a drag pans, which lets go of the account (free camera).
  const FOLLOW_PX=5,MIN_PX=0.3,MAX_PX=10;
  const cam={cx:null,cz:null,ppt:null,tx:null,tz:null,tppt:null,user:false,userPpt:null,raf:0};
  function mapInfo(){return S?.map||{x0:2368,z0:2880,w:560,h:416,scale:2};}
  function camTarget(){
    const m=mapInfo(),b=account(),p=b&&(b.live||b.pos);
    if(p&&!window.atlasFreeCamera){cam.tx=p.x;cam.tz=p.z;cam.tppt=cam.userPpt||FOLLOW_PX;return;}
    const d=window.atlasDestination;if(d&&Number.isFinite(d.x)){cam.tx=d.x;cam.tz=d.z;cam.tppt=cam.userPpt||FOLLOW_PX;return;}
    if(cam.user&&cam.cx!=null){cam.tx=cam.cx;cam.tz=cam.cz;cam.tppt=cam.ppt;return;}
    cam.tx=m.x0+m.w*m.scale/2;cam.tz=m.z0+m.h*m.scale/2;cam.tppt=window.atlasFitPpt||1;
  }
  function camStep(){
    cam.raf=0;if(cam.tx==null)return;
    if(cam.cx==null){cam.cx=cam.tx;cam.cz=cam.tz;cam.ppt=cam.tppt;}
    else{const k=0.14;cam.cx+=(cam.tx-cam.cx)*k;cam.cz+=(cam.tz-cam.cz)*k;cam.ppt+=(cam.tppt-cam.ppt)*k;}
    const done=Math.abs(cam.tx-cam.cx)<0.05&&Math.abs(cam.tz-cam.cz)<0.05&&Math.abs(cam.tppt-cam.ppt)<0.002;
    if(done){cam.cx=cam.tx;cam.cz=cam.tz;cam.ppt=cam.tppt;}
    window.atlasCam={cx:cam.cx,cz:cam.cz,ppt:cam.ppt};
    if(typeof drawMap==='function')drawMap();
    if(!done)cam.raf=requestAnimationFrame(camStep);
  }
  function camUpdate(){camTarget();if(!cam.raf)cam.raf=requestAnimationFrame(camStep);}
  window.atlasCamera={goto(x,z){window.atlasFreeCamera=true;window.atlasDestination={x,z};cam.user=false;camUpdate();},follow(){window.atlasFreeCamera=false;cam.user=false;window.atlasDestination=null;camUpdate();},reset(){window.atlasFreeCamera=true;cam.user=false;cam.userPpt=null;window.atlasDestination=null;camUpdate();},state:()=>({...cam})};
  {
    const map=document.getElementById('map');
    if(map){
      map.addEventListener('wheel',e=>{e.preventDefault();if(cam.ppt==null)return;const r=map.getBoundingClientRect(),m=mapInfo();
        const before=cam.ppt,after=Math.min(MAX_PX,Math.max(MIN_PX,before*Math.pow(1.0015,-e.deltaY)));
        // Keep the tile under the cursor where it is.
        const mx=e.clientX-r.left-r.width/2,mz=e.clientY-r.top-r.height/2;
        cam.cx+=mx/before-mx/after;cam.cz-=mz/before-mz/after;cam.ppt=after;cam.userPpt=after;cam.user=true;
        if(window.atlasFreeCamera||!account()){cam.tx=cam.cx;cam.tz=cam.cz;}cam.tppt=after;window.atlasCam={cx:cam.cx,cz:cam.cz,ppt:cam.ppt};drawMap();},{passive:false});
      let drag=null,dragged=false;
      map.addEventListener('pointerdown',e=>{if(e.button!==0)return;drag={x:e.clientX,z:e.clientY,cx:cam.cx,cz:cam.cz};dragged=false;map.setPointerCapture(e.pointerId);});
      map.addEventListener('pointermove',e=>{if(!drag||cam.ppt==null)return;const dx=e.clientX-drag.x,dz=e.clientY-drag.z;if(!dragged&&Math.hypot(dx,dz)<4)return;dragged=true;window.atlasFreeCamera=true;window.atlasDestination=null;cam.user=true;cam.cx=drag.cx-dx/cam.ppt;cam.cz=drag.cz+dz/cam.ppt;cam.tx=cam.cx;cam.tz=cam.cz;cam.tppt=cam.ppt;window.atlasCam={cx:cam.cx,cz:cam.cz,ppt:cam.ppt};drawMap();});
      map.addEventListener('pointerup',()=>{drag=null;if(dragged)refresh();});
      map.addEventListener('click',e=>{if(dragged){dragged=false;e.stopImmediatePropagation();}},true);
      map.addEventListener('dblclick',()=>{if(account()){window.atlasCamera.follow();}});
    }
  }
  function refresh(){if(!S)return;camUpdate();screens();minimap();xpDrops(account());overlay();chatFeed();idleNotifier(account());levelUps();deaths();if(selectedPlugin==='xp'&&body.dataset.plugin==='xp'){const top=body.scrollTop;body.innerHTML=xpTracker();body.scrollTop=top;}if(selectedPlugin==='boards'&&body.dataset.plugin==='boards'){const head=body.querySelector('.progress-head');if(head)head.innerHTML=progressPanel();const rw=body.querySelector('.rivals-wrap');if(rw&&!rw.contains(document.activeElement))rw.innerHTML=rivalsPanel();}if(selectedPlugin==='world'&&body.dataset.plugin==='world'&&!body.contains(document.activeElement)){const top=body.scrollTop;body.innerHTML=worldPanel();body.scrollTop=top;}infoboxes();title.querySelector('.connection').textContent=$('#connection').textContent;const b=account(),options=JSON.stringify(S.bots.filter(b=>!b.practice).map(b=>[b.name,b.inWorld]));if(options!==lastAccountOptions){lastAccountOptions=options;$('#client-account').innerHTML='<option value="">Free camera</option>'+S.bots.filter(b=>!b.practice).map(b=>`<option value="${E(b.name)}">${b.inWorld?'● ':'○ '}${E(safeName(b.name))}</option>`).join('');}$('#client-account').value=sel||'';$('#chat-name').textContent=(b?safeName(b.name):'Spectator')+':';
    const orbBox=hud.querySelector('.game-orbs');orbBox.innerHTML=[['hp','Hitpoints',b?.hp?.now,b?.hp?.max],['prayer','Prayer',level('Prayer')?.currentLevel,level('Prayer')?.level]].map(([id,label,value,max])=>`<div class="game-orb orb-${id}" title="${label}: ${value??'not reported'}${max?' / '+max:''}"><span class="orb-num" style="color:${orbColour(value,max)}">${value??'—'}</span><canvas class="orb-art" data-orb="${id}" data-frac="${value!=null&&max?Math.max(0,Math.min(1,value/max)):0}"></canvas></div>`).join('');orbBox.querySelectorAll('canvas').forEach(drawOrb);gamePanel();}
  const previousRender=render;render=function(){previousRender();refresh();};
  const previousDrawMap=drawMap;drawMap=function(){previousDrawMap();minimap();};
  const previousPick=pick;pick=function(name){previousPick(name);cam.user=false;refresh();};
  rail.onclick=e=>{const b=e.target.closest('[data-client-plugin]');if(b){if(b.dataset.clientPlugin==='settings'){selectedTab='settings';hud.classList.remove('game-panel-hidden');gamePanel();}else showPlugin(b.dataset.clientPlugin);}};
  const togglePlugin=()=>{app.classList.toggle('client-collapsed');app.classList.toggle('mobile-plugin',!app.classList.contains('client-collapsed'));};$('#client-sidebar').onclick=togglePlugin;plugin.querySelector('[aria-label="Close plugin"]').onclick=togglePlugin;
  $('#client-more').onchange=e=>{if(e.target.value)showPlugin(e.target.value);e.target.value='';};
  $('#client-account').onchange=e=>{if(e.target.value)pick(e.target.value);else{sel=null;window.atlasFreeCamera=true;refresh();}};
  function toast(text){hud.querySelector('.game-toast')?.remove();const el=document.createElement('div');el.className='game-toast';el.textContent=text;hud.append(el);setTimeout(()=>el.remove(),5000);}
  hud.onclick=e=>{const t=e.target.closest('[data-game-tab]');if(t){if(t.dataset.gameTab===selectedTab)hud.classList.toggle('game-panel-hidden');else{selectedTab=t.dataset.gameTab;hud.classList.remove('game-panel-hidden');gamePanel();}}const c=e.target.closest('[data-chat]');if(c){channel=c.dataset.chat;hud.querySelectorAll('[data-chat]').forEach(b=>b.classList.toggle('active',b===c));renderChat();}if(e.target.closest('.chat-toggle,[data-toggle-chat]'))hud.classList.toggle('chat-hidden');const to3d=msg=>$('#rsw')?.contentWindow?.postMessage(msg,location.origin);if(e.target.closest('.minimap-compass')){if(typeof mode!=='undefined'&&mode==='3d')to3d({atlasCompass:true});else toast('The 2D map always faces north.');}if(e.target.closest('[data-viewer-worldmap]')){to3d({atlasOpenWorldMap:true});placesBox.hidden=true;}else if(e.target.closest('[data-places]')){placesBox.hidden=!placesBox.hidden;placesBox.querySelector('[data-viewer-worldmap]').hidden=!(typeof mode!=='undefined'&&mode==='3d');}else if(!e.target.closest('.game-places'))placesBox.hidden=true;const p=e.target.closest('[data-open-plugin]');if(p)showPlugin(p.dataset.openPlugin);if(e.target.closest('.game-logout')){selectedTab='logout';hud.classList.remove('game-panel-hidden');gamePanel();}if(e.target.closest('[data-logout]')){if(window.FleetShim?.signedIn?.())window.FleetShim.signOut();else toast('Nothing to log out of: this is the spectator view.');}if(e.target.closest('.game-xp'))showPlugin('xp');const a=e.target.closest('[data-view-action]');if(a)toast(a.dataset.viewAction+' · spectator view; no game input sent');const q=e.target.closest('[data-quest]');if(q){questDetail=q.dataset.quest;gamePanel();}const fr=e.target.closest('[data-friend]');if(fr){pick(fr.dataset.friend);}if(e.target.closest('[data-quest-back]')){questDetail=null;gamePanel();}const sk=e.target.closest('[data-skill]');if(sk){const st=level(sk.dataset.skill);toast(sk.dataset.skill+(st?' · Level '+st.level+(st.xp!=null?' · '+st.xp.toLocaleString()+' XP':''):' · not reported by this game'));}};
  body.addEventListener('submit',e=>{if(e.target.id==='wp-form'){e.preventDefault();lookup(e.target.querySelector('#wp-name').value);return;}const f=e.target.closest('.goal-request');if(!f)return;e.preventDefault();const text=f.text.value.trim();if(!text)return;if(!window.atlasCommand){notify('The command desk is not loaded.');return;}f.querySelector('button').disabled=true;window.atlasCommand('request',{text}).then(r=>{notify('request: '+String(r?.status||'sent').replaceAll('-',' '));f.text.value='';},err=>notify('Refused: '+(err?.message||err))).finally(()=>{f.querySelector('button').disabled=false;});});
  body.addEventListener('change',e=>{if(e.target.id==='rival-board'){rivalBoard=e.target.value;const w=body.querySelector('.rivals-wrap');if(w)w.innerHTML=rivalsPanel();return;}if(e.target.dataset.notify!==undefined){setNotify(e.target.checked);toast(e.target.checked?('Notification' in window?(Notification.permission==='denied'?'Notifications are blocked for this site in the browser.':'Desktop notifications on: level-ups, deaths and idling.'):'This browser has no notifications.'):'Desktop notifications off.');}});
  body.addEventListener('input',e=>{if(e.target.id==='ge-search'){geQuery=e.target.value.trim().toLowerCase();const pos=e.target.selectionStart;body.innerHTML=gePanel();const again=body.querySelector('#ge-search');if(again){again.focus();again.setSelectionRange(pos,pos);}}if(e.target.id==='hs-name'){hiscoreName=e.target.value.trim();const b=S.bots.find(x=>x.name.toLowerCase()===hiscoreName.toLowerCase());if(b||!hiscoreName){hiscoreName=b?b.name:'';const el=body.querySelector('.hs-wrap');if(el){const input=e.target,pos=input.selectionStart;el.innerHTML=hiscorePanel();const again=body.querySelector('#hs-name');if(again){again.focus();again.setSelectionRange(pos,pos);}}}}});
  hud.addEventListener('click',e=>{const f=e.target.closest('.infobox[data-xp-focus]');if(f){pick(f.dataset.xpFocus);}});
  body.addEventListener('click',e=>{const lk=e.target.closest('[data-lookup]');if(lk){lookup(lk.dataset.lookup);return;}const go=e.target.closest('[data-world-go]');if(go){const [x,z]=go.dataset.worldGo.split(',').map(Number);window.atlasCamera.goto(x,z);return;}if(e.target.closest('[data-ge-all]')){geAll=!geAll;body.innerHTML=gePanel();return;}const hm=e.target.closest('[data-hs-mode]');if(hm){hiscoresMode=hm.dataset.hsMode;hiscores();return;}if(e.target.closest('[data-xp-reset]')){const store=xpStore();delete store[sel];saveXpStore(store);body.innerHTML=xpTracker();}const f=e.target.closest('[data-xp-focus]');if(f){pick(f.dataset.xpFocus);showPlugin('xp');}});
  hud.onchange=e=>{if(e.target.id==='game-display'){app.classList.toggle('client-collapsed',e.target.value==='closed');}if(e.target.id==='game-quality'){$('#atlas-quality').value=e.target.value;$('#atlas-quality').onchange();}};
  hud.addEventListener('contextmenu',e=>{const cell=e.target.closest('[data-item],[data-equipment]');if(!cell)return;e.preventDefault();const b=account(),it=cell.dataset.item!==undefined?b?.inventory?.[Number(cell.dataset.item)]:b?.equipment?.find(i=>i.slot===Number(cell.dataset.equipment));if(!it)return;context?.remove();context=document.createElement('div');context.className='game-context';context.style.left=Math.min(e.clientX,innerWidth-220)+'px';context.style.top=Math.min(e.clientY,innerHeight-110)+'px';const worn=cell.dataset.equipment!==undefined,n=String(it.name),verb=worn?'Remove':/\b(sword|axe|bow|dagger|mace|staff|scimitar|pickaxe|harpoon|rod|net|hammer|chisel|knife|spear|halberd|whip|wand|crossbow|blade|club|warhammer)\b/i.test(n)?'Wield':/\b(helm|hat|cape|amulet|body|chainbody|platebody|platelegs|plateskirt|legs|boots|gloves|shield|ring|coif|robe|hood|vambraces|chaps|mask|kiteshield|sq shield|necklace)\b/i.test(n)?'Wear':/\b(potion|brew|beer|wine|tea|milk|juice|water)\b/i.test(n)?'Drink':/\b(bread|cake|pie|stew|fish|shark|lobster|trout|salmon|tuna|swordfish|shrimps|anchovies|sardine|herring|pike|cod|bass|meat|chicken|kebab|pizza|cheese|apple|banana|bananas|peach|onion|tomato|cabbage|potato|egg|monkfish)\b/i.test(n)?'Eat':null;
    const options=worn?[['Remove',null]]:[['Use',null],...(verb?[[verb,null]]:[]),['Drop',null]];
    context.innerHTML='<strong>Choose Option</strong>'+options.map(([o])=>'<button data-view-action="'+E(o)+'">'+E(o)+' <span>'+E(n)+'</span></button>').join('')+'<button data-examine>Examine <span>'+E(n)+'</span></button><button data-cancel>Cancel</button>';context.onclick=e=>{if(e.target.closest('[data-examine]'))notify(n+' · Item '+it.id+' · Quantity '+it.count+' · observed '+age(b.at)+' ago');else{const v=e.target.closest('[data-view-action]');if(v)toast(v.dataset.viewAction+' · spectator view; no game input sent');}context.remove();};document.body.append(context);});
  document.addEventListener('click',e=>{if(context&&!context.contains(e.target))context.remove();});
  const map=document.getElementById('map');
  if(map)map.addEventListener('contextmenu',e=>{
    const r=map.getBoundingClientRect();let best=null,bd=400;for(const [x,z,n] of map._p||[]){const d=(x-(e.clientX-r.left))**2+(z-(e.clientY-r.top))**2;if(d<bd){bd=d;best=n;}}
    if(!best){let other=null,od=200;for(const [x,z,n] of map._q||[]){const d=(x-(e.clientX-r.left))**2+(z-(e.clientY-r.top))**2;if(d<od){od=d;other=n;}}if(!other)return;e.preventDefault();context?.remove();context=document.createElement('div');context.className='game-context';context.style.left=Math.min(e.clientX,innerWidth-220)+'px';context.style.top=Math.min(e.clientY,innerHeight-80)+'px';context.innerHTML='<strong>Choose Option</strong><button data-act="lookup">Look up <span>'+E(other)+'</span></button><button data-act="cancel">Cancel</button>';context.onclick=ev=>{const act=ev.target.closest('[data-act]')?.dataset.act;context.remove();if(act==='lookup')lookup(other);};document.body.append(context);return;}
    e.preventDefault();const b=S.bots.find(x=>x.name===best);if(!b)return;context?.remove();
    const held=!!b.hold||b.operation==='paused';
    context=document.createElement('div');context.className='game-context';context.style.left=Math.min(e.clientX,innerWidth-220)+'px';context.style.top=Math.min(e.clientY,innerHeight-150)+'px';
    context.innerHTML='<strong>Choose Option</strong><button data-act="follow">Follow <span>'+E(safeName(best))+'</span></button><button data-act="account">Account <span>'+E(safeName(best))+'</span></button><button data-act="lookup">Look up <span>'+E(safeName(best))+'</span></button><button data-act="xp">XP Tracker <span>'+E(safeName(best))+'</span></button>'+(b.reserved||b.remote||!window.atlasOperator()?'':'<button data-act="'+(held?'account-release':'account-pause')+'">'+(held?'Resume':'Pause')+' <span>'+E(safeName(best))+'</span></button>')+'<button data-act="examine">Examine <span>'+E(safeName(best))+'</span></button><button data-act="cancel">Cancel</button>';
    context.onclick=ev=>{const act=ev.target.closest('[data-act]')?.dataset.act;context.remove();if(!act||act==='cancel')return;
      if(act==='follow')pick(best);else if(act==='account'){pick(best);showPlugin('account');}else if(act==='xp'){pick(best);showPlugin('xp');}else if(act==='lookup')lookup(best);
      else if(act==='examine')notify(safeName(best)+' · '+(b.goal||b.role||'')+(b.phaseShort?' · '+b.phaseShort:'')+' · seen '+age(b.at)+' ago');
      else if(window.atlasCommand){notify('Sending '+act+' '+best+'…');window.atlasCommand(act,{account:best}).then(r=>notify(act+': '+String(r?.status||'sent').replaceAll('-',' ')),err=>notify('Refused: '+(err?.message||err)));}
      else notify('The command desk is not loaded.');};
    document.body.append(context);
  });
  hud.querySelector('form').onsubmit=e=>{e.preventDefault();const input=hud.querySelector('input'),text=input.value.trim();input.value='';if(!text)return;if(text.startsWith('::plugin ')){const id=text.slice(9).trim();if(plugins.some(p=>p[0]===id))showPlugin(id);else notify('Unknown plugin. Use '+plugins.map(p=>p[0]).join(', ')+'.');}else if(text.startsWith('::focus ')){const name=text.slice(8).trim(),b=S?.bots.find(b=>b.name.toLowerCase()===name.toLowerCase());if(b)pick(b.name);else notify('No observed account matches that name.');}else if(/^::(request|pause|resume|help|swarm|job|coordinator)\b/.test(text)){
      const [,verb,rest='']=text.match(/^::(\w+)\s*(.*)$/)||[];
      if(verb==='help'){notify(window.atlasOperator()?'Commands: ::request <text> · ::pause <account> · ::resume <account> · ::job <account> on|off · ::swarm pause|resume · ::coordinator pause|resume · ::plugin <id> · ::focus <account>':'Commands: ::plugin <id> · ::focus <account>. Sign in as owner for ::request, ::pause, ::resume, ::job, ::swarm and ::coordinator.');return;}
      if(!window.atlasOperator()){notify('Sign in as owner to send commands.');return;}
      if(!window.atlasCommand){notify('The command desk is not loaded.');return;}
      let send=null;
      if(verb==='request')send=rest?{action:'request',extra:{text:rest.slice(0,500)}}:null;
      else if(verb==='swarm')send=/^(pause|resume)$/.test(rest)?{action:'swarm-'+rest,extra:{}}:null;
      else if(verb==='coordinator')send=/^(pause|resume)$/.test(rest)?{action:rest,extra:{}}:null;
      else if(verb==='job'){const m=rest.match(/^([A-Za-z0-9]{1,12})\s+(on|off)$/);send=m?{action:m[2]==='on'?'job-enable':'job-disable',extra:{account:m[1]}}:null;}
      else send=rest&&/^[A-Za-z0-9]{1,12}$/.test(rest)?{action:verb==='pause'?'account-pause':'account-release',extra:{account:rest}}:null;
      if(!send){notify(verb==='request'?'::request needs the request text.':verb==='swarm'||verb==='coordinator'?'::'+verb+' pause or ::'+verb+' resume.':verb==='job'?'::job <account> on or off.':'::'+verb+' needs an account name.');return;}
      notify('Sending '+send.action+(send.extra.account?' '+send.extra.account:'')+'…');
      window.atlasCommand(send.action,send.extra).then(r=>notify(send.action+': '+String(r?.status||'sent').replaceAll('-',' ')),e=>notify('Refused: '+(e?.message||e)));
    }else notify('Chat is view-only in spectator mode. Commands: ::request · ::pause · ::resume · ::plugin · ::focus · ::help');};
  window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==$('#rsw').contentWindow)return;const c3=e.data?.atlasCamera3d;if(c3&&[c3.x,c3.z,c3.yaw].every(Number.isFinite)){window.atlasCam3d={x:c3.x,z:c3.z,yaw:c3.yaw,at:Date.now()};minimap();}const m=e.data?.atlasChat;if(typeof e.data?.atlasWorldMap==='boolean')hud.classList.toggle('worldmap-open',e.data.atlasWorldMap);if(!m||typeof m.text!=='string'||typeof m.name!=='string'||typeof m.key!=='string'||seen.has(m.key))return;seen.add(m.key);if(seen.size>500)seen.delete(seen.values().next().value);chat.push({kind:'Public',name:m.name.slice(0,32),text:m.text.slice(0,500),at:Date.now()});if(chat.length>200)chat.shift();renderChat();});
  window.addEventListener('keydown',e=>{
    if(e.key==='Tab'&&e.target===document.body)e.stopPropagation();
    if(e.key==='Escape'){context?.remove();hud.querySelector('.game-bank')?.remove();hud.querySelector('.game-toast')?.remove();}
    const F_KEYS={F2:'skills',F3:'quests',F4:'inventory',F5:'equipment',F8:'friends',F10:'settings'};
    if(F_KEYS[e.key]&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&!/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)){e.preventDefault();e.stopPropagation();selectedTab=F_KEYS[e.key];hud.classList.remove('game-panel-hidden');gamePanel();}
    if(e.key==='/'&&!/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)){e.preventDefault();e.stopPropagation();showPlugin('fleet');$('#search').focus();}
  },true);
  window.atlasClient={openPlugin:showPlugin,openBank,selectedPlugin:()=>selectedPlugin,gameTab:id=>{selectedTab=id;hud.classList.remove('game-panel-hidden');gamePanel();}};
  app.classList.remove('focus-map','right-hidden','left-hidden');showPlugin('fleet');renderChat();if(S)refresh();
})();
