import {test,expect} from 'bun:test';
import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import ts from 'typescript';
import {commandLine} from '../../practice/src/proc';
import {claudeArgs} from '../src/author';

test('project background launchers explicitly hide their Windows windows',()=>{
 const root=resolve(import.meta.dir,'../../..'),misses:string[]=[];let checked=0;
 const walk=(dir:string)=>{for(const e of readdirSync(join(root,dir),{withFileTypes:true})){
  const path=join(dir,e.name);if(e.isDirectory()&&!['node_modules','client-assets'].includes(e.name))walk(path);
  else if(e.isFile()&&path.endsWith('.ts')&&!path.endsWith('.test.ts')){
   const source=ts.createSourceFile(path,readFileSync(join(root,path),'utf8'),ts.ScriptTarget.Latest,true);
   const visit=(n:ts.Node)=>{if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.expression.getText(source)==='Bun'&&['spawn','spawnSync'].includes(n.expression.name.text)){
    checked++;const options=n.arguments[1]??n.arguments[0];
    if(!options||!ts.isObjectLiteralExpression(options)||!options.properties.some(p=>ts.isPropertyAssignment(p)&&p.name.getText(source)==='windowsHide'&&p.initializer.kind===ts.SyntaxKind.TrueKeyword))misses.push(path+':'+(source.getLineAndCharacterOfPosition(n.getStart()).line+1));
   }ts.forEachChild(n,visit);};visit(source);
  }
 }};
 ['packages/router/src','packages/practice/src','packages/core/src','packages/dashboard','scripts'].forEach(walk);
 expect(checked).toBeGreaterThan(50);expect(misses).toEqual([]);
});
test('headless Claude does not start user-configured MCP helper servers',()=>{
 const args=claudeArgs('inspect local files');expect(args).toContain('--strict-mcp-config');expect(args).toContain('{"mcpServers":{}}');
});
test.skipIf(process.platform!=='win32')('hidden Windows subprocesses retain command-line inspection without a visible console',async()=>{
 const code=`Add-Type -Name Window -Namespace QuietCheck -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);'; Start-Sleep -Seconds 2; [QuietCheck.Window]::IsWindowVisible([QuietCheck.Window]::GetConsoleWindow())`;
 const child=Bun.spawn(['powershell','-NoProfile','-Command',code],{windowsHide:true,stdout:'pipe',stderr:'pipe'});
 try{
  expect(commandLine(child.pid)).toContain('QuietCheck');
  const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(exit).toBe(0);expect(err.trim()).toBe('');expect(out.trim()).toBe('False');
 }finally{if(child.exitCode===null)child.kill();}
},15000);
