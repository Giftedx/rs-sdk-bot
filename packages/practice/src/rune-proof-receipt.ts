export function runeProofReceiptChecks(meta:{source?:unknown;at?:unknown;delivery?:unknown},source:string,directory:string,now=Date.now()){
 return {source:meta.source===source,fresh:typeof meta.at==='number'&&Number.isFinite(meta.at)&&meta.at<=now&&now-meta.at<900000};
}
