import type { ReceiptState } from '../types/domain'
import type { IncomingReceiptEntry } from './reconciliation'

/**
 * 模拟外部核验机构推送核验回执：两个窗口可能同时提交同一条回执，
 * 传输可能在中途失败。真正写入哪些条目由 store 按回执编号幂等决定，
 * 本模块只负责“投递”语义：先到先达，失败的条目进入 pending 供重试。
 */

export interface DeliverableReceipt extends IncomingReceiptEntry {}

export interface TransmissionWindow {
  windowId: string
  source: string
  submittedAt: string
  entries: DeliverableReceipt[]
}

export interface DeliveryOutcome {
  windowId: string
  delivered: DeliverableReceipt[]
  failed: DeliverableReceipt[]
}

const FAIL_RATE = 0.35

/**
 * 投递一个窗口的回执。失败是条目级随机故障（模拟网络中断），
 * 同一回执编号在两个窗口“同时提交”时，先调用的窗口先达。
 */
export function transmitWindow(window: TransmissionWindow, failRate = FAIL_RATE): DeliveryOutcome {
  const delivered: DeliverableReceipt[] = []
  const failed: DeliverableReceipt[] = []
  for (const entry of window.entries) {
    if (Math.random() < failRate) failed.push(entry)
    else delivered.push(entry)
  }
  return { windowId: window.windowId, delivered, failed }
}

let fixtureSeed = 0

/**
 * 构造演示用回执数据。fixture 覆盖：正常核验、撤销、换版、同编号多设备、
 * 两窗口同时提交同一条、传输失败待重试、台账中没有的证书。
 */
export function buildFixtureWindows(now: string): TransmissionWindow[] {
  fixtureSeed += 1
  const stamp = (offsetSeconds: number) => new Date(new Date(now).getTime() + offsetSeconds * 1000).toISOString()
  const entry = (receiptNo: string, certNo: string, version: number, state: ReceiptState, certificateName: string, issuer: string): DeliverableReceipt => ({ receiptNo, certNo, version, state, certificateName, issuer })

  const windowA: TransmissionWindow = {
    windowId: `WIN-A-${fixtureSeed}`,
    source: '省电科院核验窗口',
    submittedAt: stamp(0),
    entries: [
      entry('RCV-2609-0001', 'CERT-G1', 1, '有效', '继电保护装置检验报告', '省电科院'),
      entry('RCV-2609-0002', 'CERT-T1', 1, '有效', '主变出厂试验报告', '特变电工'),
      entry('RCV-2609-0003', 'CERT-I1', 2, '有效', '逆变器低电压穿越证书', '中国电科院'),
      entry('RCV-2609-0004', 'CERT-A1', 1, '有效', '方阵接地连续性检测报告', '省电科院'),
      entry('RCV-2609-0005', 'CERT-C1', 1, '有效', '汇流箱型式试验报告', '第三方检测中心')
    ]
  }
  const windowB: TransmissionWindow = {
    windowId: `WIN-B-${fixtureSeed}`,
    source: '电科院线上核验窗口',
    submittedAt: stamp(0),
    entries: [
      // 与窗口A同一条：两个窗口同时提交，先到的保留
      entry('RCV-2609-0003', 'CERT-I1', 2, '有效', '逆变器低电压穿越证书', '中国电科院'),
      entry('RCV-2609-0006', 'CERT-T1', 2, '已换版', '主变出厂试验报告（换版）', '特变电工'),
      entry('RCV-2609-0007', 'CERT-G1', 2, '已撤销', '继电保护装置检验报告（撤销）', '省电科院'),
      entry('RCV-2609-0008', 'CERT-X9', 1, '有效', '台账外证书（对账不到设备）', '未知机构')
    ]
  }
  return [windowA, windowB]
}

export function buildRetryWindow(pending: DeliverableReceipt[], now: string): TransmissionWindow {
  // 不用 structuredClone：pending 可能是 Pinia 响应式代理，会抛 DataCloneError
  const entries = JSON.parse(JSON.stringify(pending)) as DeliverableReceipt[]
  return { windowId: `WIN-RETRY-${Date.now()}`, source: '失败重传', submittedAt: now, entries }
}
