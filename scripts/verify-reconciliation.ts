// 业务规则验证：node --experimental-strip-types scripts/verify-reconciliation.ts
import assert from 'node:assert'
import { collapseIncoming, diffFindings, mergeReceiptEntries, pickEffectiveReceipt, reconcileCertificates, type IncomingReceiptEntry } from '../services/reconciliation.ts'
import type { EquipmentNode, VerificationReceipt } from '../types/domain.ts'

let passed = 0
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`) }

const cert = (id: string, certNo: string, version: number, receiptNo = '') => ({ id, name: id, issuer: '机构', expiresAt: '2099-01-01', version, certNo, receiptNo, verified: true })
const r = (receiptNo: string, certNo: string, version: number, state: '有效' | '已撤销' | '已换版' = '有效', receivedAt = '2026-10-01T10:00:00Z'): VerificationReceipt => ({ receiptNo, certNo, certificateName: certNo, issuer: '机构', version, state, receivedAt, source: '窗口', batchId: 'B' })

// 设备台账：CERT-I1 同编号挂两台设备；CERT-LEGACY 无回执编号（老证书）
const equipment: EquipmentNode[] = [
  { id: 'E1', parentId: null, name: '并网点', type: '并网点', code: 'G', status: '已验收', items: [], certificates: [cert('c1', 'CERT-G1', 1, 'R1'), cert('cDup', 'CERT-I1', 2, 'R3')] },
  { id: 'E2', parentId: null, name: '逆变器', type: '逆变器', code: 'I', status: '已验收', items: [], certificates: [cert('c2', 'CERT-I1', 2, 'R3'), cert('cLegacy', 'CERT-LEGACY', 1, ''), cert('cRevoked', 'CERT-OLD', 1, 'R7')] }
]

console.log('1) 对账：有效回执核验通过；缺回执编号先待核')
{
  const receipts = [r('R1', 'CERT-G1', 1), r('R3', 'CERT-I1', 2)]
  const result = reconcileCertificates(equipment, receipts)
  check('有效回执 → 已核验', () => assert.equal(result.findingsByCertId.c1.state, '已核验'))
  check('老证书缺回执编号 → 待核', () => assert.equal(result.findingsByCertId.cLegacy.state, '待核'))
  check('无回执 → 待核', () => assert.equal(result.findingsByCertId.cRevoked.state, '待核'))
  check('同编号挂两台设备 → duplicateGroups 命中', () => assert.equal(result.duplicateGroups[0]?.mounts.length, 2))
}

console.log('2) 同编号回执多版本：以回执里的最新版本为准')
{
  const receipts = [r('R1', 'CERT-G1', 1), r('R2', 'CERT-G1', 3, '有效', '2026-10-02T00:00:00Z'), r('R0', 'CERT-G1', 2)]
  const picked = pickEffectiveReceipt(receipts, 'CERT-G1')
  check('挑出版本号最高的回执 V3', () => assert.equal(picked?.receiptNo, 'R2'))
  check('其余回执进入 superseded', () => {
    const result = reconcileCertificates(equipment, receipts)
    assert.deepEqual(result.supersededReceipts.map((x) => x.receiptNo).sort(), ['R0', 'R1'])
  })
  check('版本相同取最后接收', () => {
    const same = [r('S1', 'X', 1, '有效', '2026-10-01T00:00:00Z'), r('S2', 'X', 1, '有效', '2026-10-03T00:00:00Z')]
    assert.equal(pickEffectiveReceipt(same, 'X')?.receiptNo, 'S2')
  })
}

console.log('3) 已撤销 / 已换版不得通过；旧回执版本也不通过')
{
  const receipts = [r('R7', 'CERT-OLD', 1, '已撤销'), r('R9', 'CERT-G1', 1, '已换版')]
  const result = reconcileCertificates(equipment, receipts)
  check('已撤销回执 → 已撤销', () => assert.equal(result.findingsByCertId.cRevoked.state, '已撤销'))
  check('已换版回执 → 已换版', () => assert.equal(result.findingsByCertId.c1.state, '已换版'))
  const stale = reconcileCertificates(equipment, [r('R1', 'CERT-G1', 0, '有效')])
  check('回执版本低于台账 → 待核', () => assert.equal(stale.findingsByCertId.c1.state, '待核'))
  const newer = reconcileCertificates(equipment, [r('R1', 'CERT-G1', 5, '有效')])
  check('回执版本高于台账 → 已核验（新版已覆盖）', () => assert.equal(newer.findingsByCertId.c1.state, '已核验'))
}

console.log('4) 两窗口同时提交：先到的保留，后到的只补新增')
{
  const windowA: IncomingReceiptEntry[] = [
    { receiptNo: 'R1', certNo: 'C-A', version: 1, state: '有效', certificateName: 'a', issuer: 'i' },
    { receiptNo: 'R2', certNo: 'C-B', version: 1, state: '有效', certificateName: 'b', issuer: 'i' }
  ]
  const windowB: IncomingReceiptEntry[] = [
    { receiptNo: 'R2', certNo: 'C-B', version: 1, state: '有效', certificateName: 'b', issuer: 'i' },
    { receiptNo: 'R3', certNo: 'C-C', version: 1, state: '有效', certificateName: 'c', issuer: 'i' }
  ]
  let ledger: VerificationReceipt[] = []
  const batch = { id: 'B1', source: '窗口A', receivedAt: '2026-10-01T10:00:00Z' }
  const first = mergeReceiptEntries(ledger, collapseIncoming(windowA).kept, batch)
  ledger = first.merged
  check('先到窗口 2 条全部新增', () => assert.equal(first.added.length, 2))
  const second = mergeReceiptEntries(ledger, collapseIncoming(windowB).kept, { ...batch, id: 'B2', source: '窗口B' })
  ledger = second.merged
  check('后到窗口同编号 R2 不重复登记，只补 R3', () => {
    assert.equal(second.added.length, 1)
    assert.equal(second.added[0].receiptNo, 'R3')
    assert.equal(second.duplicated.length, 1)
  })
  check('回执台账总共只有 3 条', () => assert.equal(ledger.length, 3))
  check('窗口内同编号重复也只保留先到', () => {
    const { kept, droppedDuplicates } = collapseIncoming([windowA[0], windowA[0]])
    assert.equal(kept.length, 1); assert.equal(droppedDuplicates.length, 1)
  })
}

console.log('5) 失败重试只补未写入；重复接收不重复登记')
{
  let ledger: VerificationReceipt[] = []
  const batch = { id: 'B', source: 's', receivedAt: '2026-10-01T10:00:00Z' }
  // 首次只成功写入 R1（R2 传输失败）
  ledger = mergeReceiptEntries(ledger, collapseIncoming([
    { receiptNo: 'R1', certNo: 'C1', version: 1, state: '有效', certificateName: 'a', issuer: 'i' }
  ]).kept, batch).merged
  // 重传整批：R1 已在 → 跳过；R2 补写
  const retry = mergeReceiptEntries(ledger, collapseIncoming([
    { receiptNo: 'R1', certNo: 'C1', version: 1, state: '有效', certificateName: 'a', issuer: 'i' },
    { receiptNo: 'R2', certNo: 'C2', version: 1, state: '有效', certificateName: 'b', issuer: 'i' }
  ]).kept, batch)
  check('重试新增仅 R2', () => assert.deepEqual(retry.added.map((x) => x.receiptNo), ['R2']))
  check('R1 计为重复、不重复登记', () => {
    assert.equal(retry.duplicated.length, 1)
    assert.equal(retry.merged.length, 2)
  })
}

console.log('6) 回执变化：已核验被推翻 → invalidated（批次失效、设备待核的依据）')
{
  const before = reconcileCertificates(equipment, [r('R3', 'CERT-I1', 2, '有效'), r('R7', 'CERT-OLD', 1, '有效')])
  const prevStates = Object.fromEntries(Object.entries(before.findingsByCertId).map(([id, f]) => [id, f.state]))
  check('变更前：逆变器两证均已核验', () => {
    assert.equal(before.findingsByCertId.c2.state, '已核验')
    assert.equal(before.findingsByCertId.cRevoked.state, '已核验')
  })
  // R7 换版撤销声明到达；I1 来新版本号
  const after = reconcileCertificates(equipment, [r('R3', 'CERT-I1', 3, '有效'), r('R7', 'CERT-OLD', 1, '已撤销')])
  const { invalidated, cleared } = diffFindings(prevStates, after)
  check('撤销导致证书退出已核验', () => assert.ok(invalidated.some((f) => f.certId === 'cRevoked')))
  check('新版本仍有效不算失效', () => assert.ok(!invalidated.some((f) => f.certId === 'c2')))
  check('恢复有效 → cleared', () => {
    const healed = reconcileCertificates(equipment, [r('R3', 'CERT-I1', 3, '有效'), r('R7', 'CERT-OLD', 1, '有效')])
    assert.ok(diffFindings(Object.fromEntries(Object.entries(after.findingsByCertId).map(([id, f]) => [id, f.state])), healed).cleared.some((f) => f.certId === 'cRevoked'))
  })
}

console.log('7) 台账外回执')
{
  const result = reconcileCertificates(equipment, [r('RX', 'CERT-UNKNOWN', 1)])
  check('对不上台账的回执进入 unmatchedReceipts', () => assert.equal(result.unmatchedReceipts[0]?.receiptNo, 'RX'))
}

console.log(`\n全部 ${passed} 项断言通过 ✅`)
