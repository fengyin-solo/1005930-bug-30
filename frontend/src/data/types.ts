/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  // 调度动作回写电站台账后，两边限电电站数与指令快照一并带回，页面可直接核对。
  stationLimitedCount?: number
  dispatchLimitedCount?: number
}

// 提交调度动作时的操作人身份：岗位决定能不能做、所属电站决定能不能越级。
export type Actor = {
  name: string
  role: '调度员' | '值班长' | '值班员'
  station: string
}

export type DispatchDraft = {
  指令类型: string
  所属电站: string
  限电负荷: string
  生效开始: string
  生效结束: string
}

export type LimitCounts = {
  // 电站台账口径：当前停在「限电运行」的电站数
  stationLimitedCount: number
  // 指令时段口径：存在生效中限电指令、应当限电的去重电站数
  dispatchLimitedCount: number
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
