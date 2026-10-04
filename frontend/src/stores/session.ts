import { defineStore } from 'pinia'

import type { Actor } from '@/data/types'

// 预置几类身份，方便演示越权 / 越级拦截：调度员跨站、值班长管本站、值班员无权。
export const ACTOR_PRESETS: (Actor & { label: string })[] = [
  { label: '本站值班长 · 王峰', name: '王峰', role: '值班长', station: 'STAT-0001' },
  { label: '调度中心调度员 · 陈立', name: '陈立', role: '调度员', station: '调度中心' },
  { label: '他站值班长 · 李海', name: '李海', role: '值班长', station: 'STAT-0002' },
  { label: '本站值班员 · 周明', name: '周明', role: '值班员', station: 'STAT-0001' },
]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '王峰',
    shiftLabel: '白班 08:00-20:00',
    scope: '光伏电站运行维护管理平台',
    role: '值班长' as Actor['role'],
    station: 'STAT-0001',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    actor: (state): Actor => ({ name: state.operator, role: state.role, station: state.station }),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    switchActor(preset: Actor & { label?: string }) {
      this.operator = preset.name
      this.role = preset.role
      this.station = preset.station
    },
  },
})
