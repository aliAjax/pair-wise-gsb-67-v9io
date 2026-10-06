<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import { useToast } from 'primevue/usetoast'
import { useAcceptanceStore } from '../stores/acceptance'
import type { CertificateLedgerRow } from '../types/domain'
import type { ReceiptSubmission } from '../services/receipts'

const store = useAcceptanceStore()
const toast = useToast()

const input = reactive({ json: '', failLineNos: '' })
const certDialog = reactive({ visible: false, certificateId: '', equipmentId: '', certNo: '' as string | null, name: '' })
const versionTarget = ref<CertificateLedgerRow | null>(null)

const severityMap: Record<string, string> = {
  已核验: 'success', 已撤销: 'danger', 换版待核: 'warn', 版本不符: 'warn', 重复挂证: 'danger', 缺回执编号: 'warn', 待核: 'secondary'
}

// 1) 正常回执：主变新版证书
const sampleReissue = (): ReceiptSubmission => ({
  receiptNo: 'RCPT-20261006-11', issuer: '特变电工质量部', source: '核验平台报文', receivedAt: new Date().toISOString(),
  entries: [
    { lineNo: 'L1', certNo: 'CERT-TB-TBEA-2024031', certName: '主变出厂试验报告', version: 2, result: '有效', issuer: '特变电工', expiresAt: '2036-04-10', checkedAt: '2026-10-06T09:10:00' }
  ]
})

// 2) 同一回执两个窗口先后提交：第一批只到L1，后到窗口含L1+L2，L1跳过只补L2
const sampleWindowA = (): ReceiptSubmission => ({
  receiptNo: 'RCPT-20261006-22', issuer: '省电科院核验中心', source: '窗口一', receivedAt: new Date(Date.now() - 60_000).toISOString(),
  entries: [
    { lineNo: 'L1', certNo: 'CERT-G1-2025-0918', certName: '继电保护装置检验报告', version: 1, result: '有效', issuer: '省电科院', expiresAt: '2027-09-20', checkedAt: '2026-10-06T10:00:00' }
  ]
})
const sampleWindowB = (): ReceiptSubmission => ({
  receiptNo: 'RCPT-20261006-22', issuer: '省电科院核验中心', source: '窗口二', receivedAt: new Date().toISOString(),
  entries: [
    { lineNo: 'L1', certNo: 'CERT-G1-2025-0918', certName: '继电保护装置检验报告', version: 1, result: '有效', issuer: '省电科院', expiresAt: '2027-09-20', checkedAt: '2026-10-06T10:00:00' },
    { lineNo: 'L2', certNo: 'CERT-INV-LVRT-CN2025041', certName: '逆变器低电压穿越证书', version: 2, result: '有效', issuer: '中国电科院', expiresAt: '2028-06-30', checkedAt: '2026-10-06T10:05:00' }
  ]
})

// 3) 部分失败后重试：L1写入失败，重试时去掉模拟失败行号即可补登
const sampleRetry = (): ReceiptSubmission => ({
  receiptNo: 'RCPT-20261006-33', issuer: '中国电科院', source: '核验平台报文', receivedAt: new Date().toISOString(),
  entries: [
    { lineNo: 'L1', certNo: 'CERT-G1-2025-0918', certName: '继电保护装置检验报告', version: 2, result: '换版待核', issuer: '省电科院', expiresAt: '2027-09-20', checkedAt: '2026-10-06T11:20:00' }
  ]
})

function fill(sample: () => ReceiptSubmission, failLineNos = '') {
  input.json = JSON.stringify(sample(), null, 2)
  input.failLineNos = failLineNos
}

function submit() {
  let parsed: ReceiptSubmission
  try {
    parsed = JSON.parse(input.json)
  } catch {
    toast.add({ severity: 'error', summary: '回执解析失败', detail: '请粘贴合法JSON', life: 3000 })
    return
  }
  const fails = input.failLineNos.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean)
  const result = store.receiveReceipt(parsed, fails)
  const { outcome } = result
  const detail = [
    result.message,
    outcome.resubmitted ? '该回执此前已接收，本次只补新增行' : '',
    outcome.skipped.length ? `跳过重复行：${outcome.skipped.map((item) => item.lineNo).join('、')}` : '',
    outcome.failed.length ? `失败行：${outcome.failed.map((item) => item.lineNo).join('、')}` : '',
    result.invalidated ? '已签署批次已失效，相关设备改判待核' : ''
  ].filter(Boolean).join('；')
  toast.add({ severity: result.ok ? 'success' : 'warn', summary: result.ok ? '回执接收完成' : '部分行未写入', detail, life: 6000 })
}

function openCert(row: CertificateLedgerRow) {
  Object.assign(certDialog, { visible: true, certificateId: row.certificateId, equipmentId: row.equipmentId, certNo: row.certNo, name: row.certName })
}
function saveCert() {
  const result = store.updateCertificate(certDialog.equipmentId, certDialog.certificateId, { certNo: certDialog.certNo, name: certDialog.name })
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 3000 })
  if (result.ok) certDialog.visible = false
}
function admitVersion(row: CertificateLedgerRow) {
  const result = store.admitReceiptVersion(row.certificateId)
  toast.add({ severity: result.ok ? 'success' : 'error', summary: result.message, life: 3500 })
  if (result.ok) versionTarget.value = null
}
function openVersion(row: CertificateLedgerRow) { versionTarget.value = row }

const versionVisible = computed({
  get: () => versionTarget.value !== null,
  set: (value: boolean) => { if (!value) versionTarget.value = null }
})
const blockingCount = computed(() => store.blockedLedger.length)
</script>

<template>
  <section class="page">
    <div class="receipt-intro metrics">
      <article><span>已接收回执批次</span><strong>{{ store.receipts.length }}</strong><small>按回执编号去重保留</small></article>
      <article><span>已登记核验条目</span><strong>{{ store.receipts.reduce((sum, batch) => sum + batch.entries.length, 0) }}</strong><small>行号幂等，不重复登记</small></article>
      <article><span>证书待核问题</span><strong>{{ blockingCount }}</strong><small>撤销/换版/重复/缺编号</small></article>
      <article><span>签署批次</span><strong>{{ store.plant.status }}</strong><small>回执一变即失效</small></article>
    </div>

    <div class="receipt-panel">
      <div class="section-head"><div><h2>接收核验回执</h2><p>粘贴外部回执JSON后与台账自动对账；模拟失败行号（逗号分隔）可演示中断后重试只补未写部分。</p></div></div>
      <div class="receipt-actions">
        <Button label="填入样例：主变换版回执" severity="secondary" outlined size="small" @click="fill(sampleReissue)" />
        <Button label="样例：窗口一（RCPT-…22 先到L1）" severity="secondary" outlined size="small" @click="fill(sampleWindowA)" />
        <Button label="样例：窗口二（同批补L2）" severity="secondary" outlined size="small" @click="fill(sampleWindowB)" />
        <Button label="样例：失败重试（模拟L1失败）" severity="secondary" outlined size="small" @click="fill(sampleRetry, 'L1')" />
      </div>
      <div class="receipt-form">
        <Textarea v-model="input.json" rows="10" :style="{ width: '100%', fontFamily: 'monospace' }" placeholder="回执JSON：{ receiptNo, issuer, receivedAt, source, entries: [{ lineNo, certNo, certName, version, result, ... }] }" />
        <div class="receipt-submit">
          <label>模拟写入失败行号<InputText v-model="input.failLineNos" placeholder="如 L1；重试时清空" /></label>
          <Button label="接收并对账" @click="submit" />
        </div>
      </div>
    </div>

    <div class="section-head" style="margin-top:22px"><div><h2>回执批次登记</h2><p>先到的提交保留，后到的同编号回执只补新增条目；失败行可重试补写。</p></div></div>
    <DataTable :value="store.receipts" dataKey="receiptNo" size="small" stripedRows>
      <Column field="receiptNo" header="回执编号" />
      <Column field="issuer" header="来源机构" />
      <Column field="source" header="来源渠道" />
      <Column header="接收时间"><template #body="{ data }">{{ data.receivedAt.replace('T', ' ').slice(0, 16) }}</template></Column>
      <Column header="写入进度"><template #body="{ data }"><Tag :value="data.failedLines.length ? `${data.writtenLines.length}已写 / ${data.failedLines.length}待重试` : `${data.writtenLines.length}条全部写入`" :severity="data.failedLines.length ? 'warn' : 'success'" /></template></Column>
      <Column header="条目"><template #body="{ data }"><span v-for="entry in data.entries" :key="entry.lineNo" class="receipt-chip"><Tag :value="entry.result" :severity="entry.result === '有效' ? 'success' : entry.result === '已撤销' ? 'danger' : 'warn'" />{{ entry.certNo }} V{{ entry.version }}（{{ entry.lineNo }}）</span></template></Column>
    </DataTable>

    <div class="section-head" style="margin-top:22px"><div><h2>证书台账对账</h2><p>同一编号以回执最新版本为准；撤销/换版不再算通过，相关设备自动改判待核。</p></div></div>
    <DataTable :value="store.ledger" dataKey="certificateId" size="small">
      <Column field="equipmentName" header="挂载设备" />
      <Column field="certName" header="证书" />
      <Column field="certNo" header="证书编号"><template #body="{ data }">{{ data.certNo ?? '—（老证书缺编号）' }}</template></Column>
      <Column header="台账/回执版本"><template #body="{ data }">V{{ data.ledgerVersion }} / {{ data.receiptVersion === null ? '—' : `V${data.receiptVersion}` }}</template></Column>
      <Column field="receiptNo" header="命中回执" />
      <Column header="结论"><template #body="{ data }"><Tag :value="data.status" :severity="(severityMap[data.status] as any)" /></template></Column>
      <Column field="note" header="说明" />
      <Column header="处置"><template #body="{ data }">
        <Button v-if="data.status === '版本不符'" label="按回执换版" size="small" text @click="openVersion(data)" />
        <Button v-if="['缺回执编号', '重复挂证'].includes(data.status)" label="修正编号" size="small" text @click="openCert(data)" />
      </template></Column>
    </DataTable>

    <Dialog v-model:visible="certDialog.visible" header="修正证书台账编号" modal :style="{ width: '520px' }">
      <div class="edit-grid">
        <label class="span2">证书名称<InputText v-model="certDialog.name" /></label>
        <label class="span2">证书编号（回执编号）<InputText v-model="certDialog.certNo" placeholder="补登真实编号；留空则继续按待核处理" /></label>
      </div>
      <template #footer><Button label="取消" text severity="secondary" @click="certDialog.visible = false" /><Button label="保存并重新对账" @click="saveCert" /></template>
    </Dialog>
    <Dialog v-model:visible="versionVisible" :header="`按回执最新版本换版`" modal :style="{ width: '480px' }">
      <p v-if="versionTarget" class="dialog-text">证书 {{ versionTarget.certNo }} 台账为 V{{ versionTarget.ledgerVersion }}，回执最新为 V{{ versionTarget.receiptVersion }}。确认以回执版本为准并换版？换版后该证书按新版本重新核验。</p>
      <template #footer><Button label="取消" text severity="secondary" @click="versionTarget = null" /><Button label="确认换版" @click="versionTarget && admitVersion(versionTarget)" /></template>
    </Dialog>
  </section>
</template>
