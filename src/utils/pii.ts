/**
 * PII Obfuscation Utility for AI Workflows
 * Intercepts and masks sensitive data before sending it to the LLM.
 */

export interface ObfuscationVault {
  [token: string]: string;
}

export interface ObfuscationResult {
  maskedText: string;
  vault: ObfuscationVault;
}

/**
 * Scans text for PII (UUIDs, Emails, Phones), replaces them with tokens,
 * and stores the mapping in a local vault.
 *
 * Accepts an optional existing vault so that repeated calls during a single
 * pipeline run (e.g. re-masking tool results) accumulate into one vault and
 * produce consistent tokens for values already seen.
 */
export function maskPII(
  text: string,
  existingVault: ObfuscationVault = {},
): ObfuscationResult {
  const vault: ObfuscationVault = { ...existingVault };
  let maskedText = text;

  // Derive counters from tokens already in the vault so we never reuse a number.
  let emailCounter =
    Object.keys(vault).filter((k) => k.startsWith('EMAIL_')).length + 1;
  let phoneCounter =
    Object.keys(vault).filter((k) => k.startsWith('<PHONE_')).length + 1;
  let uuidCounter =
    Object.keys(vault).filter((k) => k.startsWith('<UUID_')).length + 1;

  // Returns the token already assigned to a given raw value, if any.
  const getExistingToken = (match: string): string | undefined =>
    Object.keys(vault).find((key) => vault[key] === match);

  // 1. Mask UUIDs
  const uuidRegex =
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
  maskedText = maskedText.replace(uuidRegex, (match) => {
    const existing = getExistingToken(match);
    if (existing) return existing;
    const token = `<UUID_${uuidCounter++}>`;
    vault[token] = match;
    return token;
  });

  // 2. Mask Emails (format-preserving so the LLM recognizes the type)
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  maskedText = maskedText.replace(emailRegex, (match) => {
    const existing = getExistingToken(match);
    if (existing) return existing;
    const token = `EMAIL_${emailCounter++}@masked.local`;
    vault[token] = match;
    return token;
  });

  // 3. Mask European/International phone numbers
  // Matches '+', followed by a non-zero digit, then 8 to 14 digits (allowing optional spaces or dashes)
  const phoneRegex = /\+[1-9](?:[\s.-]?\d){8,14}/g;

  maskedText = maskedText.replace(phoneRegex, (match) => {
    // Optional but recommended: normalize the match by stripping spaces/dashes
    // so "+33 6 12 34 56" and "+336123456" use the same vault token.
    const normalizedMatch = match.replace(/[\s.-]/g, '');

    const existing = getExistingToken(normalizedMatch);
    if (existing) return existing;

    const token = `<PHONE_${phoneCounter++}>`;
    vault[token] = normalizedMatch;
    return token;
  });

  return { maskedText, vault };
}

/**
 * Restores the original PII into text using the local vault.
 * Call this in the MCP router before forwarding tool inputs to internal servers.
 */
export function unmaskPII(maskedText: string, vault: ObfuscationVault): string {
  let unmaskedText = maskedText;
  for (const [token, originalValue] of Object.entries(vault)) {
    unmaskedText = unmaskedText.split(token).join(originalValue);
  }
  return unmaskedText;
}
