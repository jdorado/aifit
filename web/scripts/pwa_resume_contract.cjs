const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const readSource = (...segments) => fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8')
const appSource = readSource('src', 'App.tsx')
const workerSource = readSource('public', 'sw.js')

assert.equal(appSource.includes('window.location.reload()'), false, 'foregrounding the app must not force a reload')
assert.equal(appSource.includes("window.addEventListener('focus', checkForUpdate)"), false, 'foreground focus must not force an update check')
assert.equal(appSource.includes("window.addEventListener('pageshow', checkForUpdate)"), false, 'page restore must not force an update check')
assert.equal(workerSource.includes('self.skipWaiting()'), false, 'new workers must wait for a cold app start')
assert.equal(workerSource.includes('self.clients.claim()'), false, 'new workers must not take over an active app')

console.log('pwa resume contract passed')
