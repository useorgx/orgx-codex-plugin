// Native Codex presentation belongs at root interface. Attached MCP listings
// share the public directory limits with portable Agent Plugins:
// https://developers.openai.com/plugins/deploy/submission
export function validateListingMetadata(manifest) {
  const listing = manifest?.interface;
  if (!listing || typeof listing !== 'object' || Array.isArray(listing)) {
    throw new Error('manifest.interface is required');
  }

  for (const [field, limit] of Object.entries({
    displayName: 30,
    shortDescription: 30,
    longDescription: 4000,
    developerName: 80,
  })) {
    const value = listing[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`manifest.interface.${field} must be a non-empty string`);
    }
    if (value.length > limit) {
      throw new Error(`manifest.interface.${field} must contain at most ${limit} characters`);
    }
  }

  // This package attaches OrgX MCP, so all four listing URLs are mandatory.
  for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
    const value = listing[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`manifest.interface.${field} must be a non-empty string`);
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`manifest.interface.${field} must be an HTTPS URL without credentials`);
    }
    if (value.length > 1024 || url.protocol !== 'https:' || url.username || url.password) {
      throw new Error(`manifest.interface.${field} must be an HTTPS URL without credentials, at most 1024 characters`);
    }
  }
}
