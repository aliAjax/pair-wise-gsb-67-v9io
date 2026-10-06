import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedEquipment, seedPlant, seedReceipts } from '../data/seed'
import { buildCertificateLedger, isCertBlocked } from '../services/reconciliation'
import { ingestReceiptBatch, type IngestOutcome, type ReceiptSubmission } from '../services/receipts'
import type { AcceptanceDefect, AcceptanceItem, AuditEntry, CertificateLedgerRow, EquipmentNode, PartyReply, Plant, ReceiptBatch } from '../types/domain'

const STORAGE_KEY = 'gsb67:grid-acceptance'
const STORAGE_VERSION = 2
let idSeed = 30

interface SignSnapshot {
  version: number
  signedAt: string
  certStatus: Record<string, CertificateLedgerRow['status']>
}

export interface ReceiveResult {
  ok: boolean
  outcome: IngestOutcome
  invalidated: boolean
  message: string
}

export const useAcceptanceStore = defineStore('acceptance', () => {
  const plant = ref<Plant>(structuredClone(seedPlant))
  const equipment = ref<EquipmentNode[]>(structuredClone(seedEquipment))
  const defects = ref<AcceptanceDefect[]>(structuredClone(seedDefects))
  const audit = ref<AuditEntry[]>(structuredClone(seedAudit))
  const receipts = ref<ReceiptBatch[]>(structuredClone(seedReceipts))
  const signSnapshot = ref<SignSnapshot | null>(null)
  const selectedEquipmentId = ref(equipment.value[0].id)
  const keyword = ref('')
  const hydrated = ref(false)

  const selectedEquipment = computed(() => equipment.value.find((item) => item.id === selectedEquipmentId.value))

  /** 回执与台账对账结果 */
  const ledger = computed<CertificateLedgerRow[]>(() => buildCertificateLedger(equipment.value, receipts.value))
  const ledgerByCertId = computed(() => new Map(ledger.value.map((row) => [row.certificateId, row])))
  const blockedLedger = computed(() => ledger.value.filter((row) => isCertBlocked(row.status)))

  const stats = computed(() => {
    const items = equipment.value.flatMap((item) => item.items)
    return {
      total: items.length,
      passed: items.filter((item) => item.status === '合格').length,
      failed: items.filter((item) => item.status === '不合格' || item.status === '待复验').length,
      openDefects: defects.value.filter((item) => !['已关闭', '带条件通过'].includes(item.status)).length,
      pendingCerts: blockedLedger.value.length
    }
  })

  const preflight = computed(() => {
    const blocking: string[] = []
    const items = equipment.value.flatMap((item) => item.items)
    if (items.some((item) => item.status === '待检查')) blocking.push('仍有验收项未检查')
    if (items.some((item) => item.status === '不合格' || item.status === '待复验')) blocking.push('存在不合格或待复验项')
    if (defects.value.some((item) => !['已关闭', '带条件通过'].includes(item.status))) blocking.push('存在未闭环缺陷')
    if (blockedLedger.value.some((row) => row.status === '已撤销')) blocking.push(`存在${blockedLedger.value.filter((row) => row.status === '已撤销').length}张已撤销证书（回执标记，不得计通过）`)
    if (blockedLedger.value.some((row) => row.status === '换版待核')) blocking.push('存在换版待核证书，需按回执新版本重新核验')
    if (blockedLedger.value.some((row) => row.status === '版本不符')) blocking.push(`存在${blockedLedger.value.filter((row) => row.status === '版本不符').length}张版本与回执不一致的证书`)
    if (blockedLedger.value.some((row) => row.status === '重复挂证')) blocking.push('同一证书编号挂在多台设备上，需拆分核实')
    if (blockedLedger.value.some((row) => row.status === '缺回执编号')) blocking.push('老证书缺少回执编号，按待核处理')
    if (blockedLedger.value.some((row) => row.status === '待核')) blocking.push(`存在${blockedLedger.value.filter((row) => row.status === '待核').length}张证书尚无回执核验结论`)
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
        if (stored.version === STORAGE_VERSION) {
          plant.value = stored.plant
          equipment.value = stored.equipment
          defects.value = stored.defects
          audit.value = stored.audit
          receipts.value = stored.receipts
          signSnapshot.value = stored.signSnapshot ?? null
          applyReconciliation()
        } else {
          // 旧版本本地结构与回执对账模型不兼容，重置为种子数据
          applyReconciliation()
          persist()
        }
      } else {
        applyReconciliation()
        persist()
      }
    } catch {
      // Seed data is kept when browser storage is corrupt.
    }
    hydrated.value = true
  }

  function persist() {
    if (!import.meta.client) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, plant: plant.value, equipment: equipment.value, defects: defects.value, audit: audit.value, receipts: receipts.value, signSnapshot: signSnapshot.value }))
  }

  /**
   * 按对账结论回写：
   * - 证书挂接命中的回执编号；
   * - 挂有阻断证书的设备改判“待核”，问题消除后由待核恢复为验收中。
   */
  function applyReconciliation() {
    for (const row of ledger.value) {
      const node = equipment.value.find((item) => item.id === row.equipmentId)
      const cert = node?.certificates.find((item) => item.id === row.certificateId)
      if (cert) cert.receiptNo = row.receiptNo
    }
    for (const node of equipment.value) {
      const rows = ledger.value.filter((row) => row.equipmentId === node.id)
      const hasBlocked = rows.some((row) => isCertBlocked(row.status))
      if (hasBlocked) {
        node.status = '待核'
      } else if (node.status === '待核') {
        node.status = '验收中'
      }
    }
  }

  /**
   * 接收外部核验回执：
   * - 与台账对账，同一编号以回执最新版本为准；
   * - 两个窗口同提：先到保留、后到只补新增行；
   * - 失败重试只补没写入的部分，重复接收不重复登记；
   * - 回执变化导致结论改变时，已签署批次失效、相关设备改判待核。
   */
  function receiveReceipt(submission: ReceiptSubmission, failLineNos: string[] = []): ReceiveResult {
    const failSet = new Set(failLineNos)
    const before = new Map(ledger.value.map((row) => [row.certificateId, row.status]))
    const { batches, outcome } = ingestReceiptBatch(receipts.value, submission, (lineNo) =>
      failSet.has(lineNo) ? '传输中断，该行未写入' : null
    )
    receipts.value = batches
    applyReconciliation()

    // 仅本次新登记条目可能引起“回执一变”
    const changedCertNos = new Set(outcome.registered.map((entry) => entry.certNo))
    const changedRows = ledger.value.filter(
      (row) => row.certNo && changedCertNos.has(row.certNo) && before.get(row.certificateId) !== undefined && before.get(row.certificateId) !== row.status
    )
    let invalidated = false
    if (changedRows.length && plant.value.status === '已签署' && signSnapshot.value) {
      invalidated = true
      plant.value.status = '待复核'
      plant.value.version += 1
      const deviceIds = new Set(changedRows.map((row) => row.equipmentId))
      for (const node of equipment.value) {
        if (deviceIds.has(node.id)) node.status = '待核'
      }
      const names = changedRows.map((row) => `${row.certName}（${row.certNo}）→${row.status}`).join('、')
      log(plant.value.id, '签署批次失效', '系统对账', `回执${submission.receiptNo}更新导致${[...deviceIds].join('、')}证书结论变化：${names}，批次改判待复核`)
    }

    if (outcome.registered.length) {
      log(submission.receiptNo, '接收核验回执', '系统对账', `新登记${outcome.registered.length}条：${outcome.registered.map((entry) => `${entry.certNo}/V${entry.version}/${entry.result}`).join('；')}`)
    }
    if (outcome.resubmitted && (outcome.skipped.length || !outcome.registered.length)) {
      log(submission.receiptNo, '回执重复接收', '系统对账', `跳过${outcome.skipped.length}条已登记条目${outcome.failed.length ? `，仍有${outcome.failed.length}条未写入` : ''}`)
    }
    if (outcome.failed.length) {
      log(submission.receiptNo, '回执接收部分失败', '系统对账', `未写入${outcome.failed.length}条：${outcome.failed.map((item) => item.lineNo).join('、')}，可重试只补这些行`)
    }

    persist()
    const message = outcome.failed.length
      ? `新登记${outcome.registered.length}条，${outcome.failed.length}条写入失败，重试仅补未写部分`
      : outcome.registered.length
        ? `回执已接收并完成台账对账，新登记${outcome.registered.length}条`
        : '回执内容此前已全部登记，未重复登记'
    return { ok: outcome.failed.length === 0, outcome, invalidated, message }
  }

  /** 版本不符时，按回执最新版本换版登记（以回执为准） */
  function admitReceiptVersion(certificateId: string) {
    const row = ledgerByCertId.value.get(certificateId)
    if (!row || row.status !== '版本不符' || row.receiptVersion === null) return { ok: false, message: '当前证书无需按回执换版' }
    const node = equipment.value.find((item) => item.id === row.equipmentId)
    const cert = node?.certificates.find((item) => item.id === certificateId)
    if (!cert) return { ok: false, message: '证书不存在' }
    const oldVersion = cert.version
    cert.version = row.receiptVersion
    applyReconciliation()
    log(certificateId, '按回执换版', '验收负责人陆川', `${row.certNo}由V${oldVersion}更新为回执最新V${cert.version}`)
    persist()
    return { ok: true, message: `已按回执更新为V${cert.version}，请重新核验归档` }
  }

  /** 修正台账证书（老证书补编号、重复挂证核实后改挂正确编号） */
  function updateCertificate(equipmentId: string, certificateId: string, patch: Partial<{ certNo: string | null; name: string; expiresAt: string }>) {
    const cert = equipment.value.find((node) => node.id === equipmentId)?.certificates.find((item) => item.id === certificateId)
    if (!cert) return { ok: false, message: '证书不存在' }
    const certNo = patch.certNo !== undefined ? (patch.certNo?.trim() || null) : cert.certNo
    if (patch.name !== undefined && !patch.name.trim()) return { ok: false, message: '证书名称不能为空' }
    Object.assign(cert, { ...patch, certNo })
    applyReconciliation()
    log(certificateId, '修正证书台账', '验收负责人陆川', certNo ? `补登/修正证书编号${certNo}并重新对账` : '证书编号清空，改判待核')
    persist()
    return { ok: true, message: '证书台账已更新并重新对账' }
  }

  function updateItem(equipmentId: string, itemId: string, patch: Partial<AcceptanceItem>) {
    const item = equipment.value.find((node) => node.id === equipmentId)?.items.find((value) => value.id === itemId)
    if (!item) return
    Object.assign(item, patch, { version: item.version + 1 })
    log(equipmentId, '更新验收项', '当前用户', `${item.id}状态更新为${item.status}`)
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

  function signOff() {
    if (!preflight.value.allowed) return { ok: false, message: preflight.value.blocking.join('；') }
    plant.value.status = '已签署'
    plant.value.version += 1
    equipment.value.forEach((node) => { node.status = '已验收' })
    signSnapshot.value = {
      version: plant.value.version,
      signedAt: new Date().toISOString(),
      certStatus: Object.fromEntries(ledger.value.map((row) => [row.certificateId, row.status]))
    }
    log(plant.value.id, '签署交付版本', '验收负责人陆川', `锁定V${plant.value.version}并生成交付包（证书对账结论随批锁定）`)
    persist()
    return { ok: true, message: '签署完成，交付版本已锁定' }
  }

  function reset() {
    plant.value = structuredClone(seedPlant)
    equipment.value = structuredClone(seedEquipment)
    defects.value = structuredClone(seedDefects)
    audit.value = structuredClone(seedAudit)
    receipts.value = structuredClone(seedReceipts)
    signSnapshot.value = null
    applyReconciliation()
    persist()
  }

  function log(entityId: string, action: string, operator: string, detail: string) {
    audit.value.unshift({ id: `AUD-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, createdAt: new Date().toISOString() })
  }

  return {
    plant, equipment, defects, audit, receipts, signSnapshot, selectedEquipmentId, keyword, hydrated,
    selectedEquipment, stats, preflight, ledger, ledgerByCertId, blockedLedger,
    hydrate, persist, receiveReceipt, admitReceiptVersion, updateCertificate,
    updateItem, assignDefect, addReply, addRetest, decideDefect, signOff, reset
  }
})
