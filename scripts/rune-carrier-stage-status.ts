import {noteStatusLine} from '../packages/core/src/status';
export function runeStageStatus(names:readonly string[]){
 for(const name of names)noteStatusLine(name,'MILESTONE finite Rune carrier staging');
 return (name:string,line:string)=>{noteStatusLine(name,line);console.log(line);};
}
