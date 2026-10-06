import type { ReceiptBatch, ReceiptEntry } from '../types/domain'

/** 外部提交的一版原始回执（文件/报文） */
export interface ReceiptSubmission {
  receiptNo: string
  issuer: string
  receivedAt: string
  source: string
  entries: Array<Omit<ReceiptEntry, never>>
}

export interface IngestOutcome {
  receiptNo: string
  /** 是否为重复提交/重试（同编号回执此前已到过一个窗口） */
  resubmitted: boolean
  registered: ReceiptEntry[]
  skipped: Array<{ lineNo: string; reason: string }>
  failed: Array<{ lineNo: string; reason: string }>
}

/** 传输层写某一行是否失败：返回失败原因，null 表示成功 */
export type LineWriteGate = (lineNo: string, entry: ReceiptEntry) => string | null

function validateEntry(entry: Partial<ReceiptEntry> | undefined): string | null {
  if (!entry) return '回执条目格式不正确'
  if (!entry.lineNo || !String(entry.lineNo).trim()) return '缺少回执行号'
  if (!entry.certNo || !String(entry.certNo).trim()) return '缺少证书编号'
  if (typeof entry.version !== 'number' || Number.isNaN(entry.version)) return '证书版本号无效'
  if (!['有效', '已撤销', '换版待核'].includes(String(entry.result))) return '核验结论无法识别'
  if (!entry.checkedAt) return '缺少核验时间'
  return null
}

/**
 * 接收一版核验回执并写入登记。
 * - 两个窗口同时提交同一回执：先到的整体保留，后到的只补此前没有的行（按行号去重）。
 * - 重复接收：已登记的行不再重复登记；内容与已登记行完全一致的行同样跳过。
 * - 接收失败后重试：仅写入 writtenLines 之外、且本次写成功的部分。
 */
export function ingestReceiptBatch(
  existing: ReceiptBatch[],
  input: ReceiptSubmission,
  writeGate?: LineWriteGate
): { batches: ReceiptBatch[]; outcome: IngestOutcome } {
  const batches = existing.map((batch) => structuredClone(batch))
  let batch = batches.find((item) => item.receiptNo === input.receiptNo)
  const resubmitted = Boolean(batch)
  if (!batch) {
    batch = { receiptNo: input.receiptNo, issuer: input.issuer, receivedAt: input.receivedAt, source: input.source, entries: [], writtenLines: [], failedLines: [] }
    batches.push(batch)
  } else {
    // 先到的窗口保留其来源与最早接收时间
    batch.receivedAt = batch.receivedAt < input.receivedAt ? batch.receivedAt : input.receivedAt
  }

  const registered: ReceiptEntry[] = []
  const skipped: IngestOutcome['skipped'] = []
  const failed: IngestOutcome['failed'] = []

  for (const raw of input.entries) {
    const invalid = validateEntry(raw)
    const lineNo = String(raw?.lineNo ?? '').trim()
    if (invalid) {
      failed.push({ lineNo: lineNo || '(无行号)', reason: invalid })
      continue
    }
    const entry: ReceiptEntry = { ...raw, lineNo, certNo: raw.certNo.trim() }
    if (batch.writtenLines.includes(lineNo)) {
      skipped.push({ lineNo, reason: '该行此前窗口已登记，重复接收不重复登记' })
      continue
    }
    const sameContent = batch.entries.some(
      (value) => value.certNo === entry.certNo && value.version === entry.version && value.result === entry.result && value.checkedAt === entry.checkedAt
    )
    if (sameContent) {
      skipped.push({ lineNo, reason: '与已登记条目内容一致，不重复登记' })
      continue
    }
    const failure = writeGate?.(lineNo, entry) ?? null
    if (failure) {
      failed.push({ lineNo, reason: failure })
      continue
    }
    batch.entries.push(entry)
    batch.writtenLines.push(lineNo)
    batch.failedLines = batch.failedLines.filter((item) => item.lineNo !== lineNo)
    registered.push(entry)
  }

  // failedLines 始终表示“尝试过但尚未写入”的行：本次失败的并入，本次补写成功的移除
  const failedMap = new Map(batch.failedLines.map((item) => [item.lineNo, item]))
  for (const item of failed) failedMap.set(item.lineNo, item)
  for (const lineNo of batch.writtenLines) failedMap.delete(lineNo)
  batch.failedLines = [...failedMap.values()]

  return { batches, outcome: { receiptNo: input.receiptNo, resubmitted, registered, skipped, failed } }
}
