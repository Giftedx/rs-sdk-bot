import {test,expect} from 'bun:test';
import {initialState} from '../src/coordinator';
import {plannerPrompt,gameCoverage} from '../src/coordinator-planner';

const world={coverage:{scriptCandidates:[]},statuses:[],jobs:[],capabilities:[]} as any;

test('planner separates the main Overall record from specialist board wins',()=>{
 const prompt=plannerPrompt(initialState(),world);
 expect(prompt).not.toContain('main rank1 on all24boards simultaneously');
 expect(prompt).toMatch(/Haggis rank\s*1 Overall under the record/);
 expect(prompt).toContain('specialists rank1 on every available scoreboard');
 expect(gameCoverage([],[],[],[],[]).otherGoals).toContain('main Overall record');
});

test('planner completion requires the fresh account and bosses, not fleet coverage totals',()=>{
 const prompt=plannerPrompt(initialState(),world);
 expect(prompt).toContain('one fresh completion account');
 expect(prompt).toContain('every available boss defeated');
 expect(prompt).toContain('fleet-wide coverage, not completion proof');
 expect(prompt).toContain('current game state and scoreboards');
 expect(prompt).not.toContain('the project ends only when world.scoreboard.progress.done is true');
});

test('cross-side helper leads do not bar required completion or scored progression',()=>{
 const led={...world,statuses:[{name:'Haggis',skills:[{name:'Mining',level:1}]}],
  scoreboard:{fleet:{side:'local'},fleetSkills:[{skill:'Mining',best:85,side:'cloud',account:'OtherMiner'}]}};
 const prompt=plannerPrompt(initialState(),led as any);
 expect(prompt).toContain('For ordinary helper batches, do not queue work');
 expect(prompt).toContain('The fresh completion account and scored main/specialist routes follow their own required progression and clocks');
 expect(prompt).toContain('Ordinary helper batches target the next unlock');
 expect(prompt).toContain('Completion and scored routes may span a qualified method-switching ladder');
});
