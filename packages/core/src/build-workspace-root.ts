import {basename,dirname,join} from 'node:path';

export function workspaceRoot(mainRoot:string,capability:string):string{
 if(!/^[-a-z0-9]+$/.test(capability))throw Error('workspace capability id invalid');
 return join(dirname(mainRoot),basename(mainRoot)+'-build',capability);
}
