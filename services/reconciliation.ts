import type { Certificate, EquipmentNode, ReceiptState, VerificationReceipt, VerifyState } from '../types/domain'

/**
 * 核验回执对账（纯函数）。
 *
 * 规则：
 * - 台账与回执按证书编号对账，状态一律由回执推导，不再看手工勾选；
 * - 同一证书编号存在多份回执时，以版本最新的为准，版本相同取最后接收的；
 * - 老证书缺回执编号，或回执台账查不到有效回执，先判“待核”；
 * - 回执为已撤销 / 已换版，或回执版本早于台账证书版本，不得判通过。
 */

export interface IncomingReceiptEntry {
  receiptNo: string
  certNo: string
  certificateName: string
  issuer: string
  version: number
  state: ReceiptState
}

export interface CertFinding {
  certId: string
  equipmentId: string
  certNo: string
  effectiveReceiptNo: string
  state: VerifyState
  certVersion: number
  receiptVersion: number | null
  reason: string
}

export interface DuplicateCertGroup {
  certNo: string
  mounts: Array<{ equipmentId: string; equipmentName: string; certId: string; name: string }>
}

export interface ReconcileResult {
  findingsByCertId: Record<string, CertFinding>
  effectiveByCertNo: Map<string, VerificationReceipt>
  supersededReceipts: VerificationReceipt[]
  unmatchedReceipts: VerificationReceipt[]
  duplicateGroups: DuplicateCertGroup[]
  counts: Record<VerifyState, number>
}

/**
 * 同一证书编号挑最新版本回执；版本相同取最后接收（“以回执里的最新版本为准”）。
 */
export function pickEffectiveReceipt(receipts: VerificationReceipt[], certNo: string): VerificationReceipt | undefined {
  return receipts
    .filter((receipt) => receipt.certNo === certNo)
    .sort((a, b) => (b.version - a.version) || (a.receivedAt < b.receivedAt ? 1 : -1))[0]
}

/**
 * 窗口提交去重：同一回执编号先到的保留，后到的丢弃。
 */
export function collapseIncoming(entries: IncomingReceiptEntry[]): { kept: IncomingReceiptEntry[]; droppedDuplicates: IncomingReceiptEntry[] } {
  const seen = new Set<string>()
  const kept: IncomingReceiptEntry[] = []
  const droppedDuplicates: IncomingReceiptEntry[] = []
  for (const entry of entries) {
    const key = entry.receiptNo.trim()
    if (!key || seen.has(key)) {
      droppedDuplicates.push(entry)
      continue
    }
    seen.add(key)
    kept.push(entry)
  }
  return { kept, droppedDuplicates }
}

/**
 * 回执登记：按回执编号幂等合并，已登记的只跳过、不重复登记。
 */
export function mergeReceiptEntries(
  existing: VerificationReceipt[],
  kept: IncomingReceiptEntry[],
  batch: { id: string; source: string; receivedAt: string }
): { merged: VerificationReceipt[]; added: VerificationReceipt[]; duplicated: IncomingReceiptEntry[] } {
  const known = new Set(existing.map((receipt) => receipt.receiptNo))
  const merged = [...existing]
  const added: VerificationReceipt[] = []
  const duplicated: IncomingReceiptEntry[] = []
  for (const entry of kept) {
    if (known.has(entry.receiptNo)) {
      duplicated.push(entry)
      continue
    }
    const receipt: VerificationReceipt = { ...entry, receivedAt: batch.receivedAt, source: batch.source, batchId: batch.id }
    merged.push(receipt)
    added.push(receipt)
    known.add(entry.receiptNo)
  }
  return { merged, added, duplicated }
}

function judgeCertificate(certificate: Certificate, effective: VerificationReceipt | undefined): { state: VerifyState; receiptVersion: number | null; reason: string } {
  if (!certificate.receiptNo?.trim()) {
    return { state: '待核', receiptVersion: null, reason: '老证书缺少回执编号，先按待核处理' }
  }
  if (!effective) {
    return { state: '待核', receiptVersion: null, reason: '回执台账中查不到该证书编号的回执' }
  }
  if (effective.state === '已撤销') {
    return { state: '已撤销', receiptVersion: effective.version, reason: `回执${effective.receiptNo}声明该证书已撤销` }
  }
  if (effective.state === '已换版') {
    return { state: '已换版', receiptVersion: effective.version, reason: `回执${effective.receiptNo}声明该版本已换版` }
  }
  if (effective.version < certificate.version) {
    return { state: '待核', receiptVersion: effective.version, reason: `回执V${effective.version}早于台账证书V${certificate.version}，需要重新核验` }
  }
  if (effective.version > certificate.version) {
    return { state: '已核验', receiptVersion: effective.version, reason: `回执V${effective.version}已覆盖台账V${certificate.version}` }
  }
  return { state: '已核验', receiptVersion: effective.version, reason: `回执${effective.receiptNo}核验通过` }
}

export function reconcileCertificates(equipment: EquipmentNode[], receipts: VerificationReceipt[]): ReconcileResult {
  const findingsByCertId: Record<string, CertFinding> = {}
  const effectiveByCertNo = new Map<string, VerificationReceipt>()
  const supersededReceipts: VerificationReceipt[] = []
  const mountsByCertNo = new Map<string, DuplicateCertGroup>()
  const referencedCertNos = new Set<string>()

  const allCertificates = equipment.flatMap((node) => node.certificates.map((certificate) => ({ node, certificate })))
  for (const { node, certificate } of allCertificates) {
    referencedCertNos.add(certificate.certNo)
    if (!mountsByCertNo.has(certificate.certNo)) {
      mountsByCertNo.set(certificate.certNo, { certNo: certificate.certNo, mounts: [] })
    }
    mountsByCertNo.get(certificate.certNo)!.mounts.push({ equipmentId: node.id, equipmentName: node.name, certId: certificate.id, name: certificate.name })
  }

  for (const certNo of new Set(allCertificates.map(({ certificate }) => certificate.certNo))) {
    const effective = pickEffectiveReceipt(receipts, certNo)
    if (effective) effectiveByCertNo.set(certNo, effective)
    const winners = new Set(effective ? [effective.receiptNo] : [])
    for (const receipt of receipts.filter((item) => item.certNo === certNo && !winners.has(item.receiptNo))) {
      supersededReceipts.push(receipt)
    }
  }

  const counts: Record<VerifyState, number> = { 已核验: 0, 待核: 0, 已撤销: 0, 已换版: 0 }
  for (const { node, certificate } of allCertificates) {
    const effective = effectiveByCertNo.get(certificate.certNo)
    const verdict = judgeCertificate(certificate, effective)
    findingsByCertId[certificate.id] = {
      certId: certificate.id,
      equipmentId: node.id,
      certNo: certificate.certNo,
      effectiveReceiptNo: effective?.receiptNo ?? '',
      state: verdict.state,
      certVersion: certificate.version,
      receiptVersion: verdict.receiptVersion,
      reason: verdict.reason
    }
    counts[verdict.state] += 1
  }

  const unmatchedReceipts = receipts.filter((receipt) => !referencedCertNos.has(receipt.certNo))
  const duplicateGroups = [...mountsByCertNo.values()].filter((group) => group.mounts.length > 1)

  return { findingsByCertId, effectiveByCertNo, supersededReceipts, unmatchedReceipts, duplicateGroups, counts }
}

/**
 * 对账结果前后差异：找出原先已核验、现在不再通过的证书（用于批次失效、设备改判待核）。
 */
export function diffFindings(prev: Record<string, VerifyState>, next: ReconcileResult): { invalidated: CertFinding[]; cleared: CertFinding[] } {
  const invalidated: CertFinding[] = []
  const cleared: CertFinding[] = []
  for (const finding of Object.values(next.findingsByCertId)) {
    const before = prev[finding.certId]
    if (before === '已核验' && finding.state !== '已核验') invalidated.push(finding)
    if (before && before !== '已核验' && finding.state === '已核验') cleared.push(finding)
  }
  return { invalidated, cleared }
}
