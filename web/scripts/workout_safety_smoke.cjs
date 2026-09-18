const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  })
  module._compile(outputText, filename)
}

const {
  applyCoachExerciseUpdateToDraft,
  protectLoggedExercises,
  reconcileExerciseIds,
} = require('../src/utils/workoutSafety.ts')
const {
  normalizeMetricTarget,
  normalizeWeightTarget,
  normalizeWorkoutTargetText,
} = require('../src/utils/workoutDisplay.ts')

assert.equal(normalizeWorkoutTargetText({ value: 0, unit: 'kg' }), '0kg')
assert.equal(normalizeWeightTarget({ value: 0, unit: 'kg' }), '0kg')
assert.equal(normalizeMetricTarget({ value: 0, unit: '' }), '0')

const makeSquat = (overrides = {}) => ({
  id: 'db_squat',
  name: 'Dumbbell Squat',
  standardName: 'Dumbbell Squat',
  section: 'Main',
  summary: '2 sets x 10 - 20kg',
  restSec: 75,
  metric: 'reps',
  sets: [
    { targetReps: '10', targetWeight: '20kg' },
    { targetReps: '10', targetWeight: '20kg' },
  ],
  cues: ['Brace and sit between hips'],
  equipment: 'dumbbell',
  ...overrides,
})

const loggedStates = [
  { weight: '20kg', metric: '10', done: true },
  { weight: '', metric: '', done: false },
]

{
  const existing = [makeSquat()]
  const incoming = [
    makeSquat({
      id: 'db_squat',
      name: 'Barbell Squat',
      standardName: 'Barbell Squat',
      equipment: 'barbell',
      sets: [
        { targetReps: '8', targetWeight: '40kg' },
        { targetReps: '8', targetWeight: '40kg' },
      ],
    }),
  ]

  const reconciled = reconcileExerciseIds(incoming, existing)
  const protectedExercises = protectLoggedExercises(reconciled, existing, { db_squat: loggedStates })

  assert.equal(protectedExercises.length, 1)
  assert.equal(protectedExercises[0].id, 'db_squat')
  assert.equal(protectedExercises[0].name, 'Dumbbell Squat')
  assert.equal(protectedExercises[0].equipment, 'dumbbell')
}

{
  const existing = [makeSquat()]
  const incoming = [
    makeSquat({
      id: 'db_squat',
      sets: [
        { targetReps: '8', targetWeight: '40kg' },
        { targetReps: '12', targetWeight: '24kg' },
        { targetReps: '12', targetWeight: '24kg' },
      ],
    }),
  ]

  const protectedExercises = protectLoggedExercises(incoming, existing, { db_squat: loggedStates })

  assert.equal(protectedExercises.length, 1)
  assert.equal(protectedExercises[0].id, 'db_squat')
  assert.equal(protectedExercises[0].name, 'Dumbbell Squat')
  assert.deepEqual(protectedExercises[0].sets[0], { targetReps: '10', targetWeight: '20kg' })
  assert.deepEqual(protectedExercises[0].sets[1], { targetReps: '12', targetWeight: '24kg' })
  assert.deepEqual(protectedExercises[0].sets[2], { targetReps: '12', targetWeight: '24kg' })
}

{
  const exercise = makeSquat()
  const states = loggedStates.map((state) => ({ ...state }))

  const changed = applyCoachExerciseUpdateToDraft(exercise, states, {
    exerciseId: 'db_squat',
    name: 'Barbell Squat',
    standardName: 'Barbell Squat',
    equipment: 'barbell',
    reps: '8',
    weight: '40kg',
    setCount: 2,
  })

  assert.equal(changed, true)
  assert.equal(exercise.id, 'db_squat')
  assert.equal(exercise.name, 'Barbell Squat')
  assert.equal(exercise.equipment, 'barbell')
  assert.deepEqual(states[0], { weight: '20kg', metric: '10', done: true })
  assert.deepEqual(states[1], { weight: '40kg', metric: '8', done: false })
  assert.equal(exercise.sets[1].targetWeight, '40kg')
  assert.equal(exercise.sets[1].targetReps, '8')
}

console.log('workout safety smoke passed')
