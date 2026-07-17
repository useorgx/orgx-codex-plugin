/**
 * Autonomous dispatch is a runner-owned permission. Keep this parser
 * deliberately narrow so a missing value, typo, or inherited truthy value
 * cannot silently authorize unattended work.
 */
export function parseAutonomousDispatchEnabled(value) {
  return value === 'true';
}
