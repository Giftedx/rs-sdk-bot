// "Can a server start here?" asked by binding, not by connecting. After the power cuts on 2026-10-23, a connect to an
// empty 127.0.0.1:8888 failed with "access forbidden" and Bun's node:net reported it as connected, so a connect test
// said "in use" with nothing there. Both addresses are tried: Windows lets 0.0.0.0 bind while another process
// listens on 127.0.0.1 with the same port.
export function canBind(port: number): boolean {
    for (const hostname of ['127.0.0.1', '0.0.0.0']) {
        try {
            const s = Bun.listen({ hostname, port, socket: { data() {} } });
            s.stop(true);
        } catch {
            return false;
        }
    }
    return true;
}

export async function portInUse(port: number): Promise<boolean> {
    return !canBind(port);
}
