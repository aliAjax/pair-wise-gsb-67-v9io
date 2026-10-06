<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import InputText from 'primevue/inputtext'
import Tag from 'primevue/tag'
import { useToast } from 'primevue/usetoast'
import { useAcceptanceStore } from '../stores/acceptance'
import { buildFixtureWindows } from '../services/receiptFeed'

const store = useAcceptanceStore()
const toast = useToast()
const keyword = ref('')
const receiving = ref(false)
const rows = computed(() => store.audit.filter((item) => !keyword.value || `${item.entityId} ${item.action} ${item.operator} ${item.detail}`.includes(keyword.value)))

const stateSeverity = (state: string) => state === '有效' ? 'success' : state === '已撤销' ? 'danger' : 'warn'
const batchSeverity = (status: string) => status === '已完成' ? 'success' : status === '部分写入' ? 'warn' : 'secondary'

function sign() {
  const result = store.signOff()
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.ok ? '签署完成' : '完整性校验未通过', detail: result.message, life: 4000 })
}

/** 模拟两个核验窗口同时提交一批回执（传输可能部分失败） */
async function simulateConcurrentWindows() {
  if (receiving.value) return
  receiving.value = true
  const windows = buildFixtureWindows(new Date().toISOString())
  await new Promise((resolve) => setTimeout(resolve, 120))
  const results = store.receiveWindowsConcurrently(windows)
  const added = results.reduce((sum, item) => sum + item.added, 0)
  const pending = results.reduce((sum, item) => sum + item.pending.length, 0)
  const duplicated = results.reduce((sum, item) => sum + item.duplicated, 0)
  toast.add({
    severity: pending ? 'warn' : 'success',
    summary: `回执批次已接收：新增${added}条`,
    detail: `重复回执${duplicated}条未重复登记，${pending}条传输失败待重传`,
    life: 4500
  })
  receiving.value = false
}

function retry(batchId: string) {
  const batch = store.retryPending(batchId)
  if (!batch) return
  toast.add({
    severity: batch.pending.length ? 'warn' : 'success',
    summary: batch.pending.length ? `仍有${batch.pending.length}条失败` : '失败回执已补写完成',
    detail: '仅重传未写入部分，已登记回执未重复登记',
    life: 3500
  })
}

function exportPackage() {
  const payload = { plant: store.plant, equipment: store.equipment, defects: store.defects, receipts: store.receipts, reconciliation: store.reconciliation, audit: store.audit, preflight: store.preflight }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '光伏并网验收交付包.json'; anchor.click(); URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="page">
    <div class="preflight-panel">
      <div><span>并网前完整性校验（证书结论以回执对账为准）</span><strong>{{ store.preflight.allowed ? '全部条件满足' : `${store.preflight.blocking.length}项阻断` }}</strong><p v-for="item in store.preflight.blocking" :key="item">{{ item }}</p></div>
      <div><Button label="导出交付包" outlined @click="exportPackage" /><Button label="签署并锁定版本" @click="sign" /></div>
    </div>

    <div class="receipt-panel">
      <h3>核验回执接收与对账</h3>
      <p>外部两个核验窗口可能同时提交；同回执编号先到保留、后到只补新增；接收失败可重传，仅补未写入部分。</p>
      <div class="receipt-toolbar">
        <Button label="模拟两窗口同时提交回执" :loading="receiving" @click="simulateConcurrentWindows" />
        <Tag :value="`有效回执 ${store.receipts.length} 条`" severity="success" />
        <Tag :value="`已核验 ${store.reconciliation.counts.已核验}`" severity="success" />
        <Tag :value="`待核 ${store.reconciliation.counts.待核}`" severity="secondary" />
        <Tag :value="`已撤销 ${store.reconciliation.counts.已撤销}`" severity="danger" />
        <Tag :value="`已换版 ${store.reconciliation.counts.已换版}`" severity="warn" />
        <Tag v-if="store.reconciliation.duplicateGroups.length" :value="`同编号多挂 ${store.reconciliation.duplicateGroups.length} 组`" severity="danger" />
        <Tag v-if="store.reconciliation.unmatchedReceipts.length" :value="`台账外回执 ${store.reconciliation.unmatchedReceipts.length} 条`" severity="warn" />
      </div>

      <div class="receipt-grid">
        <div>
          <h4>接收批次</h4>
          <p v-if="!store.batches.length" class="cert-reasons" style="margin-top:0"><li>尚未接收任何核验回执，全部证书按待核处理。</li></p>
          <div v-for="batch in store.batches" :key="batch.id" class="receipt-batch">
            <div class="row"><strong>{{ batch.source }}</strong><Tag :value="batch.status" :severity="batchSeverity(batch.status)" /></div>
            <small>{{ batch.receivedAt.replace('T', ' ').slice(0, 19) }} · 共{{ batch.total }}条 · 新增{{ batch.added }}条 · 成功写入{{ batch.delivered }}条 · 重复{{ batch.duplicated }}条</small>
            <small v-if="batch.note">{{ batch.note }}</small>
            <template v-if="batch.pending.length">
              <p class="pending-line">传输失败 {{ batch.pending.length }} 条：{{ batch.pending.map((item) => item.receiptNo).join('、') }}</p>
              <div><Button label="失败重传（只补未写入）" size="small" severity="warn" outlined @click="retry(batch.id)" /></div>
            </template>
          </div>
        </div>
        <div>
          <h4>回执台账</h4>
          <DataTable :value="store.receipts" dataKey="receiptNo" size="small" stripedRows :scrollable="true" scrollHeight="320px">
            <Column field="receiptNo" header="回执编号" style="min-width:130px" />
            <Column field="certNo" header="证书编号" style="min-width:100px" />
            <Column header="版本" style="width:60px"><template #body="{ data }">V{{ data.version }}</template></Column>
            <Column header="状态" style="width:80px"><template #body="{ data }"><Tag :value="data.state" :severity="stateSeverity(data.state)" /></template></Column>
            <Column field="source" header="来源窗口" style="min-width:130px" />
          </DataTable>
        </div>
      </div>

      <div v-if="store.reconciliation.duplicateGroups.length" class="cert-hint" style="margin-top:12px">
        同编号多挂：
        <template v-for="group in store.reconciliation.duplicateGroups" :key="group.certNo">
          证书 {{ group.certNo }} 挂在 {{ group.mounts.map((item) => item.equipmentName).join('、') }}；
        </template>
        请在设备页摘除误挂证书后才可签署。
      </div>
      <div v-if="store.reconciliation.unmatchedReceipts.length" class="cert-hint" style="margin-top:8px">
        台账外回执：{{ store.reconciliation.unmatchedReceipts.map((item) => `${item.receiptNo}(证书${item.certNo})`).join('、') }}，无法与设备台账对账。
      </div>
      <div v-if="store.signedSnapshot" class="cert-hint" style="margin-top:8px;border-left-color:#2c6757;background:#eef5f2;color:#215849">
        已签署批次 V{{ store.signedSnapshot.version }}：回执一旦变化导致核验结论变更，该批次自动失效，相关设备改判待核。
      </div>
    </div>

    <div class="section-head"><div><h2>验收审计</h2><p>当前交付版本 V{{ store.plant.version }} · {{ store.plant.status }}</p></div><InputText v-model="keyword" placeholder="搜索实体、动作或操作人" /></div>
    <DataTable :value="rows" dataKey="id" size="small" :scrollable="true" scrollHeight="360px">
      <Column field="createdAt" header="时间" style="width:150px"><template #body="{ data }">{{ data.createdAt.replace('T', ' ').slice(0, 16) }}</template></Column>
      <Column field="entityId" header="实体" style="width:170px" />
      <Column field="action" header="动作" style="width:150px"><template #body="{ data }"><Tag :value="data.action" :severity="data.action.includes('失效') ? 'danger' : 'secondary'" /></template></Column>
      <Column field="operator" header="操作人" style="width:130px" />
      <Column field="detail" header="说明" />
    </DataTable>
  </section>
</template>
