// Resolve a catalog route without letting environment-only overrides discard its positional defaults.
import {parseStep,type Step} from '../packages/core/src/chain-step';

export function resolveRouteStep(spec: {
 script: string;
 defaultArgs?: readonly string[];
 defaultEnv?: Readonly<Record<string,string>>;
}, rest: readonly string[] = []): Step {
 const supplied = parseStep(spec.script);
 for (const token of rest) {
  const setting = token.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/);
  if (setting) supplied.env[setting[1]!] = setting[2]!;
  else supplied.args.push(token);
 }
 return {
  script: supplied.script,
  args: supplied.args.length ? supplied.args : [...(spec.defaultArgs ?? [])],
  env: { ...(spec.defaultEnv ?? {}), ...supplied.env },
 };
}
