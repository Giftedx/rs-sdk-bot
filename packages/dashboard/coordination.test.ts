import {test,expect} from 'bun:test';
import {coordinationView} from './coordination';
import {readFileSync} from 'node:fs';
test('queue projection separates AI jobs and proof levels without leaking prompts or credentials',()=>{
 const state={version:1,planner:{agent:'codex',startedAt:90},tasks:[{spec:{id:'build',kind:'build',goal:'quests',why:'Next quest'},status:'running',startedAt:90},{spec:{id:'old',kind:'qualify'},status:'superseded'},{spec:{id:'review',kind:'review',goal:'wealth'},status:'failed',receipt:{at:95,output:{evidence:'source-review',review:{reason:'refund missing'},password:'NEVER_EXPOSE'}}}]};
 const c=coordinationView(state,99,100);
 expect(c.tasks).toHaveLength(2);expect(c.counts.running).toBe(1);expect(c.counts.failed).toBe(1);expect(c.agents[0]!.planning).toBe(true);expect(c.agents[1]!.tasks).toEqual(['build']);
 expect(c.tasks[1]!.detail).toBe('refund missing');expect(JSON.stringify(c)).not.toContain('NEVER_EXPOSE');expect(coordinationView(state,1,20000).fresh).toBe(false);expect(coordinationView(null,0,1).available).toBe(false);
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
