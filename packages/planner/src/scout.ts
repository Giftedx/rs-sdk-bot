// Reads public hiscore boards and compares our planned scored time with the current #1.
// Page shape: server/engine/src/web/pages/hiscores.ts:364-370 (rank, name, level and time columns, one
// value per `<br>`; the time cell carries the exact tick count as `title="N ticks"`).

export interface BoardRow { rank: number; name: string; level: number; ticks: number }

export function parseBoard(html: string, expectedTickMs?: number): BoardRow[] {
    const names = [...html.matchAll(/href="\/hiscores\/player\/([^"?]+)\?[^"]*"[^>]*>([^<]*)<\/a><br>/g)].map(m => decodeURIComponent(m[1]!));
    // Current pages title the cell "2,935 ticks normalized to 400 ms per tick"; older pages end at "ticks".
    const times = [...html.matchAll(/title="([\d,]+) ticks\b([^"]*)"/g)];
    const ticks = times.map(m => Number(m[1]!.replace(/,/g, '')));
    // Bare numbers ending in <br>, at a line start or right after a tag (`<td>1<br>`): the rank column comes
    // first, then the level column. Names end in `</a><br>` and times in `</span><br>`, so they never match.
    const nums = [...html.matchAll(/(?:^|>)\s*([\d,]+)<br>/gm)].map(m => Number(m[1]!.replace(/,/g, '')));
    const n = names.length;
    if (expectedTickMs !== undefined) {
        if (!n || ticks.length !== n || nums.length < 2 * n || nums[0] !== 1 || !Number.isSafeInteger(ticks[0]) || ticks[0]! <= 0) {
            throw Error('hiscore board has no readable leader');
        }
        if (times.some(m => m[2] !== ` normalized to ${expectedTickMs} ms per tick`)) {
            throw Error(`hiscore times must explicitly use ${expectedTickMs} ms per tick`);
        }
    }
    if (ticks.length < n || nums.length < 2 * n) return [];
    return names.map((name, i) => ({ rank: nums[i]!, name, level: nums[n + i]!, ticks: ticks[i]! }));
}

export async function fetchBoard(base: string, category: number, profile = 'main', expectedTickMs?: number): Promise<BoardRow[]> {
    const res = await fetch(`${base}/hiscores?category=${category}&profile=${profile}`, { signal: AbortSignal.timeout(15_000), cache: 'no-store' });
    if (!res.ok) throw new Error(`hiscores ${category}: HTTP ${res.status}`);
    return parseBoard(await res.text(), expectedTickMs);
}

export async function observeProfile(base:string,name:string,request:typeof fetch=fetch){
    const account=name.toLowerCase();
    if(!/^[a-z0-9]{1,12}$/.test(account))throw Error('invalid fresh account name');
    const response=await request(base+'/hiscores/player/'+account+'?profile=main',
        {signal:AbortSignal.timeout(15_000),cache:'no-store',redirect:'error'});
    if(response.status===404){
        if(await response.text()!==`Player "${account}" not found.`)throw Error('hiscore profile '+account+': invalid 404 response');
    }else if(response.status===200)await response.body?.cancel();
    else throw Error('hiscore profile '+account+': HTTP '+response.status);
    return {name:account,status:response.status,at:Date.now()};
}

export interface Gap { board: string; leaderName: string | null; leaderTicks: number | null; ourTicks: number; marginTicks: number; winnable: boolean }

// A board is winnable when our plan reaches the leader's level in fewer scored ticks than they took.
// Empty boards come first, then the widest margins.
export function boardGaps(items: { board: string; leader: BoardRow | null; ourTicks: number }[]): Gap[] {
    return items
        .map(i => {
            const margin = i.leader ? i.leader.ticks - i.ourTicks : Infinity;
            return { board: i.board, leaderName: i.leader?.name ?? null, leaderTicks: i.leader?.ticks ?? null, ourTicks: i.ourTicks, marginTicks: margin, winnable: margin > 0 };
        })
        .sort((a, b) => b.marginTicks - a.marginTicks);
}
