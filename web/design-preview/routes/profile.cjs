// Profile area mock: Telegram connection states and coach links.
// State comes from a tiny JSON file in the OS temp dir so a screenshot script can flip scenarios:
//   { "telegram": "unavailable|ready|needs_bot|connected", "links": "none|some" }
// Default (no file): Telegram unavailable, no coach links, so other areas keep their current behaviour.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'aifit-preview-profile.json'), 'utf8'))
  } catch {
    return { telegram: 'unavailable', links: 'none' }
  }
}

const iso = (days) => new Date(Date.now() + days * 86_400_000).toISOString()

const link = (id, patch) => ({
  link_id: id,
  trainee_account_id: 'acct_demo',
  trainee_email: 'maya@example.com',
  coach_account_id: null,
  coach_email: null,
  permissions: { view_progress: true, edit_programs: false },
  status: 'pending',
  invite_token: 'aifit_inv_7Kq2mXv9Rt4LpZ',
  invite_expires_at: iso(6),
  created_at: iso(-1),
  updated_at: iso(-1),
  ...patch,
})

const asTrainee = () => [
  link('l_1', {
    coach_account_id: 'acct_coach_1',
    coach_email: 'diego.alvarez@strongroom.fit',
    permissions: { view_progress: true, edit_programs: true },
    status: 'active',
    invite_token: 'aifit_inv_accepted',
    invite_expires_at: null,
  }),
  link('l_2', { coach_email: 'sam.okafor@example.com', permissions: { view_progress: true, edit_programs: false } }),
  link('l_3', {
    coach_account_id: 'acct_coach_3',
    coach_email: 'old.coach@example.com',
    status: 'revoked',
    invite_expires_at: null,
  }),
]

const asCoach = () => [
  link('l_9', {
    trainee_account_id: 'acct_t9',
    trainee_email: 'priya.nair@example.com',
    coach_account_id: 'acct_demo',
    coach_email: 'maya@example.com',
    status: 'active',
    permissions: { view_progress: true, edit_programs: false },
    invite_expires_at: null,
  }),
  link('l_10', {
    trainee_account_id: 'acct_t10',
    trainee_email: 'leo.martin@example.com',
    coach_account_id: null,
    coach_email: 'maya@example.com',
    invite_token: 'aifit_inv_Zp81QdW5nBc3Yh',
  }),
]

module.exports = (url, req, body) => {
  const { pathname, searchParams } = url
  const state = readState()

  if (pathname === '/v1/coach-links' && req.method === 'GET') {
    if (state.links !== 'some') return undefined
    return searchParams.get('role') === 'coach' ? asCoach() : asTrainee()
  }
  if (pathname === '/v1/coach-links' && req.method === 'POST') {
    return link(`l_${Date.now()}`, {
      coach_email: body?.coach_email || 'new.coach@example.com',
      permissions: body?.permissions || { view_progress: true, edit_programs: false },
      invite_token: 'aifit_inv_Nw3TzK8vYq1Rb2',
    })
  }
  if (pathname.startsWith('/v1/coach-links/') && req.method === 'PATCH') {
    const id = decodeURIComponent(pathname.split('/').pop())
    const base = [...asTrainee(), ...asCoach()].find((row) => row.link_id === id) || link(id, {})
    return { ...base, ...(body?.status ? { status: body.status } : {}), ...(body?.permissions ? { permissions: body.permissions } : {}) }
  }

  if (pathname === '/account/telegram' && req.method === 'GET') {
    if (state.telegram === 'connected') return { state: 'connected' }
    if (state.telegram === 'ready') return { state: 'ready' }
    if (state.telegram === 'needs_bot') return { state: 'needs_bot' }
    return undefined
  }
  return undefined
}
