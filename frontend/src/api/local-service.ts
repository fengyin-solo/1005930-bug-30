import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAllRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OperatorInfo,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// ———— 并网调度专用链路 ————
// 一条调度指令的流转要同时落在两处：指令记录（dispatch）和电站台账（station）。
// 规矩：先把两侧的新数据都在内存里算好并完成对账，再一次落盘；算不出来或账对不上
// 就整笔放弃，绝不留「指令撤了、电站还限电」的半成品。
const DISPATCH_KEY = 'dispatch'
const STATION_KEY = 'station'
const CURTAIL_TYPE = '限电'

// 状态机：动作 → 允许的前置状态与目标状态，不在列的一律按越级拦截。
const DISPATCH_FLOW: Record<string, { from: string[]; to: string }> = {
  开始执行: { from: ['待执行'], to: '执行中' },
  确认执行: { from: ['执行中'], to: '已执行' },
  撤销指令: { from: ['待执行', '执行中'], to: '已撤销' },
}

// 动作 → 允许的角色。执行结果（含撤销结论）只有本电站值班长能落笔。
const DISPATCH_ACTION_ROLES: Record<string, string[]> = {
  开始执行: ['值班员', '值班长'],
  确认执行: ['值班长'],
  撤销指令: ['值班长'],
}

function isCurtailOrder(row: EntryRow): boolean {
  return String(row['指令类型'] ?? '').includes(CURTAIL_TYPE)
}

// 指令口径：哪些电站此刻应当限电——执行中/已执行的限电指令是唯一依据。
function curtailedStationCodes(dispatchRows: EntryRow[]): Set<string> {
  const codes = new Set<string>()
  for (const row of dispatchRows) {
    const status = String(row.status)
    if (isCurtailOrder(row) && (status === '执行中' || status === '已执行')) {
      const code = String(row['电站编号'] ?? '')
      if (code) {
        codes.add(code)
      }
    }
  }
  return codes
}

function countCurtailedStations(stationRows: EntryRow[]): number {
  return stationRows.filter((row) => String(row.status) === '限电运行').length
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  // 调度指令按生效时段归档：补录、查询都沿同一条时间轴走。
  const ordered =
    key === DISPATCH_KEY
      ? [...matched].sort((a, b) =>
          String(a['生效时段'] ?? '').localeCompare(String(b['生效时段'] ?? '')),
        )
      : matched
  return { items: ordered, total: ordered.length, page: 1, size: ordered.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  operator?: OperatorInfo,
): ActionResult {
  if (key === DISPATCH_KEY) {
    return runDispatchAction(id, action, operator)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const terminals = meta.terminalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: !terminals.includes(target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function runDispatchAction(id: number, action: string, operator?: OperatorInfo): ActionResult {
  const flow = DISPATCH_FLOW[action]
  if (!flow) {
    return { ok: false, message: `调度指令没有登记「${action}」这个动作` }
  }
  // 越权拦截：先验身份，再碰数据。
  if (!operator || !operator.name) {
    return { ok: false, message: '没有识别到值班人员，调度指令操作被拒绝' }
  }
  const allowedRoles = DISPATCH_ACTION_ROLES[action] ?? []
  if (!allowedRoles.includes(operator.role)) {
    return { ok: false, message: `${operator.role || '未登记岗位'}无权执行「${action}」，已拦截` }
  }
  const dispatchRows = listRows(DISPATCH_KEY)
  const index = dispatchRows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的调度指令` }
  }
  const order = dispatchRows[index]
  const stationCode = String(order['电站编号'] ?? '')
  if (!stationCode) {
    return { ok: false, message: `指令 ${order['指令编号'] ?? id} 没有登记电站编号，无法对账，已拦截` }
  }
  // 越权拦截：只能动本电站的指令，别站值班长也不行。
  if (operator.station !== stationCode) {
    return {
      ok: false,
      message: `指令属于电站 ${stationCode}，${operator.name} 只能操作本电站（${operator.station}）的指令，已拦截`,
    }
  }
  const current = String(order.status)
  // 幂等：重复撤销只算一次；历史欠账（指令撤了电站没回写）趁这次补平。
  if (action === '撤销指令' && current === '已撤销') {
    return settleRevokedOrder(order)
  }
  // 越级拦截：状态机之外的一律不放行。
  if (!flow.from.includes(current)) {
    if (action === '撤销指令' && current === '已执行') {
      return { ok: false, message: '指令已执行完毕，不能撤销；如需停发限电，请重新登记一条调度指令' }
    }
    return { ok: false, message: `指令当前为「${current}」，不能越级执行「${action}」，已拦截` }
  }

  // 先算后写：两侧新数据都在内存里算好并对账，通过才落盘。
  const stationRows = listRows(STATION_KEY)
  const stationIndex = stationRows.findIndex((row) => String(row['电站编号'] ?? '') === stationCode)
  const curtail = isCurtailOrder(order)
  if (curtail && stationIndex < 0) {
    return { ok: false, message: `电站台账里找不到 ${stationCode}，限电指令无法回写，整笔已放弃` }
  }

  const period = String(order['生效时段'] ?? '')
  const load = String(order['限电负荷'] ?? '')
  const updatedOrder: EntryRow = { ...order, status: flow.to, 指令状态: flow.to }
  let updatedStation: EntryRow | null = null

  if (action === '开始执行') {
    updatedOrder['执行人员'] = operator.name
    updatedOrder.pending = true
    updatedOrder.abnormal = false
    if (curtail) {
      updatedStation = { ...stationRows[stationIndex], status: '限电运行', 电站状态: '限电运行', pending: true }
    }
  } else if (action === '确认执行') {
    updatedOrder['执行结果'] = curtail
      ? `已按指令限电${load}，${operator.name} 确认（生效时段 ${period}）`
      : `已按指令执行完毕，${operator.name} 确认（生效时段 ${period}）`
    updatedOrder.pending = false
    updatedOrder.abnormal = false
    if (curtail) {
      updatedStation = { ...stationRows[stationIndex], status: '限电运行', 电站状态: '限电运行', pending: true }
    }
  } else {
    // 撤销指令：负荷收回、执行痕迹清掉、撤销结论按生效时段补录在执行结果里。
    updatedOrder['执行人员'] = ''
    updatedOrder['限电负荷'] = curtail ? '0MW' : load
    updatedOrder.pending = false
    updatedOrder.abnormal = true
    if (curtail) {
      // 该电站还有没有其它在效限电指令：有则维持限电，没有则恢复运行。
      const stillCurtailed = dispatchRows.some(
        (row) =>
          Number(row.id) !== id &&
          String(row['电站编号'] ?? '') === stationCode &&
          isCurtailOrder(row) &&
          ['执行中', '已执行'].includes(String(row.status)),
      )
      if (stillCurtailed) {
        updatedOrder['执行结果'] = `已撤销：限电负荷${load}已收回；电站 ${stationCode} 仍有其它在效限电指令，维持限电运行（生效时段 ${period}）`
      } else {
        updatedStation = { ...stationRows[stationIndex], status: '运行中', 电站状态: '运行中', pending: false }
        updatedOrder['执行结果'] = `已撤销：限电负荷${load}已收回，电站 ${stationCode} 恢复运行中（生效时段 ${period}）`
      }
    } else {
      updatedOrder['执行结果'] = `已撤销：指令未再执行（生效时段 ${period}）`
    }
  }

  const nextDispatch = [...dispatchRows]
  nextDispatch[index] = updatedOrder
  const nextStation = [...stationRows]
  if (updatedStation) {
    nextStation[stationIndex] = updatedStation
  }

  // 对账一：回写前后限电电站数的差额必须等于本次实际改动的电站数。
  const stationDelta = updatedStation
    ? (updatedStation.status === '限电运行' ? 1 : 0) -
      (String(stationRows[stationIndex].status) === '限电运行' ? 1 : 0)
    : 0
  const before = countCurtailedStations(stationRows)
  const after = countCurtailedStations(nextStation)
  if (after !== before + stationDelta) {
    return {
      ok: false,
      message: `限电电站数对不上：回写前 ${before}、回写后 ${after}、预期差额 ${stationDelta}，整笔已回退`,
    }
  }
  // 对账二：指令口径（在效限电指令覆盖的电站）必须全部落在电站口径（限电运行）之内。
  const stationCurtailedCodes = new Set(
    nextStation
      .filter((row) => String(row.status) === '限电运行')
      .map((row) => String(row['电站编号'] ?? '')),
  )
  for (const code of curtailedStationCodes(nextDispatch)) {
    if (!stationCurtailedCodes.has(code)) {
      return { ok: false, message: `电站 ${code} 有在效限电指令但台账未限电，两处口径对不上，整笔已回退` }
    }
  }

  saveAllRows({ [DISPATCH_KEY]: nextDispatch, [STATION_KEY]: nextStation })
  return { ok: true, message: `指令 ${order['指令编号']} 已${action}，当前状态「${flow.to}」` }
}

// 重复撤销只算一次：已撤销的指令本身不再改；
// 但历史欠账（指令撤了、电站还挂着限电）趁这次补平，同样先对账再落盘。
function settleRevokedOrder(order: EntryRow): ActionResult {
  const code = String(order['指令编号'] ?? order.id)
  const stationCode = String(order['电站编号'] ?? '')
  const dispatchRows = listRows(DISPATCH_KEY)
  const stationRows = listRows(STATION_KEY)
  const stationIndex = stationRows.findIndex((row) => String(row['电站编号'] ?? '') === stationCode)
  const station = stationIndex >= 0 ? stationRows[stationIndex] : null
  const stillCurtailed = dispatchRows.some(
    (row) =>
      Number(row.id) !== Number(order.id) &&
      String(row['电站编号'] ?? '') === stationCode &&
      isCurtailOrder(row) &&
      ['执行中', '已执行'].includes(String(row.status)),
  )
  if (!station || stillCurtailed || String(station.status) !== '限电运行' || !isCurtailOrder(order)) {
    return { ok: true, message: `指令 ${code} 已是「已撤销」，本次未重复执行` }
  }
  const nextStation = [...stationRows]
  nextStation[stationIndex] = { ...station, status: '运行中', 电站状态: '运行中', pending: false }
  if (countCurtailedStations(nextStation) !== countCurtailedStations(stationRows) - 1) {
    return { ok: false, message: `电站 ${stationCode} 限电数对账失败，补偿回写已放弃` }
  }
  saveAllRows({ [STATION_KEY]: nextStation })
  return { ok: true, message: `指令 ${code} 此前已撤销，本次补记电站 ${stationCode} 的限电收回` }
}

export type DispatchEntryInput = {
  电站编号: string
  调度机构: string
  指令类型: string
  限电负荷: string
  生效时段: string
}

// 登记/补录：新指令按生效时段插进时间轴，不堆在列表末尾。
export function createDispatchEntry(input: DispatchEntryInput, operator?: OperatorInfo): ActionResult {
  if (!operator || operator.role !== '值班长') {
    return { ok: false, message: '只有值班长能登记调度指令，已拦截' }
  }
  if (!input.电站编号 || operator.station !== input.电站编号) {
    return { ok: false, message: `只能登记本电站（${operator.station}）的调度指令，已拦截` }
  }
  if (!input.调度机构.trim() || !input.生效时段.trim()) {
    return { ok: false, message: '调度机构和生效时段不能为空' }
  }
  if (input.指令类型.includes(CURTAIL_TYPE) && !input.限电负荷.trim()) {
    return { ok: false, message: '限电指令必须登记限电负荷' }
  }
  const rows = listRows(DISPATCH_KEY)
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const entry: EntryRow = {
    id: nextId,
    status: '待执行',
    pending: true,
    abnormal: false,
    指令编号: `DISP-${String(nextId).padStart(4, '0')}`,
    电站编号: input.电站编号,
    调度机构: input.调度机构.trim(),
    指令类型: input.指令类型,
    限电负荷: input.限电负荷.trim() || '0MW',
    生效时段: input.生效时段.trim(),
    执行人员: '',
    执行结果: '',
    指令状态: '待执行',
  }
  const next = [...rows, entry].sort((a, b) =>
    String(a['生效时段'] ?? '').localeCompare(String(b['生效时段'] ?? '')),
  )
  saveAllRows({ [DISPATCH_KEY]: next })
  return { ok: true, message: `调度指令 ${entry['指令编号']} 已按生效时段 ${entry['生效时段']} 补录` }
}

// 两个页面的「限电电站」同口径：一个按指令算、一个按台账算，撤销后两边必须一致。
export function dispatchSummary(): { label: string; value: number }[] {
  const rows = listRows(DISPATCH_KEY)
  return [
    { label: '待执行指令', value: rows.filter((row) => String(row.status) === '待执行').length },
    { label: '执行中指令', value: rows.filter((row) => String(row.status) === '执行中').length },
    { label: '限电电站', value: curtailedStationCodes(rows).size },
  ]
}

export function stationSummary(): { label: string; value: string | number }[] {
  const rows = listRows(STATION_KEY)
  const capacity = rows.reduce((sum, row) => sum + (Number(row['装机容量']) || 0), 0)
  return [
    { label: '在运电站', value: rows.filter((row) => ['运行中', '限电运行'].includes(String(row.status))).length },
    { label: '装机总容量', value: `${capacity}MW` },
    { label: '限电电站', value: countCurtailedStations(rows) },
  ]
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
