// XP tracker arithmetic for the client shell's XP Tracker plugin (the RuneLite panel): this server's level curve
// (packages/planner/src/curve.ts), a per-session baseline so gains count from the account's login as RuneLite counts
// from the client start, and one row per skill with gain, rate, level progress and time to level. Pure, so bun tests it;
// client-shell.js renders it.
(function (global) {
    // The engine stores tenths of XP: levelExperience[i] = floor(acc / 4) * 10, acc += floor(L + 2^(L/10) * 300).
    const TABLE = (() => { const t = []; let acc = 0; for (let i = 0; i < 99; i++) { const level = i + 1; acc += Math.floor(level + Math.pow(2, level / 10) * 300); t.push(Math.floor(acc / 4)); } return t; })();
    const xpForLevel = level => level <= 1 ? 0 : TABLE[Math.min(level, 99) - 2];
    const levelForXp = xp => { for (let i = 97; i >= 0; i--) if (xp >= TABLE[i]) return Math.min(i + 2, 99); return 1; };
    // The baseline for an account session: its skills' XP when the tracker first saw this login (bot.started).
    function baseline(store, bot, now) {
        const have = store[bot.name];
        if (have && have.started === (bot.started ?? null) && have.xp) return have;
        const fresh = { started: bot.started ?? null, at: now, xp: Object.fromEntries((bot.skills || []).map(k => [k.name, k.xp])) };
        store[bot.name] = fresh;
        return fresh;
    }
    // serverRate: the page's own rate for the goal skill ({skill, xpPerHour}), which smooths over the last minutes.
    function rows(bot, base, now, serverRate) {
        const hours = Math.max((now - base.at) / 3.6e6, 1 / 3600);
        return (bot.skills || []).filter(k => k.name !== 'Overall' && typeof k.xp === 'number').map(k => {
            const start = base.xp[k.name] ?? k.xp, gained = Math.max(0, k.xp - start);
            const level = levelForXp(k.xp), next = Math.min(99, level + 1), floor = xpForLevel(level), ceil = xpForLevel(next);
            const rate = serverRate && serverRate.skill === k.name && serverRate.xpPerHour > 0 ? serverRate.xpPerHour : gained / hours;
            const left = Math.max(0, ceil - k.xp);
            return { skill: k.name, xp: k.xp, level, next, gained, rate: Math.round(rate), progress: ceil > floor ? Math.min(1, (k.xp - floor) / (ceil - floor)) : 1, left, ttl: rate > 0 && level < 99 ? left / rate * 3.6e6 : null };
        }).filter(r => r.gained > 0 || r.rate > 0).sort((a, b) => b.gained - a.gained || b.rate - a.rate);
    }
    const total = list => list.reduce((n, r) => n + r.gained, 0);
    global.atlasXp = { TABLE, xpForLevel, levelForXp, baseline, rows, total };
})(globalThis);
