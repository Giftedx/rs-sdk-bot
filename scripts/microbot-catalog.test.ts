import {test,expect} from 'bun:test';
import {catalog,reviewCoverage} from './microbot-catalog';
test('catalog includes scripts with unusual names and refuses incomplete inventories',()=>{
 const prefix='src/main/java/net/runelite/client/plugins/microbot/';
 const tree={sha:'a'.repeat(40),truncated:false,paths:[prefix+'odd/Worker.java',prefix+'odd/OddPlugin.java',prefix+'odd/OddScript.java','src/test/java/Other.java']};
 const c=catalog('chsami/Microbot-Hub',tree,process.cwd());
 expect(c.javaFiles).toBe(3);expect(c.modules[0]!.files.length).toBe(3);
 expect(c.modules[0]!.status).toBe('unreviewed');expect(c.modules[0]!.compatibility).toBe('unknown');
 expect(()=>catalog('chsami/Microbot-Hub',{...tree,truncated:true},process.cwd())).toThrow();
});
test('full-catalog review gate rejects dropped modules, nested scripts, evidence and consumers',()=>{
 const module={name:'example',scripts:['example/OneScript.java','example/nested/TwoScript.java']};
 const review={name:'example',decision:'port',behaviour:'converts owned inputs',localConsumers:['scripts/example.ts'],sourceEvidence:[{path:module.scripts[0]!,line:1,claim:'conversion'}],serverEvidence:[],blockers:[],scriptDecisions:module.scripts.map(path=>({path,decision:'port',consumer:'scripts/example.ts',gap:''})),proof:'unit'};
 expect(reviewCoverage([module],[review])).toEqual([]);
 expect(reviewCoverage([module],[])).toContain('missing module decision example');
 expect(reviewCoverage([module],[{...review,scriptDecisions:review.scriptDecisions.slice(0,1)}])).toContain('missing script decision example/nested/TwoScript.java');
 expect(reviewCoverage([module],[{...review,localConsumers:[]}])).toContain('missing consumer example');
 expect(reviewCoverage([module],[{...review,decision:'blocked'}])).toContain('missing exact blockers example');
 expect(reviewCoverage([module],[review,review])).toContain('duplicate decision example');
});
