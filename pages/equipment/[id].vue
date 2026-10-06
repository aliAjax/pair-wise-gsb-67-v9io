<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
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
import type { AcceptanceItem, Certificate } from '../../types/domain'

const route = useRoute()
const store = useAcceptanceStore()
const node = computed(() => store.equipment.find((item) => item.id === route.params.id))
const visible = ref(false)
const editable = reactive<Partial<AcceptanceItem>>({})
function openItem(item: AcceptanceItem) { Object.assign(editable, structuredClone(item)); visible.value = true }
function save() {
  if (!node.value || !editable.id) return
  store.updateItem(node.value.id, editable.id, editable)
  visible.value = false
}
const verifySeverity = (state: string) => state === '已核验' ? 'success' : state === '已撤销' ? 'danger' : state === '已换版' ? 'warn' : 'secondary'
const isDuplicated = (cert: Certificate) => store.reconciliation.duplicateGroups.some((group) => group.certNo === cert.certNo)
const detach = (cert: Certificate) => { if (node.value) store.removeCertificate(node.value.id, cert.id) }
</script>

<template>
  <section v-if="node" class="page">
    <div class="section-head"><div><span>{{ node.id }} · {{ node.code }}</span><h2>{{ node.name }}</h2><p>{{ node.type }} · 当前状态 {{ node.status }}</p></div><Tag :value="node.status" :severity="node.status === '已验收' ? 'success' : node.status === '待核' ? 'danger' : 'warn'" /></div>
    <div class="equipment-path"><span v-for="item in store.equipment.filter((value) => value.parentId === node?.parentId || value.id === node?.id)" :key="item.id" :class="{ active: item.id === node.id }" @click="navigateTo(`/equipment/${item.id}`)">{{ item.name }}</span></div>
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
      <p class="cert-hint">核验状态一律以外部回执对账结果为准：已撤销 / 已换版不得通过，缺回执编号先待核；同编号挂多台设备需摘除误挂证书。</p>
      <div class="certificate-head"><span>核验结论</span><strong>证书 / 编号</strong><span>签发机构</span><span>有效期至</span><small>台账/回执版本</small><small>回执编号</small><span></span></div>
      <div v-for="certificate in node.certificates" :key="certificate.id" class="certificate-item">
        <Tag :value="store.certState(certificate.id)" :severity="verifySeverity(store.certState(certificate.id))" />
        <strong>{{ certificate.name }}<small v-if="isDuplicated(certificate)" class="dup-warn">编号 {{ certificate.certNo }} 同时挂在多台设备</small></strong>
        <span>{{ certificate.issuer }}</span>
        <span>有效期至 {{ certificate.expiresAt }}</span>
        <small>V{{ certificate.version }}<template v-if="store.certFinding(certificate.id)?.receiptVersion != null"> / 回执V{{ store.certFinding(certificate.id)!.receiptVersion }}</template></small>
        <small>{{ certificate.receiptNo || '缺失·待核' }}</small>
        <Button v-if="isDuplicated(certificate)" label="摘除误挂" severity="danger" text size="small" @click="detach(certificate)" />
      </div>
      <p v-if="!node.certificates.length">当前设备节点暂无证书附件。</p>
      <ul v-if="node.certificates.length" class="cert-reasons">
        <li v-for="certificate in node.certificates" :key="`r-${certificate.id}`" v-show="store.certState(certificate.id) !== '已核验'">{{ certificate.certNo }}：{{ store.certFinding(certificate.id)?.reason }}</li>
      </ul>
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
