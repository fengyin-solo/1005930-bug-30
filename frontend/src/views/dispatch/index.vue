<template>
  <section class="page" data-module="dispatch">
    <header class="page-head">
      <div>
        <h2>并网调度管理</h2>
        <p class="page-desc">维护调度指令，围绕指令编号、调度机构、指令类型、限电负荷做登记、筛选与状态流转。</p>
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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无并网调度数据，可先登记调度指令</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条并网调度记录</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <form class="modal-card" @submit.prevent="submitCreate">
        <h3>登记调度指令</h3>
        <label>
          <span>电站编号（本电站）</span>
          <input v-model="createForm.电站编号" disabled />
        </label>
        <label>
          <span>调度机构</span>
          <input v-model="createForm.调度机构" placeholder="如：省调中心" />
        </label>
        <label>
          <span>指令类型</span>
          <select v-model="createForm.指令类型">
            <option value="限电">限电</option>
            <option value="发电计划">发电计划</option>
            <option value="检修配合">检修配合</option>
          </select>
        </label>
        <label>
          <span>限电负荷</span>
          <input v-model="createForm.限电负荷" placeholder="如：30MW" />
        </label>
        <label>
          <span>生效时段</span>
          <input v-model="createForm.生效时段" placeholder="如：2026-10-06 08:00-12:00" />
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="showCreate = false">取消</button>
          <button class="btn primary" type="submit">登记</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createDispatchEntry,
  dispatchSummary,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('dispatch')
const session = useSessionStore()
const columns = ["指令编号", "电站编号", "调度机构", "指令类型", "限电负荷", "生效时段", "执行人员", "执行结果", "指令状态"]
const actions = ["开始执行", "确认执行", "撤销指令"]
const statuses = ["待执行", "执行中", "已执行", "已撤销"]

const rows = ref<EntryRow[]>([])
const stats = ref<{ label: string; value: string | number }[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const showCreate = ref(false)
const emptyCreateForm = () => ({
  电站编号: session.station,
  调度机构: '',
  指令类型: '限电',
  限电负荷: '',
  生效时段: '',
})
const createForm = ref(emptyCreateForm())

function operatorInfo() {
  return { name: session.operator, role: session.role, station: session.station }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = ''
  infoMessage.value = ''
  createForm.value = emptyCreateForm()
  showCreate.value = true
}

function submitCreate() {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = createDispatchEntry({ ...createForm.value }, operatorInfo())
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  showCreate.value = false
  infoMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, operatorInfo())
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = dispatchSummary()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '并网调度列表读取失败'
  }
}

onMounted(reload)
</script>
