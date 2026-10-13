// Chat scenarios for design previews. Switch with GET /__chat_mode?mode=empty|long|thinking
const state = globalThis.__aifitChatMock || (globalThis.__aifitChatMock = { mode: 'long', polls: 0 })

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString()

const longHistory = () => [
  { role: 'user', content: 'Build me a plan for the next 4 weeks. I can train four days and my shoulder is cranky on pressing.', timestamp: minutesAgo(190) },
  {
    role: 'ai',
    agent_label: 'Detailed planning',
    timestamp: minutesAgo(188),
    content: [
      'Here is the shape of the block. **Four days, one idea per week**: build volume, keep the shoulder happy, and finish with a heavy week.',
      '',
      '## Weekly split',
      '',
      '| Day | Focus | Main lift |',
      '| --- | --- | --- |',
      '| Mon | Upper push + pull | Bench press 4×6 |',
      '| Tue | Lower power | Back squat 5×5 |',
      '| Thu | Upper pull + shoulders | Chest-supported row 4×10 |',
      '| Sat | Lower + conditioning | Romanian deadlift 3×8 |',
      '',
      '### Rules of the block',
      '',
      '1. Stop every set with **two reps in reserve**.',
      '2. Add *2.5 kg* only when every set hits the top of the range.',
      '3. If the shoulder pinches, switch to `neutral-grip dumbbell press` and keep reps.',
      '',
      '> The best plan is the one you can repeat on a bad Tuesday.',
      '',
      '- Warm up with band pull-aparts every session',
      '- Face pulls after every press',
      '- Deload in week 4 (cut sets, keep load)',
    ].join('\n'),
  },
  { role: 'user', content: 'How should I load bench today? My shoulder felt a bit cranky on Tuesday.', timestamp: minutesAgo(42) },
  { role: 'ai', agent_label: 'Everyday help', timestamp: minutesAgo(41), content: "Stay at **70 kg for 4×6**, but shorten the range: touch the bar to your lower chest and stop an inch above. If the shoulder pinches on set 2, drop to **65 kg** and keep the same reps.\n\nI added a face-pull superset after the press — it's the cheapest shoulder insurance in the plan." },
  { role: 'user', content: 'Great. Swap row for something easier on my lower back?', timestamp: minutesAgo(12) },
  { role: 'ai', agent_label: 'Quick reply', timestamp: minutesAgo(11), content: 'Done — the **chest-supported row** is already back-friendly because the pad takes your spine out of the equation. Keep the pause at the top and you will get the lats without the load.' },
]

module.exports = (url, req, body) => {
  const { pathname } = url
  if (pathname === '/__chat_mode') {
    state.mode = url.searchParams.get('mode') || 'long'
    state.polls = 0
    return { mode: state.mode }
  }
  if (pathname === '/chat/models') {
    // Purposes are labelled efforts of one model, which is how the real backend exposes them.
    return {
      presets: [{ id: 'everyday', name: 'Everyday help', cli: 'codex', provider: 'openai', model: 'gpt-5', effort: 'medium' }],
      selected_id: 'everyday',
      models: [{
        cli: 'codex',
        provider: 'openai',
        name: 'GPT-5',
        model: 'gpt-5',
        efforts: ['low', 'medium', 'high'],
        labels: { low: 'Quick reply', medium: 'Everyday help', high: 'Detailed planning' },
      }],
      active_session_id: null,
    }
  }
  if (pathname === '/chat/history') {
    if (state.mode === 'empty') return []
    return longHistory()
  }
  if (pathname === '/chat/async' && req.method === 'POST') {
    state.polls = 0
    return { job_id: 'job_preview', status: 'queued' }
  }
  if (pathname.startsWith('/chat/jobs/')) {
    if (pathname.endsWith('/speech')) return undefined
    state.polls += 1
    if (state.mode === 'thinking') return { job_id: 'job_preview', status: 'running' }
    return {
      job_id: 'job_preview',
      status: 'complete',
      reply: 'Good call. Go with **three sets of 8** at the same load, then add a back-off set at 60 kg only if the first three felt crisp.',
      preset: { id: 'everyday', name: 'Everyday help', label: 'Everyday help' },
    }
  }
  return undefined
}
