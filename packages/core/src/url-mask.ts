// Removes the user and the password of each URL in a text, so that a log line or a RESULT line holds no credential.
export const maskUrlCredentials = (text: string) => text.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1');
