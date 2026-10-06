import type { Certificate, CertificateLedgerRow, EquipmentNode, ReceiptBatch, ReceiptEntry } from '../types/domain'

/**
 * 跨全部回执，按证书编号归并出“最新版本”条目。
 * 规则：先取版本号最大的；版本相同取核验时间最新的。
 */
export function latestEntriesByCertNo(batches: ReceiptBatch[]): Map<string, { entry: ReceiptEntry; receiptNo: string }> {
  const latest = new Map<string, { entry: ReceiptEntry; receiptNo: string }>()
  for (const batch of batches) {
    for (const entry of batch.entries) {
      const current = latest.get(entry.certNo)
      if (
        !current ||
        entry.version > current.entry.version ||
        (entry.version === current.entry.version && entry.checkedAt > current.entry.checkedAt)
      ) {
        latest.set(entry.certNo, { entry, receiptNo: batch.receiptNo })
      }
    }
  }
  return latest
}

/** 同一证书编号挂在几台设备上（按设备去重计数） */
export function mountCountByCertNo(equipment: EquipmentNode[]): Map<string, number> {
  const counts = new Map<string, Set<string>>()
  for (const node of equipment) {
    for (const cert of node.certificates) {
      if (!cert.certNo) continue
      if (!counts.has(cert.certNo)) counts.set(cert.certNo, new Set())
      counts.get(cert.certNo)!.add(node.id)
    }
  }
  return new Map([...counts].map(([certNo, ids]) => [certNo, ids.size]))
}

function resolveStatus(cert: Certificate, match: { entry: ReceiptEntry }, mountedCount: number): CertificateLedgerRow['status'] {
  const { entry } = match
  if (entry.result === '已撤销') return '已撤销'
  if (entry.result === '换版待核') return '换版待核'
  // 回执有效：版本必须与台账一致，且不能重复挂证
  if (entry.version !== cert.version) return '版本不符'
  if (mountedCount > 1) return '重复挂证'
  return '已核验'
}

function noteFor(row: Pick<CertificateLedgerRow, 'status' | 'mountedCount' | 'ledgerVersion' | 'receiptVersion' | 'checkedAt'>): string {
  switch (row.status) {
    case '已核验': return '回执与台账一致'
    case '已撤销': return `回执（${row.checkedAt?.slice(0, 10) ?? ''}核验）标记该编号证书已撤销，不得计通过`
    case '换版待核': return '回执提示已换版，台账仍为旧版，改判待核'
    case '版本不符': return `台账V${row.ledgerVersion}与回执V${row.receiptVersion}不一致，以回执最新版本为准`
    case '重复挂证': return `同一编号挂在${row.mountedCount}台设备上，需核实并拆分真实编号后重核`
    case '缺回执编号': return '老证书缺少回执编号，无法自动比对，先待核'
    case '待核': return '所有回执中均无该编号的核验结论'
  }
}

/**
 * 接收回执后与设备台账对账，逐张台账证书给出结论。
 * 同一证书编号一律以回执里的最新版本为准；撤销/换版不得算通过。
 */
export function buildCertificateLedger(equipment: EquipmentNode[], batches: ReceiptBatch[]): CertificateLedgerRow[] {
  const latest = latestEntriesByCertNo(batches)
  const mountCounts = mountCountByCertNo(equipment)
  const rows: CertificateLedgerRow[] = []
  for (const node of equipment) {
    for (const cert of node.certificates) {
      const mountedCount = cert.certNo ? mountCounts.get(cert.certNo) ?? 1 : 1
      const match = cert.certNo ? latest.get(cert.certNo) : undefined
      let status: CertificateLedgerRow['status']
      if (!cert.certNo) {
        status = '缺回执编号'
      } else if (!match) {
        status = '待核'
      } else {
        status = resolveStatus(cert, match, mountedCount)
      }
      const row: CertificateLedgerRow = {
        certificateId: cert.id,
        equipmentId: node.id,
        equipmentName: node.name,
        certNo: cert.certNo,
        certName: cert.name,
        ledgerVersion: cert.version,
        status,
        receiptNo: match?.receiptNo ?? null,
        receiptVersion: match?.entry.version ?? null,
        receiptResult: match?.entry.result ?? null,
        checkedAt: match?.entry.checkedAt ?? null,
        mountedCount,
        note: ''
      }
      row.note = noteFor(row)
      rows.push(row)
    }
  }
  return rows
}

/** 台账中阻断签署的证书问题状态 */
export const BLOCKING_CERT_STATUSES: CertificateLedgerRow['status'][] = ['已撤销', '换版待核', '版本不符', '重复挂证', '缺回执编号', '待核']

export function isCertBlocked(status: CertificateLedgerRow['status']): boolean {
  return BLOCKING_CERT_STATUSES.includes(status)
}
