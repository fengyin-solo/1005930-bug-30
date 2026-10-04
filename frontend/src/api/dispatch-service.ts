import { commitAll, listRows } from '@/data/local-store'
import type {
  ActionResult,
  Actor,
  DispatchDraft,
  EntryRow,
  LimitCounts,
} from '@/data/types'

// 调度指令与电站台账之间的联动全部收口在这一个文件：
// 页面只调这里的动作，电站台账不单独改限电状态，避免两处各改各的、数字对不上。

const DISPATCH_KEY = 'dispatch'
const STATION_KEY = 'station'
const STATION_RUNNING = '运行中'
const STATION_LIMITED = '限电运行'
const DRIVEN_STATUSES = new Set([STATION_RUNNING, STATION_LIMITED])
const TERMINAL_STATUSES = new Set(['已执行', '已撤销'])

// mutate 的三种结论：拒绝（原样返回失败）、幂等完成（不写盘直接成功）、继续（提交事务）。
type MutationOutcome =
  | { type: 'reject'; message: string }
  | { type: 'done'; message: string }
  | { type: 'proceed'; message: string }

// ---------- 时段口径 ----------

// 指令时段是限电是否成立的唯一依据。台账状态与指令时段打架时，听指令时段的：
// 时段覆盖当前时刻才算生效中，时段过去就自动恢复，撤销则立刻从生效集合里剔除。
function startOf(row: EntryRow): number {
  const raw = String(row.生效开始 ?? '').trim()
  const time = raw ? Date.parse(raw.replace(' ', 'T')) : NaN
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time
}

function isActiveAt(row: EntryRow, now: number): boolean {
  const begin = startOf(row)
  if (!Number.isFinite(begin)) {
    return false
  }
  const endRaw = String(row.生效结束 ?? '').trim()
  const end = endRaw ? Date.parse(endRaw.replace(' ', 'T')) : NaN
  return begin <= now && (Number.isNaN(end) || now <= end)
}

// 生效中的限电指令：未撤销、限电类、带限电负荷、已开工（执行中/已执行）、当前时刻在时段内。
export function activeLimitOrders(rows: EntryRow[], now: number = Date.now()): EntryRow[] {
  return rows.filter(
    (row) =>
      row.status !== '已撤销' &&
      String(row.指令类型 ?? '') !== '恢复送电' &&
      String(row.限电负荷 ?? '').trim() !== '' &&
      (row.status === '执行中' || row.status === '已执行') &&
      isActiveAt(row, now),
  )
}

// 指令口径：存在生效限电指令的去重电站集合。
function dispatchLimitedSet(rows: EntryRow[], now: number): Set<string> {
  return new Set(activeLimitOrders(rows, now).map((row) => String(row.所属电站 ?? '')))
}

// ---------- 台账回写 ----------

function appendLedger(row: EntryRow, line: string): void {
  const prev = String(row.调度台账记录 ?? '').trim()
  row.调度台账记录 = prev ? `${prev}；${line}` : line
}

function formatTime(time: number): string {
  const d = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 撤销结论回写电站台账，并把台账限电状态对齐到「生效限电指令」这一指令口径。
// 只有状态/依据真的变化时才追加台账行；待投运、停运检修不由调度指令驱动，跳过。
function reconcileStations(
  snapshot: Record<string, EntryRow[]>,
  now: number,
): LimitCounts {
  const orders = snapshot[DISPATCH_KEY] ?? []
  const stations = snapshot[STATION_KEY] ?? []
  const limitedSet = dispatchLimitedSet(orders, now)

  for (const station of stations) {
    const code = String(station.电站编号 ?? '')
    const current = String(station.status)
    if (!DRIVEN_STATUSES.has(current)) {
      continue
    }
    const basisOrders = activeLimitOrders(orders, now).filter(
      (order) => String(order.所属电站 ?? '') === code,
    )
    // 多条生效指令时取最早一条作为限电依据，保证台账依据是确定值。
    const basis = basisOrders.sort((a, b) => startOf(a) - startOf(b))[0]
    const nextStatus = basis ? STATION_LIMITED : STATION_RUNNING

    station.限电依据 = basis ? String(basis.指令编号) : ''
    if (current !== nextStatus) {
      station.status = nextStatus
      station.电站状态 = nextStatus
      station.pending = nextStatus !== STATION_RUNNING
      if (basis) {
        appendLedger(station, `${formatTime(now)} 按${String(basis.指令编号)}生效时段登记限电`)
      } else {
        appendLedger(station, `${formatTime(now)} 限电指令已撤销或时段结束，恢复${STATION_RUNNING}`)
      }
    }
  }

  // 两处口径同源：台账停在「限电运行」的电站，必须正是指令集合里那些在运限电电站。
  const eligible = new Set(
    stations.filter((row) => DRIVEN_STATUSES.has(String(row.status))).map((row) => String(row.电站编号 ?? '')),
  )
  return {
    stationLimitedCount: stations.filter((row) => String(row.status) === STATION_LIMITED).length,
    dispatchLimitedCount: [...limitedSet].filter((code) => eligible.has(code)).length,
  }
}

// ---------- 权限 ----------

function assertRevoke(actor: Actor, order: EntryRow): string | null {
  const station = String(order.所属电站 ?? '')
  if (actor.role === '值班员') {
    return '越权操作被拦截：值班员无权撤销调度指令，需由本电站值班长或调度中心办理'
  }
  if (actor.role === '值班长' && actor.station !== station) {
    return `越级操作被拦截：值班长只能撤销本电站（${actor.station}）的指令，该指令属于${station}`
  }
  // 调度员跨站可撤，本站值班长可撤。
  return null
}

// 执行结果（开始执行 / 确认执行）只有本电站值班长能动，调度员也不能代填。
function assertExecute(actor: Actor, order: EntryRow): string | null {
  if (actor.role !== '值班长') {
    return `越权操作被拦截：执行结果只能由本电站值班长登记，${actor.role}无权操作`
  }
  if (actor.station !== String(order.所属电站 ?? '')) {
    return `越级操作被拦截：该指令属于${String(order.所属电站 ?? '')}，非本电站值班长不能登记执行结果`
  }
  return null
}

function assertIssue(actor: Actor, draft: DispatchDraft): string | null {
  if (actor.role === '值班员') {
    return '越权操作被拦截：值班员无权发布调度指令'
  }
  if (actor.role === '值班长' && actor.station !== draft.所属电站) {
    return `越级发布被拦截：值班长只能向本电站（${actor.station}）发布指令`
  }
  return null
}

// ---------- 事务骨架 ----------

function cloneRows(): Record<string, EntryRow[]> {
  return JSON.parse(
    JSON.stringify({ dispatch: listRows(DISPATCH_KEY), station: listRows(STATION_KEY) }),
  ) as Record<string, EntryRow[]>
}

function findOrder(snapshot: Record<string, EntryRow[]>, id: number): EntryRow | undefined {
  return snapshot[DISPATCH_KEY].find((row) => Number(row.id) === id)
}

// 一次撤销要经过：校验身份与指令状态 → 在事务草稿里改指令 → 回写电站台账与限电依据
// → 校验两边限电电站数一致 → 一次性写盘。任何一步不通过，整笔回退、不留半成品。
function commitDispatchMutation(
  mutate: (snapshot: Record<string, EntryRow[]>) => MutationOutcome,
): ActionResult {
  const snapshot = cloneRows()
  let outcome: MutationOutcome
  try {
    outcome = mutate(snapshot)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '操作未执行' }
  }
  if (outcome.type === 'reject') {
    return { ok: false, message: outcome.message }
  }

  // 幂等完成（如重复撤销）：什么都不改、什么都不写，直接带当前计数返回。
  if (outcome.type === 'done') {
    return { ok: true, message: outcome.message, ...currentCounts() }
  }

  try {
    // 回滚前先在草稿上对齐台账，再核对两处数字：对不上就整笔回退，绝不写一半。
    const counts = reconcileStations(snapshot, Date.now())
    if (counts.stationLimitedCount !== counts.dispatchLimitedCount) {
      return {
        ok: false,
        message: `限电电站数校验失败（台账${counts.stationLimitedCount}座 / 指令口径${counts.dispatchLimitedCount}座），整笔回退，未写入任何数据`,
      }
    }
    commitAll((target) => {
      target[DISPATCH_KEY] = snapshot[DISPATCH_KEY]
      target[STATION_KEY] = snapshot[STATION_KEY]
    })
    return { ok: true, message: outcome.message, ...counts }
  } catch (error) {
    return {
      ok: false,
      message: `写入失败，已整笔回退：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }
}

// ---------- 动作 ----------

export function revokeDispatch(id: number, actor: Actor): ActionResult {
  return commitDispatchMutation((snapshot) => {
    const order = findOrder(snapshot, id)
    if (!order) {
      return { type: 'reject', message: `没有找到编号为 ${id} 的调度指令` }
    }
    // 重复提交撤销只算一次：已撤销直接原样成功，不产生任何回写、不多待办。
    if (String(order.status) === '已撤销') {
      return {
        type: 'done',
        message: `指令${String(order.指令编号)}已是「已撤销」，重复撤销只计一次`,
      }
    }
    const denied = assertRevoke(actor, order)
    if (denied) {
      return { type: 'reject', message: denied }
    }
    // 已经执行过的指令不能再撤，要停就重新发一条（恢复送电或新的限电）指令。
    if (String(order.status) === '已执行') {
      return {
        type: 'reject',
        message: `指令${String(order.指令编号)}已执行，不能撤销；如需停止限电请重新发布一条「恢复送电」指令`,
      }
    }

    const now = Date.now()
    // 第一步：改指令记录——状态、执行人/执行结果一次退净。
    order.status = '已撤销'
    order.指令状态 = '已撤销'
    order.pending = false
    order.abnormal = true
    order.执行人员 = ''
    order.执行结果 = `已撤销（${formatTime(now)} ${actor.name}）`
    order.撤销人 = actor.name
    order.撤销时间 = formatTime(now)
    // 第二步（回写电站台账、清限电依据、恢复运行中、记撤销结论）由
    // reconcileStations 在同一事务草稿里完成，与指令记录一次性写盘。

    return {
      type: 'proceed',
      message: `指令${String(order.指令编号)}已撤销，电站限电负荷已收回，执行人/执行结果与台账同步退净`,
    }
  })
}

export function startDispatch(id: number, actor: Actor): ActionResult {
  return commitDispatchMutation((snapshot) => {
    const order = findOrder(snapshot, id)
    if (!order) {
      return { type: 'reject', message: `没有找到编号为 ${id} 的调度指令` }
    }
    // 权限先于状态判断：越权/越级提交一律拦截，不能借「重复操作」绕过授权。
    const denied = assertExecute(actor, order)
    if (denied) {
      return { type: 'reject', message: denied }
    }
    if (String(order.status) === '执行中') {
      return { type: 'reject', message: `指令${String(order.指令编号)}已在执行中，不用重复操作` }
    }
    if (TERMINAL_STATUSES.has(String(order.status))) {
      return { type: 'reject', message: `指令${String(order.指令编号)}已${String(order.status)}，不能再开始执行` }
    }
    order.status = '执行中'
    order.指令状态 = '执行中'
    order.pending = true
    order.执行人员 = actor.name
    order.执行结果 = `执行中（${formatTime(Date.now())} ${actor.name} 开工）`
    return { type: 'proceed', message: `指令${String(order.指令编号)}已开始执行` }
  })
}

export function confirmDispatch(id: number, actor: Actor): ActionResult {
  return commitDispatchMutation((snapshot) => {
    const order = findOrder(snapshot, id)
    if (!order) {
      return { type: 'reject', message: `没有找到编号为 ${id} 的调度指令` }
    }
    // 权限先于状态判断：执行结果只有本电站值班长能动。
    const denied = assertExecute(actor, order)
    if (denied) {
      return { type: 'reject', message: denied }
    }
    if (String(order.status) === '已执行') {
      return { type: 'reject', message: `指令${String(order.指令编号)}已确认执行，不用重复操作` }
    }
    if (String(order.status) !== '执行中') {
      return { type: 'reject', message: `指令${String(order.指令编号)}需先开始执行，才能确认执行结果` }
    }
    const now = Date.now()
    order.status = '已执行'
    order.指令状态 = '已执行'
    order.pending = false
    order.执行人员 = order.执行人员 || actor.name
    order.执行结果 = `已按${String(order.限电负荷 ?? '')}限电运行（${formatTime(now)} ${actor.name} 确认）`

    const station = snapshot[STATION_KEY].find(
      (row) => String(row.电站编号 ?? '') === String(order.所属电站 ?? ''),
    )
    if (station && DRIVEN_STATUSES.has(String(station.status)) && isActiveAt(order, now)) {
      appendLedger(station, `${formatTime(now)} ${actor.name} 确认执行${String(order.指令编号)}`)
    }
    return { type: 'proceed', message: `指令${String(order.指令编号)}执行结果已登记` }
  })
}

export function issueDispatch(draft: DispatchDraft, actor: Actor): ActionResult {
  return commitDispatchMutation((snapshot) => {
    const denied = assertIssue(actor, draft)
    if (denied) {
      return { type: 'reject', message: denied }
    }
    const station = snapshot[STATION_KEY].find(
      (row) => String(row.电站编号 ?? '') === draft.所属电站,
    )
    if (!station) {
      return { type: 'reject', message: `电站台账中不存在 ${draft.所属电站}，无法下达指令` }
    }
    const begin = Date.parse(draft.生效开始)
    const end = Date.parse(draft.生效结束)
    if (Number.isNaN(begin) || Number.isNaN(end) || end <= begin) {
      return { type: 'reject', message: '生效时段不合法：结束时间必须晚于开始时间' }
    }
    const isCurtail = draft.指令类型 !== '恢复送电'
    if (isCurtail && String(draft.限电负荷 ?? '').trim() === '') {
      return { type: 'reject', message: '限电指令必须填写限电负荷' }
    }

    const orders = snapshot[DISPATCH_KEY]
    const nextId = orders.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    const seq = String(nextId).padStart(4, '0')
    const row: EntryRow = {
      id: nextId,
      status: '待执行',
      pending: true,
      abnormal: false,
      指令编号: `DISP-${seq}`,
      所属电站: draft.所属电站,
      调度机构: actor.role === '调度员' ? '调度中心' : '电站调度',
      指令类型: draft.指令类型,
      限电负荷: isCurtail ? draft.限电负荷 : '',
      生效开始: draft.生效开始,
      生效结束: draft.生效结束,
      生效时段: `${draft.生效开始.replace('T', ' ')} ~ ${draft.生效结束.replace('T', ' ')}`,
      执行人员: '',
      执行结果: '',
      指令状态: '待执行',
    }
    orders.push(row)
    // 指令记录按生效时段补录：新指令按生效开始时间插序，台账始终按时段有序。
    orders.sort((a, b) => startOf(a) - startOf(b))
    appendLedger(station, `${formatTime(Date.now())} ${actor.name} 下达${row.指令编号}（${draft.指令类型}）`)
    return { type: 'proceed', message: `指令${row.指令编号}已下达，电站台账已补录` }
  })
}

function currentCounts(now: number = Date.now()): LimitCounts {
  const orders = listRows(DISPATCH_KEY)
  const stations = listRows(STATION_KEY)
  const eligible = new Set(
    stations
      .filter((row) => DRIVEN_STATUSES.has(String(row.status)))
      .map((row) => String(row.电站编号 ?? '')),
  )
  return {
    stationLimitedCount: stations.filter((row) => String(row.status) === STATION_LIMITED).length,
    dispatchLimitedCount: [...dispatchLimitedSet(orders, now)].filter((code) => eligible.has(code))
      .length,
  }
}

// 页面挂载时对齐口径：电站台账以指令时段为准自愈一遍，两处限电电站数始终同源。
export function syncStationsToOrders(): LimitCounts {
  const snapshot = cloneRows()
  const before = JSON.stringify(snapshot[STATION_KEY])
  const counts = reconcileStations(snapshot, Date.now())
  if (JSON.stringify(snapshot[STATION_KEY]) !== before) {
    commitAll((target) => {
      target[DISPATCH_KEY] = snapshot[DISPATCH_KEY]
      target[STATION_KEY] = snapshot[STATION_KEY]
    })
  }
  return counts
}

export function limitCounts(): LimitCounts {
  return currentCounts()
}
