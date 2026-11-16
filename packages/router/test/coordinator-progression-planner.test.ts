import {expect,test} from 'bun:test';
import {plannerPrompt,type readWorld} from '../src/coordinator-planner';
import {initialState} from '../src/coordinator';
test('planner receives finite progression evidence requests and rules for their consumer chain',()=>{
 const world={at:100000,scoreboard:null,statuses:[],jobs:[],capabilities:[],ended:{},coverage:{scriptCandidates:[]},
  progression:[{account:'A',intent:{kind:'train',skill:'Ranged',targetLevel:50},followUps:[{method:'faster',state:'measure',reason:['rate unknown']}]}]} as unknown as ReturnType<typeof readWorld>;
 const prompt=plannerPrompt(initialState(),world);
 expect(prompt).toContain('PROGRESSION REQUESTS');expect(prompt).toContain('original finite consumer');
 expect(prompt).toContain('exact method');expect(prompt).toContain('rate unknown');expect(prompt).toContain('qualified current');
});
