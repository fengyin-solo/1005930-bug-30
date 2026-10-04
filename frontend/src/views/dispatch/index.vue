<template>
  <section class="page" data-module="dispatch">
    <header class="page-head">
      <div>
        <h2>并网调度管理</h2>
        <p class="page-desc">维护调度指令，围绕指令编号、调度机构、指令类型、限电负荷做登记、筛选与状态流转；撤销在详情面板办理，指令与电站台账同笔进退。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记调度指令</button>
        <button class="btn" type="button" @click="exportRows">导出并网调度清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="reconcile-bar" :class="{ mismatch: counts.stationLimitedCount !== counts.dispatchLimitedCount }">
      限电电站数核对：电站台账 <strong>{{ counts.stationLimitedCount }}</strong> 座 ·
      指令时段口径 <strong>{{ counts.dispatchLimitedCount }}</strong> 座
      <span v-if="counts.stationLimitedCount === counts.dispatchLimitedCount">（两处一致）</span>
      <span v-else>（数字对不上，已阻止提交）</span>
    </p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' ? '—' : (row[column] ?? '—') }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情 / 办理</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无并网调度数据，可先登记调度指令</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条调度指令记录（按生效时段排列）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 详情面板：撤销链路只在这里办理，指令、执行结果、电站台账同笔进退 -->
    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>调度指令详情</h3>
          <button class="link" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-list">
          <template v-for="field in columns" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ detail[field] === '' ? '—' : (detail[field] ?? '—') }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detail.status }}</dd>
          <dt>撤销人</dt>
          <dd>{{ detail.撤销人 || '—' }}</dd>
          <dt>撤销时间</dt>
          <dd>{{ detail.撤销时间 || '—' }}</dd>
        </dl>

        <section class="drawer-station">
          <h4>电站台账联动</h4>
          <p v-if="linkedStation">
            {{ linkedStation.电站编号 }} · {{ linkedStation.电站名称 }} ——
            当前台账状态「{{ linkedStation.status }}」，限电依据：{{ linkedStation.限电依据 || '无' }}
          </p>
          <p v-else class="error-text">台账中找不到 {{ detail.所属电站 }}，该指令提交时将整笔回退</p>
          <p class="ledger-log">台账记录：{{ linkedStation?.调度台账记录 || '—' }}</p>
        </section>

        <div class="drawer-actions">
          <button class="btn" type="button" :disabled="detail.status !== '待执行'" @click="doAction('start')">
            开始执行
          </button>
          <button class="btn" type="button" :disabled="detail.status !== '执行中'" @click="doAction('confirm')">
            确认执行
          </button>
          <button
            class="btn danger"
            type="button"
            :disabled="detail.status === '已执行' || detail.status === '已撤销'"
            @click="doAction('revoke')"
          >
            撤销指令
          </button>
          <button
            v-if="detail.status === '已执行'"
            class="btn primary"
            type="button"
            @click="openCreateForStation(String(detail.所属电站))"
          >
            重新发布恢复送电指令
          </button>
        </div>
        <p class="action-hint">
          当前身份：{{ store.operator }}（{{ store.role }}
          <template v-if="store.station !== '调度中心'">· {{ store.station }}</template>）。
          执行结果仅本电站值班长可登记；撤销可由本电站值班长或调度中心办理。
        </p>
        <p v-if="detailMessage" class="result-text" :class="{ ok: detailOk }">{{ detailMessage }}</p>
      </aside>
    </div>

    <!-- 新指令登记 -->
    <div v-if="creating" class="drawer-mask" @click.self="creating = false">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>登记调度指令</h3>
          <button class="link" type="button" @click="creating = false">关闭</button>
        </header>
        <form class="create-form" @submit.prevent="submitCreate">
          <label>
            <span>所属电站</span>
            <select v-model="draft.所属电站" required>
              <option value="" disabled>请选择电站</option>
              <option v-for="station in stations" :key="String(station.id)" :value="station.电站编号">
                {{ station.电站编号 }} · {{ station.电站名称 }}
              </option>
            </select>
          </label>
          <label>
            <span>指令类型</span>
            <select v-model="draft.指令类型">
              <option value="限电">限电</option>
              <option value="恢复送电">恢复送电</option>
            </select>
          </label>
          <label v-if="draft.指令类型 !== '恢复送电'">
            <span>限电负荷</span>
            <input v-model="draft.限电负荷" placeholder="如 15MW" required />
          </label>
          <label>
            <span>生效开始</span>
            <input v-model="draft.生效开始" type="datetime-local" required />
          </label>
          <label>
            <span>生效结束</span>
            <input v-model="draft.生效结束" type="datetime-local" required />
          </label>
          <p v-if="createError" class="error-text">{{ createError }}</p>
          <button class="btn primary" type="submit">下达指令</button>
        </form>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import {
  confirmDispatch,
  issueDispatch,
  limitCounts,
  revokeDispatch,
  startDispatch,
  syncStationsToOrders,
} from '@/api/dispatch-service'
import { listRows } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type { DispatchDraft, EntryRow } from '@/data/types'

const meta = moduleMeta('dispatch')
const store = useSessionStore()
const columns = ["指令编号", "所属电站", "调度机构", "指令类型", "限电负荷", "生效时段", "执行人员", "执行结果", "指令状态"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const counts = ref(limitCounts())

const stats = computed(() => [
  { label: '待执行指令', value: rows.value.filter((row) => row.status === '待执行').length },
  { label: '执行中指令', value: rows.value.filter((row) => row.status === '执行中').length },
  { label: '限电电站（两处同步）', value: counts.value.dispatchLimitedCount },
])

const statusSummary = computed(() =>
  ['待执行', '执行中', '已执行', '已撤销'].map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stations = ref<EntryRow[]>([])
const detail = ref<EntryRow | null>(null)
const detailMessage = ref('')
const detailOk = ref(false)
const creating = ref(false)
const createError = ref('')

const linkedStation = computed(() =>
  detail.value
    ? stations.value.find((row) => String(row.电站编号) === String(detail.value!.所属电站))
    : undefined,
)

function emptyDraft(station = ''): DispatchDraft {
  return {
    指令类型: '限电',
    所属电站: station,
    限电负荷: '',
    生效开始: '',
    生效结束: '',
  }
}
const draft = ref<DispatchDraft>(emptyDraft())

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  createError.value = ''
  const presetStation = store.station !== '调度中心' ? store.station : ''
  draft.value = emptyDraft(presetStation)
  creating.value = true
}

function openCreateForStation(station: string) {
  closeDetail()
  createError.value = ''
  draft.value = { ...emptyDraft(station), 指令类型: '恢复送电' }
  creating.value = true
}

function submitCreate() {
  const result = issueDispatch(draft.value, store.actor)
  if (!result.ok) {
    createError.value = result.message
    return
  }
  creating.value = false
  errorMessage.value = result.message
  reload()
}

function openDetail(row: EntryRow) {
  detailMessage.value = ''
  detail.value = rows.value.find((item) => Number(item.id) === Number(row.id)) ?? row
}

function closeDetail() {
  detail.value = null
}

function doAction(kind: 'start' | 'confirm' | 'revoke') {
  if (!detail.value) {
    return
  }
  const id = Number(detail.value.id)
  const result =
    kind === 'revoke'
      ? revokeDispatch(id, store.actor)
      : kind === 'start'
        ? startDispatch(id, store.actor)
        : confirmDispatch(id, store.actor)
  detailOk.value = result.ok
  detailMessage.value = result.message
  if (result.ok) {
    reload()
    detail.value = rows.value.find((item) => Number(item.id) === id) ?? null
  }
}

function reload() {
  errorMessage.value = ''
  try {
    // 进页面先按指令时段口径对齐电站台账，再读数：两处限电电站数天然同源。
    syncStationsToOrders()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stations.value = listRows('station')
    counts.value = limitCounts()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '并网调度列表读取失败'
  }
}

onMounted(reload)
</script>
