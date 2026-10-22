import { xpForLevel } from '../packages/planner/src/curve';
const p=(lo:number,hi:number,l:number)=>(Math.floor(lo*(99-l)/98)+Math.floor(hi*(l-1)/98)+1)/256;
const S = Number(process.env.S ?? 2), F = Number(process.env.F ?? 12.8);
const r=(xp:number,lo:number,hi:number,l:number)=>{const q=p(lo,hi,l);return q*xp*2.5/(q*S+(1-q)*F)};
function total(ladder:(l:number)=>number){let t=0;const legs:number[]=[];for(let l=1;l<99;l++){const d=(xpForLevel(l+1)-xpForLevel(l))/ladder(l);t+=d;legs.push(t)}return {t,legs}}
const A=total(l=>l<40?r(80,180,240,l):l<55?r(468,50,240,l):r(843,50,240,l));
const B=total(l=>l<40?r(80,180,240,l):r(468,50,240,l));
const h=(t:number)=>`${Math.round(t)} ticks = ${(t*0.6/3600).toFixed(1)} h`;
console.log('man->guard40->knight55 to 99:',h(A.t),' | to 40:',h(A.legs[38]),' to 55:',h(A.legs[53]));
console.log('man->guard40 only to 99:',h(B.t));
console.log('xp 40/55/99:',xpForLevel(40),xpForLevel(55),xpForLevel(99));
