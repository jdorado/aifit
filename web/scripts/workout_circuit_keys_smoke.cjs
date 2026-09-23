// Circuit-key smoke. Executes the real WorkoutPlanList render with two
// same-titled circuits — the shape an agent override produces when it keeps
// logged history next to the replacement plan — and proves every element in
// the returned tree carries a unique key. A title-based key made React leave
// the previous day's circuit rows mounted, so empty/future days rendered
// phantom completed cards. Segment identity, not the human title, owns the key.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '../src/components/workout/WorkoutPlanList.tsx'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText

const react = require('react')
const jsxRuntime = require('react/jsx-runtime')

const exercise = (id, circuitKey, title) => ({
  id,
  name: `${id} movement`,
  standardName: `${id} movement`,
  section: title,
  summary: '2 sets x 10',
  metric: 'reps',
  sets: [{ setId: `${id}-1` }, { setId: `${id}-2` }],
  circuit: {
    name: title,
    key: circuitKey,
    rounds: 2,
    restAfterSec: 60,
    order: 1,
    totalExercises: 1,
  },
})

// Logged history preserved by an override plus the replacement segment: both
// segments carry the same human title, only segment_id tells them apart.
const exercises = [
  exercise('ex_logged', 'seg_main', 'Chest + Back'),
  exercise('ex_replacement', 'seg_today_main', 'Chest + Back'),
]

const hooks = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
  useCallback: (fn) => fn,
}

const collectKeys = (node, keys, pathLabel) => {
  if (Array.isArray(node)) {
    node.forEach((child, index) => collectKeys(child, keys, `${pathLabel}[${index}]`))
    return
  }
  if (!react.isValidElement(node)) return
  if (node.key !== null) keys.push({ key: node.key, path: pathLabel })
  const children = node.props?.children
  collectKeys(children, keys, pathLabel)
}

const moduleExports = {}
const localRequire = (id) => {
  if (id === 'react') return { ...react, ...hooks }
  if (id === 'react/jsx-runtime') return jsxRuntime
  if (id === '../../i18n') return { useI18n: () => ({ t: (key) => key }) }
  if (id === '../../data/testWorkout') {
    return { circuitGroupKey: (circuit) => circuit?.key ?? circuit?.name }
  }
  if (id === './PlanNotes') return { __esModule: true, default: () => null }
  throw new Error(`unexpected import in WorkoutPlanList: ${id}`)
}

new Function('require', 'exports', 'module', compiled)(localRequire, moduleExports, { exports: moduleExports })
const WorkoutPlanList = moduleExports.default

const tree = WorkoutPlanList({
  activeEntryId: null,
  hasWeekWorkouts: true,
  loading: false,
  selectedDayLabel: 'Tue',
  exercises,
  extras: [],
  setLogs: {},
  planNotes: '',
  canEditPlanNotes: true,
  savingPlanNotes: false,
  onSavePlanNotes: async () => true,
  circuitGroups: new Map([
    ['seg_main', { items: [{ exercise: exercises[0], index: 0 }], rounds: 2, restAfterSec: 60, totalExercises: 1 }],
    ['seg_today_main', { items: [{ exercise: exercises[1], index: 1 }], rounds: 2, restAfterSec: 60, totalExercises: 1 }],
  ]),
  getNextCircuitExercise: () => exercises[0],
  onSelectEntry: () => undefined,
})

const keys = []
collectKeys(tree, keys, 'root')
const duplicates = keys
  .map(({ key }) => key)
  .filter((key, index, all) => all.indexOf(key) !== index)
assert.deepEqual(duplicates, [], `same-titled circuits must not share a React key: ${duplicates.join(', ')}`)

const circuitKeys = keys.map(({ key }) => String(key)).filter((key) => key.startsWith('circuit-row-'))
assert.deepEqual(
  circuitKeys.sort(),
  ['circuit-row-seg_main', 'circuit-row-seg_today_main'],
  'circuit rows must be keyed by segment identity',
)

console.log('workout circuit keys smoke passed')
