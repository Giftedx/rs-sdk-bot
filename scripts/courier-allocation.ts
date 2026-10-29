// Keep the existing per-type cap; an optional total cap bounds one recipient's lot.
export function courierFoodAllocation(counts:readonly number[],need:number,perType=0,total=0):number[]{
 if([need,perType,total,...counts].some(n=>!Number.isSafeInteger(n)||n<0))throw Error('Invalid courier food budget');
 let remaining=Math.min(need,total>0?total:Infinity);
 return counts.map(count=>{const amount=Math.min(remaining,count,perType>0?perType:Infinity);remaining-=amount;return amount;});
}
