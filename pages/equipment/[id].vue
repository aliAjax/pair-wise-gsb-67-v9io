<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import { useAcceptanceStore } from '../../stores/acceptance'
import type { AcceptanceItem } from '../../types/domain'

const route = useRoute()
const store = useAcceptanceStore()
const node = computed(() => store.equipment.find((item) => item.id === route.params.id))
const visible = ref(false)
const editable = reactive<Partial<AcceptanceItem>>({})
const certSeverity: Record<string, string> = { 已核验: 'success', 已撤销: 'danger', 换版待核: 'warn', 版本不符: 'warn', 重复挂证: 'danger', 缺回执编号: 'warn', 待核: 'secondary' }
function ledgerRow(certificateId: string) { return store.ledgerByCertId.get(certificateId) }
function openItem(item: AcceptanceItem) { Object.assign(editable, structuredClone(item)); visible.value = true }
function save() {
  if (!node.value || !editable.id) return
  store.updateItem(node.value.id, editable.id, editable)
  visible.value = false
}
</script>

<template>
  <section v-if="node" class="page">
    <div class="section-head"><div><span>{{ node.id }} · {{ node.code }}</span><h2>{{ node.name }}</h2><p>{{ node.type }} · 当前状态 {{ node.status }}</p></div><Tag :value="node.status" :severity="node.status === '已验收' ? 'success' : 'warn'" /></div>
    <div class="equipment-path"><span v-for="item in store.equipment.filter((value) => value.parentId === node?.parentId || value.id === node?.id)" :key="item.id" :class="{ active: item.id === node?.id }" @click="navigateTo(`/equipment/${item.id}`)">{{ item.name }}</span></div>
    <DataTable :value="node.items" dataKey="id" size="small">
      <Column field="id" header="编号" style="width:100px" />
      <Column field="standard" header="验收标准" />
      <Column field="method" header="测试方法" />
      <Column field="condition" header="测试条件" />
      <Column field="measured" header="实测结果" />
      <Column field="evidence" header="测试证据" />
      <Column header="状态"><template #body="{ data }"><Tag :value="data.status" :severity="data.status === '合格' ? 'success' : data.status === '不合格' ? 'danger' : 'warn'" /></template></Column>
      <Column header="版本"><template #body="{ data }">V{{ data.version }}</template></Column>
      <Column header=""><template #body="{ data }"><Button label="录入/复核" text @click="openItem(data)" /></template></Column>
    </DataTable>
    <div class="certificate-panel">
      <h3>证书与测试附件</h3>
      <div v-for="certificate in node.certificates" :key="certificate.id" class="certificate-item">
        <Tag :value="ledgerRow(certificate.id)?.status ?? '待核'" :severity="(certSeverity[ledgerRow(certificate.id)?.status ?? '待核'] as any)" />
        <strong>{{ certificate.name }}</strong>
        <span>{{ certificate.issuer }} · {{ certificate.certNo ?? '缺回执编号' }}</span>
        <span>有效期至 {{ certificate.expiresAt }} · 命中回执 {{ certificate.receiptNo ?? '无' }}</span>
        <small>V{{ certificate.version }}</small>
      </div>
      <p v-if="!node.certificates.length">当前设备节点暂无证书附件。</p>
      <p v-if="node.status === '待核'" class="cert-warn">该设备证书对账未通过，已改判待核；问题消除前不能签署并网。</p>
    </div>
    <Dialog v-model:visible="visible" header="录入验收项" modal :style="{ width: '620px' }">
      <div class="edit-grid">
        <label>状态<Select v-model="editable.status" :options="['待检查', '合格', '不合格', '待复验']" /></label>
        <label>实测结果<InputText v-model="editable.measured" /></label>
        <label>测试证据<InputText v-model="editable.evidence" /></label>
        <label>测试条件<Textarea v-model="editable.condition" rows="3" /></label>
      </div>
      <template #footer><Button label="取消" severity="secondary" text @click="visible = false" /><Button label="保存并递增版本" @click="save" /></template>
    </Dialog>
  </section>
  <section v-else class="page">未找到设备节点</section>
</template>
