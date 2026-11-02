import { validateRuleDefinition } from '../../src/automation/rules.ts';
import { isJsonSyntaxError, rethrowUnless } from './expected.ts';

// A rule definition arrives as JSON from the dashboard, the CLI, or an agent, and is stored as it
// was accepted. Text that is not JSON is skipped; a value that is must be judged without a throw,
// and a definition the validator accepts must be accepted again in its normalized form, or a rule
// could be saved that fails to load.
export function fuzz(data: Buffer): void {
  let value: unknown;
  try {
    value = JSON.parse(data.toString('utf8'));
  } catch (err) {
    rethrowUnless(err, isJsonSyntaxError);
    return;
  }
  const result = validateRuleDefinition(value);
  if (!result.ok) {
    if (result.errors.length === 0) throw new Error('refused with no error message');
    return;
  }
  const again = validateRuleDefinition(result.normalized);
  if (!again.ok) throw new Error(`normalized rule refused: ${again.errors.join('; ')}`);
}
