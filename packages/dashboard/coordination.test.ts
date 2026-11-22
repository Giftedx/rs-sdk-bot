import {test,expect} from 'bun:test';
import {coordinationView} from './coordination';
import {readFileSync} from 'node:fs';
test('fleet state projection separates active chains and defects without leaking prompts or credentials',()=>{
 const state={
  schemaVersion:1,
  emittedAt:99,
  side:'local',
  server:'localhost:8888',
  maxBots:4,
  accounts:{
   Worker:{name:'Worker',side:'local',role:'helper',protectedClock:false,lifecycle:'active',skills:{},quests:{},pos:null,inventory:{},equipment:{},bank:{coins:0,items:{},observedAt:null},activeJob:{activityId:'quest_cooks_assistant',demandId:'g1',startedAt:90},password:'NEVER_EXPOSE'},
  },
  activeChains:{
   Worker:{account:'Worker',demandId:'g1',scorePerHour:120,steps:[{stepKind:'work',activityId:'quest_cooks_assistant',demandId:'g1',workerId:'quester',batchUnits:1,estimatedTicks:50,expectedValuePerHour:120,config:{}}]},
  },
  idleReasons:{Idle:'no demand'},
  goals:[{id:'g1',goalKind:'quest_board',valueScore:100,target:{kind:'quest',questSlug:'cooks_assistant'},fulfilled:0,remaining:1,priorityWeight:1,active:true}],
  campaigns:[],
  missions:[],
  pendingTransfers:[],
  quarantinedDefects:[{id:'def-1',activityId:'bank_deposit',faultSignature:'bank closed',outcomeKind:'worker_defect',account:'Worker',observedAt:92,quarantinedAt:95,quarantined:true,logPath:'log.txt',detail:'refund missing',count:1}],
 };
 const c=coordinationView(state,99,100);
 expect(c.tasks).toHaveLength(2);
 expect(c.counts.running).toBe(1);
 expect(c.counts.failed).toBe(1);
 expect(c.activeChains).toBe(1);
 expect(c.goals).toBe(1);
 expect(c.defects).toBe(1);
 expect(c.chains[0]).toMatchObject({account:'Worker',goal:'quest_board',step:'quest_cooks_assistant',running:true});
 expect(c.agents[0]!.planning).toBe(true);
 expect(c.agents[0]!.tasks).toEqual(['chain:Worker:g1']);
 expect(c.tasks[1]!.detail).toBe('refund missing');
 expect(JSON.stringify(c)).not.toContain('NEVER_EXPOSE');
 expect(coordinationView(state,1,20000).fresh).toBe(false);
 expect(coordinationView(null,0,1).available).toBe(false);
});
test('camera destinations use the pinned viewer URL interface and reject invalid coordinates',()=>{
 const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
 const source=html.slice(html.indexOf('function viewerCameraUrl('),html.indexOf('function viewerMessage('));
 const camera=new Function('URL',source+';return viewerCameraUrl;')(URL);
 const url=camera(new URL('http://localhost/viewer/'),{x:3212,z:3428});
 expect(url.searchParams.get('cx')).toBe('3212');expect(url.searchParams.get('cz')).toBe('3410');expect(url.searchParams.get('cy')).toBe('38');
 expect(url.searchParams.get('v')).toBe('1');expect(url.searchParams.get('p')).toBe('-300');
 for(const pos of [null,{x:NaN,z:1},{x:-1,z:1},{x:1,z:20000}])expect(camera(new URL('http://localhost/viewer/'),pos).search).toBe('');
 expect(html).toContain('viewerCameraUrl(viewerFrameUrl(VIEWER.url,location.origin),window.atlasDestination||(window.atlasFreeCamera||window.atlasFollowOther?null:b?.live||b?.pos))');
});
