// Independent rewrite of y5c/ge-bridge OfferTracker.observe's baseline and
// cumulative-delta model. Account/server/offer ID replace modern client slots.
// A fill is exchange execution, not collection, delivery or realized profit.
export interface MarketProgress {
 actor:string;server:string;offerId:number;itemId:number;side:'buy'|'sell';
 quantity:number;limit:number;filled:number;gross:number;tax:number;at:number;
}
export function marketProgress(previous:MarketProgress|null,current:MarketProgress){
 const whole=(v:number)=>Number.isSafeInteger(v)&&v>=0;
 const check=(p:MarketProgress)=>{
  if(!p.actor||!p.server||!['buy','sell'].includes(p.side)||![p.offerId,p.itemId,p.quantity,p.limit,p.at].every(v=>whole(v)&&v>0)
   ||![p.filled,p.gross,p.tax].every(whole)||p.filled>p.quantity||!whole(p.quantity*p.limit)||p.tax>p.gross
   ||p.filled===0&&p.gross!==0||p.filled>0&&p.gross<p.filled)throw Error('Invalid cumulative market observation');
  if(p.side==='buy'&&(p.gross>p.filled*p.limit||p.tax!==0))throw Error('Invalid buy tax or execution gross');
  if(p.side==='sell'&&p.gross<p.filled*p.limit)throw Error('Sell execution below limit');
 };
 check(current);
 if(!previous)return{current:{...current},baseline:true,delta:{filled:0,gross:0,tax:0}};
 check(previous);
 if(previous.actor.toLowerCase()!==current.actor.toLowerCase()||previous.server!==current.server
  ||(['offerId','itemId','side','quantity','limit'] as const).some(k=>previous[k]!==current[k]))throw Error('Market order identity changed');
 if(current.at<previous.at||current.filled<previous.filled||current.gross<previous.gross||current.tax<previous.tax)throw Error('Cumulative market evidence regressed');
 const delta={filled:current.filled-previous.filled,gross:current.gross-previous.gross,tax:current.tax-previous.tax};
 if(delta.filled===0&&(delta.gross!==0||delta.tax!==0))throw Error('Cumulative money changed without new fills');
 if(delta.filled>0&&(delta.gross<delta.filled||delta.tax>delta.gross
  ||current.side==='buy'&&delta.gross>delta.filled*current.limit
  ||current.side==='sell'&&delta.gross<delta.filled*current.limit))throw Error('Market fill delta violates its execution limit');
 return{current:{...current},baseline:false,delta};
}
