// PKCE verifier and challenge (RFC 7636, S256) for an OAuth loopback or web flow. Pure crypto,
// not tied to any provider.
import { createHash, randomBytes } from 'node:crypto';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48)); // 64 chars: within the required 43-128
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
