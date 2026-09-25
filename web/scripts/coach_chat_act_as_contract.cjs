// Coach-chat act-as contract. Asserts the mini-chat in the trainee view
// carries the act-as link to the canonical chat surface (enqueue + job poll)
// and stays gated by the link permission, matching the legacy rule
// (chat_as_coach has no new-schema equivalent; edit_programs implies coach
// chat). Source-level, in the style of plan_edit_contract.cjs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')

const has = (haystack, needle, message) => assert.ok(haystack.includes(needle), `${message} (missing: ${needle})`)

// 1. The mini-chat payload carries the act-as link.
has(appSource, 'act_as_link_id?: string', 'the chat request payload must allow the act-as link')
has(appSource, '...(coachActAsLinkId ? { act_as_link_id: coachActAsLinkId } : {})', 'the mini-chat send must forward the act-as link')

// 2. The job poll carries it too (the run lives on the trainee relay).
has(appSource, '...(payload.act_as_link_id ? { act_as_link_id: payload.act_as_link_id } : {})', 'the chat job poll must forward the act-as link')

// 3. Gating: the link permission implies coach chat.
has(appSource, 'coachActAsPermissions?.view_progress === true && coachActAsPermissions?.edit_programs === true', 'coach chat must require the link permission')

// 4. The mini-chat owner context resolves through the act-as owner.
has(appSource, 'const ownerWorkoutKey = `${coachActAsOwnerId ?? currentUserId}:${selectedDay?.date ?? todayId}`', 'the mini-chat context must use the act-as owner')

// 5. The mini model picker stays off in coach mode (the trainee default applies).
has(appSource, 'miniModelSelectionDisabled={miniModelSelectionPending || Boolean(coachActAsLinkId)}', 'the mini model picker must stay off in coach mode')

// 6. General chat is available in an authorized trainee view and sends the link.
has(appSource, 'coachActAsLinkId && !coachChatEnabled', 'read-only trainee views must keep chat disabled')
has(appSource, 'act_as_link_id: coachActAsLinkId,', 'general coach chat must send the act-as link')
has(appSource, 'coachMessagesByScope[`coach-link:${coachActAsLinkId}`]', 'coach messages must be separate from owner chat')

console.log('coach chat act-as contract passed')
