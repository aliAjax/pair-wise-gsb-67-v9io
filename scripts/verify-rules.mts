import assert from 'node:assert'
import { ingestReceiptBatch } from '../services/receipts'
import { buildCertificateLedger } from '../services/reconciliation'
import type { EquipmentNode, ReceiptBatch } from '../types/domain'

const equipment: EquipmentNode[] = [
  { id: 'E1', parentId: null, name: '逆变器A', type: '逆变器', code: 'A', status: '验收中', items: [], certificates: [
    { id: 'C1', certNo: 'N-001', name: '穿越证书', issuer: '院', expiresAt: '2030-01-01', version: 1, receiptNo: null },
    { id: 'C2', certNo: 'N-002', name: '老证书', issuer: '院', expiresAt: '2030-01-01', version: 1, receiptNo: null }
  ] },
  { id: 'E2', parentId: null, name: '逆变器B', type: '逆变器', code: 'B', status: '验收中', items: [], certificates: [
    { id: 'C3', certNo: 'N-001', name: '穿越证书复印件', issuer: '院', expiresAt: '2030-01-01', version: 1, receiptNo: null }
  ] },
  { id: 'E3', parentId: null, name: '老设备', type: '汇流箱', code: 'C', status: '验收中', items: [], certificates: [
    { id: 'C4', certNo: null, name: '历史报告', issuer: '站', expiresAt: '2030-01-01', version: 1, receiptNo: null }
  ] }
]

// 1. 窗口一先到：只含 L1
let batches: ReceiptBatch[] = []
;({ batches } = ingestReceiptBatch(batches, {
  receiptNo: 'R1', issuer: 'x', source: '窗口一', receivedAt: '2026-10-06T10:00:00',
  entries: [{ lineNo: 'L1', certNo: 'N-001', certName: '穿越证书', version: 1, result: '有效', issuer: '院', expiresAt: '2030-01-01', checkedAt: '2026-10-06T09:00:00' }]
}))
// 2. 窗口二后到：L1 重复 + L2 新增，只补 L2
{
  const result = ingestReceiptBatch(batches, {
    receiptNo: 'R1', issuer: 'x', source: '窗口二', receivedAt: '2026-10-06T10:05:00',
    entries: [
      { lineNo: 'L1', certNo: 'N-001', certName: '穿越证书', version: 1, result: '有效', issuer: '院', expiresAt: '2030-01-01', checkedAt: '2026-10-06T09:00:00' },
      { lineNo: 'L2', certNo: 'N-002', certName: '老证书', version: 1, result: '有效', issuer: '院', expiresAt: '2030-01-01', checkedAt: '2026-10-06T09:05:00' }
    ]
  })
  batches = result.batches
  const { outcome } = result
  assert.equal(outcome.registered.length, 1)
  assert.equal(outcome.registered[0].lineNo, 'L2')
  assert.equal(outcome.skipped.length, 1)
  assert.equal(outcome.resubmitted, true)
}
// 先到窗口的来源和最早接收时间保留
assert.equal(batches[0].source, '窗口一')
assert.equal(batches[0].receivedAt, '2026-10-06T10:00:00')

// 3. 部分失败：L1 失败，重试只补 L1，不重复 L2
{
  const first = ingestReceiptBatch([], {
    receiptNo: 'R2', issuer: 'x', source: 's', receivedAt: '2026-10-06T11:00:00',
    entries: [
      { lineNo: 'L1', certNo: 'N-X', certName: 'x', version: 1, result: '有效', issuer: '院', expiresAt: '2030-01-01', checkedAt: '2026-10-06T10:30:00' },
      { lineNo: 'L2', certNo: 'N-Y', certName: 'y', version: 1, result: '有效', issuer: '院', expiresAt: '2030-01-01', checkedAt: '2026-10-06T10:31:00' }
    ]
  }, (lineNo) => lineNo === 'L1' ? '传输中断' : null)
  assert.deepEqual(first.outcome.registered.map((e) => e.lineNo), ['L2'])
  assert.deepEqual(first.outcome.failed.map((e) => e.lineNo), ['L1'])
  const retry = ingestReceiptBatch(first.batches, {
    receiptNo: 'R2', issuer: 'x', source: 's', receivedAt: '2026-10-06T11:10:00',
    entries: [
      { lineNo: 'L1', certNo: 'N-X', certName: 'x', version: 1, result: '有效', issuer: '院', expiresAt: '2030-01-01', checkedAt: '2026-10-06T10:30:00' },
      { lineNo: 'L2', certNo: 'N-Y', certName: 'y', version: 1, result: '有效', issuer: '院', expiresAt: '2030-01-01', checkedAt: '2026-10-06T10:31:00' }
    ]
  })
  assert.deepEqual(retry.outcome.registered.map((e) => e.lineNo), ['L1'])
  assert.equal(retry.outcome.failed.length, 0)
  assert.equal(retry.batches[0].entries.length, 2)
  // 再重试一次：全部已登记，不重复
  const again = ingestReceiptBatch(retry.batches, {
    receiptNo: 'R2', issuer: 'x', source: 's', receivedAt: '2026-10-06T11:20:00',
    entries: [
      { lineNo: 'L1', certNo: 'N-X', certName: 'x', version: 1, result: '有效', issuer: '院', expiresAt: '2030-01-01', checkedAt: '2026-10-06T10:30:00' },
      { lineNo: 'L2', certNo: 'N-Y', certName: 'y', version: 1, result: '有效', issuer: '院', expiresAt: '2030-01-01', checkedAt: '2026-10-06T10:31:00' }
    ]
  })
  assert.equal(again.outcome.registered.length, 0)
  assert.equal(again.batches[0].entries.length, 2)
}

// 4. 对账：初始 R1 两条有效；N-001 挂两台 → 重复挂证；N-002 已核验；C4 缺编号
let ledger = buildCertificateLedger(equipment, batches)
assert.equal(ledger.find((r) => r.certificateId === 'C1')?.status, '重复挂证')
assert.equal(ledger.find((r) => r.certificateId === 'C3')?.status, '重复挂证')
assert.equal(ledger.find((r) => r.certificateId === 'C2')?.status, '已核验')
assert.equal(ledger.find((r) => r.certificateId === 'C4')?.status, '缺回执编号')

// 5. 新回执：N-001 撤销；N-002 换版V2。撤销/旧版不得通过，且以最新版本为准
;({ batches } = ingestReceiptBatch(batches, {
  receiptNo: 'R3', issuer: 'x', source: 's', receivedAt: '2026-10-06T12:00:00',
  entries: [
    { lineNo: 'L1', certNo: 'N-001', certName: '穿越证书', version: 1, result: '已撤销', issuer: '院', expiresAt: '2030-01-01', checkedAt: '2026-10-06T11:50:00' },
    { lineNo: 'L2', certNo: 'N-002', certName: '老证书', version: 2, result: '换版待核', issuer: '院', expiresAt: '2031-01-01', checkedAt: '2026-10-06T11:55:00' }
  ]
}))
ledger = buildCertificateLedger(equipment, batches)
assert.equal(ledger.find((r) => r.certificateId === 'C1')?.status, '已撤销')
assert.equal(ledger.find((r) => r.certificateId === 'C3')?.status, '已撤销')
assert.equal(ledger.find((r) => r.certificateId === 'C2')?.status, '换版待核')

// 6. 同编号新版本“有效”到达：台账仍是V1 → 版本不符；换版后核验
;({ batches } = ingestReceiptBatch(batches, {
  receiptNo: 'R4', issuer: 'x', source: 's', receivedAt: '2026-10-06T13:00:00',
  entries: [{ lineNo: 'L1', certNo: 'N-002', certName: '老证书', version: 2, result: '有效', issuer: '院', expiresAt: '2031-01-01', checkedAt: '2026-10-06T12:40:00' }]
}))
ledger = buildCertificateLedger(equipment, batches)
assert.equal(ledger.find((r) => r.certificateId === 'C2')?.status, '版本不符')
equipment[0].certificates[1].version = 2
ledger = buildCertificateLedger(equipment, batches)
assert.equal(ledger.find((r) => r.certificateId === 'C2')?.status, '已核验')

// 7. 无任何回执命中的证书 → 待核
;({ batches } = ingestReceiptBatch(batches, {
  receiptNo: 'R5', issuer: 'x', source: 's', receivedAt: '2026-10-06T14:00:00',
  entries: [{ lineNo: 'L1', certNo: 'N-NEW', certName: '新证', version: 1, result: '有效', issuer: '院', expiresAt: '2031-01-01', checkedAt: '2026-10-06T13:50:00' }]
}))
equipment.push({ id: 'E4', parentId: null, name: '新设备', type: '逆变器', code: 'D', status: '验收中', items: [], certificates: [{ id: 'C5', certNo: 'N-ORPHAN', name: '孤证', issuer: '院', expiresAt: '2031-01-01', version: 1, receiptNo: null }] })
ledger = buildCertificateLedger(equipment, batches)
assert.equal(ledger.find((r) => r.certificateId === 'C5')?.status, '待核')

console.log('all reconciliation/receipt rules passed')
