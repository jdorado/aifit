const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const vm = require('node:vm')
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/views/HealthTimelineView.tsx'), 'utf8')
const body = source.slice(source.indexOf('  const upload = async'), source.indexOf('  const retry = async'))
let fail = true
const calls = []; const state = {}; const pendingUpload = { current: null }
const context = { pendingUpload, uploadBusy: { current: false }, uploadAbort: { current: null }, mounted: { current: true }, selectedDate: '2026-09-09', crypto: require('node:crypto').webcrypto, Intl, Date, URLSearchParams, AbortController, setTimeout, clearTimeout,
  request: async (url) => { calls.push(url); if (fail) throw new Error('Request failed (413).') },
  setUploading: v => state.uploading = v, setUploadError: v => state.error = v,
  setUploadNotice: v => state.notice = v, setRefreshKey: () => {},
}
vm.createContext(context)
vm.runInContext(ts.transpileModule(body + '\nglobalThis.handlers = {upload, selectPhoto}', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context)
;(async () => {
  context.handlers.selectPhoto({ size: 2825326, type: 'image/jpeg' })
  assert.equal(state.uploading, true)
  await new Promise(setImmediate)
  assert.match(state.error, /Photo not confirmed saved/)
  assert.ok(pendingUpload.current)
  const loadingEffect = source.slice(source.indexOf('    const load = async'), source.indexOf('  const addEntry = async'))
  assert.doesNotMatch(loadingEffect, /setUploadError|pendingUpload/, 'Refresh cannot clear upload failure or its retry file')
  fail = false
  await context.handlers.upload()
  assert.equal(state.uploading, false)
  assert.match(state.notice, /Photo saved/)
  assert.equal(state.error, '')
  assert.equal(pendingUpload.current, null)
  assert.equal(calls[0], calls[1], 'Retry retains request id')
  console.log('Meal upload contract passed: progress, failure retention, stable retry and save confirmation')
})().catch(e => { console.error(e); process.exitCode = 1 })
