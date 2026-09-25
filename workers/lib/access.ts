import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from '../types';

const ADMIN_EMAIL = 'hammadshaikh43@gmail.com';
// Deliberately exact identities, not a domain-wide grant. Changes require an admin deployment.
const OWNERS: Record<string, readonly string[]> = {
 'hammad@cookdbrands.com': ['hammad@cateniq.com', 'hammad@catenor.com'],
 'reza@cookdbrands.com': ['reza@cateniq.com', 'reza@catenor.com'],
 'zuhayr@cookdbrands.com': ['zuhayr@cateniq.com', 'zuhayr@catenor.com'],
 'yassir@cookdbrands.com': ['yassir@cateniq.com', 'yassir@catenor.com'],
 'sabiha@cookdbrands.com': ['sabiha@cateniq.com', 'sabiha@catenor.com'],
};
export type Identity = { email: string; isAdmin: boolean; mailboxes: readonly string[]; expiresAt?: number };
export type AccessContext = { Bindings: Env; Variables: { identity: Identity } };
export function identityFor(email: unknown): Identity | null {
 if (typeof email !== 'string') return null;
 const normalized = email.toLowerCase();
 if (normalized === ADMIN_EMAIL) return {email:normalized,isAdmin:true,mailboxes:[]};
 if (!Object.hasOwn(OWNERS, normalized)) return null;
 return {email:normalized,isAdmin:false,mailboxes:OWNERS[normalized]};
}
export function canAccessMailbox(identity: Identity, mailbox: string): boolean {
 // Canonical mailbox IDs only; no path separators or second decoding.
 return /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]+$/.test(mailbox) &&
  (identity.isAdmin || identity.mailboxes.includes(mailbox));
}
const keySets = new Map<string, JWTVerifyGetKey>();
export async function verifyAccessToken(token: string, env: Pick<Env,'TEAM_DOMAIN'|'POLICY_AUD'>, keys?: JWTVerifyGetKey): Promise<Identity> {
 if (!env.TEAM_DOMAIN || !env.POLICY_AUD) throw new Error('Access is not configured');
 const issuer = new URL(env.TEAM_DOMAIN).origin;
 if (!issuer.startsWith('https://')) throw new Error('Access issuer must use HTTPS');
 if (!keys) {
  if (!keySets.has(issuer)) keySets.set(issuer, createRemoteJWKSet(new URL('/cdn-cgi/access/certs',issuer)));
  keys = keySets.get(issuer)!;
 }
 const {payload} = await jwtVerify(token,keys,{issuer,audience:env.POLICY_AUD,algorithms:['RS256'],requiredClaims:['exp','iat','email']});
 const identity = identityFor(payload.email);
 if (!identity) throw new Error('Identity is not allowed');
 return {...identity, expiresAt:payload.exp};
}
export const authenticate = createMiddleware<AccessContext>(async(c,next)=>{
 try {
  c.set('identity',await verifyAccessToken(c.req.header('cf-access-jwt-assertion') || '',c.env));
 } catch { return c.text('Access denied. Sign in with an approved email address.',403); }
 await next();
});

export const authorizeRequest = createMiddleware<AccessContext>(async(c,next)=>{
 c.header('Cache-Control','private, no-store');
 const verified = c.get('identity');
 const identity = identityFor(verified?.email);
 if (!identity) return c.text('Access denied',403);
 c.set('identity',{...identity,expiresAt:verified.expiresAt});
 const path = new URL(c.req.url).pathname;
 let parts: string[];
 try { parts=path.split('/').map(decodeURIComponent); } catch { return c.text('Invalid path',400); }
 const deny=()=>c.text('Access denied',403);
 if (parts[1]==='mcp' && !identity.isAdmin) return deny();
 if (parts[1]==='api' && parts[2]==='v1' && parts[3]==='mailboxes') {
  const mailbox=parts[4];
  if (mailbox && !canAccessMailbox(identity,mailbox)) return deny();
  if (!identity.isAdmin && ((!mailbox && c.req.method!=='GET') || (mailbox && parts.length===5 && c.req.method==='DELETE'))) return deny();
 }
 if (parts[1]==='mailbox' && !canAccessMailbox(identity,parts[2] || '')) return deny();
 if (parts[1]==='agents') {
  // Expose only the chat class; never arbitrary Durable Objects or internal delivery hooks.
  if (parts[2]!=='email-agent' || !canAccessMailbox(identity,parts[3] || '')) return deny();
  if (parts[3]!==path.split('/')[3]) return deny(); // PartyServer uses the raw name as its storage key.
  if (parts.slice(4).some(p=>p==='onNewEmail' || p==='set-name' || p==='cdn-cgi')) return deny();
 }
 await next();
});

export function canUseAgentSession(session: {email?: unknown; expiresAt?: number} | null | undefined, mailbox: string, now = Date.now()/1000): boolean {
 const identity=identityFor(session?.email);
 return !!identity && typeof session?.expiresAt==='number' && Number.isFinite(session.expiresAt) && session.expiresAt>now && canAccessMailbox(identity,mailbox);
}
