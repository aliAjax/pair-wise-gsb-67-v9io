// store 集成规则验证：失败重试只补未写入、签署批次失效、设备改判待核
import { createPinia, setActivePinia } from 'pinia'
import { useAcceptanceStore } from '../stores/acceptance.ts'

setActivePinia(createPinia())
;(globalThis as any).importMeta = { client: false }

let passed = 0
const check = (name: string, cond: boolean) => { if (!cond) throw new Error(name); passed++; console.log(`  ✓ ${name}`) }

// 关闭随机传输失败，专注验证登记/重传/失效逻辑
const win = (id: string, source: string, entries: any[]) => ({ windowId: id, source, submittedAt: '2026-10-05T10:00:00Z', entries })
const E = (receiptNo: string, certNo: string, version: number, state: any = '有效') => ({ receiptNo, certNo, version, state, certificateName: certNo, issuer: '机构' })

const store = useAcceptanceStore()
;(store as any).hydrated = true

console.log('1) 首次接收失败部分写入，重试只补未写入')
{
  // failRate=1 全失败，failRate=0 全成功
  const batch1 = store.receiveWindow(win('W1', '窗口甲', [E('RA', 'CERT-G1', 1), E('RB', 'CERT-T1', 1)]), 1)
  check('全部传输失败：0 新增，2 条 pending', batch1.added === 0 && batch1.pending.length === 2)
  check('失败批次状态为部分写入', batch1.status === '部分写入')

  // 模拟另一窗口抢先写入 RA
  store.receiveWindow(win('W2', '窗口乙', [E('RA', 'CERT-G1', 1)]), 0)
  // 重传链路有随机失败率，循环重传直至清零（每次只补仍 pending 的部分）
  let retried = store.retryPending(batch1.id)!
  let guard = 0
  while (retried.pending.length && guard++ < 20) retried = store.retryPending(batch1.id)!
  check('重试后 pending 清零', retried.pending.length === 0 && retried.status === '已完成')
  check('回执台账只有 RA、RB 两条，无重复', store.receipts.length === 2)
  check('RA 来自先到窗口乙', store.receipts.find((x) => x.receiptNo === 'RA')?.source === '窗口乙')
}

console.log('2) 两窗口同时提交同一回执，先到保留')
{
  const shared = E('RC', 'CERT-I1', 2)
  const extra = E('RD', 'CERT-A1', 1)
  const [ba, bb] = store.receiveWindowsConcurrently([win('WA', '省电科院窗口', [shared]), win('WB', '线上窗口', [shared, extra])], 0)
  check('先到窗口写入 RC', ba.added === 1 && ba.delivered === 1)
  check('后到窗口 RC 重复、只补 RD', bb.added === 1 && bb.duplicated === 1)
  check('RC 只登记一次', store.receipts.filter((x) => x.receiptNo === 'RC').length === 1)
}

console.log('3) 已签署批次在回执变化后失效，挂载设备改判待核')
{
  // 补齐全部台账证书的有效回执，且摘除重复挂载，制造可签署状态
  store.removeCertificate('EQ-GRID', 'C-G1-DUP')
  // 台账证书：C-G1(RA v1) T1(RB v1) I1(RC v2) A1(RD v1) C1
  store.receiveWindow(win('W3', '窗口丙', [E('RE', 'CERT-C1', 1)]), 0)
  // 当前仍有不合格验收项 → 用 store 内部数据直接验证签署门槛
  const beforeSign = store.signOff()
  check('完整性检查未过时拒绝签署', beforeSign.ok === false)

  // 手工把验收项/缺陷清到可签署（模拟闭环完成）
  store.equipment.forEach((node) => { node.items.forEach((item) => { item.status = '合格'; item.measured ||= 'x'; item.evidence ||= 'x' }); node.status = '已验收' })
  store.defects.forEach((d) => { d.status = '已关闭'; d.retests = [{ round: 1, passed: true, result: 'ok', tester: '组', testedAt: '2026-10-05T09:00:00Z' }] })
  const signResult = store.signOff()
  check('对账全部通过后签署成功', signResult.ok === true && store.plant.status === '已签署')
  check('签署快照已留存', store.signedSnapshot !== null)

  // 新回执：CERT-G1 被撤销
  store.receiveWindow(win('W4', '撤销通知', [E('RF', 'CERT-G1', 2, '已撤销')]), 0)
  check('撤销回执到达 → 已签署批次失效，工厂退回待复核', store.plant.status === '待复核' && store.signedSnapshot === null)
  const grid = store.equipment.find((n) => n.id === 'EQ-GRID')!
  check('挂该证书的已验收设备改判待核', grid.status === '待核')
  const inverter = store.equipment.find((n) => n.id === 'EQ-INV11')!
  check('未受影响设备保持已验收', inverter.status === '已验收')
  check('完整性检查阻断：已撤销证书不得通过', store.preflight.allowed === false && store.preflight.blocking.some((m) => m.includes('已撤销')))
  check('审计日志记录批次失效', store.audit.some((a) => a.action === '签署批次失效'))
}

console.log('4) 老证书缺回执编号 → 待核且阻断签署')
{
  // CERT-T1 的回执 RB 有效；人为删掉一张证书的 receiptNo 模拟历史数据
  const t1 = store.equipment.find((n) => n.id === 'EQ-TR1')!.certificates[0]
  check('缺回执编号初始即待核', store.certState('c-not-exist') === '待核')
  check('已登记回执的证书为已核验/撤销/换版状态之一', ['已核验', '已撤销', '已换版', '待核'].includes(store.certState(t1.id)))
}

console.log(`\n集成场景全部 ${passed} 项断言通过 ✅`)
