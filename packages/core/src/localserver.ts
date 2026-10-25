// True only for our own machine: localhost, a full 127.x.x.x address, or ::1, each with an optional :port.
// The whole host must match. A prefix test (`/^(localhost|127\.)/`) also let through names such as
// localhost.example.com or 127.evil.io, which resolve anywhere.
export function isLocalServer(server: string): boolean {
    const s = server.trim().toLowerCase();
    const octet = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
    return new RegExp(`^(?:localhost|127(?:\\.${octet}){3}|\\[::1\\])(?::\\d{1,5})?$|^::1$`).test(s);
}
