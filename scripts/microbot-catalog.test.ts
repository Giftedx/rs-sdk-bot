import {test,expect} from 'bun:test';
import {catalog} from './microbot-catalog';
test('catalog includes scripts with unusual names and refuses incomplete inventories',()=>{
 const prefix='src/main/java/net/runelite/client/plugins/microbot/';
 const tree={sha:'a'.repeat(40),truncated:false,paths:[prefix+'odd/Worker.java',prefix+'odd/OddPlugin.java',prefix+'odd/OddScript.java','src/test/java/Other.java']};
 const c=catalog('chsami/Microbot-Hub',tree,process.cwd());
 expect(c.javaFiles).toBe(3);expect(c.modules[0]!.files.length).toBe(3);
 expect(c.modules[0]!.status).toBe('unreviewed');expect(c.modules[0]!.compatibility).toBe('unknown');
 expect(()=>catalog('chsami/Microbot-Hub',{...tree,truncated:true},process.cwd())).toThrow();
});
