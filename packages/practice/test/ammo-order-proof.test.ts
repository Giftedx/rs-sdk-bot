import {test,expect} from 'bun:test';
import {ammoOrderChecks} from '../src/ammo-order-proof';

test('ammo acceptance rejects missing product, lost reserve and absent XP',()=>{
    const save=(bank:{id:number;count:number}[],xp=0)=>({inventories:{93:[],94:[],95:bank.map((item,slot)=>({...item,slot}))},skills:Array.from({length:21},(_,i)=>({index:i,level:i===3?15:1,xp:i===9?xp:0,rawExperience:0})),position:{x:3253,z:3421,level:0},version:9,vars:{}});
    const before=[save([{id:40,count:90},{id:39,count:16}]),save([{id:53,count:390}])];
    const donor=save([{id:39,count:16}]),received=save([{id:53,count:390},{id:40,count:90}]),final=save([{id:53,count:300},{id:884,count:90}],10);
    const input={before,donor,received,final,receipt:{state:'settled',expected:[{id:40,count:90}]},transfer:{code:0,log:'HANDOFF_RESULT {"ok":true\nLOGOUT logged-out\nLOGOUT logged-out'},craft:{code:0,log:'LOGOUT logged-out'},repeat:{code:1,log:'already settled'}};
    expect(Object.values(ammoOrderChecks(input)).every(Boolean)).toBe(true);
    const emptyEquipmentOmitted={...before[0]!,inventories:{93:[],95:before[0]!.inventories[95]}};
    expect(ammoOrderChecks({...input,before:[emptyEquipmentOmitted,before[1]!]}).pack).toBe(true);
    for(const bad of [save([{id:53,count:300}],10),save([{id:53,count:299},{id:884,count:90}],10),save([{id:53,count:300},{id:884,count:90}])])
        expect(Object.values(ammoOrderChecks({...input,final:bad})).every(Boolean)).toBe(false);
    expect(ammoOrderChecks({...input,repeat:{code:1,log:'already settled\nSTART 1 2 0'}}).restart).toBe(false);
});
