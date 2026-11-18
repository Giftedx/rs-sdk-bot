// Removes the user and the password of each URL in a text, so that a log line or a RESULT line holds no credential.
export const maskUrlCredentials = (text: string) => text.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1');
// The same, and also a Bearer or Basic token and the value of a name that holds TOKEN, PASSWORD, SECRET, SEED, KEY,
// COOKIE or AUTH. For a text that is not a Git error, such as the error line of a process that ended.
export const maskSecrets = (text: string) => maskUrlCredentials(text)
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted]')
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|SEED|KEY|COOKIE|AUTH)[A-Za-z0-9_]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]');
