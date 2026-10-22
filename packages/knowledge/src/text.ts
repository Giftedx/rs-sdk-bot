// Content files may carry CRLF and `//` comments. Removed lines become '' so indexes stay 0-based line numbers.
export function cleanLines(text: string): string[] {
    return text.split('\n').map(l => {
        const s = l.replace(/\r$/, '');
        const c = s.indexOf('//');
        return (c >= 0 ? s.slice(0, c) : s).trim();
    });
}
