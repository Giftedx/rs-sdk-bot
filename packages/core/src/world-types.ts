import type { OpenDoorVariant } from '../../knowledge/src/doors';

export type Tile = { x: number; z: number; level: number };
export interface Account { skills: Record<string, number>; varps: Record<string, number>; items: string[]; coins?: number; counts?: Record<string, number>; worn?:string[]; unlocks?:string[];questStages?:Record<string,number>;castlewarsTeam?:0|1;doorStates?:Record<string,boolean>;visibleLocs?:ReadonlyArray<Tile&{id:number}> }
export interface Door { id: number; loc: string; x: number; z: number; level: number; angle?:number; shape?:number;open?:OpenDoorVariant; kind: string; need?: { skill?: string; level?: number; varp?: string; item?: string;worn?:string;whenAxis?:boolean;minimum?:number;team?:0|1 }; trigger: string; src: string }
export type DoorBlock=Tile&{whenAxis?:boolean;angle?:number;shape?:number;blockrange?:boolean};
