import { logWarn } from '../log.js';

export function getAdminTokenFromRequest(c) {
  const internal = c.req.header('X-PersonalRSS-Admin-Token');
  if (internal) return internal.trim();

  const header = c.req.header('Authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return header.trim();
}

export function requireAdmin(c) {
  const expected = c.env.ADMIN_TOKEN || '';
  const actual = getAdminTokenFromRequest(c);
  if (!expected || actual !== expected) {
    logWarn('admin.auth_failed', {
      path: c.req.path,
      method: c.req.method
    });
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return null;
}
