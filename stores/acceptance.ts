import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedEquipment, seedPlant } from '../data/seed'
import type { AcceptanceDefect, AcceptanceItem, AuditEntry, EquipmentNode, PartyReply, Plant, ReceiptBatch, VerificationReceipt, VerifyState } from '../types/domain'
import { collapseIncoming, diffFindings, mergeReceiptEntries, reconcileCertificates, type IncomingReceiptEntry, type ReconcileResult } from '../services/reconciliation'
import { buildRetryWindow, transmitWindow, type TransmissionWindow } from '../services/receiptFeed'

const STORAGE_KEY = 'gsb67:grid-acceptance'
let idSeed = 30

interface SignedSnapshot {
  version: number
  findings: Record<string, { state: VerifyState; effectiveReceiptNo: string; receiptVersion: number | null }>
}

export const useAcceptanceStore = defineStore('acceptance', () => {
  const plant = ref<Plant>(structuredClone(seedPlant))
  const equipment = ref<EquipmentNode[]>(structuredClone(seedEquipment))
  const defects = ref<AcceptanceDefect[]>(structuredClone(seedDefects))
  const audit = ref<AuditEntry[]>(structuredClone(seedAudit))
  const receipts = ref<VerificationReceipt[]>([])
  const batches = ref<ReceiptBatch[]>([])
  const signedSnapshot = ref<SignedSnapshot | null>(null)
  const selectedEquipmentId = ref(equipment.value[0].id)
  const keyword = ref('')
  const hydrated = ref(false)

  const selectedEquipment = computed(() => equipment.value.find((item) => item.id === selectedEquipmentId.value))
  const reconciliation = computed<ReconcileResult>(() => reconcileCertificates(equipment.value, receipts.value))
  const certFinding = (certId: string) => reconciliation.value.findingsByCertId[certId]
  const certState = (certId: string): VerifyState => certFinding(certId)?.state ?? '待核'

  const stats = computed(() => {
    const items = equipment.value.flatMap((item) => item.items)
    return {
      total: items.length,
      passed: items.filter((item) => item.status === '合格').length,
      failed: items.filter((item) => item.status === '不合格' || item.status === '待复验').length,
      openDefects: defects.value.filter((item) => !['已关闭', '带条件通过'].includes(item.status)).length,
      certs: reconciliation.value.counts
    }
  })

  const preflight = computed(() => {
    const blocking: string[] = []
    const items = equipment.value.flatMap((item) => item.items)
    if (items.some((item) => item.status === '待检查')) blocking.push('仍有验收项未检查')
    if (items.some((item) => item.status === '不合格' || item.status === '待复验')) blocking.push('存在不合格或待复验项')
    if (defects.value.some((item) => !['已关闭', '带条件通过'].includes(item.status))) blocking.push('存在未闭环缺陷')

    const nameOf = new Map(equipment.value.flatMap((node) => node.certificates.map((cert) => [cert.id, node.name] as const)))
    for (const finding of Object.values(reconciliation.value.findingsByCertId)) {
      if (finding.state === '已核验') continue
      const cert = equipment.value.flatMap((node) => node.certificates).find((item) => item.id === finding.certId)
      if (finding.state === '已撤销') blocking.push(`[${nameOf.get(finding.certId)}] ${cert?.name ?? finding.certNo}（${finding.certNo}）回执声明已撤销，不得通过`)
      else if (finding.state === '已换版') blocking.push(`[${nameOf.get(finding.certId)}] ${cert?.name ?? finding.certNo}（${finding.certNo}）已换版，旧版本不得通过`)
      else blocking.push(`[${nameOf.get(finding.certId)}] ${cert?.name ?? finding.certNo}（${finding.certNo}）待核：${finding.reason}`)
    }
    for (const group of reconciliation.value.duplicateGroups) {
      blocking.push(`证书编号${group.certNo}同时挂在${group.mounts.length}台设备（${group.mounts.map((item) => item.equipmentName).join('、')}），需摘除误挂证书`)
    }
    for (const receipt of reconciliation.value.unmatchedReceipts) {
      blocking.push(`回执${receipt.receiptNo}对应的证书编号${receipt.certNo}在台账中查不到，对账不一致`)
    }
    const expired = equipment.value.flatMap((item) => item.certificates).some((item) => item.expiresAt < plant.value.commissioningDate)
    if (expired) blocking.push('证书在并网日期前失效')
    return { allowed: blocking.length === 0, blocking }
  })

  function hydrate() {
    if (!import.meta.client || hydrated.value) return
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const stored = JSON.parse(raw)
        plant.value = stored.plant
        equipment.value = (stored.equipment ?? []).map(migrateNode)
        defects.value = stored.defects
        audit.value = stored.audit
        receipts.value = Array.isArray(stored.receipts) ? stored.receipts : []
        batches.value = Array.isArray(stored.batches) ? stored.batches : []
        signedSnapshot.value = stored.signedSnapshot ?? null
      }
    } catch {
      // Seed data is kept when browser storage is corrupt.
    }
    hydrated.value = true
  }

  function migrateNode(node: EquipmentNode): EquipmentNode {
    return {
      ...node,
      status: ['待验收', '验收中', '已验收', '待核'].includes(node.status) ? node.status : '验收中',
      certificates: (node.certificates ?? []).map((cert) => ({
        ...cert,
        certNo: cert.certNo ?? cert.id,
        receiptNo: cert.receiptNo ?? ''
      }))
    }
  }

  function persist() {
    if (!import.meta.client) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      plant: plant.value,
      equipment: equipment.value,
      defects: defects.value,
      audit: audit.value,
      receipts: receipts.value,
      batches: batches.value,
      signedSnapshot: signedSnapshot.value
    }))
  }

  function updateItem(equipmentId: string, itemId: string, patch: Partial<AcceptanceItem>) {
    const item = equipment.value.find((node) => node.id === equipmentId)?.items.find((value) => value.id === itemId)
    if (!item) return
    Object.assign(item, patch, { version: item.version + 1 })
    log(equipmentId, '更新验收项', '当前用户', `${item.id}状态更新为${item.status}`)
    persist()
  }

  /** 摘除重复挂载（同一证书编号挂多台设备）时误挂的证书 */
  function removeCertificate(equipmentId: string, certId: string) {
    const node = equipment.value.find((item) => item.id === equipmentId)
    const cert = node?.certificates.find((item) => item.id === certId)
    if (!node || !cert) return
    node.certificates = node.certificates.filter((item) => item.id !== certId)
    log(equipmentId, '摘除误挂证书', '验收负责人陆川', `${cert.name}（${cert.certNo}）与其它设备证书编号重复，予以摘除`)
    persist()
  }

  function assignDefect(id: string, owner: string) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.owner = owner
    defect.status = '整改中'
    defect.version += 1
    log(id, '分派缺陷', '验收负责人', `责任方调整为${owner}`)
    persist()
  }

  function addReply(id: string, reply: PartyReply) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect || !reply.content || !reply.evidence) return { ok: false, message: '回复内容和证据均不能为空' }
    defect.replies.unshift(reply)
    defect.status = '待联合复验'
    defect.version += 1
    log(id, `${reply.party}提交处理说明`, reply.owner, reply.content)
    persist()
    return { ok: true, message: '已提交处理说明并进入联合复验' }
  }

  function addRetest(id: string, result: string, passed: boolean) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.retests.unshift({ round: defect.retests.length + 1, passed, result, tester: '联合验收组', testedAt: new Date().toISOString() })
    defect.status = passed ? '已关闭' : '整改中'
    defect.version += 1
    log(id, '执行联合复验', '联合验收组', result)
    persist()
  }

  function decideDefect(id: string, status: '已关闭' | '带条件通过' | '整改中', note: string) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (status === '已关闭' && !defect.retests.some((item) => item.passed)) return { ok: false, message: '没有合格复验记录，不能关闭' }
    if (status === '带条件通过' && !note.trim()) return { ok: false, message: '带条件通过必须说明限制条件' }
    defect.status = status
    defect.decisionNote = note
    defect.version += 1
    log(id, `验收决定：${status}`, '验收负责人', note || '完成整改闭环')
    persist()
    return { ok: true, message: `缺陷已更新为${status}` }
  }

  /**
   * 接收一个核验窗口的回执：传输可能只成功一部分（条目级失败），
   * 窗口内/跨窗口同一回执编号先到的保留，已登记的不重复登记。
   */
  function receiveWindow(window: TransmissionWindow, failRate?: number) {
    const outcome = transmitWindow(window, failRate)
    return commitOutcome(window.source, window.windowId, outcome.delivered, outcome.failed, window.entries.length)
  }

  /** 两个窗口同时提交：按到达顺序登记，同编号先到保留、后到只补新增 */
  function receiveWindowsConcurrently(windows: TransmissionWindow[], failRate?: number) {
    return windows.map((window) => receiveWindow(window, failRate))
  }

  function commitOutcome(
    source: string,
    windowId: string,
    delivered: IncomingReceiptEntry[],
    failed: IncomingReceiptEntry[],
    total: number
  ): ReceiptBatch {
    const prevStates: Record<string, VerifyState> = Object.fromEntries(
      Object.entries(reconciliation.value.findingsByCertId).map(([id, finding]) => [id, finding.state])
    )
    const { kept, droppedDuplicates } = collapseIncoming(delivered)
    const receivedAt = new Date().toISOString()
    const batchId = `BATCH-${receivedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${windowId.slice(-4)}`
    const { merged, added, duplicated } = mergeReceiptEntries(receipts.value, kept, { id: batchId, source, receivedAt })
    receipts.value = merged
    syncLedgerReceiptNos()

    applyReconciliationEffects(prevStates)

    const duplicatedCount = droppedDuplicates.length + duplicated.length
    const batch: ReceiptBatch = {
      id: batchId,
      source,
      receivedAt,
      total,
      added: added.length,
      duplicated: duplicatedCount,
      delivered: kept.length - duplicated.length,
      pending: failed.map(({ receiptNo, certNo, version, state, certificateName, issuer }) => ({ receiptNo, certNo, version, state, certificateName, issuer })),
      status: failed.length ? '部分写入' : added.length === 0 ? '重复批次' : '已完成',
      note: droppedDuplicates.length ? `窗口内${droppedDuplicates.length}条同编号回执已按先到保留丢弃` : ''
    }
    batches.value.unshift(batch)
    log(batchId, '接收核验回执批次', source, `新增${added.length}条，重复${duplicatedCount}条，传输失败${failed.length}条待重传`)
    persist()
    return batch
  }

  /** 失败重试：只重传没写入的 pending 条目；已被其它窗口写入的按重复跳过 */
  function retryPending(batchId: string) {
    const batch = batches.value.find((item) => item.id === batchId)
    if (!batch || !batch.pending.length) return null
    const prevStates: Record<string, VerifyState> = Object.fromEntries(
      Object.entries(reconciliation.value.findingsByCertId).map(([id, finding]) => [id, finding.state])
    )
    const retryWindow = buildRetryWindow(batch.pending, new Date().toISOString())
    const outcome = transmitWindow(retryWindow, 0.15)
    const { kept, droppedDuplicates } = collapseIncoming(outcome.delivered)
    const receivedAt = new Date().toISOString()
    const { merged, added, duplicated } = mergeReceiptEntries(receipts.value, kept, { id: `${batchId}-R`, source: `${batch.source}重传`, receivedAt })
    receipts.value = merged
    syncLedgerReceiptNos()
    applyReconciliationEffects(prevStates)

    const deliveredReceiptNos = new Set(outcome.delivered.map((entry) => entry.receiptNo))
    batch.pending = batch.pending.filter((entry) => !deliveredReceiptNos.has(entry.receiptNo))
    batch.duplicated += droppedDuplicates.length + duplicated.length
    batch.delivered += kept.length - duplicated.length
    batch.status = batch.pending.length ? '部分写入' : '已完成'
    log(batch.id, '重传核验回执', `${batch.source}重传`, `新增${added.length}条，重复跳过${droppedDuplicates.length + duplicated.length}条，仍失败${batch.pending.length}条`)
    persist()
    return batch
  }

  /**
   * 回执与台账按证书编号对账后，把有效回执编号补登到台账证书：
   * 老证书在回执到达前缺编号一律待核，对得上之后以最新版本回执为准。
   */
  function syncLedgerReceiptNos() {
    for (const node of equipment.value) {
      for (const certificate of node.certificates) {
        const effective = reconciliation.value.effectiveByCertNo.get(certificate.certNo)
        if (effective && certificate.receiptNo !== effective.receiptNo) certificate.receiptNo = effective.receiptNo
      }
    }
  }

  /**
   * 回执变更后的连锁处理：
   * - 已签署批次：任一已核验结论被新回执推翻（撤销/换版/新版本替换），签署批次失效；
   * - 挂这些证书的设备改判“待核”（仅已验收设备需要回退）。
   */
  function applyReconciliationEffects(prevStates: Record<string, VerifyState>) {
    const result = reconciliation.value
    const { invalidated } = diffFindings(prevStates, result)

    if (signedSnapshot.value) {
      const snapshot = signedSnapshot.value
      const changed = Object.values(result.findingsByCertId).filter((finding) => {
        const before = snapshot.findings[finding.certId]
        return before && (before.state !== finding.state || before.effectiveReceiptNo !== finding.effectiveReceiptNo || before.receiptVersion !== finding.receiptVersion)
      })
      if (changed.length) {
        const affectedIds = new Set(changed.map((item) => item.certId))
        plant.value.status = '待复核'
        plant.value.version += 1
        for (const node of equipment.value) {
          if (node.status === '已验收' && node.certificates.some((cert) => affectedIds.has(cert.id))) node.status = '待核'
        }
        signedSnapshot.value = null
        log(plant.value.id, '签署批次失效', '系统对账', `核验回执发生变化：${changed.map((item) => `${item.certNo}→${item.state}`).join('；')}，V${plant.value.version}退回待复核，相关设备改判待核`)
      }
    }

    // 非签署场景下，已验收设备一旦挂上不再通过的证书同样回退待核
    if (invalidated.length) {
      const ids = new Set(invalidated.map((item) => item.certId))
      for (const node of equipment.value) {
        if (node.status === '已验收' && node.certificates.some((cert) => ids.has(cert.id))) node.status = '待核'
      }
    }
  }

  function signOff() {
    if (!preflight.value.allowed) return { ok: false, message: preflight.value.blocking.join('；') }
    plant.value.status = '已签署'
    plant.value.version += 1
    equipment.value.forEach((node) => { node.status = '已验收' })
    signedSnapshot.value = {
      version: plant.value.version,
      findings: Object.fromEntries(Object.entries(reconciliation.value.findingsByCertId).map(([id, finding]) => [id, {
        state: finding.state,
        effectiveReceiptNo: finding.effectiveReceiptNo,
        receiptVersion: finding.receiptVersion
      }]))
    }
    log(plant.value.id, '签署交付版本', '验收负责人陆川', `锁定V${plant.value.version}并生成交付包`)
    persist()
    return { ok: true, message: '签署完成，交付版本已锁定' }
  }

  function reset() {
    plant.value = structuredClone(seedPlant)
    equipment.value = structuredClone(seedEquipment)
    defects.value = structuredClone(seedDefects)
    audit.value = structuredClone(seedAudit)
    receipts.value = []
    batches.value = []
    signedSnapshot.value = null
    persist()
  }

  function log(entityId: string, action: string, operator: string, detail: string) {
    audit.value.unshift({ id: `AUD-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, createdAt: new Date().toISOString() })
  }

  return {
    plant, equipment, defects, audit, receipts, batches, hydrated,
    selectedEquipmentId, keyword,
    selectedEquipment, stats, preflight, reconciliation, signedSnapshot,
    certFinding, certState,
    hydrate, updateItem, removeCertificate, assignDefect, addReply, addRetest, decideDefect,
    receiveWindow, receiveWindowsConcurrently, retryPending, signOff, reset
  }
})
