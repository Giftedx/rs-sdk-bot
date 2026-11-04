import {basename} from 'node:path';
export function runeProofReceiptChecks(meta:{source?:unknown;at?:unknown;delivery?:unknown},source:string,directory:string,now=Date.now()){
 const delivery=basename(directory),match=/^rune-bank-craft-(\d+)-[A-Za-z0-9]+$/.exec(delivery),started=match?Number(match[1]):NaN;
 // A later practice phase and the shared FIFO can outlast a wall-age window.
 // Bind the producer to this exact delivery instead of accepting another run's receipt.
 return {source:meta.source===source,fresh:meta.delivery===delivery&&Number.isSafeInteger(started)&&started>0&&typeof meta.at==='number'&&Number.isSafeInteger(meta.at)&&Number.isFinite(now)&&meta.at>=started&&meta.at<=now};
}
